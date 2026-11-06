"""Dump everything a demo exposes into a directory of Parquet files."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import polars as pl
from awpy import Demo, InvalidDemoError

from cs2lens.demorepair import repair_demo

REPAIRED_FILE = "_repaired.dem"  # a temporary copy, for a demo the parser refuses (see demorepair.py)
REPLAY_EVERY = 4  # ticks between replay frames (16 per second at 64 tick)
REPLAY_COLUMNS = [
    "tick", "steamid", "name", "side", "x", "y", "z", "yaw", "health", "armor", "has_helmet", "has_defuser",
    "has_bomb", "active_weapon", "is_defusing", "is_blinded", "money",
]

Progress = Callable[[float, str], None]


def _noop(_fraction: float, _stage: str) -> None:
    pass


def write_replay(demo: Demo, out: Path, *, every: int = REPLAY_EVERY) -> int:
    """Write ``replay.parquet``: player state every ``every`` ticks over the whole demo. Returns the row count."""
    last_tick = int(demo.header.get("playback_ticks") or 0)
    if not last_tick:
        return 0
    frames = demo.snapshots(every=every, start_tick=0, end_tick=last_tick).select(REPLAY_COLUMNS)
    frames.write_parquet(out / "replay.parquet")
    return frames.height


def extract(
    demo_path: str | Path,
    out_dir: str | Path,
    *,
    snapshot_seconds: float = 0.5,
    replay_every: int = REPLAY_EVERY,
    progress: Progress | None = None,
) -> dict:
    """Write all awpy datasets, every game event, periodic snapshots and replay frames to ``out_dir``.

    Returns a manifest ``{table: row_count}`` that is also saved as ``manifest.json``.
    ``progress(fraction, stage)`` is called between stages.
    """
    progress = progress or _noop
    out = Path(out_dir)
    (out / "events").mkdir(parents=True, exist_ok=True)
    repaired = out / REPAIRED_FILE
    try:
        return _extract(demo_path, out, repaired, snapshot_seconds, replay_every, progress)
    finally:
        try:
            repaired.unlink(missing_ok=True)
        except OSError:  # the parser may still hold the file; it does no harm until the next run
            pass


def _load(demo_path: str | Path, repaired: Path, progress: Progress) -> tuple[Demo, int]:
    """The demo with all datasets loaded and how many broken strings had to be repaired for that."""
    demo = Demo(demo_path)
    try:
        demo.load(*Demo.available_datasets())
        return demo, 0
    except InvalidDemoError as e:
        if "not UTF-8" not in str(e):
            raise
        progress(0.0, "repairing demo")
        count = repair_demo(demo_path, repaired)
        if not count:
            raise
    demo = Demo(repaired)
    demo.load(*Demo.available_datasets())
    return demo, count


def _extract(
    demo_path: str | Path, out: Path, repaired: Path, snapshot_seconds: float, replay_every: int, progress: Progress,
) -> dict:
    progress(0.0, "parsing demo")
    demo, repaired_strings = _load(demo_path, repaired, progress)
    manifest: dict = {
        "header": demo.header,
        "tick_rate": demo.tick_rate,
        "demo_path": str(Path(demo_path).resolve()),
        "replay_every": replay_every,
        "repaired_strings": repaired_strings,
        "tables": {},
    }

    def write(name: str, df: pl.DataFrame, path: Path) -> None:
        df.write_parquet(path)
        manifest["tables"][name] = df.height

    progress(0.6, "writing datasets")
    for name in Demo.available_datasets():
        write(name, getattr(demo, name), out / f"{name}.parquet")

    progress(0.7, "writing events")
    for name in demo.events.names:
        write(f"events/{name}", demo.events[name], out / "events" / f"{name}.parquet")

    progress(0.8, "snapshots")
    last_tick = demo.header.get("playback_ticks")
    if last_tick:
        snaps = demo.snapshots(seconds=snapshot_seconds, start_tick=0, end_tick=int(last_tick))
        write("snapshots", snaps, out / "snapshots.parquet")

    progress(0.9, "replay frames")
    manifest["tables"]["replay"] = write_replay(demo, out, every=replay_every)

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    progress(1.0, "done")
    return manifest


def add_replay(demo_path: str | Path, out_dir: str | Path, *, every: int = REPLAY_EVERY) -> int:
    """Add ``replay.parquet`` to an extract made before replay frames existed."""
    out = Path(out_dir)
    demo = Demo(demo_path)
    rows = write_replay(demo, out, every=every)
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["tables"]["replay"] = rows
    manifest["replay_every"] = every
    manifest["demo_path"] = str(Path(demo_path).resolve())
    manifest_path.write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    return rows
