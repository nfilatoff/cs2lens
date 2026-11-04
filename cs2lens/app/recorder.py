"""Automatic clip recording: CS2 plays the demo, ffmpeg records the screen.

For every clip the open game (driven as described in ``cs2.py``) seeks the demo a moment
before the clip, switches to the player's eyes and stays paused; ffmpeg starts capturing
(the monitor through Desktop Duplication, or the CS2 window through GDI); once frames
arrive the demo resumes, plays the clip at normal speed and pauses again. The few paused
frames before the resume are cut off by a stream copy, so encoding happens only once, on
the GPU when there is a hardware H.264 encoder. Clips go to ``<extract>/recordings``.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from cs2lens.app import hlae
from cs2lens.app.cs2 import INGAME, LOAD_WAIT, NO_CONSOLE, CS2Bridge, NoConsole, game_running, user_cvars

PREROLL = 1.0  # seconds before the clip window that are played (and cut) so the view settles
SEEK_WAIT = 10.0  # seconds for a demo seek (measured: 5 for 20 minutes of a demo)
SPEC_WAIT = 1.0
BLIND_LOAD_WAIT = 20.0  # seconds for a demo to load when the game can't confirm it (measured: under 10)
SEEK_DONE = re.compile(r"Demo Skipping finished")
# What is on the screen besides the game, with the value the game has by default. Set to the hide
# value for a recording, then back to the player's own value (see overlay_commands).
OVERLAYS = {  # name: (hide, default)
    "cl_draw_only_deathnotices": ("1", "0"),
    "spec_show_xray": ("0", "1"),
    "r_show_build_info": ("0", "1"),
    "cl_trueview_show_status": ("0", "2"),
    "cl_hud_telemetry_frametime_show": ("0", "2"),
    "cl_hud_telemetry_net_misdelivery_show": ("0", "2"),
    "cl_hud_telemetry_ping_show": ("0", "2"),
}
FRAME_WAIT = 8.0  # seconds to wait for ffmpeg's first frame
INDEX = "recordings.json"
ENCODERS = ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"]  # tried in this order
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
QUALITY = {
    "h264_nvenc": ["-preset", "p4", "-rc", "vbr", "-cq", "21", "-b:v", "0"],
    "h264_amf": ["-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"],
    "h264_qsv": ["-global_quality", "22"],
    "libx264": ["-preset", "veryfast", "-crf", "20"],
}


def find_ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:  # optional: pip install imageio-ffmpeg ships a binary
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return None


_encoder_cache: dict[str, str | None] = {}


def pick_encoder(ffmpeg: str) -> str | None:
    """The first H.264 encoder that really works here (a hardware one is listed only if its driver is present)."""
    if ffmpeg not in _encoder_cache:
        found = None
        for enc in ENCODERS:
            r = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.2",
                 "-frames:v", "1", "-c:v", enc, "-pix_fmt", "nv12" if enc != "libx264" else "yuv420p", "-f", "null", "-"],
                capture_output=True, creationflags=NO_WINDOW, timeout=30,
            )
            if r.returncode == 0:
                found = enc
                break
        _encoder_cache[ffmpeg] = found  # only once known: status requests come in while this runs
    return _encoder_cache[ffmpeg]


def capture_command(ffmpeg: str, encoder: str, capture: str, fps: int, out: Path) -> list[str]:
    """ffmpeg capturing the screen (``capture="screen"``) or the CS2 window (``"window"``) into ``out``."""
    if capture == "window":
        src = ["-f", "gdigrab", "-framerate", str(fps), "-draw_mouse", "0", "-i", "title=Counter-Strike 2"]
        vf = []
    else:  # Desktop Duplication: also works for exclusive fullscreen; frames live on the GPU until downloaded
        src = ["-f", "lavfi", "-i", f"ddagrab=output_idx=0:framerate={fps}:draw_mouse=0"]
        vf = ["hwdownload", "format=bgra"]
    vf.append("format=yuv420p" if encoder == "libx264" else "format=nv12")
    quality = QUALITY[encoder]
    return [
        ffmpeg, "-hide_banner", "-y", "-stats_period", "0.2", *src, "-vf", ",".join(vf),
        "-c:v", encoder, *quality, "-g", str(max(1, fps // 4)), "-an", str(out),
    ]


@dataclass
class Clip:
    round: int
    start: float  # seconds after the freeze end
    end: float
    tick: int  # demo tick of start - PREROLL
    player: str | None  # name for spec_player
    title: str
    kind: str
    steamid: str | None = None
    rate: float = 64.0  # ticks per second

    @property
    def start_tick(self) -> int:
        return self.tick + round(PREROLL * self.rate)

    @property
    def end_tick(self) -> int:
        return self.start_tick + round((self.end - self.start) * self.rate)


def safe_name(text: str) -> str:
    return re.sub(r"[^\w.+-]+", "_", text, flags=re.UNICODE).strip("_")[:90] or "clip"


def load_index(folder: Path) -> list[dict]:
    p = folder / INDEX
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    except ValueError:
        return []


def save_index(folder: Path, items: list[dict]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / (INDEX + ".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(folder / INDEX)


class Cancelled(Exception):
    pass


def overlay_commands(saved: dict[str, str]) -> tuple[list[str], list[str]]:
    """Commands that clear the screen for a recording, and those that put the player's settings back."""
    hide = [f"{name} {value}" for name, (value, _) in OVERLAYS.items()]
    restore = [f"{name} {saved.get(name, default)}" for name, (_, default) in OVERLAYS.items()]
    return hide, restore


