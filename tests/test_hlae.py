import hashlib
import io
import subprocess
import zipfile
from pathlib import Path

import pytest

from cs2lens.app import hlae
from cs2lens.app import recorder as rec
from cs2lens.app.cs2 import CS2Bridge
from tests.test_lineups import _wait


def clip(tick, seconds=2.0, player="kanf1s", title="t"):
    return rec.Clip(round=1, start=10, end=10 + seconds, tick=tick, player=player, title=title, kind="kills", rate=64.0)


def test_ticks_of_a_clip():
    c = clip(1000)
    assert (c.start_tick, c.end_tick) == (1064, 1192)  # a second of preroll, then exactly the window


def test_hlae_stays_out_of_the_install_folder(monkeypatch, tmp_path):
    """install.ps1 clones into %LOCALAPPDATA%/cs2lens and can't do that if HLAE is already there."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert not hlae.default_dir().is_relative_to(tmp_path / "cs2lens")


def test_launch_command(tmp_path):
    cmd = hlae.launch_command(tmp_path / "HLAE.exe", tmp_path / "game" / "csgo", "my_demo", 1920, 1080)
    args = cmd[cmd.index("-cmdLine") + 1]
    assert "-insecure" in args and "-condebug" in args and args.endswith("+exec cs2lens_hlae_boot +playdemo my_demo")
    assert cmd[cmd.index("-hookDllPath") + 1].endswith("AfxHookSource2.dll")
    assert cmd[cmd.index("-programPath") + 1].endswith("cs2.exe")


def test_takes_go_to_an_absolute_path(tmp_path, monkeypatch):
    """A relative --out must not send the game's files into the game folder."""
    monkeypatch.chdir(tmp_path)
    seen = {}

    def fake_session(_hlae, _game, _demo, _batch, cfgs, *_rest):
        seen["setup"] = cfgs["cs2lens_hlae_0_setup"][0]

    monkeypatch.setattr(rec.hlae, "run_session", fake_session)
    monkeypatch.setattr(rec.hlae, "configure_ffmpeg", lambda *_: None)
    monkeypatch.setattr(rec, "user_cvars", lambda: {})
    settings = {}
    r = rec.Recorder(CS2Bridge(settings.get, settings.__setitem__))
    r._run_hlae("ffmpeg", "libx264", Path("out/m/recordings"), "d", tmp_path, tmp_path / "H.exe", [clip(1000)], 60, True, 1, 1)
    assert tmp_path.as_posix() in seen["setup"]


def test_overlapping_clips_go_to_another_run():
    a, b, c, d = clip(1000), clip(1100), clip(5000), clip(1200 + 64)
    batches = hlae.session_batches([c, a, b, d])
    assert batches == [[a, d, c], [b]]  # each run only moves forward through the demo
    for batch in batches:
        assert all(x.end_tick < y.tick for x, y in zip(batch, batch[1:]))


def test_session_cfgs(tmp_path):
    a, b = clip(1000), clip(5000, player=None)
    cfgs = hlae.session_cfgs([a, b], tmp_path, ["-c:v", "h264_nvenc"], 60, ["cl_draw_only_deathnotices 1"], ["cl_draw_only_deathnotices 0"])
    boot = cfgs["cs2lens_hlae_boot"]
    assert 'mirv_cmd addAtTick 1064 "exec cs2lens_hlae_0_rec"' in boot
    assert 'mirv_cmd addAtTick 1192 "exec cs2lens_hlae_0_end"' in boot
    assert 'mirv_cmd addAtTick 5192 "exec cs2lens_hlae_1_end"' in boot
    assert 'mirv_cmd addAtTick 5256 "exec cs2lens_hlae_quit"' in boot
    assert "demo_gototick 1000" in cfgs["cs2lens_hlae_start"]
    assert "demo_gototick 5000" in cfgs["cs2lens_hlae_0_end"]
    assert not any("gototick" in line for line in cfgs["cs2lens_hlae_1_end"])
    assert 'spec_player "kanf1s"' in cfgs["cs2lens_hlae_0_setup"]
    assert not any("spec_player" in line for line in cfgs["cs2lens_hlae_1_setup"])
    assert cfgs["cs2lens_hlae_quit"][0] == "cl_draw_only_deathnotices 0" and cfgs["cs2lens_hlae_quit"][-1] == "quit"
    assert "snd_mute_losefocus 1" in cfgs["cs2lens_hlae_quit"]  # taken back before the game closes
    assert any("{QUOTE}{AFX_STREAM_PATH}" in line and "video.mp4" in line for line in boot)


