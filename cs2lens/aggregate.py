"""Aggregate team statistics, tactics and player stats over several matches.

Counts are summed and every percentage or ratio is recomputed from the sums, so a
long match weighs more than a short one. Averages (ADR, plant time, ...) are
weighted by the count they were averaged over. Teams are matched by clan name.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from cs2lens.context import load_match, pct
from cs2lens.tactics import tactics
from cs2lens.team_stats import team_stats


@dataclass
class Spec:
    keys: list[str]
    sums: list[str] = field(default_factory=list)
    wmeans: dict[str, str] = field(default_factory=dict)  # column -> weight column
    pcts: list[tuple[str, pl.Expr, pl.Expr]] = field(default_factory=list)
    ratios: list[tuple[str, pl.Expr, pl.Expr, int]] = field(default_factory=list)


def _c(name: str) -> pl.Expr:
    return pl.col(name)


_WIN = [("win_pct", _c("wins"), _c("rounds"))]

SPECS: dict[str, Spec] = {
    "summary": Spec(
        ["team"],
        sums=[
            "rounds", "rounds_won", "kills", "deaths", "assists", "headshots", "clutches_won", "clutches_played",
            "multikill_rounds", "utility_damage", "flashes_thrown", "enemies_flashed", "flash_seconds",
        ],
        wmeans={"adr": "rounds", "kast": "rounds"},
        pcts=[("round_win_pct", _c("rounds_won"), _c("rounds")), ("hs_pct", _c("headshots"), _c("kills"))],
        ratios=[
            ("kd", _c("kills"), _c("deaths"), 2),
            ("utility_damage_per_round", _c("utility_damage"), _c("rounds"), 1),
            ("enemies_flashed_per_flash", _c("enemies_flashed"), _c("flashes_thrown"), 2),
        ],
    ),
    "by_side": Spec(["team", "side"], sums=["rounds", "wins"], pcts=_WIN),
    "by_buy": Spec(
        ["team", "buy", "opp_buy"],
        sums=["rounds", "wins"],
        wmeans={"avg_equip": "rounds", "avg_opp_equip": "rounds"},
        pcts=_WIN,
    ),
    "win_reasons": Spec(["team", "side", "reason_name"], sums=["rounds"]),
    "opening": Spec(
        ["team", "side"],
        sums=["rounds", "opening_kills", "opening_deaths", "won_after_kill", "won_after_death"],
        pcts=[
            ("opening_win_pct", _c("opening_kills"), _c("opening_kills") + _c("opening_deaths")),
            ("round_win_after_kill_pct", _c("won_after_kill"), _c("opening_kills")),
            ("round_win_after_death_pct", _c("won_after_death"), _c("opening_deaths")),
        ],
    ),
    "trades": Spec(
        ["team"],
        sums=["kills", "trade_kills", "deaths", "traded_deaths"],
        pcts=[("trade_kill_pct", _c("trade_kills"), _c("kills")), ("traded_death_pct", _c("traded_deaths"), _c("deaths"))],
    ),
    "bomb_t": Spec(
        ["team"],
        sums=["t_rounds", "plants", "site_a", "site_b", "post_plant_wins", "no_plant_wins", "no_plant_rounds"],
        wmeans={"avg_plant_sec": "plants"},
        pcts=[
            ("plant_pct", _c("plants"), _c("t_rounds")),
            ("post_plant_win_pct", _c("post_plant_wins"), _c("plants")),
            ("no_plant_win_pct", _c("no_plant_wins"), _c("no_plant_rounds")),
        ],
    ),
    "bomb_ct": Spec(
        ["team"],
        sums=["ct_rounds", "bombs_planted_on_them", "defuses", "retake_wins", "hold_wins"],
        pcts=[("retake_win_pct", _c("retake_wins"), _c("bombs_planted_on_them"))],
    ),
    # Tactics depend on the map (site positions differ), so they are always keyed by map.
    "executes": Spec(
        ["map", "team", "target_site"],
        sums=["rounds", "wins", "plants", "smokes", "flashes", "mollies", "hes", "early", "mid", "late"],
        wmeans={"avg_exec_start_sec": "rounds", "avg_plant_sec": "plants"},
        pcts=_WIN,
    ),
    "executes_by_buy": Spec(
        ["map", "team", "buy", "target_site"],
        sums=["rounds", "wins", "plants"],
        wmeans={"avg_exec_start_sec": "rounds", "avg_plant_sec": "plants"},
        pcts=_WIN,
    ),
    "rotations": Spec(
        ["map", "team", "plant_site"],
        sums=["plants_faced", "retake_wins"],
        wmeans={c: "plants_faced" for c in ("avg_rotators", "avg_arrived", "avg_before_plant", "avg_rot_sec")},
        pcts=[("retake_win_pct", _c("retake_wins"), _c("plants_faced"))],
    ),
}
# Per-map variants of the team tables.
SPECS["summary_by_map"] = Spec(["map", *SPECS["summary"].keys], **{k: v for k, v in vars(SPECS["summary"]).items() if k != "keys"})
SPECS["by_side_map"] = Spec(["map", *SPECS["by_side"].keys], **{k: v for k, v in vars(SPECS["by_side"]).items() if k != "keys"})

_SOURCE = {"summary_by_map": "summary", "by_side_map": "by_side"}


def combine(frames: pl.DataFrame, spec: Spec) -> pl.DataFrame:
    """Aggregate ``frames`` (per-match rows stacked, with a ``match`` column) according to ``spec``."""
    aggs: list[pl.Expr] = [pl.col("match").n_unique().alias("matches")]
    aggs += [pl.col(c).sum() for c in spec.sums]
    for col, weight in spec.wmeans.items():
        valid = pl.col(weight).filter(pl.col(col).is_not_null()).sum()
        aggs.append(pl.when(valid > 0).then((pl.col(col) * pl.col(weight)).sum() / valid).otherwise(None).round(2).alias(col))
    out = frames.group_by(spec.keys).agg(aggs)
    out = out.with_columns(pct(num, den).alias(name) for name, num, den in spec.pcts)
    out = out.with_columns(
        pl.when(den > 0).then((num / den).round(digits)).otherwise(None).alias(name) for name, num, den, digits in spec.ratios
    )
    return out.sort(spec.keys)


def _match_label(name: str, summary: pl.DataFrame) -> dict:
    top = summary.sort("rounds_won", descending=True)
    rows = top.rows(named=True)
    score = ":".join(str(r["rounds_won"]) for r in rows)
    teams = " vs ".join(r["team"] for r in rows)
    return {"match": name, "teams": teams, "score": score, "rounds": rows[0]["rounds"]}


def aggregate(directories: list[str | Path], aliases: dict[str, str] | None = None) -> dict[str, pl.DataFrame]:
    """Aggregate extract directories. Matches whose tactics cannot be computed still count for the rest.

    ``aliases`` maps team names as they appear in demos to the name to report (``{"old": "new"}``).
    """

    def rename(df: pl.DataFrame) -> pl.DataFrame:
        if not aliases or "team" not in df.columns:
            return df
        return df.with_columns(pl.col("team").replace(aliases))

    stacked: dict[str, list[pl.DataFrame]] = {}
    players: list[pl.DataFrame] = []
    setups: list[pl.DataFrame] = []
    matches: list[dict] = []

    for i, directory in enumerate(directories):
        directory = Path(directory)
        label = f"{i}:{directory.name}"  # position keeps a repeated directory a separate match
        m = load_match(directory)
        tables = {k: rename(v) for k, v in team_stats(directory).items()}
        for name in ("summary", "by_side", "by_buy", "win_reasons", "opening", "trades", "bomb_t", "bomb_ct"):
            stacked.setdefault(name, []).append(tables[name].with_columns(match=pl.lit(label), map=pl.lit(m.map_name)))
        matches.append({**_match_label(directory.name, tables["summary"]), "map": m.map_name})

        try:
            tac = {k: rename(v) for k, v in tactics(directory).items()}
        except ValueError as e:
            warnings.warn(f"{directory.name}: tactics skipped ({e})", stacklevel=2)
        else:
            for name in ("executes", "executes_by_buy", "rotations"):
                stacked.setdefault(name, []).append(tac[name].with_columns(match=pl.lit(label), map=pl.lit(m.map_name)))
            setups.append(tac["setups"].with_columns(match=pl.lit(label), map=pl.lit(m.map_name)))

        st = rename(m.data["stats"].join(m.teams, on="steamid")).with_columns(match=pl.lit(label))
        players.append(st)

    result: dict[str, pl.DataFrame] = {"matches": pl.DataFrame(matches).select("match", "map", "teams", "score", "rounds")}
    for name, spec in SPECS.items():
        source = _SOURCE.get(name, name)
        if source in stacked:
            result[name] = combine(pl.concat(stacked[source], how="diagonal_relaxed"), spec)

    if setups:
        result["setups"] = (
            pl.concat(setups)
            .group_by("map", "team", "setup")
            .agg(matches=pl.col("match").n_unique(), rounds=pl.len(), wins=pl.col("won").sum())
            .with_columns(win_pct=pct(_c("wins"), _c("rounds")))
            .sort("map", "team", "rounds", descending=[False, False, True])
        )

    p = pl.concat(players, how="diagonal_relaxed").with_columns(pl.col("adr", "kast").cast(pl.Float64))
    summed = ["rounds_played", "kills", "deaths", "assists", "headshot_kills", "opening_kills", "opening_deaths",
              "traded_deaths", "clutches_won", "clutches_played", "utility_damage", "flashes_thrown", "enemies_flashed"]
    result["players"] = (
        p.group_by("steamid", maintain_order=True)
        .agg(
            pl.col("name").last(),
            pl.col("team").last(),
            pl.col("match").n_unique().alias("matches"),
            *[pl.col(c).sum() for c in summed],
            ((pl.col("adr") * pl.col("rounds_played")).sum() / pl.col("rounds_played").sum()).round(1).alias("adr"),
            ((pl.col("kast") * pl.col("rounds_played")).sum() / pl.col("rounds_played").sum()).round(1).alias("kast"),
        )
        .with_columns(
            kd=(_c("kills") / _c("deaths")).round(2),
            hs_pct=pct(_c("headshot_kills"), _c("kills")),
            opening_win_pct=pct(_c("opening_kills"), _c("opening_kills") + _c("opening_deaths")),
        )
        .select("name", "team", "matches", "rounds_played", "kills", "deaths", "assists", "kd", "adr", "kast", "hs_pct",
                "opening_kills", "opening_deaths", "opening_win_pct", "traded_deaths", "clutches_won", "clutches_played",
                "utility_damage", "flashes_thrown", "enemies_flashed")
        .sort("adr", descending=True)
    )
    return result
