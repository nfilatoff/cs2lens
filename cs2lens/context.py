"""Shared loading and round/team resolution for analyses of an ``extract`` directory."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import polars as pl

BASE_TABLES = ["rounds", "kills", "bomb", "players", "stats", "round_economy", "snapshots"]


def pct(num: pl.Expr, den: pl.Expr) -> pl.Expr:
    return pl.when(den > 0).then((num / den * 100).round(1)).otherwise(None)


def with_round(df: pl.DataFrame, rounds: pl.DataFrame) -> pl.DataFrame:
    """Attach ``round_num`` and the round's tick bounds to rows with a ``tick`` column.

    Rows outside every round (warmup, knife rounds, post-round) are dropped.
    """
    return (
        df.with_columns(pl.col("tick").cast(pl.Int32))
        .sort("tick")
        .join_asof(rounds, left_on="tick", right_on="start_tick")
        .filter(pl.col("round_num").is_not_null() & (pl.col("tick") <= pl.col("end_tick")))
    )


@dataclass
class Match:
    directory: Path
    data: dict[str, pl.DataFrame]
    tick_rate: float
    map_name: str
    rounds: pl.DataFrame  # non-knife rounds
    teams: pl.DataFrame  # steamid, team
    sides: pl.DataFrame  # round_num, team, side
    tr: pl.DataFrame  # one row per (round, team): side, won, buy, equip, opp, opp_buy, opp_equip
    snap_step: int  # ticks between snapshots
    snap_offset: int = 0  # snapshot ticks are snap_offset + k * snap_step (some demos start at tick 1)

    def snap_floor(self, tick):
        """The snapshot tick at or before ``tick`` (int or polars expression)."""
        return (tick - self.snap_offset) // self.snap_step * self.snap_step + self.snap_offset

    def event(self, name: str) -> pl.DataFrame | None:
        path = self.directory / "events" / f"{name}.parquet"
        return pl.read_parquet(path) if path.exists() else None


def alive_counts(m: Match) -> pl.DataFrame:
    """Living players of each side per snapshot tick: ``tick``, ``alive_t``, ``alive_ct``."""
    alive = (
        m.data["snapshots"]
        .select(pl.col("tick").cast(pl.Int32), "steamid", "side", "health")
        .join(m.teams.select("steamid"), on="steamid")
        .group_by("tick")
        .agg(
            alive_t=((pl.col("side") == "terrorist") & (pl.col("health") > 0)).sum().cast(pl.Int32),
            alive_ct=((pl.col("side") == "counter-terrorist") & (pl.col("health") > 0)).sum().cast(pl.Int32),
        )
    )
    return alive.sort("tick")


def with_man_diff(df: pl.DataFrame, alive: pl.DataFrame, side_col: str = "side") -> pl.DataFrame:
    """Add ``man_diff``: living players of the row's side minus the enemy's, at the last snapshot before its ``tick``."""
    t_diff = pl.col("alive_t") - pl.col("alive_ct")
    return (
        df.with_columns(pl.col("tick").cast(pl.Int32))
        .sort("tick")
        .join_asof(alive, on="tick")
        .with_columns(
            man_diff=pl.when(pl.col(side_col) == "terrorist").then(t_diff)
            .when(pl.col(side_col) == "counter-terrorist").then(-t_diff)
            .otherwise(None)
        )
        .drop("alive_t", "alive_ct")
    )


def round_context(m: Match) -> pl.DataFrame:
    """What a team walked into each round: one row per (round, team).

    On top of ``Match.tr``: ``is_pistol``, ``prev_won``, ``loss_streak`` (losses in a row
    before this round, reset at the half), ``after_pistol_loss`` (true after losing the
    half's pistol round, false after winning it, null in every other round) and the
    players alive at the plant (``alive_t_plant``, ``alive_ct_plant``; null without a
    plant) and at the end of the round (``alive_t_end``, ``alive_ct_end``).
    """
    rows = m.tr.sort("team", "round_num").with_columns(is_pistol=(pl.col("buy") == "pistol").fill_null(False))
    streaks = []
    for _team, group in rows.group_by("team", maintain_order=True):
        streak, side = 0, None
        for r in group.iter_rows(named=True):
            if r["side"] != side:
                streak, side = 0, r["side"]
            streaks.append(streak)
            streak = 0 if r["won"] else streak + 1
    ctx = rows.with_columns(
        loss_streak=pl.Series(streaks, dtype=pl.Int32),
        prev_won=pl.col("won").shift(1).over("team"),
        after_pistol_loss=pl.when(pl.col("is_pistol").shift(1).over("team")).then(~pl.col("won").shift(1).over("team")).otherwise(None),
    )

    alive = alive_counts(m)
    alive_at = lambda ticks, suffix: (  # noqa: E731
        ticks.sort("tick").join_asof(alive, on="tick").select("round_num", **{f"alive_t_{suffix}": "alive_t", f"alive_ct_{suffix}": "alive_ct"})
    )
    plants = with_round(m.data["bomb"].filter(pl.col("event") == "finish_plant").select("tick"), m.rounds).select("round_num", "tick")
    # one snapshot past the end: the last kill may fall between two snapshots
    ends = m.rounds.select("round_num", tick=(pl.col("end_tick") + m.snap_step).cast(pl.Int32))
    return (
        ctx.join(alive_at(plants.unique("round_num"), "plant"), on="round_num", how="left")
        .join(alive_at(ends, "end"), on="round_num", how="left")
        .sort("round_num", "team")
    )


def load_match(directory: str | Path, extra_tables: tuple[str, ...] = ()) -> Match:
    directory = Path(directory)
    names = [*BASE_TABLES, *extra_tables]
    missing = [t for t in names if not (directory / f"{t}.parquet").exists()]
    if missing:
        raise FileNotFoundError(f"{directory}: missing {missing}; run `cs2lens extract` first")
    data = {t: pl.read_parquet(directory / f"{t}.parquet") for t in names}
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    # Coaches have a stats row (no kills, deaths, assists or damage) and a pawn on their team.
    data["stats"] = data["stats"].filter(
        (pl.col("kills") + pl.col("deaths") + pl.col("assists") > 0) | (pl.col("adr").cast(pl.Float64) > 0)
    )

    # Ticks inside a knife round fall past the previous round's end_tick and are dropped by with_round.
    rounds = (
        data["rounds"]
        .filter(~pl.col("is_knife_round"))
        .select(
            "round_num",
            # Some demos start recording after round 1 began, leaving its start_tick null.
            pl.col("start_tick").fill_null(0),
            "freeze_end_tick",
            "end_tick",
            "winner_side",
            "reason_name",
        )
        .sort("start_tick")
    )
    teams = (
        data["players"]
        .filter((pl.col("steamid") != 0) & pl.col("team_clan_name").is_not_null())
        .select("steamid", team=pl.col("team_clan_name"))
    )
    if data["stats"].height:
        teams = teams.filter(pl.col("steamid").is_in(data["stats"]["steamid"].implode()))

    # Which side each team played in each round (snapshots, majority vote).
    snaps = with_round(data["snapshots"].select("tick", "steamid", "side"), rounds).join(teams, on="steamid")
    sides = (
        snaps.group_by("round_num", "team", "side")
        .len()
        .sort("len", descending=True)
        .group_by("round_num", "team", maintain_order=True)
        .first()
        .select("round_num", "team", "side")
    )

    econ = data["round_economy"].select("round_num", "side", equip="equipment_value", buy="buy_type")
    tr = (
        sides.join(rounds.select("round_num", "winner_side", "reason_name"), on="round_num")
        .join(econ, on=["round_num", "side"], how="left")
        .with_columns(won=pl.col("side") == pl.col("winner_side"))
    )
    opp = tr.select("round_num", opp=pl.col("team"), opp_buy=pl.col("buy"), opp_equip=pl.col("equip"))
    tr = tr.join(opp, on="round_num").filter(pl.col("team") != pl.col("opp"))

    ticks = data["snapshots"]["tick"].unique().sort()
    snap_step = int(ticks.diff().drop_nulls().min())

    return Match(
        directory=directory,
        data=data,
        tick_rate=float(manifest["tick_rate"]),
        map_name=str(manifest["header"].get("map_name", "")),
        rounds=rounds,
        teams=teams,
        sides=sides,
        tr=tr,
        snap_step=snap_step,
        snap_offset=int(ticks.min()) % snap_step,
    )
