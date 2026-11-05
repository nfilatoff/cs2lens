import numpy as np
import polars as pl
import pytest

from cs2lens.mapgen import _convex_hull, _simplify, humanize
from cs2lens.maps import GROUPS, Area, Level, MapConfig, available_maps, load_map_config

POOL = ["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"]


def square(x0, y0, x1, y1):
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=float)


@pytest.fixture
def two_level():
    """A 1000x1000 map: upper level split into zones L (x<500) and R, a small zone S inside L,
    and one lower-level zone under R. Site A is upper, site B lower."""
    levels = [Level("default", 0, 1e9, "m"), Level("lower", -1e9, 0, "m_lower")]
    zones = [
        Area("L", "A", "default", square(0, 0, 500, 1000)),
        Area("R", "mid", "default", square(500, 0, 1000, 1000)),
        Area("S", "A", "default", square(100, 100, 200, 200)),
        Area("Under", "B", "lower", square(500, 0, 1000, 1000)),
    ]
    sites = [Area("A", None, "default", square(0, 0, 300, 300)), Area("B", None, "lower", square(600, 600, 900, 900))]
    return MapConfig("m", "test", levels, sites, zones)


def test_point_in_zone(two_level):
    assert two_level.zone_of([250, 750, 150], [500, 500, 150], [10, 10, 10]) == ["L", "R", "S"]


def test_levels_pick_the_zone(two_level):
    assert two_level.zone_of([750, 750], [500, 500], [10, -10]) == ["R", "Under"]
    assert two_level.group_of([750], [500], [-10]) == ["B"]
    assert two_level.site_of([700, 700], [700, 700], [-10, 10]) == ["B", None]


def test_snap_and_outside(two_level):
    # Just outside the map edge snaps to the nearest zone; far away is nothing.
    assert two_level.zone_of([-30, -500], [500, 500], [10, 10]) == ["L", None]


def test_pool_configs_exist_and_are_complete():
    assert set(POOL) <= set(available_maps())
    for name in POOL:
        cfg = load_map_config(name)
        assert {s.name for s in cfg.sites} == {"A", "B"}, name
        assert all(z.group in GROUPS for z in cfg.zones), name
        assert {z.level for z in cfg.zones} <= {lv.name for lv in cfg.levels}, name
    assert load_map_config("de_nuke").multilevel
    assert load_map_config("de_nosuchmap") is None


@pytest.mark.parametrize(
    ("map_name", "expected"),
    [
        ("de_cache", {"Truck": "A", "Long A": "A_approach", "Heaven": "B", "Sun Room": "B_approach", "Sandbags": "mid", "T Yard": "t_spawn", "Bus Stop": "ct_spawn"}),
        ("de_nuke", {"Hell": "A", "Trophy": "A_approach", "Vents": "B", "Tunnels": "B_approach", "Silo": "mid"}),
    ],
)
def test_configs_built_from_demos(map_name, expected):
    cfg = load_map_config(map_name)
    assert cfg.source.startswith("derived")
    assert expected.items() <= {z.name: z.group for z in cfg.zones}.items()


def test_nuke_sites_are_on_different_levels():
    cfg = load_map_config("de_nuke")
    # the same spot of the map: A upstairs, B below it
    assert cfg.site_of([650, 650], [-900, -900], [-400, -760]) == ["A", "B"]


def test_plants_fall_in_their_site(dust2_mini):
    cfg = load_map_config("de_dust2")
    plants = pl.read_parquet(dust2_mini / "bomb.parquet").filter(pl.col("event") == "finish_plant")
    assert cfg.site_of(plants["x"], plants["y"], plants["z"]) == plants["bombsite"].to_list()
    assert cfg.group_of(plants["x"], plants["y"], plants["z"]) == plants["bombsite"].to_list()


def test_humanize():
    assert humanize("TopofMid") == "Top of Mid"
    assert humanize("CTSpawn") == "CT Spawn"
    assert humanize("BombsiteB") == "B Site"
    assert humanize("PalaceInterior") == "Palace Interior"


def test_geometry_helpers():
    hull = _convex_hull(np.array([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]]))
    assert len(hull) == 4
    line = np.array([[0, 0], [1, 0.01], [2, 0], [3, 5]])
    assert len(_simplify(line, 0.1)) == 3
