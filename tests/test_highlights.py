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


def test_pov_in_cs2(dust2_mini, tmp_path):
    """POV playback seeks the demo to the window, watches the player and pauses after the window."""
    import json

    from cs2lens.app.server import create_app
    from tests.test_lineups import _fake_cs2, _wait

    srv, port, received = _fake_cs2()
    out = tmp_path / "out"
    shutil.copytree(dust2_mini, out / "m")
    demo = tmp_path / "demos" / "m.dem"
    demo.parent.mkdir()
    demo.write_bytes(b"demo")
    manifest = json.loads((out / "m" / "manifest.json").read_text(encoding="utf-8"))
    (out / "m" / "manifest.json").write_text(json.dumps(manifest | {"demo_path": str(demo)}), encoding="utf-8")
    game = tmp_path / "game" / "csgo"
    (game / "cfg").mkdir(parents=True)
    (out / "library.json").write_text(json.dumps({"cs2_dir": str(game), "netcon_port": port}), encoding="utf-8")

    app = create_app(out)
    pov = next(r.endpoint for r in app.routes if getattr(r, "path", "") == "/api/cs2/pov")
    best = highlights(out / "m")[0]
    res = pov(match_id="m", round=best["round"], start=best["start"], end=best["start"] + 0.2, steamid=best["steamid"], speed=1.0)
    assert res["mode"] == "netcon"
    _wait(lambda: "demo_pause" in received, 10)
    srv.close()
    assert (game / "m.dem").exists()
    assert received[0] == "playdemo m"
    assert received[1].startswith("demo_gototick ")
    assert received[2] == f'spec_player "{best["name"]}"'
    assert received[3:] == ["demo_timescale 1", "demo_resume", "demo_pause"]
