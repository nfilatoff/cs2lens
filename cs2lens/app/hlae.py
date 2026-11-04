"""Recording through HLAE (advancedfx, MIT): frames and sound come from the game itself.

HLAE starts CS2 with its hook. Everything is scheduled inside the game on demo ticks with
``mirv_cmd addAtTick``, so no keys are pressed, the window may stay in the background and
clips begin and end exactly on their ticks: seek, watch the player, ``mirv_streams record
start``, ``record end``, next clip, and finally ``quit``. The app only writes the cfg files,
waits for the game to exit and muxes each take's video and sound into a clip.

The hook is not for normal play: the game runs with ``-insecure`` until it quits.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path

RELEASES = "https://api.github.com/repos/advancedfx/advancedfx/releases/latest"
MAX_ZIP = 200 * 2**20
CFG_PREFIX = "cs2lens_hlae"
START_TICK = 128  # the first scheduled command: the demo is playing by then
BOOT_WAIT = 90.0  # seconds for the game process to appear
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# what recording needs and what is taken back before quitting: name -> (value, default)
SESSION_CVARS = {
    "snd_mute_losefocus": ("0", "1"),  # the sound must not stop when the window is in the background
    "engine_no_focus_sleep": ("0", "20"),
}


def default_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "cs2lens" / "hlae"


def find_hlae(folder: Path | None = None) -> Path | None:
    """HLAE.exe, when it is complete (the hook DLL for CS2 is next to it)."""
    d = folder or default_dir()
    exe = d / "HLAE.exe"
    return exe if exe.is_file() and (d / "x64" / "AfxHookSource2.dll").is_file() else None


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "cs2lens", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _fetch_file(url: str, target: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "cs2lens"})
    with urllib.request.urlopen(req, timeout=60) as r, target.open("wb") as f:
        shutil.copyfileobj(r, f)


def release_asset(release: dict) -> dict:
    """The release's zip with its checksum; nothing without a checksum gets installed."""
    for a in release.get("assets", []):
        if re.fullmatch(r"hlae_[\d_]+\.zip", a["name"]):
            if not str(a.get("digest", "")).startswith("sha256:"):
                raise ValueError(f"{a['name']} has no SHA-256 digest")
            if a["size"] > MAX_ZIP:
                raise ValueError(f"{a['name']} is unexpectedly large")
            return a
    raise ValueError("the release has no HLAE zip")


def install(folder: Path | None = None, fetch_json=_fetch_json, fetch_file=_fetch_file) -> dict:
    """Download the latest HLAE from its official releases, check the SHA-256, unpack into ``folder``."""
    d = folder or default_dir()
    release = fetch_json(RELEASES)
    asset = release_asset(release)
    d.parent.mkdir(parents=True, exist_ok=True)
    tmp = d.parent / f"{asset['name']}.part"
    staged = d.parent / f"{d.name}.new"
    try:
        fetch_file(asset["browser_download_url"], tmp)
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if digest != asset["digest"].split(":", 1)[1]:
            raise ValueError(f"checksum mismatch for {asset['name']}")
        shutil.rmtree(staged, ignore_errors=True)
        staged.mkdir()
        with zipfile.ZipFile(tmp) as z:
            for name in z.namelist():  # nothing may land outside the folder
                if not (staged / name).resolve().is_relative_to(staged.resolve()):
                    raise ValueError(f"unsafe path in the archive: {name}")
            z.extractall(staged)
        if find_hlae(staged) is None:
            raise ValueError("the archive has no HLAE.exe and x64/AfxHookSource2.dll")
        shutil.rmtree(d, ignore_errors=True)
        staged.replace(d)
    finally:
        tmp.unlink(missing_ok=True)
        shutil.rmtree(staged, ignore_errors=True)
    return {"version": release.get("tag_name"), "path": str(d), "sha256": digest}


def steam_running() -> bool:
    try:
        r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq steam.exe", "/NH"], capture_output=True, text=True,
                           errors="ignore", timeout=10, creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return False
    return "steam.exe" in r.stdout.lower()


def close_game() -> None:
    subprocess.run(["taskkill", "/IM", "cs2.exe", "/F"], capture_output=True, timeout=15, creationflags=NO_WINDOW)


def configure_ffmpeg(hlae: Path, ffmpeg: str) -> None:
    """Point HLAE at the ffmpeg the app already uses (its readme's option B)."""
    (hlae.parent / "ffmpeg" / "ffmpeg.ini").write_text(f"[Ffmpeg]\nPath={ffmpeg}\n", encoding="utf-8")


def launch_command(hlae: Path, game_dir: Path, playdemo: str, width: int, height: int) -> list[str]:
    """``game_dir`` is game/csgo. The game writes its console to console.log (-condebug) for progress and errors."""
    game = (
        f"-steam -insecure -novid -condebug -sw -w {width} -h {height} "
        f"+exec {CFG_PREFIX}_boot +playdemo {playdemo}"
    )
    return [
        str(hlae), "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader",
        "-hookDllPath", str(hlae.parent / "x64" / "AfxHookSource2.dll"),
        "-programPath", str(game_dir.parent / "bin" / "win64" / "cs2.exe"),
        "-cmdLine", game,
    ]


def session_batches(clips: list) -> list[list]:
    """Clips of one game run go forward through the demo without overlaps; overlapping ones (two
    players in one moment) wait for another run, because the demo can't be rewound under mirv_cmd."""
    batches: list[list] = []
    for clip in sorted(clips, key=lambda c: c.tick):
        for batch in batches:
            if clip.tick > batch[-1].end_tick:
                batch.append(clip)
                break
        else:
            batches.append([clip])
    return batches


