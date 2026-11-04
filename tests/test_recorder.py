import json
import subprocess

import pytest

from cs2lens.app import recorder as rec
from cs2lens.app.cs2 import CS2Bridge, NoConsole
from tests.test_lineups import _fake_cs2, _wait

ffmpeg = rec.find_ffmpeg()
pytestmark = pytest.mark.skipif(ffmpeg is None, reason="ffmpeg is not installed")


def test_record_session(tmp_path, monkeypatch):
    """The session seeks, watches the player, records while the demo plays and keeps a trimmed MP4."""
    real = rec.capture_command

    def fake_capture(ffmpeg, encoder, capture, fps, out):  # a live test pattern instead of the screen
        cmd = real(ffmpeg, encoder, capture, fps, out)
        i, vf = cmd.index("-i"), cmd.index("-vf")
        pix = cmd[vf + 1].split(",")[-1]
        return [*cmd[: cmd.index("-f")], "-re", "-f", "lavfi", "-i", f"testsrc2=s=320x240:r={fps}", "-vf", pix, *cmd[vf + 2 :]]

    monkeypatch.setattr(rec, "capture_command", fake_capture)
    monkeypatch.setattr(rec, "SEEK_WAIT", 0.1)
    monkeypatch.setattr(rec, "SPEC_WAIT", 0.1)
    monkeypatch.setattr(rec, "user_cvars", lambda: {})
    srv, port, received = _fake_cs2()
    settings = {"netcon_port": port}
    r = rec.Recorder(CS2Bridge(settings.get, settings.__setitem__))
    clip = rec.Clip(round=3, start=10, end=11.5, tick=640, player="dr1amwtf", title="dr1amwtf 4K", kind="4k", steamid="1")
    assert r.start("m", tmp_path, "m", [clip], "screen", 30, True) == {"steam_url": None}
    _wait(lambda: r.state["status"] not in ("waiting", "running"), 60)
    srv.close()
    assert r.state["status"] == "done", r.state["error"]
    hide, restore = rec.overlay_commands({"spec_show_xray": "0"})
    assert 'spec_show_xray 0' in restore and "cl_draw_only_deathnotices 0" in restore  # the player's own value, else the default
    assert received[0] == "playdemo m"
    assert received[1:3 + len(hide)] == ["demo_pause", "demoui", *hide]
    n = 3 + len(hide)
    assert received[n:n + 7] == ["demo_timescale 1", "demo_gototick 640", "demo_pause", "spec_mode 1", 'spec_player "dr1amwtf"', "demo_resume", "demo_pause"]
    assert received[n + 7:n + 10] == ["demo_pause", "demo_timescale 1", "demoui"]
    assert len(received) == n + 10 + len(hide)

    [name] = r.state["files"]
    assert name == "R3_dr1amwtf_4K.mp4" and not list(tmp_path.glob("_raw_*"))
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(tmp_path / name)], capture_output=True, text=True).stderr
    h, m, s = probe.split("Duration: ")[1].split(",")[0].split(":")
    assert 1.0 <= float(s) <= 2.3  # the 1.5 s clip, give or take a keyframe
    index = json.loads((tmp_path / "recordings.json").read_text(encoding="utf-8"))
    assert index[0]["file"] == name and index[0]["kind"] == "4k"


def test_no_console_fails_at_once(tmp_path):
    """Without a console there is nothing to wait for: the session does not start."""
    srv, port, _ = _fake_cs2()
    srv.close()
    settings = {"netcon_port": port}
    r = rec.Recorder(CS2Bridge(settings.get, settings.__setitem__))
    clip = rec.Clip(round=1, start=0, end=5, tick=1, player=None, title="x", kind="kills")
    with pytest.raises(NoConsole):
        r.start("m", tmp_path, "d", [clip], "screen", 30, False)
    assert not r.running()


def test_cancel(tmp_path, monkeypatch):
    monkeypatch.setattr(rec, "SEEK_WAIT", 5)
    srv, port, received = _fake_cs2()
    settings = {"netcon_port": port}
    r = rec.Recorder(CS2Bridge(settings.get, settings.__setitem__))
    clip = rec.Clip(round=1, start=0, end=5, tick=1, player=None, title="x", kind="kills")
    r.start("m", tmp_path, "d", [clip, clip], "screen", 30, False)
    _wait(lambda: "demo_pause" in received)
    r.cancel()
    _wait(lambda: r.state["status"] == "cancelled")
    srv.close()
    assert r.state["status"] == "cancelled" and r.state["files"] == []
    with pytest.raises(RuntimeError):  # one session at a time is enforced only while running
        r.state["status"] = "running"
        r.start("m", tmp_path, "d", [clip], "screen", 30, False)
