"""Derive a map config (bomb sites and callout zones) from demos of that map.

Every player position is tagged by the game with the nav place it is in
(``m_szLastPlaceName``: "BombsiteA", "Banana", "TopofMid", ...), and a T standing
inside a ``func_bomb_target`` volume has ``m_bInBombZone`` set. Sampling those over a
few demos gives the map's callouts and bomb zones:

1. positions are binned into ``CELL``-unit cells per vertical level and each cell takes
   its most frequent place (bomb-zone cells: most T samples in the zone);
2. small gaps are closed and specks removed;
3. each place's cells are outlined (marching squares) and simplified to polygons.

Bomb zones are labelled A/B by the nearest mean plant position. Zone groups
(A, B, mid, ...) are not in the demo; they are kept from an existing config file
and new zones get ``null`` to be filled in by hand.
"""

from __future__ import annotations

import json
import re
from collections import deque
from pathlib import Path

import contourpy
import numpy as np
import polars as pl
from awpy import Demo, data
from matplotlib.path import Path as MplPath

from cs2lens.maps import CONFIG_DIR

CELL = 32.0
TICK_STEP = 8  # sample every 8th tick
MIN_SAMPLES = 2  # a cell needs this many samples to count
MIN_CELLS = 4  # drop components smaller than this
SIMPLIFY = 0.6 * CELL  # Douglas-Peucker tolerance
ZONE_PAD = 40.0  # bomb-zone hulls are padded by this (samples are player centres)
PLANT_REACH = 400.0  # plants this close to a bomb-zone hull extend it

_PROPS = ["X", "Y", "Z", "m_szLastPlaceName", "m_bInBombZone", "team_num", "health"]
_RENAME = {"BombsiteA": "A Site", "BombsiteB": "B Site"}


def humanize(place: str) -> str:
    """``TopofMid`` -> ``Top of Mid``, ``CTSpawn`` -> ``CT Spawn``, ``BombsiteA`` -> ``A Site``."""
    if place in _RENAME:
        return _RENAME[place]
    s = re.sub(r"([a-z])of([A-Z])", r"\1 of \2", place)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return re.sub(r"([a-z])([A-Z])", r"\1 \2", s)


def map_levels(map_name: str) -> list[dict]:
    """Levels from awpy's ``map_data.json`` vertical sections (one level on flat maps)."""
    sections = data.map_data().get(map_name, {}).get("verticalsections") or {}
    if "lower" not in sections:
        return [{"name": "default", "z_min": -1e9, "z_max": 1e9, "radar": map_name}]
    lower = sections["lower"]
    split = float(lower["AltitudeMax"])
    return [
        {"name": "default", "z_min": split, "z_max": 1e9, "radar": map_name},
        {"name": "lower", "z_min": -1e9, "z_max": split, "radar": f"{map_name}_lower"},
    ]


def sample_demo(path: str | Path) -> tuple[str, pl.DataFrame, pl.DataFrame]:
    """(map name, position samples, plants) for one demo."""
    demo = Demo(path)
    pos = demo.ticks(_PROPS).filter((pl.col("tick") % TICK_STEP == 0) & (pl.col("health") > 0))
    pos = pos.select(
        x="X", y="Y", z="Z", place="m_szLastPlaceName", in_zone="m_bInBombZone", is_t=pl.col("team_num") == 2
    )
    demo.load("bomb")
    plants = demo.bomb.filter(pl.col("event") == "finish_plant").select("bombsite", "x", "y", "z")
    return str(demo.header["map_name"]), pos, plants


