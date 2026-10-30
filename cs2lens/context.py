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

    def event(self, name: str) -> pl.DataFrame | None:
        path = self.directory / "events" / f"{name}.parquet"
        return pl.read_parquet(path) if path.exists() else None


def load_match(directory: str | Path, extra_tables: tuple[str, ...] = ()) -> Match:
    directory = Path(directory)
    names = [*BASE_TABLES, *extra_tables]
    missing = [t for t in names if not (directory / f"{t}.parquet").exists()]
    if missing:
        raise FileNotFoundError(f"{directory}: missing {missing}; run `cs2lens extract` first")
    data = {t: pl.read_parquet(directory / f"{t}.parquet") for t in names}
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))

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
    )