class Recorder:
    """One recording session at a time; its state is polled by the app."""

    def __init__(self, bridge: CS2Bridge) -> None:
        self.bridge = bridge
        self.state: dict = {"status": "idle"}
        self._cancel = threading.Event()
        self._lock = threading.Lock()

    def running(self) -> bool:
        return self.state.get("status") == "running"

    def start(self, match_id: str, folder: Path, playdemo: str, clips: list[Clip], capture: str, fps: int, clean: bool) -> dict:
        ffmpeg = find_ffmpeg()
        if ffmpeg is None:
            raise RuntimeError("ffmpeg not found: install it (winget install Gyan.FFmpeg) or pip install imageio-ffmpeg")
        encoder = pick_encoder(ffmpeg)
        if encoder is None:
            raise RuntimeError("no working H.264 encoder in this ffmpeg")
        with self._lock:
            if self.running():
                raise RuntimeError("a recording is already running")
            if not self.bridge.connected():  # nothing to drive: fail now instead of waiting for a port that won't open
                raise NoConsole(NO_CONSOLE)
            self._cancel.clear()
            self.state = {
                "status": "running", "match_id": match_id, "i": 0, "n": len(clips),
                "phase": "connect", "encoder": encoder, "files": [], "error": None, "started": time.time(),
            }
        args = (ffmpeg, encoder, match_id, folder, playdemo, clips, capture, fps, clean)
        threading.Thread(target=self._run, args=args, daemon=True, name="cs2lens-recorder").start()
        return {"steam_url": None}

    def cancel(self) -> None:
        self._cancel.set()

    def start_hlae(self, match_id: str, folder: Path, playdemo: str, game_dir: Path, hlae_exe: Path, clips: list[Clip], fps: int, clean: bool, width: int = 1920, height: int = 1080) -> dict:
        """Record through HLAE: starts the game itself and closes it when the clips are done."""
        ffmpeg = find_ffmpeg()
        if ffmpeg is None:
            raise RuntimeError("ffmpeg not found: install it (winget install Gyan.FFmpeg) or pip install imageio-ffmpeg")
        encoder = pick_encoder(ffmpeg)
        if encoder is None:
            raise RuntimeError("no working H.264 encoder in this ffmpeg")
        with self._lock:
            if self.running():
                raise RuntimeError("a recording is already running")
            self._cancel.clear()
            self.state = {
                "status": "running", "match_id": match_id, "i": 0, "n": len(clips), "phase": "launch",
                "encoder": encoder, "files": [], "error": None, "started": time.time(),
            }
        args = (ffmpeg, encoder, folder, playdemo, game_dir, hlae_exe, clips, fps, clean, width, height)
        threading.Thread(target=self._run_hlae, args=args, daemon=True, name="cs2lens-hlae").start()
        return {"steam_url": None}

    def _run_hlae(self, ffmpeg, encoder, folder: Path, playdemo, game_dir, hlae_exe, clips: list[Clip], fps, clean, width, height) -> None:
        folder = folder.resolve()
        work = folder / "_hlae"  # absolute: the game resolves a relative path against its own folder
        try:
            with self.bridge._io:
                self.bridge.claim()
                self.bridge.loaded = None
                hlae.configure_ffmpeg(hlae_exe, ffmpeg)
                _, restore = overlay_commands(user_cvars())
                hide = overlay_commands({})[0] if clean else []
                # HLAE pipes yuv420p into any encoder; its quality options are shared with the screen recorder
                encoder_args = ["-c:v", encoder, *QUALITY[encoder], "-pix_fmt", "yuv420p"]
                done = 0
                for batch in hlae.session_batches(clips):
                    shutil.rmtree(work, ignore_errors=True)
                    work.mkdir(parents=True)
                    self._phase("launch")
                    cfgs = hlae.session_cfgs(batch, work, encoder_args, fps, hide, restore if clean else [])

                    def on_log(text: str, base: int = done) -> None:
                        # the game logs "execing <cfg>" for every scheduled step (an echo in them is not logged)
                        started = re.findall(rf"execing {hlae.CFG_PREFIX}_(\d+)_rec", text)
                        if started:
                            self.state.update(i=base + int(started[-1]) + 1, phase="record")
                        elif f"execing {hlae.CFG_PREFIX}_start" in text:
                            self.state.update(i=base + 1, phase="seek")
                        elif self.state.get("phase") == "launch" and text:
                            self.state.update(phase="loading")

                    hlae.run_session(hlae_exe, game_dir, playdemo, batch, cfgs, width, height, game_running, on_log, self._cancel.is_set)
                    if self._cancel.is_set():
                        raise Cancelled
                    self._phase("finish")
                    for k, clip in enumerate(batch):
                        out = self._new_path(folder, clip)
                        if not hlae.mux_take(ffmpeg, work / f"clip{k}", out):
                            raise RuntimeError("cs2_hlae_no_video")
                        self.state["files"].append(self._index(folder, clip, out))
                    done += len(batch)
            self.state.update(status="done", phase="done", finished=time.time())
        except Cancelled:
            self.state.update(status="cancelled", phase="cancelled", finished=time.time())
        except (OSError, RuntimeError, subprocess.SubprocessError) as e:
            self.state.update(status="error", error=str(e), finished=time.time())
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @staticmethod
    def _new_path(folder: Path, clip: Clip) -> Path:
        name = safe_name(f"R{clip.round}_{clip.title}")
        out = folder / f"{name}.mp4"
        for k in range(2, 1000):
            if not out.exists():
                break
            out = folder / f"{name}_{k}.mp4"
        return out

    @staticmethod
    def _index(folder: Path, clip: Clip, out: Path) -> str:
        items = load_index(folder)
        items.append({
            "file": out.name, "title": clip.title, "kind": clip.kind, "round": clip.round, "steamid": clip.steamid,
            "seconds": round(clip.end - clip.start, 1), "size": out.stat().st_size, "created": int(time.time()),
        })
        save_index(folder, items)
        return out.name

    # ---- the session ----
    def _phase(self, phase: str, **kw) -> None:
        self.state.update(phase=phase, **kw)
        if self._cancel.is_set():
            raise Cancelled

    def _sleep(self, sec: float) -> None:
        if self._cancel.wait(sec):
            raise Cancelled

    def _run(self, ffmpeg, encoder, match_id, folder: Path, playdemo, clips: list[Clip], capture, fps, clean) -> None:
        con = None
        try:
            with self.bridge._io:
                self.bridge.claim()  # cancels a pending POV pause
                con = self.bridge.open_console()
                # always load: a fresh demo has a known state (the demo panel open, whatever came before)
                load = f"playdemo {playdemo}"
                self._phase("loading")
                con.load(load)
                if con.has_log:
                    con.wait_for(INGAME, LOAD_WAIT)
                else:
                    self._sleep(BLIND_LOAD_WAIT)
                self._sleep(3)
                self.bridge.loaded = load
                hide, restore = overlay_commands(user_cvars())
                con.send("demo_pause", "demoui", *(hide if clean else []))
                try:
                    for i, clip in enumerate(clips):
                        self.state["i"] = i + 1
                        self.state["files"].append(self._record(con, ffmpeg, encoder, folder, clip, capture, fps))
                finally:
                    con.send("demo_pause", "demo_timescale 1", "demoui", *(restore if clean else []))
            self.state.update(status="done", phase="done", finished=time.time())
        except Cancelled:
            self.state.update(status="cancelled", phase="cancelled", finished=time.time())
        except (OSError, RuntimeError, subprocess.SubprocessError) as e:
            self.state.update(status="error", error=str(e), finished=time.time())
        finally:
            if con is not None:
                con.close()

    def _record(self, con, ffmpeg, encoder, folder: Path, clip: Clip, capture, fps) -> str:
        folder.mkdir(parents=True, exist_ok=True)
        self._phase("seek")
        con.send("demo_timescale 1", f"demo_gototick {clip.tick}", "demo_pause")
        if con.has_log:
            con.wait_for(SEEK_DONE, SEEK_WAIT)
        else:
            self._sleep(SEEK_WAIT)
        if clip.player:
            con.send("spec_mode 1", f'spec_player "{clip.player}"')  # 1: from the player's eyes
            self._sleep(SPEC_WAIT)

        self._phase("record")
        raw = folder / f"_raw_{int(time.time() * 1000)}.mkv"
        proc = subprocess.Popen(
            capture_command(ffmpeg, encoder, capture, fps, raw), stdin=subprocess.PIPE, stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL, creationflags=NO_WINDOW,
        )
        first = threading.Event()
        started: list[float] = []  # when the first frame was captured
        log: list[str] = []

        def watch():  # ffmpeg reports progress as "frame=  N" on stderr
            buf = b""
            while chunk := proc.stderr.read1(4096):
                buf = (buf + chunk)[-4096:]
                text = buf.decode("utf-8", "ignore")
                log.append(text)
                m = re.search(r"frame=\s*([1-9]\d*)", text)
                if m and not first.is_set():  # ffmpeg reports late: its frame count tells when it really began
                    started.append(time.monotonic() - int(m.group(1)) / fps)
                    first.set()

        threading.Thread(target=watch, daemon=True).start()
        try:
            if not first.wait(FRAME_WAIT):
                raise RuntimeError("ffmpeg captured no frames: " + (log[-1].strip()[-300:] if log else "no output"))
            t_first = started[0]
            self._sleep(0.3)
            t_send = time.monotonic()
            con.send("demo_resume")  # returns once the game confirmed: it resumed somewhere in between
            offset = (t_send + time.monotonic()) / 2 - t_first
            self._sleep(clip.end - clip.start + PREROLL)
            con.send("demo_pause")
        finally:
            try:
                proc.stdin.write(b"q")
                proc.stdin.flush()
                proc.stdin.close()
            except OSError:
                pass
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()
            if self._cancel.is_set():
                raw.unlink(missing_ok=True)
        if proc.returncode not in (0, None) and not raw.exists():
            raise RuntimeError("ffmpeg failed: " + (log[-1].strip()[-300:] if log else ""))

        # keep just the window: cut the paused frames and the preroll before it and the stop lag after it;
        # keyframes every 1/4 s keep a stream-copy cut close
        self._phase("finish")
        out = self._new_path(folder, clip)
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{offset + PREROLL:.2f}", "-i", str(raw),
             "-t", f"{clip.end - clip.start:.2f}", "-c", "copy", "-movflags", "+faststart", str(out)],
            check=True, creationflags=NO_WINDOW, timeout=120,
        )
        raw.unlink(missing_ok=True)
        return self._index(folder, clip, out)
