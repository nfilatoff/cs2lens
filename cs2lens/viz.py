"""Visualizations drawn over the map radar (via ``awpy.plot``).

Radar images are downloaded by awpy on first use into ``~/.awpy``.
Multi-level maps are drawn on the upper radar only.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import polars as pl  # noqa: E402
from awpy import plot  # noqa: E402

from cs2lens.context import Match, load_match  # noqa: E402
from cs2lens.tactics import userid_map, utility_events  # noqa: E402

UTIL_COLORS = {"smoke": "#cfcfcf", "flash": "#fff35c", "he": "#ff5c5c", "molotov": "#ff9f1c"}


def _side(value: str | None) -> str | None:
    if value is None:
        return None
    short = {"t": "terrorist", "ct": "counter-terrorist"}
    if value.lower() not in short and value.lower() not in short.values():
        raise ValueError(f"side must be t or ct, not {value!r}")
    return short.get(value.lower(), value.lower())


def kill_heatmap(directory: str | Path, path: str | Path, *, side: str | None = None, role: str = "victim") -> Path:
    """Density of kill locations. ``role`` is where to look: ``victim`` or ``attacker`` positions."""
    if role not in ("victim", "attacker"):
        raise ValueError("role must be victim or attacker")
    m = load_match(directory)
    side = _side(side)
    kills = m.data["kills"].filter(pl.col(f"{role}_x").is_not_null())
    if side:
        kills = kills.filter(pl.col(f"{role}_side") == side)
    points = kills.select(f"{role}_x", f"{role}_y", f"{role}_z").rows()
    fig, ax = plot.heatmap(m.map_name, points, method="kde")
    ax.text(8, 14, f"{role} positions of kills" + (f" ({side})" if side else ""), color="white", fontsize=7, va="top", zorder=10)
    return _save(fig, path)


def utility_map(directory: str | Path, path: str | Path, *, side: str | None = None, team: str | None = None) -> Path:
    """Where grenades landed, coloured by type. Filter by side and/or team name."""
    m = load_match(directory, extra_tables=("fires", "shots"))
    util = utility_events(m, userid_map(m))
    if side := _side(side):
        util = util.filter(pl.col("side") == side)
    if team:
        util = util.filter(pl.col("team") == team)
    fig, ax = plot.radar(m.map_name)
    for kind, color in UTIL_COLORS.items():
        pts = util.filter(pl.col("type") == kind)
        if pts.is_empty():
            continue
        px = [plot.world_to_pixel(m.map_name, (x, y)) for x, y in pts.select("x", "y").rows()]
        ax.scatter([p[0] for p in px], [p[1] for p in px], s=22, c=color, edgecolors="black", linewidths=0.4, alpha=0.85, label=f"{kind} ({pts.height})", zorder=3)
    ax.legend(loc="lower left", fontsize=6, framealpha=0.6)
    title = "grenade landings" + (f" - {team}" if team else "") + (f" ({side})" if side else "")
    ax.text(8, 14, title, color="white", fontsize=7, va="top", zorder=10)
    return _save(fig, path)


def _round_ticks(m: Match, round_num: int, step_sec: float) -> tuple[list[int], dict]:
    row = m.rounds.filter(pl.col("round_num") == round_num)
    if row.is_empty():
        raise ValueError(f"round {round_num} not found (knife rounds are excluded)")
    info = row.row(0, named=True)
    step = max(1, round(step_sec * m.tick_rate / m.snap_step)) * m.snap_step
    first = m.snap_floor(info["freeze_end_tick"] + m.snap_step - 1)
    return list(range(first, info["end_tick"] + 1, step)), info


def _frame_args(m: Match, tick: int, plant: tuple[float, float, float] | None, plant_tick: int | None) -> dict:
    snap = m.data["snapshots"].filter(pl.col("tick") == tick)
    names = {r["steamid"]: r["name"] for r in snap.iter_rows(named=True)}
    players = [
        plot.Player(
            x=float(r["x"]), y=float(r["y"]), z=float(r["z"] or 0.0), side=r["side"], hp=int(r["health"]),
            armor=int(r["armor"] or 0), yaw=float(r["yaw"]) if r["yaw"] is not None else None,
            label=names[r["steamid"]], has_bomb=bool(r["has_bomb"]),
        )
        for r in snap.iter_rows(named=True)
    ]
    smokes = m.data["smokes"].filter((pl.col("start_tick") <= tick) & (pl.col("end_tick") >= tick))
    fires = m.data["fires"].filter((pl.col("start_tick") <= tick) & (pl.col("end_tick") >= tick))
    # Grenade rows exist per tick; take those within one snapshot step of the frame.
    flying = m.data["grenades"].filter((pl.col("tick") > tick - m.snap_step) & (pl.col("tick") <= tick))
    flying = flying.sort("tick").group_by("entity_id", maintain_order=True).last()
    planted = plant is not None and plant_tick is not None and tick >= plant_tick
    return {
        "players": players,
        "bomb": plant if planted else None,
        "bomb_planted": planted,
        "smokes": smokes.select("x", "y", "z").rows(),
        "fires": fires.select("x", "y", "z").rows(),
        "grenades": flying.select("x", "y", "z", "type").iter_rows(named=True),
    }


def _plant(m: Match, info: dict) -> tuple[tuple[float, float, float] | None, int | None]:
    plants = m.data["bomb"].filter(
        (pl.col("event") == "finish_plant") & (pl.col("tick") >= info["start_tick"]) & (pl.col("tick") <= info["end_tick"])
    )
    if plants.is_empty():
        return None, None
    r = plants.row(0, named=True)
    return (float(r["x"]), float(r["y"]), float(r["z"])), int(r["tick"])


def round_frame(directory: str | Path, path: str | Path, *, round_num: int, sec: float = 30.0) -> Path:
    """One game-state frame, ``sec`` seconds after the round's freeze time ends."""
    m = load_match(directory, extra_tables=("smokes", "fires", "grenades"))
    ticks, info = _round_ticks(m, round_num, 1.0)
    target = info["freeze_end_tick"] + sec * m.tick_rate
    tick = min(ticks, key=lambda t: abs(t - target))
    plant, plant_tick = _plant(m, info)
    fig, ax = plot.frame(m.map_name, **_frame_args(m, tick, plant, plant_tick))
    ax.text(8, 14, f"round {round_num}, {(tick - info['freeze_end_tick']) / m.tick_rate:.0f}s", color="white", fontsize=7, va="top", zorder=10)
    return _save(fig, path)


def round_gif(directory: str | Path, path: str | Path, *, round_num: int, step_sec: float = 0.5, fps: int = 4) -> Path:
    """Animated 2D replay of one round."""
    m = load_match(directory, extra_tables=("smokes", "fires", "grenades"))
    ticks, info = _round_ticks(m, round_num, step_sec)
    plant, plant_tick = _plant(m, info)
    frames = [_frame_args(m, t, plant, plant_tick) for t in ticks]
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    plot.gif(m.map_name, frames, str(path), fps=fps)
    return path


def _save(fig, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=200, facecolor="black")
    plt.close(fig)
    return path
