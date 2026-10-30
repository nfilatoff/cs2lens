"""Render team statistics as Markdown."""

from __future__ import annotations

import polars as pl

_SECTIONS = [
    ("summary", "Summary"),
    ("by_side", "Rounds by side"),
    ("by_buy", "Rounds by buy type (own vs opponent)"),
    ("win_reasons", "How rounds were won"),
    ("opening", "Opening duels"),
    ("trades", "Trades"),
    ("bomb_t", "T side: bomb plants"),
    ("bomb_ct", "CT side: retakes and defuses"),
]


def _table(df: pl.DataFrame) -> str:
    head = "| " + " | ".join(df.columns) + " |"
    sep = "|" + "|".join("---" for _ in df.columns) + "|"
    rows = ("| " + " | ".join("" if v is None else str(v) for v in row) + " |" for row in df.rows())
    return "\n".join([head, sep, *rows])


def to_markdown(tables: dict[str, pl.DataFrame], title: str) -> str:
    parts = [f"# {title}"]
    for key, heading in _SECTIONS:
        parts += [f"## {heading}", _table(tables[key])]
    return "\n\n".join(parts) + "\n"


_TACTICS_SECTIONS = [
    ("executes", "T executes by target site"),
    ("rounds_t", "T rounds: target, tempo and utility package"),
    ("setup_summary", "CT setups (CTs per zone at setup time: A, B, mid)"),
    ("rotations", "CT rotations by planted site"),
]


def tactics_markdown(tables: dict[str, pl.DataFrame], title: str) -> str:
    tables = dict(tables)
    tables["rounds_t"] = tables["rounds_t"].select(
        "team", "round_num", "target_site", "exec_sec", "plant_sec", "tempo", "package", "won",
        *[c for c in ("entry", "package_zones") if c in tables["rounds_t"].columns],
    )
    tables["setup_summary"] = (
        tables["setups"]
        .group_by("team", "setup")
        .agg(rounds=pl.len(), wins=pl.col("won").sum())
        .with_columns(win_pct=(pl.col("wins") / pl.col("rounds") * 100).round(1))
        .sort("team", "rounds", descending=[False, True])
    )
    parts = [f"# {title}"]
    for key, heading in _TACTICS_SECTIONS:
        parts += [f"## {heading}", _table(tables[key])]
    return "\n\n".join(parts) + "\n"


_AGGREGATE_SECTIONS = [
    ("matches", "Matches"),
    ("summary", "Teams: overall"),
    ("summary_by_map", "Teams: by map"),
    ("by_side", "Rounds by side"),
    ("by_side_map", "Rounds by map and side"),
    ("by_buy", "Rounds by buy type (own vs opponent)"),
    ("win_reasons", "How rounds were won"),
    ("opening", "Opening duels"),
    ("trades", "Trades"),
    ("bomb_t", "T side: bomb plants"),
    ("bomb_ct", "CT side: retakes and defuses"),
    ("executes", "T executes by map and target site"),
    ("rotations", "CT rotations by map and planted site"),
    ("setups", "CT setups by map"),
    ("players", "Players (sorted by ADR)"),
]


def aggregate_markdown(tables: dict[str, pl.DataFrame], title: str) -> str:
    parts = [f"# {title}"]
    for key, heading in _AGGREGATE_SECTIONS:
        if key in tables:
            parts += [f"## {heading}", _table(tables[key])]
    return "\n\n".join(parts) + "\n"
