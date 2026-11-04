import shutil

import pytest

from cs2lens.highlights import add_custom, delete_custom, highlights, load_custom


def test_auto_highlights(dust2_mini):
    hs = highlights(dust2_mini)
    assert hs == sorted(hs, key=lambda h: (-h["score"], h["round"]))
    best = hs[0]
    assert (best["kind"], best["round"], best["name"], best["kills"]) == ("4k", 3, "dr1amwtf", 4)
    assert best["start"] < best["kill_secs"][0] <= best["kill_secs"][-1] < best["end"]
    clutch = next(h for h in hs if h["kind"] == "clutch")
    assert clutch["clutch"] >= 1 and clutch["won"]
    assert {h["kind"] for h in hs} <= {"ace", "4k", "3k", "clutch", "double", "special"}
    assert len({h["id"] for h in hs}) == len(hs)
    for h in hs:
        assert h["end"] - h["start"] <= 60
        if h["kind"] == "special":
            assert h["tags"]


def test_custom_highlights(dust2_mini, tmp_path):
    d = tmp_path / "m"
    shutil.copytree(dust2_mini, d)
    assert load_custom(d) == []
    h = add_custom(d, 5, 10, 25.5, "  nice   retake ", "76561198848914912")
    assert h["title"] == "nice retake" and h["kind"] == "custom"
    assert load_custom(d) == [h]
    assert add_custom(d, 5, 10, 25.5, "nice retake", "76561198848914912") == h  # the same moment is kept once
    assert load_custom(d) == [h]
    with pytest.raises(ValueError):
        add_custom(d, 99, 0, 5)
    with pytest.raises(ValueError):
        add_custom(d, 5, 10, 5)
    assert delete_custom(d, h["id"])
    assert not delete_custom(d, h["id"])
    assert load_custom(d) == []
