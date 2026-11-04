import json
import subprocess
from pathlib import Path

import pytest

from cs2lens.app import hlae
from cs2lens.app import recorder as rec
from cs2lens.highlights import highlights, keep_ranges, kill_clips


def test_close_kills_are_not_cut():
    assert keep_ranges(10, 20, [13, 15, 17.5], 3) == [(0.0, 10.0)]


def test_a_long_pause_is_cut_out():
    # kills at 13 and 30: up to a second after the first, from 1.5 s before the second
    assert keep_ranges(10, 32, [13, 30], 3) == [(0.0, 4.0), (18.5, 22.0)]


def test_exactly_the_gap_is_not_a_pause():
    assert len(keep_ranges(0, 20, [3, 6], 3)) == 1
    assert len(keep_ranges(0, 20, [3, 6.1], 3)) == 2


def test_every_cut_removes_something():
    for gap in (1, 2, 2.5, 3, 5):
        ranges = keep_ranges(0, 100, [3, 3 + gap + 0.01, 50], gap)
        assert all(a[1] < b[0] for a, b in zip(ranges, ranges[1:]))


def test_long_wait_before_the_first_kill_is_cut():
    """A clutch's window begins long before its first kill."""
    assert keep_ranges(0, 40, [30, 32], 3) == [(27.0, 40.0)]


def test_off_or_without_kills_keeps_everything():
    assert keep_ranges(5, 15, [7, 14], None) == [(0.0, 10.0)]
    assert keep_ranges(5, 15, [], 3) == [(0.0, 10.0)]


def test_kill_clips_split_by_the_gap(dust2_mini):
    steamid = highlights(dust2_mini)[0]["steamid"]
    wide, narrow = kill_clips(dust2_mini, steamid, merge_sec=5), kill_clips(dust2_mini, steamid, merge_sec=3)
    assert len(narrow) >= len(wide)
    for c in narrow:
        assert all(b - a <= 3 for a, b in zip(c["kill_secs"], c["kill_secs"][1:]))
    for a, b in zip(narrow, narrow[1:]):
        if a["round"] == b["round"]:
            assert a["end"] < b["start"] and a["kill_secs"][-1] <= a["end"] and b["start"] <= b["kill_secs"][0]


def clip(tick, seconds=2.0):
    return rec.Clip(round=1, start=10, end=10 + seconds, tick=tick, player="p", title="t", kind="kills", rate=64.0)


def test_close_neighbours_share_a_game_run_without_seeking(tmp_path):
    a = clip(1000)  # records 1064..1192
    b = clip(1140)  # records from 1204: its preroll begins during a's take
    assert hlae.session_batches([a, b]) == [[a, b]]
    cfgs = hlae.session_cfgs([a, b], tmp_path, ["-c:v", "x"], 60, [], [])
    assert not any("gototick" in line for line in cfgs["cs2lens_hlae_0_end"])
    # its setup waits until the previous take has ended
    assert 'mirv_cmd addAtTick 1193 "exec cs2lens_hlae_1_setup"' in cfgs["cs2lens_hlae_boot"]


ffmpeg = rec.find_ffmpeg()
needs_ffmpeg = pytest.mark.skipif(ffmpeg is None, reason="ffmpeg is not installed")


def _duration(path: Path) -> float:
    r = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    h, m, s = r.split("Duration: ")[1].split(",")[0].split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


@needs_ffmpeg
@pytest.mark.parametrize("sound", [True, False])
def test_cut_video(tmp_path, sound):
    path = tmp_path / "c.mp4"
    extra = ["-f", "lavfi", "-i", "sine=f=440:d=6", "-c:a", "aac"] if sound else []
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=6", *extra,
                    "-pix_fmt", "yuv420p", str(path)], check=True)
    rec.cut_video(ffmpeg, "libx264", path, [(0.0, 1.0), (4.0, 5.5)])
    assert _duration(path) == pytest.approx(2.5, abs=0.15)
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    assert ("Audio:" in probe) == sound
    assert not list(tmp_path.glob("_cut_*"))


@needs_ffmpeg
def test_single_range_leaves_the_file_alone(tmp_path):
    path = tmp_path / "c.mp4"
    path.write_bytes(b"not touched")
    rec.cut_video(ffmpeg, "libx264", path, [(0.0, 5.0)])
    assert path.read_bytes() == b"not touched"


def test_index_gets_the_cut_length(tmp_path):
    c = clip(1000, seconds=30)
    c.kill_secs, c.cut_gap = [13, 35], 3
    out = tmp_path / "x.mp4"
    out.write_bytes(b"v")
    rec.Recorder._index(tmp_path, c, out)
    assert json.loads((tmp_path / "recordings.json").read_text(encoding="utf-8"))[0]["seconds"] == 10.5  # 4 s + 6.5 s of 30
