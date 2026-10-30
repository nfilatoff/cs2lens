"""Visualizations drawn over the map radar (via ``awpy.plot``).

Radar images are downloaded by awpy on first use into ``~/.awpy``.
Multi-level maps (Nuke, ...) get two panels, upper and lower, and every point is drawn
on the panel of its altitude.
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
    fig, axes = plot.heatmap_levels(m.map_name, points, method="kde")
    ax = axes[0]
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
    fig, panels = _level_axes(m.map_name)
    for ax, lower in panels:
        for kind, color in UTIL_COLORS.items():
            pts = util.filter(pl.col("type") == kind)
            if pts.is_empty():
                continue
            xs, ys = _panel_points(m.map_name, pts, lower)
            ax.scatter(xs, ys, s=22, c=color, edgecolors="black", linewidths=0.4, alpha=0.85, label=f"{kind} ({pts.height})", zorder=3)
        if lower is False:
            ax.legend(loc="lower left", fontsize=6, framealpha=0.6)
    title = "grenade landings" + (f" - {team}" if team else "") + (f" ({side})" if side else "")
    panels[0][0].text(8, 40 if len(panels) > 1 else 14, title, color="white", fontsize=7, va="top", zorder=10)
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
        "grenades": flying.select("x", "y", "z", "type").rows(named=True),
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
    fig, axes = _frame_figure(m.map_name, dpi=300)
    _draw_frame(m.map_name, axes, _frame_args(m, tick, plant, plant_tick))
    axes[0].text(8, 40 if len(axes) > 1 else 14, f"round {round_num}, {(tick - info['freeze_end_tick']) / m.tick_rate:.0f}s", color="white", fontsize=7, va="top", zorder=10)
    return _save(fig, path)


def _frame_figure(map_name: str, dpi: int):
    n = 2 if plot.has_lower_level(map_name) else 1
    fig, axes = plt.subplots(1, n, figsize=(n * plot.RADAR_SIZE / 300, plot.RADAR_SIZE / 300), dpi=dpi, squeeze=False)
    fig.patch.set_facecolor("black")
    return fig, list(axes[0])


def _draw_frame(map_name: str, axes: list, args: dict) -> None:
    """Draw one frame on each level panel; things on the other level are faded."""
    for ax, lower in zip(axes, (False, True)):
        ax.clear()
        plot.frame(map_name, **args, lower=lower, ax=ax, off_level_alpha=0.15)
        if len(axes) > 1:
            ax.text(1016, 14, "lower" if lower else "upper", color="white", fontsize=6, va="top", ha="right", zorder=10)
    axes[0].figure.tight_layout(pad=0.05)


def round_gif(directory: str | Path, path: str | Path, *, round_num: int, step_sec: float = 0.5, fps: int = 4) -> Path:
    """Animated 2D replay of one round."""
    m = load_match(directory, extra_tables=("smokes", "fires", "grenades"))
    ticks, info = _round_ticks(m, round_num, step_sec)
    plant, plant_tick = _plant(m, info)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    from matplotlib.animation import PillowWriter

    fig, axes = _frame_figure(m.map_name, dpi=150)
    writer = PillowWriter(fps=fps)
    try:
        with writer.saving(fig, str(path), dpi=150):
            for t in ticks:
                _draw_frame(m.map_name, axes, _frame_args(m, t, plant, plant_tick))
                writer.grab_frame(facecolor="black")
    finally:
        plt.close(fig)
    return path


def _level_axes(map_name: str):
    """(fig, [(ax, lower), ...]): one radar panel per level, upper first."""
    if plot.has_lower_level(map_name):
        fig, axes = plt.subplots(1, 2, figsize=(2 * plot.RADAR_SIZE / 300, plot.RADAR_SIZE / 300), dpi=300)
        fig.patch.set_facecolor("black")
        for ax, lower in zip(axes, (False, True)):
            plot.radar(map_name, lower=lower, ax=ax)
            ax.text(8, 14, "lower" if lower else "upper", color="white", fontsize=6, va="top", ha="left", zorder=10)
        fig.tight_layout(pad=0.05)
        return fig, list(zip(axes, (False, True)))
    fig, ax = plot.radar(map_name)
    return fig, [(ax, False)]


def _panel_points(map_name: str, df: pl.DataFrame, lower: bool, x: str = "x", y: str = "y", z: str = "z") -> tuple[list, list]:
    """Pixel coordinates of the rows of ``df`` that belong on the given level."""
    xs, ys = [], []
    for px_, py_, pz in df.select(x, y, z).rows():
        if plot.is_lower_level(map_name, float(pz or 0.0)) != lower:
            continue
        px, py = plot.world_to_pixel(map_name, (px_, py_))
        xs.append(px)
        ys.append(py)
    return xs, ys


GROUP_COLORS = {
    "A": "#ff6b6b", "B": "#4dabf7", "A_approach": "#ffa94d", "B_approach": "#74c0fc",
    "mid": "#ffd43b", "t_spawn": "#e599f7", "ct_spawn": "#63e6be", None: "#adb5bd",
}


def zones_map(map_name: str, path: str | Path, *, plants: pl.DataFrame | None = None) -> Path:
    """Draw a map config (bomb sites, callout zones coloured by group) over the radar.

    ``plants`` (columns ``x``, ``y``, ``z``, ``bombsite``) are drawn on top to check the sites.
    """
    from matplotlib.patches import Polygon as MplPolygon

    from cs2lens.maps import load_map_config

    cfg = load_map_config(map_name)
    if cfg is None:
        raise ValueError(f"no map config for {map_name}")
    fig, panels = _level_axes(map_name)
    for ax, lower in panels:
        level = "lower" if lower else "default"
        for z in cfg.zones:
            if z.level != level:
                continue
            px = [plot.world_to_pixel(map_name, p) for p in z.polygon]
            color = GROUP_COLORS.get(z.group, GROUP_COLORS[None])
            ax.add_patch(MplPolygon(px, closed=True, facecolor=color, alpha=0.25, edgecolor=color, linewidth=0.4, zorder=3))
        labelled = set()
        for z in sorted(cfg.zones, key=lambda a: -a.area):
            if z.level != level or z.name in labelled:
                continue
            labelled.add(z.name)
            cx, cy = plot.world_to_pixel(map_name, z.polygon.mean(axis=0))
            ax.text(cx, cy, z.name, color="white", fontsize=2.6, ha="center", va="center", zorder=6,
                    bbox={"boxstyle": "round,pad=0.15", "fc": "black", "ec": "none", "alpha": 0.55})
        for s in cfg.sites:
            if s.level != level:
                continue
            px = [plot.world_to_pixel(map_name, p) for p in s.polygon]
            ax.add_patch(MplPolygon(px, closed=True, fill=False, edgecolor="#00ff66", linewidth=0.9, linestyle="--", zorder=5))
            cx, cy = plot.world_to_pixel(map_name, s.polygon.mean(axis=0))
            ax.text(cx, cy + 14, f"site {s.name}", color="#00ff66", fontsize=4, ha="center", zorder=7, fontweight="bold")
        if plants is not None and not plants.is_empty():
            xs, ys = _panel_points(map_name, plants, lower)
            ax.scatter(xs, ys, s=5, c="#ff2d2d", marker="x", linewidths=0.6, zorder=8, label=f"plants ({len(xs)})")
            ax.legend(loc="lower left", fontsize=4, framealpha=0.6)
    panels[0][0].text(8, 40 if cfg.multilevel else 14, f"{map_name} zones", color="white", fontsize=6, va="top", zorder=10)
    return _save(fig, path)


def _save(fig, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=200, facecolor="black")
    plt.close(fig)
    return path
