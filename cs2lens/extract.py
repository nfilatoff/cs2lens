"""Dump everything a demo exposes into a directory of Parquet files."""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl
from awpy import Demo


def extract(demo_path: str | Path, out_dir: str | Path, *, snapshot_seconds: float = 0.5) -> dict:
    """Write all awpy datasets, every game event and periodic snapshots to ``out_dir``.

    Returns a manifest ``{table: row_count}`` that is also saved as ``manifest.json``.
    """
    demo = Demo(demo_path)
    out = Path(out_dir)
    (out / "events").mkdir(parents=True, exist_ok=True)

    demo.load(*Demo.available_datasets())
    manifest: dict = {"header": demo.header, "tick_rate": demo.tick_rate, "tables": {}}

    def write(name: str, df: pl.DataFrame, path: Path) -> None:
        df.write_parquet(path)
        manifest["tables"][name] = df.height

    for name in Demo.available_datasets():
        write(name, getattr(demo, name), out / f"{name}.parquet")

    for name in demo.events.names:
        write(f"events/{name}", demo.events[name], out / "events" / f"{name}.parquet")

    last_tick = demo.header.get("playback_ticks")
    if last_tick:
        snaps = demo.snapshots(seconds=snapshot_seconds, start_tick=0, end_tick=int(last_tick))
        write("snapshots", snaps, out / "snapshots.parquet")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    return manifest