def _zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def _release(data, digest=None):
    return {"tag_name": "v9", "assets": [
        {"name": "HLAE_Setup.exe", "size": 1, "browser_download_url": "x", "digest": "sha256:0"},
        {"name": "hlae_9_0.zip", "size": len(data), "browser_download_url": "u", "digest": f"sha256:{digest or hashlib.sha256(data).hexdigest()}"},
    ]}


GOOD = {"HLAE.exe": b"exe", "x64/AfxHookSource2.dll": b"dll"}


def test_install_checks_the_checksum(tmp_path):
    target = tmp_path / "hlae"
    data = _zip(GOOD)
    fetch = lambda _url, path: path.write_bytes(data)  # noqa: E731
    r = hlae.install(target, lambda _: _release(data), fetch)
    assert r["version"] == "v9" and hlae.find_hlae(target) == target / "HLAE.exe"
    target2 = tmp_path / "other"
    with pytest.raises(ValueError, match="checksum"):
        hlae.install(target2, lambda _: _release(data, digest="00"), fetch)
    assert not target2.exists() and not list(tmp_path.glob("*.part"))


@pytest.mark.parametrize("files", [{"../evil.exe": b"x", **GOOD}, {"readme.txt": b"x"}])
def test_install_refuses_bad_archives(tmp_path, files):
    data = _zip(files)
    with pytest.raises(ValueError):
        hlae.install(tmp_path / "h", lambda _: _release(data), lambda _u, p: p.write_bytes(data))
    assert hlae.find_hlae(tmp_path / "h") is None and not (tmp_path / "evil.exe").exists()


def test_release_without_digest_is_refused():
    with pytest.raises(ValueError, match="digest"):
        hlae.release_asset({"assets": [{"name": "hlae_1.zip", "size": 1}]})


ffmpeg = rec.find_ffmpeg()
needs_ffmpeg = pytest.mark.skipif(ffmpeg is None, reason="ffmpeg is not installed")


def _fake_take(folder):
    take = folder / "take0000"
    take.mkdir(parents=True)
    run = lambda *a: subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *a], check=True)  # noqa: E731
    run("-f", "lavfi", "-i", "testsrc2=s=320x240:r=30", "-t", "1", "-pix_fmt", "yuv420p", str(take / "video.mp4"))
    run("-f", "lavfi", "-i", "sine=f=440", "-t", "1", str(take / "audio.wav"))


@needs_ffmpeg
def test_session_end_to_end(tmp_path, monkeypatch):
    """The whole run with a stand-in for the game: launch, progress, quit, a clip with sound in the gallery."""
    game = tmp_path / "game" / "csgo"
    (game / "cfg").mkdir(parents=True)
    folder = tmp_path / "recordings"
    alive = []

    def fake_popen(cmd, **_kw):
        assert "cs2lens_hlae_boot" in cmd[cmd.index("-cmdLine") + 1]
        assert (game / "cfg" / "cs2lens_hlae_boot.cfg").exists()
        (game / "console.log").write_text("[InputService] execing cs2lens_hlae_start\n[InputService] execing cs2lens_hlae_0_rec\n", encoding="utf-8")
        _fake_take(folder / "_hlae" / "clip0")
        alive.append(True)

    def fake_running():
        if alive:
            alive.pop()
            return True
        return False

    real = hlae.run_session
    monkeypatch.setattr(rec.hlae, "run_session", lambda *a: real(*a, popen=fake_popen))
    monkeypatch.setattr(rec, "game_running", fake_running)
    monkeypatch.setattr(hlae, "BOOT_WAIT", 5)
    monkeypatch.setattr(rec, "user_cvars", lambda: {})
    alive.append(True)  # seen once while booting, then the game quits

    (tmp_path / "ffmpeg").mkdir()
    settings = {}
    r = rec.Recorder(CS2Bridge(settings.get, settings.__setitem__))
    r.start_hlae("m", folder, "d", game, tmp_path / "HLAE.exe", [clip(1000, title="ace")], 60, True)
    _wait(lambda: r.state["status"] != "running", 30)
    assert r.state["status"] == "done", r.state["error"]
    [name] = r.state["files"]
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(folder / name)], capture_output=True, text=True).stderr
    assert "Video: h264" in probe and "Audio: aac" in probe
    assert not (folder / "_hlae").exists() and not list((game / "cfg").glob("cs2lens_hlae_*"))


def test_a_game_without_the_hook_is_reported(tmp_path):
    game = tmp_path / "csgo"
    (game / "cfg").mkdir(parents=True)
    states = [True, False]

    def popen(*_a, **_k):
        (game / "console.log").write_text("Unknown command: mirv_cmd\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="cs2_hlae_no_hook"):
        hlae.run_session(tmp_path / "H.exe", game, "d", [clip(1000)], {"a": ["x"]}, 1, 1, lambda: states.pop(0) if states else False,
                         lambda _t: None, lambda: False, kill=lambda: None, popen=popen)
