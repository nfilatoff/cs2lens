import shutil
import warnings

import polars as pl
import pytest

from cs2lens.tactics import tactics


def test_tactics_with_config(dust2_mini):
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # the config path must not warn
        out = tactics(dust2_mini)
    t = out["rounds_t"]
    planted = t.filter(pl.col("plant_site").is_not_null())
    assert (planted["target_site"] == planted["plant_site"]).all()
    # Setups are counted for every CT round: 5 living CTs at most, split over A/B/M.
    s = out["setups"]
    assert s["setup"].null_count() == 0
    assert ((s["a"] + s["b"] + s["mid"]) <= 5).all()
    assert "entry" in t.columns and t["entry"].null_count() < t.height


def test_tactics_fallback_warns(dust2_mini, tmp_path):
    d = tmp_path / "m"
    shutil.copytree(dust2_mini, d)
    (d / "manifest.json").write_text('{"header": {"map_name": "de_unknown"}, "tick_rate": 64}')
    with pytest.warns(UserWarning, match="plant-centre heuristic"):
        out = tactics(d)
    assert out["setups"].height > 0
