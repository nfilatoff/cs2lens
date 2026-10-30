"""Cut a small extract (the first rounds of a match) into tests/fixtures/<name>.

    python tests/make_fixture.py out/Dust2ArenaPro_vs_teamSirena dust2_mini --rounds 8

Tables with a ``tick`` (or ``start_tick``) column are cut to the ticks of the kept rounds;
the per-match tables (players, stats) are copied whole.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import polars as pl

TABLES = ["rounds", "kills", "bomb", "players", "stats", "round_economy", "snapshots", "damages", "fires", "smokes", "shots", "blinds"]
EVENTS = ["weapon_fire", "smokegrenade_detonate", "flashbang_detonate", "hegrenade_detonate", "grenade_thrown"]
SNAP_COLUMNS = ["tick", "steamid", "name", "side", "x", "y", "z", "yaw", "health", "armor", "has_bomb", "active_weapon"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("name")
    ap.add_argument("--rounds", type=int, default=8)
    args = ap.parse_args()

    target = Path(__file__).parent / "fixtures" / args.name
    if target.exists():
        shutil.rmtree(target)
    (target / "events").mkdir(parents=True)

    rounds = pl.read_parquet(args.source / "rounds.parquet").filter(pl.col("round_num") <= args.rounds)
    last = int(rounds["end_tick"].max())

    def cut(df: pl.DataFrame) -> pl.DataFrame:
        for col in ("tick", "start_tick"):
            if col in df.columns:
                return df.filter(pl.col(col).cast(pl.Int64) <= last)
        return df

    for t in TABLES:
        df = rounds if t == "rounds" else cut(pl.read_parquet(args.source / f"{t}.parquet"))
        if t == "snapshots":
            df = df.select(SNAP_COLUMNS)
        if t == "round_economy":
            df = df.filter(pl.col("round_num") <= args.rounds)
        df.write_parquet(target / f"{t}.parquet")
    for e in EVENTS:
        path = args.source / "events" / f"{e}.parquet"
        if path.exists():
            cut(pl.read_parquet(path)).write_parquet(target / "events" / f"{e}.parquet")
    manifest = json.loads((args.source / "manifest.json").read_text(encoding="utf-8"))
    manifest = {"header": {"map_name": manifest["header"]["map_name"]}, "tick_rate": manifest["tick_rate"]}
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    size = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
    print(f"{target}: {size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