def _components(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    for i, j in zip(*np.nonzero(mask)):
        if seen[i, j]:
            continue
        comp, queue = [], deque([(i, j)])
        seen[i, j] = True
        while queue:
            a, b = queue.popleft()
            comp.append((a, b))
            for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                na, nb = a + da, b + db
                if 0 <= na < mask.shape[0] and 0 <= nb < mask.shape[1] and mask[na, nb] and not seen[na, nb]:
                    seen[na, nb] = True
                    queue.append((na, nb))
        comps.append(comp)
    return comps


def _close_gaps(grid: np.ndarray, passes: int = 2) -> np.ndarray:
    """Give an empty cell the label shared by at least 5 of its 8 neighbours."""
    offsets = [(a, b) for a in (-1, 0, 1) for b in (-1, 0, 1) if (a, b) != (0, 0)]
    for _ in range(passes):
        padded = np.pad(grid, 1, constant_values=-1)
        neigh = np.stack([padded[1 + a : padded.shape[0] - 1 + a, 1 + b : padded.shape[1] - 1 + b] for a, b in offsets])
        out = grid.copy()
        for label in np.unique(grid[grid >= 0]):
            fill = (grid < 0) & ((neigh == label).sum(axis=0) >= 5)
            out[fill] = label
        grid = out
    return grid


def _simplify(points: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker on an open polyline."""
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    ab = b - a
    norm = np.hypot(*ab)
    rel = points - a
    d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / norm if norm > 0 else np.hypot(rel[:, 0], rel[:, 1])
    k = int(np.argmax(d))
    if d[k] <= tol:
        return np.array([a, b])
    return np.vstack([_simplify(points[: k + 1], tol)[:-1], _simplify(points[k:], tol)])


def _ring_area(ring: np.ndarray) -> float:
    x, y = ring[:, 0], ring[:, 1]
    return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2


def _outline(mask: np.ndarray, x0: float, y0: float) -> list[np.ndarray]:
    """Outer polygons of the true cells of ``mask`` (holes are dropped), in world units."""
    padded = np.pad(mask.astype(float), 1)
    xs = x0 + (np.arange(padded.shape[0]) - 0.5) * CELL
    ys = y0 + (np.arange(padded.shape[1]) - 0.5) * CELL
    gen = contourpy.contour_generator(xs, ys, padded.T, line_type=contourpy.LineType.Separate)
    rings = [r for r in gen.lines(0.5) if len(r) >= 4 and _ring_area(r) >= MIN_CELLS * CELL * CELL]
    outer = []
    for i, r in enumerate(rings):
        inside_other = any(j != i and _ring_area(o) > _ring_area(r) and MplPath(o).contains_point(r[0]) for j, o in enumerate(rings))
        if not inside_other:
            ring = r[:-1] if np.allclose(r[0], r[-1]) else r
            # Simplify as two halves so the ring's start point is not forced to stay.
            half = len(ring) // 2
            simple = np.vstack([_simplify(ring[: half + 1], SIMPLIFY)[:-1], _simplify(np.vstack([ring[half:], ring[:1]]), SIMPLIFY)[:-1]])
            if len(simple) >= 3:
                outer.append(simple)
    return outer


def _rasterize(pos: pl.DataFrame, x0: float, y0: float, shape: tuple[int, int], label: str) -> np.ndarray:
    """Most frequent ``label`` value per cell (codes into the sorted label list), -1 where too few samples."""
    cells = (
        pos.with_columns(
            ci=((pl.col("x") - x0) // CELL).cast(pl.Int32), cj=((pl.col("y") - y0) // CELL).cast(pl.Int32)
        )
        .group_by("ci", "cj", label)
        .len()
        .sort("len", descending=True)
        .group_by("ci", "cj", maintain_order=True)
        .agg(pl.col(label).first(), n=pl.col("len").sum(), top=pl.col("len").first())
        .filter(pl.col("n") >= MIN_SAMPLES)
    )
    grid = np.full(shape, -1, dtype=np.int32)
    grid[cells["ci"].to_numpy(), cells["cj"].to_numpy()] = cells[label].to_numpy()
    return grid


def _drop_specks(grid: np.ndarray) -> np.ndarray:
    for label in np.unique(grid[grid >= 0]):
        for comp in _components(grid == label):
            if len(comp) < MIN_CELLS:
                a, b = zip(*comp)
                grid[list(a), list(b)] = -1
    return grid


def derive(demos: list[str | Path], map_name: str | None = None) -> dict:
    """Build a map config dict from demos of one map. Groups are kept from an existing config."""
    samples, plants, maps = [], [], set()
    for path in demos:
        name, pos, pl_ = sample_demo(path)
        maps.add(name)
        samples.append(pos)
        plants.append(pl_)
    if map_name is None:
        if len(maps) != 1:
            raise ValueError(f"demos are from several maps: {sorted(maps)}")
        map_name = maps.pop()
    elif maps != {map_name}:
        raise ValueError(f"expected only {map_name} demos, got {sorted(maps)}")
    pos = pl.concat(samples).filter(pl.col("place").is_not_null() & (pl.col("place") != ""))
    plants_df = pl.concat(plants)

    levels = map_levels(map_name)
    old = _existing_groups(map_name)
    x0 = float(pos["x"].min()) - CELL
    y0 = float(pos["y"].min()) - CELL
    shape = (int((pos["x"].max() - x0) // CELL) + 2, int((pos["y"].max() - y0) // CELL) + 2)

    places = sorted(pos["place"].unique().to_list())
    pos = pos.with_columns(code=pl.col("place").replace_strict({p: i for i, p in enumerate(places)}, return_dtype=pl.Int32))

    zones, sites = [], []
    for lv in levels:
        on = pos.filter((pl.col("z") >= lv["z_min"]) & (pl.col("z") < lv["z_max"]))
        if on.is_empty():
            continue
        grid = _drop_specks(_close_gaps(_rasterize(on, x0, y0, shape, "code")))
        for code in np.unique(grid[grid >= 0]):
            name = humanize(places[code])
            for ring in _outline(grid == code, x0, y0):
                zones.append({"name": name, "place": places[code], "group": old.get(name), "level": lv["name"], "polygon": _round(ring)})

        # Bomb zones: the flag is only seen on Ts and sparsely, so each cluster of in-zone
        # samples becomes its convex hull, labelled by the plants inside it (else by place).
        lv_plants = plants_df.filter((pl.col("z") >= lv["z_min"]) & (pl.col("z") < lv["z_max"]))
        for ring in _bomb_zones(on.filter(pl.col("in_zone")), x0, y0, shape):
            site = _site_label(ring, lv_plants, on)
            if not site:
                continue
            # Plants are inside the zone by definition; samples are player centres, so pad the hull.
            near = lv_plants.filter(pl.col("bombsite") == site).select("x", "y").to_numpy()
            near = near[np.min(np.hypot(*(near[:, None, :] - ring[None, :, :]).transpose(2, 0, 1)), axis=1) <= PLANT_REACH] if len(near) else near
            pts = np.vstack([ring, near]) if len(near) else ring
            angles = np.linspace(0, 2 * np.pi, 8, endpoint=False)
            pad = np.column_stack([np.cos(angles), np.sin(angles)]) * ZONE_PAD
            hull = _convex_hull(np.round((pts[:, None, :] + pad[None, :, :]).reshape(-1, 2)))
            sites.append({"site": site, "level": lv["name"], "polygon": _round(hull)})

    return {
        "map": map_name,
        "source": f"derived by `cs2lens maps derive` from {len(demos)} demo(s): nav place names "
        f"(m_szLastPlaceName) and T bomb-zone flags (m_bInBombZone), {CELL:g}-unit cells",
        "levels": levels,
        "sites": sites,
        "zones": zones,
    }


def _convex_hull(points: np.ndarray) -> np.ndarray:
    """Monotone chain; counter-clockwise, no repeated end point."""
    pts = sorted(set(map(tuple, points)))
    if len(pts) < 3:
        return np.array(pts)

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0:
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(reversed(pts))
    return np.array(lower[:-1] + upper[:-1])


def _bomb_zones(inzone: pl.DataFrame, x0: float, y0: float, shape: tuple[int, int]) -> list[np.ndarray]:
    """Convex hulls of clusters of in-bomb-zone samples (cells within 2 cells are one cluster)."""
    if inzone.is_empty():
        return []
    ci = ((inzone["x"].to_numpy() - x0) // CELL).astype(int)
    cj = ((inzone["y"].to_numpy() - y0) // CELL).astype(int)
    mask = np.zeros(shape, dtype=bool)
    mask[ci, cj] = True
    grown = mask.copy()
    for _ in range(2):
        g = grown.copy()
        g[1:, :] |= grown[:-1, :]
        g[:-1, :] |= grown[1:, :]
        g[:, 1:] |= grown[:, :-1]
        g[:, :-1] |= grown[:, 1:]
        grown = g
    hulls = []
    xy = inzone.select("x", "y").to_numpy()
    for comp in _components(grown):
        cells = set(comp)
        sel = np.array([(a, b) in cells for a, b in zip(ci, cj)])
        if sel.sum() >= 10:
            hull = _convex_hull(np.round(xy[sel]))
            if len(hull) >= 3 and _ring_area(hull) >= MIN_CELLS * CELL * CELL:
                hulls.append(hull)
    return hulls


def _site_label(ring: np.ndarray, plants: pl.DataFrame, pos: pl.DataFrame) -> str | None:
    path = MplPath(ring)
    if not plants.is_empty():
        inside = plants.filter(path.contains_points(plants.select("x", "y").to_numpy()))
        if not inside.is_empty():
            return inside["bombsite"].mode().sort()[0]
    inside = pos.filter(path.contains_points(pos.select("x", "y").to_numpy()))
    if inside.is_empty():
        return None
    top = inside["place"].mode().sort()[0]
    return top[-1] if top in ("BombsiteA", "BombsiteB") else None


def _round(ring: np.ndarray) -> list[list[float]]:
    return [[round(float(x)), round(float(y))] for x, y in ring]


def _existing_groups(map_name: str) -> dict[str, str]:
    path = CONFIG_DIR / f"{map_name}.json"
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {z["name"]: z["group"] for z in raw.get("zones", []) if z.get("group")}


def write_config(config: dict, path: str | Path | None = None) -> Path:
    """Save a config as compact JSON (one polygon per line)."""
    path = Path(path) if path else CONFIG_DIR / f"{config['map']}.json"
    lines = ["{"]
    lines.append(f'  "map": {json.dumps(config["map"])},')
    lines.append(f'  "source": {json.dumps(config["source"], ensure_ascii=False)},')
    lines.append('  "levels": [')
    lines.append(",\n".join(f"    {json.dumps(lv)}" for lv in config["levels"]))
    lines.append("  ],")
    for key, last in (("sites", False), ("zones", True)):
        lines.append(f'  "{key}": [')
        lines.append(",\n".join(f"    {json.dumps(a, ensure_ascii=False)}" for a in config[key]))
        lines.append("  ]" + ("" if last else ","))
    lines.append("}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