def _p(path: Path) -> str:
    return path.as_posix()  # forward slashes: nothing to escape inside the console's quotes


def session_cfgs(clips: list, work: Path, encoder_args: list[str], fps: int, hide: list[str], restore: list[str]) -> dict[str, list[str]]:
    """The cfg files of one game run: name (without .cfg) -> lines. ``clips`` go forward through the demo."""
    cfgs: dict[str, list[str]] = {}
    boot = [
        "mirv_streams record screen enabled 1",
        f"mirv_streams record fps {fps}",
        "mirv_streams record startMovieWav 1",
        # {AFX_STREAM_PATH} is filled in by HLAE; the console reads \\ as one backslash
        f'mirv_streams settings add ffmpeg {CFG_PREFIX} "{" ".join(encoder_args)} {{QUOTE}}{{AFX_STREAM_PATH}}\\\\video.mp4{{QUOTE}}"',
        f"mirv_streams record screen settings {CFG_PREFIX}",
        f'mirv_cmd addAtTick {START_TICK} "exec {CFG_PREFIX}_start"',
    ]
    start = [
        "sv_cheats 1", "cl_demo_predict 0", "demoui", *hide,
        *(f"{name} {value}" for name, (value, _) in SESSION_CVARS.items()),
        f"demo_gototick {clips[0].tick}",
    ]
    cfgs[f"{CFG_PREFIX}_start"] = start
    for i, c in enumerate(clips):
        cfgs[f"{CFG_PREFIX}_{i}_setup"] = [
            f'mirv_streams record name "{_p(work / f"clip{i}")}"',
            "spec_mode 1",
            *([f'spec_player "{c.player}"'] if c.player else []),
        ]
        cfgs[f"{CFG_PREFIX}_{i}_rec"] = ["mirv_streams record start"]
        following = [f"demo_gototick {clips[i + 1].tick}"] if i + 1 < len(clips) else []
        cfgs[f"{CFG_PREFIX}_{i}_end"] = ["mirv_streams record end", *following]
        settle = c.tick + max(1, (c.start_tick - c.tick) // 4)
        boot += [
            f'mirv_cmd addAtTick {settle} "exec {CFG_PREFIX}_{i}_setup"',
            f'mirv_cmd addAtTick {c.start_tick} "exec {CFG_PREFIX}_{i}_rec"',
            f'mirv_cmd addAtTick {c.end_tick} "exec {CFG_PREFIX}_{i}_end"',
        ]
    last = clips[-1]
    boot.append(f'mirv_cmd addAtTick {last.end_tick + round(last.rate)} "exec {CFG_PREFIX}_quit"')
    cfgs[f"{CFG_PREFIX}_quit"] = [
        *restore,
        *(f"{name} {default}" for name, (_, default) in SESSION_CVARS.items()),
        "quit",
    ]
    cfgs[f"{CFG_PREFIX}_boot"] = boot
    return cfgs


def write_cfgs(game_dir: Path, cfgs: dict[str, list[str]]) -> None:
    for name, lines in cfgs.items():
        (game_dir / "cfg" / f"{name}.cfg").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def remove_cfgs(game_dir: Path) -> None:
    for p in (game_dir / "cfg").glob(f"{CFG_PREFIX}_*.cfg"):
        p.unlink(missing_ok=True)


def session_timeout(clips: list) -> float:
    """Generous: rendering may run slower than the game, but a stuck game must not hang the app."""
    return 180.0 + sum(30 + 6 * (c.end - c.start) for c in clips)


def run_session(
    hlae: Path, game_dir: Path, playdemo: str, clips: list, cfgs: dict[str, list[str]], width: int, height: int,
    running: Callable[[], bool], on_log: Callable[[str], None], cancelled: Callable[[], bool], kill: Callable[[], None] | None = None,
    popen=subprocess.Popen,
) -> str:
    """Start the game, wait for it to quit. Returns the console output; raises RuntimeError with a code."""
    kill = kill or close_game
    write_cfgs(game_dir, cfgs)
    log = game_dir / "console.log"
    log.unlink(missing_ok=True)
    popen(launch_command(hlae, game_dir, playdemo, width, height), creationflags=NO_WINDOW, cwd=str(hlae.parent))
    text = ""

    def read() -> None:
        nonlocal text
        try:
            new = log.read_bytes().decode("utf-8", "ignore")
        except OSError:
            return
        if len(new) != len(text):
            text = new
            on_log(text)

    try:
        end = time.monotonic() + BOOT_WAIT
        while not running():
            if cancelled():
                return text
            if time.monotonic() > end:
                raise RuntimeError("cs2_hlae_no_start")
            time.sleep(0.5)
        end = time.monotonic() + session_timeout(clips)
        while running():
            read()
            if cancelled():
                kill()
                return text
            if time.monotonic() > end:
                kill()
                raise RuntimeError("cs2_hlae_stuck")
            time.sleep(0.5)
        read()
    finally:
        remove_cfgs(game_dir)
    if "Unknown command: mirv" in text or "Unknown command 'mirv" in text:
        raise RuntimeError("cs2_hlae_no_hook")
    return text


def mux_take(ffmpeg: str, take: Path, out: Path) -> bool:
    """The take's video with its sound into ``out``. False when the game left no video."""
    videos = sorted(take.rglob("video.mp4"))
    if not videos or videos[0].stat().st_size == 0:
        return False
    sounds = sorted(take.rglob("audio.wav"))
    sound = ["-i", str(sounds[0]), "-c:a", "aac", "-b:a", "192k", "-shortest"] if sounds else []
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(videos[0]), *sound, "-c:v", "copy", "-movflags", "+faststart", str(out)],
        check=True, creationflags=NO_WINDOW, timeout=300,
    )
    return True
