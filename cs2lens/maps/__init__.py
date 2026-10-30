"""Per-map configuration: bomb sites, named zones (callouts) and vertical levels.

Each supported map has a ``<map>.json`` next to this file::

    {
      "map": "de_mirage",
      "source": "...how the polygons were made...",
      "levels": [{"name": "default", "z_min": -1e9, "z_max": 1e9, "radar": "de_mirage"}],
      "sites": [{"site": "A", "level": "default", "polygon": [[x, y], ...]}, ...],
      "zones": [{"name": "Jungle", "group": "A", "level": "default", "polygon": [[x, y], ...]}, ...]
    }

Polygons are in world coordinates (Hammer units). A site or zone may have several
polygons (several entries with the same name). ``group`` says which part of the map a
zone belongs to:

- ``A`` / ``B``: the bomb site and the CT-side positions around it (where CTs hold it
  and where utility "on the site" lands);
- ``A_approach`` / ``B_approach``: T-side routes into the site;
- ``mid``, ``t_spawn``, ``ct_spawn``.

Point lookup goes through a raster (``CELL`` units) built once per map, so it is
vectorised over numpy arrays. Smaller zones are painted last and win where polygons
overlap; points just outside every polygon take the nearest zone up to ``SNAP`` units.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

import numpy as np
from matplotlib.path import Path as MplPath

CONFIG_DIR = Path(__file__).parent
CELL = 16.0
SNAP = 64.0
GROUPS = ("A", "B", "A_approach", "B_approach", "mid", "t_spawn", "ct_spawn")


@dataclass
class Level:
    name: str
    z_min: float
    z_max: float
    radar: str  # awpy radar name; the lower radar of de_nuke is "de_nuke" drawn with lower=True

    @property
    def lower(self) -> bool:
        return self.name == "lower"


@dataclass
class Area:
    name: str
    group: str | None
    level: str
    polygon: np.ndarray  # (n, 2)

    @property
    def area(self) -> float:
        x, y = self.polygon[:, 0], self.polygon[:, 1]
        return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2


@dataclass
class _Raster:
    x0: float
    y0: float
    grid: np.ndarray  # int16, -1 = nothing


@dataclass
class MapConfig:
    map_name: str
    source: str
    levels: list[Level]
    sites: list[Area]  # name is the site letter
    zones: list[Area]
    _rasters: dict = field(default_factory=dict, repr=False)

    @property
    def multilevel(self) -> bool:
        return len(self.levels) > 1

    def level_of(self, z: np.ndarray) -> np.ndarray:
        """Level index for each altitude (0 = upper/default)."""
        z = np.asarray(z, dtype=float)
        out = np.zeros(z.shape, dtype=np.int8)
        for i, lv in enumerate(self.levels):
            out[(z >= lv.z_min) & (z < lv.z_max)] = i
        return out

    def _raster(self, kind: str, level: int) -> _Raster | None:
        key = (kind, level)
        if key not in self._rasters:
            self._rasters[key] = _build_raster(self._areas(kind), self.levels[level].name)
        return self._rasters[key]

    def _areas(self, kind: str) -> list[Area]:
        return self.sites if kind == "sites" else self.zones

    def _lookup(self, kind: str, x, y, z) -> np.ndarray:
        x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
        z = np.zeros_like(x) if z is None else np.nan_to_num(np.asarray(z, dtype=float))
        idx = np.full(x.shape, -1, dtype=np.int32)
        levels = self.level_of(z)
        for lv in np.unique(levels):
            r = self._raster(kind, int(lv))
            if r is None:
                continue
            sel = levels == lv
            ci = np.floor((x[sel] - r.x0) / CELL).astype(np.int64)
            cj = np.floor((y[sel] - r.y0) / CELL).astype(np.int64)
            ok = (ci >= 0) & (cj >= 0) & (ci < r.grid.shape[0]) & (cj < r.grid.shape[1])
            vals = np.full(ci.shape, -1, dtype=np.int32)
            vals[ok] = r.grid[ci[ok], cj[ok]]
            idx[sel] = vals
        return idx

    def zone_of(self, x, y, z=None) -> list[str | None]:
        """Zone name for each point (``None`` outside every zone)."""
        names = [a.name for a in self.zones]
        return [names[i] if i >= 0 else None for i in self._lookup("zones", x, y, z)]

    def group_of(self, x, y, z=None) -> list[str | None]:
        """Zone group (``A``, ``B``, ``mid``, ...) for each point."""
        groups = [a.group for a in self.zones]
        return [groups[i] if i >= 0 else None for i in self._lookup("zones", x, y, z)]

    def site_of(self, x, y, z=None) -> list[str | None]:
        """Bomb site letter for points inside a bomb zone, else ``None``."""
        names = [a.name for a in self.sites]
        return [names[i] if i >= 0 else None for i in self._lookup("sites", x, y, z)]

    def site_centers(self) -> dict[str, tuple[float, float]]:
        """Area-weighted centre of each bomb site."""
        out = {}
        for site in sorted({a.name for a in self.sites}):
            parts = [a for a in self.sites if a.name == site]
            w = np.array([a.area for a in parts])
            c = np.array([a.polygon.mean(axis=0) for a in parts])
            out[site] = tuple(float(v) for v in (c * w[:, None]).sum(axis=0) / w.sum())
        return out


def _build_raster(areas: list[Area], level: str) -> _Raster | None:
    on_level = [(i, a) for i, a in enumerate(areas) if a.level == level]
    if not on_level:
        return None
    pts = np.concatenate([a.polygon for _, a in on_level])
    x0, y0 = pts.min(axis=0) - SNAP - CELL
    x1, y1 = pts.max(axis=0) + SNAP + CELL
    nx, ny = int((x1 - x0) // CELL) + 1, int((y1 - y0) // CELL) + 1
    gx, gy = np.meshgrid(x0 + (np.arange(nx) + 0.5) * CELL, y0 + (np.arange(ny) + 0.5) * CELL, indexing="ij")
    centers = np.column_stack([gx.ravel(), gy.ravel()])
    grid = np.full(nx * ny, -1, dtype=np.int16)
    for i, a in sorted(on_level, key=lambda t: -t[1].area):
        grid[MplPath(a.polygon).contains_points(centers)] = i
    grid = grid.reshape(nx, ny)
    # Snap: grow zones into empty cells, one cell per pass.
    for _ in range(int(SNAP // CELL)):
        empty = grid < 0
        if not empty.any():
            break
        grown = grid.copy()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(grid, (dx, dy), axis=(0, 1))
            fill = empty & (grown < 0) & (shifted >= 0)
            grown[fill] = shifted[fill]
        grid = grown
    return _Raster(float(x0), float(y0), grid)


def _levels(map_name: str, raw: list[dict] | None) -> list[Level]:
    if raw:
        return [Level(r["name"], float(r["z_min"]), float(r["z_max"]), r.get("radar", map_name)) for r in raw]
    return [Level("default", -1e9, 1e9, map_name)]


def _areas(raw: list[dict], name_key: str) -> list[Area]:
    return [Area(r[name_key], r.get("group"), r.get("level", "default"), np.asarray(r["polygon"], dtype=float)) for r in raw]


def available_maps() -> list[str]:
    """Maps with a config file."""
    return sorted(p.stem for p in CONFIG_DIR.glob("*.json"))


@cache
def load_map_config(map_name: str) -> MapConfig | None:
    """The map's config, or ``None`` when the map has no config file."""
    path = CONFIG_DIR / f"{map_name}.json"
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    return MapConfig(
        map_name=map_name,
        source=raw.get("source", ""),
        levels=_levels(map_name, raw.get("levels")),
        sites=_areas(raw.get("sites", []), "site"),
        zones=_areas(raw.get("zones", []), "name"),
    )
