"""Talking to a local CS2: find the game folder, write practice configs into it, and send
console commands to the running game.

Current CS2 builds ignore ``-netconport``, so commands normally go through a key: once, the
player types ``bind f13 "exec cs2lens_cmd"`` in the console (the game saves binds). To send
commands the app writes them to ``cfg/cs2lens_cmd.cfg`` and presses F13 in the game window.
Binds do not fire in the main menu, so loading a demo types ``exec cs2lens_cmd`` into the
console instead. Input goes wherever the focus is: every key is sent only while the game
window is in front. ``con_logfile`` is not available, so only a game started with
``-condebug`` can confirm commands; otherwise the app uses measured waits. A network console,
if the game opens one, is still preferred: both have ``send`` / ``load`` / ``wait_for``.

When CS2 is not running, the browser opens ``steam://run/730//+map <map>/`` (Steam asks to
confirm the launch options), and the commands follow once the game answers.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote

NETCON_PORT = 29000
CONNECT_TIMEOUT = 0.5
LAUNCH_WAIT = 240.0  # seconds to wait for CS2 to start after a Steam launch
LOAD_WAIT = 90.0  # seconds to wait for a map to load
KEY_LOAD_WAIT = 25.0  # after a Steam launch the log starts too late to see the load finish: wait this long
# CS2 still logs the old prefix: "ChangeGameUIState: CSGO_GAME_UI_STATE_LOADINGSCREEN -> CSGO_GAME_UI_STATE_INGAME"
INGAME = re.compile(r"ChangeGameUIState: .*-> (?:CSGO|CS2)_GAME_UI_STATE_INGAME")
OLD_STAGED_DIR = "cs2lens_demos"  # where earlier versions kept demos; they now go straight into game/csgo
# API error details, translated by the app (cs2.msg.<after the prefix>)
NO_CONSOLE = "cs2_no_console"  # no link was set up yet
NO_ACK = "cs2_no_ack"  # the key was pressed but the game did not run the cfg
NO_BIND = "cs2_no_bind"  # the bind is not in the game's saved keys
NOT_FRONT = "cs2_not_front"  # the game window could not be brought to the front
CMD_CFG = "cs2lens_cmd"
BIND_KEY = "f13"  # on no ordinary keyboard, so it can't clash with anything; no lock light either
BIND_COMMAND = f'bind {BIND_KEY} "exec {CMD_CFG}"'
BIND_SAVED = re.compile(r'"F13"\s+"exec cs2lens_cmd"', re.IGNORECASE)
ACK_WAIT = 2.5  # seconds for the game to run the cfg after the key press
ACK_TRIES = 2
BLIND_RUN = 0.25  # without confirmations: seconds to let the game run the cfg
BLIND_LOAD = 20.0  # without confirmations: seconds to let a demo load (measured: under 10)
GAME_SUBDIR = Path("steamapps") / "common" / "Counter-Strike Global Offensive" / "game" / "csgo"


def steam_libraries() -> list[Path]:
    """Steam library folders from the registry and ``libraryfolders.vdf`` (Windows)."""
    roots: list[Path] = []
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            roots.append(Path(winreg.QueryValueEx(key, "SteamPath")[0]))
    except OSError:
        pass
    except ImportError:  # not Windows
        roots += [Path.home() / ".steam" / "steam", Path.home() / ".local" / "share" / "Steam"]
    libs = list(roots)
    for root in roots:
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if vdf.exists():
            for path in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(encoding="utf-8", errors="ignore")):
                libs.append(Path(path.replace("\\\\", "\\")))
    seen, out = set(), []
    for lib in libs:
        key = str(lib.resolve()).lower() if lib.exists() else str(lib).lower()
        if key not in seen:
            seen.add(key)
            out.append(lib)
    return out


def detect_game_dir() -> Path | None:
    for lib in steam_libraries():
        d = lib / GAME_SUBDIR
        if (d / "cfg").is_dir():
            return d
    return None


def game_running() -> bool:
    """Is cs2.exe running? (Windows; elsewhere the answer is always no.)"""
    try:
        r = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/NH"], capture_output=True, text=True, errors="ignore",
            timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return "cs2.exe" in r.stdout.lower()


class NoConsole(RuntimeError):
    """Nothing can be sent to CS2; the message is one of the codes above."""


def _user32():
    import ctypes
    from ctypes import wintypes

    u = ctypes.WinDLL("user32", use_last_error=True)
    u.GetForegroundWindow.restype = wintypes.HWND
    u.SetForegroundWindow.argtypes = [wintypes.HWND]
    u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    u.IsIconic.argtypes = [wintypes.HWND]
    u.IsWindowVisible.argtypes = [wintypes.HWND]
    u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    return u


def _game_window(u) -> int | None:
    import ctypes
    from ctypes import wintypes

    found: list[int] = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def check(hwnd, _lparam):
        title = ctypes.create_unicode_buffer(64)
        if u.IsWindowVisible(hwnd) and u.GetWindowTextW(hwnd, title, 64) and title.value == "Counter-Strike 2":
            found.append(hwnd)
            return False
        return True

    u.EnumWindows(proc(check), 0)
    return found[0] if found else None


def _send_key(u, vk: int, scan: int, up: bool = False, unicode: bool = False) -> None:
    import ctypes
    from ctypes import wintypes

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class MOUSEINPUT(ctypes.Structure):  # the largest union member: gives INPUT its real size
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class UNION(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", UNION)]

    event = INPUT(type=1, u=UNION(ki=KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=(2 if up else 0) | (4 if unicode else 0))))  # 1: keyboard; 2: key up, 4: unicode
    u.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT))


def _send_char(u, ch: str) -> None:
    for up in (False, True):
        _send_key(u, 0, ord(ch), up=up, unicode=True)
    time.sleep(0.01)


def _ensure_front(u) -> int:
    """The game window, in front. Input goes wherever the focus is, so nothing is sent otherwise."""
    hwnd = _game_window(u)
    if hwnd is None:
        raise NoConsole(NOT_FRONT)
    if u.GetForegroundWindow() != hwnd:
        if u.IsIconic(hwnd):
            u.ShowWindow(hwnd, 9)  # SW_RESTORE
        # Windows lets a background process take the focus right after a key press
        _send_key(u, 0x12, 0x38)  # Alt
        _send_key(u, 0x12, 0x38, up=True)
        u.SetForegroundWindow(hwnd)
        time.sleep(0.5)
        if u.GetForegroundWindow() != hwnd:
            raise NoConsole(NOT_FRONT)
    return hwnd


def _tap(u, hwnd: int, vk: int, scan: int) -> None:
    if u.GetForegroundWindow() != hwnd:  # the player switched away: stop typing into their other window
        raise NoConsole(NOT_FRONT)
    _send_key(u, vk, scan)
    time.sleep(0.05)
    _send_key(u, vk, scan, up=True)
    time.sleep(0.05)


def press_game_key() -> None:
    """Press the bound key in the game. The bind works while a demo or map is on, not in the main menu."""
    u = _user32()
    _tap(u, _ensure_front(u), 0x7C, 0x64)  # F13


def type_in_console(line: str) -> None:
    """Open the console, type a line, run it, close the console (the only way in from the main menu)."""
    u = _user32()
    hwnd = _ensure_front(u)
    _tap(u, hwnd, 0xC0, 0x29)  # the console key; on some layouts it also types a character...
    time.sleep(0.5)
    for _ in range(4):
        _tap(u, hwnd, 0x08, 0x0E)  # ...so clear the line first
    for ch in line:
        if u.GetForegroundWindow() != hwnd:
            raise NoConsole(NOT_FRONT)
        _send_char(u, ch)
    time.sleep(0.1)
    _tap(u, hwnd, 0x0D, 0x1C)  # Enter
    time.sleep(0.3)
    _tap(u, hwnd, 0xC0, 0x29)
    time.sleep(0.3)


def condebug_on() -> bool:
    """Was the game started with -condebug? Then it writes its console to csgo/console.log."""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='cs2.exe'\").CommandLine"],
            capture_output=True, text=True, errors="ignore", timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return "-condebug" in r.stdout


def bind_saved() -> bool:
    """Is the app's bind in the game's saved keys? (The game writes them right after the bind is entered.)"""
    for root in steam_libraries():
        for vcfg in (root / "userdata").glob("*/730/local/cfg/cs2_user_keys_0_slot0.vcfg"):
            try:
                if BIND_SAVED.search(vcfg.read_text(encoding="utf-8", errors="ignore")):
                    return True
            except OSError:
                continue
    return False


def user_cvars() -> dict[str, str]:
    """Settings the player changed, from the game's saved config (a missing one is at its default)."""
    found: dict[str, str] = {}
    for root in steam_libraries():
        for vcfg in (root / "userdata").glob("*/730/local/cfg/cs2_user_convars_0_slot0.vcfg"):
            try:
                found.update(re.findall(r'"(\w+)"\s+"([^"]*)"', vcfg.read_text(encoding="utf-8", errors="ignore")))
            except OSError:
                continue
    return found


class KeyConsole:
    """Commands through ``cfg/cs2lens_cmd.cfg``: run by the bound key, or typed in the console to load
    something from the main menu. Only a game started with ``-condebug`` can confirm them (a token in
    console.log); without it the app relies on measured waits."""

    def __init__(self, game_dir: Path, press=None, typer=None, has_log: bool | None = None) -> None:
        self.dir = game_dir
        self.press = press or press_game_key
        self.typer = typer or type_in_console
        self.has_log = condebug_on() if has_log is None else has_log
        self.seq = 0
        self.buffer = ""
        self.log = game_dir / "console.log"
        self.pos = self.log.stat().st_size if self.log.exists() else 0
        self.run_id = int(time.time() * 1000)

    def _read(self) -> None:
        try:
            size = self.log.stat().st_size
            if size < self.pos:  # the game started the log over
                self.pos = 0
            if size > self.pos:
                with self.log.open("rb") as f:
                    f.seek(self.pos)
                    self.buffer = (self.buffer + f.read().decode("utf-8", "ignore"))[-262144:]
                self.pos = size
        except OSError:
            pass

    def _write(self, commands: tuple[str, ...]) -> str:
        self.seq += 1
        token = f"cs2lens_ack_{self.run_id}_{self.seq}"
        cfg = self.dir / "cfg" / f"{CMD_CFG}.cfg"
        tmp = cfg.with_suffix(".tmp")
        # the token goes first: commands like playdemo block the game for a while once they start
        tmp.write_text("\n".join([f"echo {token}", *commands, ""]), encoding="utf-8", newline="\n")
        tmp.replace(cfg)
        return token

    def _acked(self, token: str) -> bool:
        end = time.monotonic() + ACK_WAIT
        while time.monotonic() < end:
            self._read()
            if token in self.buffer:
                self.buffer = self.buffer.split(token, 1)[1]
                return True
            time.sleep(0.02)
        return False

    def send(self, *commands: str) -> None:
        token = self._write(commands)
        for _ in range(ACK_TRIES if self.has_log else 1):
            self.press()
            if not self.has_log:
                time.sleep(BLIND_RUN)
                return
            if self._acked(token):
                return
        raise NoConsole(NO_ACK)

    def load(self, *commands: str) -> None:
        """Commands that may have to work from the main menu, where the bind does not."""
        token = self._write(commands)
        self.typer(f"exec {CMD_CFG}")
        if self.has_log and not self._acked(token):
            raise NoConsole(NO_ACK)

    def wait_for(self, pattern: re.Pattern, timeout: float) -> bool:
        if not self.has_log:
            time.sleep(min(timeout, BLIND_LOAD))
            return False
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self._read()
            if pattern.search(self.buffer):
                self.buffer = ""
                return True
            time.sleep(0.1)
        return False

    def close(self) -> None:
        pass


def steam_account() -> dict | None:
    """The Steam account last signed in on this computer: {"steamid": SteamID64, "name": persona name}."""
    for root in steam_libraries():
        vdf = root / "config" / "loginusers.vdf"
        if not vdf.exists():
            continue
        text = vdf.read_text(encoding="utf-8", errors="ignore")
        users = re.findall(r'"(\d{17})"\s*\{([^}]*)\}', text)

        def field(body: str, key: str) -> str:
            m = re.search(rf'"{key}"\s+"([^"]*)"', body, re.IGNORECASE)
            return m.group(1) if m else ""

        users.sort(key=lambda u: (field(u[1], "MostRecent") == "1", field(u[1], "Timestamp")), reverse=True)
        if users:
            return {"steamid": users[0][0], "name": field(users[0][1], "PersonaName")}
    return None


def steam_launch_url(load: str, port: int) -> str:
    """Steam link that starts CS2 with the network console and runs ``load`` (``map ...``, ``playdemo ...``)."""
    return "steam://run/730//" + quote(f"-netconport {port} +{load}", safe="+/") + "/"


class Netcon:
    """One connection to the CS2 network console."""

    has_log = True  # it streams the console output

    def __init__(self, port: int, timeout: float = CONNECT_TIMEOUT) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.buffer = b""

    def send(self, *commands: str) -> None:
        for c in commands:
            self.sock.sendall(c.encode("utf-8") + b"\n")
            time.sleep(0.03)

    def load(self, *commands: str) -> None:
        self.send(*commands)

    def wait_for(self, pattern: re.Pattern, timeout: float) -> bool:
        """Read console output until a line matches, or the timeout passes."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.sock.settimeout(max(0.1, min(1.0, end - time.monotonic())))
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                return False
            self.buffer = (self.buffer + chunk)[-65536:]
            if pattern.search(self.buffer.decode("utf-8", errors="ignore")):
                self.buffer = b""
                return True
        return False

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class CS2Bridge:
    """Game folder, config files and the network console, with the state of the last action."""

    def __init__(self, settings_get, settings_set) -> None:
        self._get, self._set = settings_get, settings_set
        self.loaded: str | None = None  # the last ``map`` / ``playdemo`` command this app ran
        self.state = {"phase": "idle", "key": "idle", "params": {}, "message": "", "time": time.time()}
        self._generation = 0
        self._lock = threading.Lock()
        self._io = threading.Lock()  # one action talks to the console at a time

    # settings
    @property
    def port(self) -> int:
        return int(self._get("netcon_port") or NETCON_PORT)

    def game_dir(self) -> Path | None:
        saved = self._get("cs2_dir")
        if saved and (Path(saved) / "cfg").is_dir():
            return Path(saved)
        return detect_game_dir()

    def configure(self, game_dir: str | None, port: int | None) -> None:
        if game_dir is not None:
            if game_dir and not (Path(game_dir) / "cfg").is_dir():
                raise ValueError(f"no cfg folder in {game_dir}: the path must point at ...\\game\\csgo")
            self._set("cs2_dir", game_dir or None)
        if port is not None:
            if not 1024 <= port <= 65535:
                raise ValueError("port must be 1024-65535")
            self._set("netcon_port", port)

    def key_ready(self) -> bool:
        """The bind is in the game's saved keys."""
        return bind_saved()

    def open_console(self):
        """A live link to the game. Raises OSError when there is none."""
        try:
            return Netcon(self.port, timeout=0.5)
        except OSError:
            d = self.game_dir()
            if d is None or not game_running() or not self.key_ready():
                raise
            return KeyConsole(d)

    def test_console(self) -> str:
        """Is there a link? Nothing is pressed in the game. Returns "netcon" or "key"."""
        try:
            Netcon(self.port, timeout=0.5).close()
            return "netcon"
        except OSError:
            pass
        if not game_running():
            raise NoConsole(NOT_FRONT)
        if not self.key_ready():
            raise NoConsole(NO_BIND)
        return "key"

    def connected(self) -> bool:
        try:
            Netcon(self.port).close()
            return True
        except OSError:
            if game_running() and self.key_ready():
                return True
            self.loaded = None  # whatever was loaded is gone with the connection
            return False

    def status(self) -> dict:
        d = self.game_dir()
        return {
            "game_dir": str(d) if d else None,
            "cfg_dir": str(d / "cfg") if d else None,
            "port": self.port,
            "connected": self.connected(),
            "running": game_running(),
            "bind_command": BIND_COMMAND,
            "loaded": self.loaded,
            "state": self.state,
        }

    def write_cfg(self, name: str, text: str) -> Path | None:
        """Write ``<game>/cfg/<name>.cfg``; None when the game folder is unknown."""
        d = self.game_dir()
        if d is None:
            return None
        target = d / "cfg" / f"{name}.cfg"
        if target.resolve().parent != (d / "cfg").resolve():
            raise ValueError("refusing to write outside the cfg folder")
        target.write_text(text, encoding="utf-8", newline="\n")
        return target

    def demo_path(self, demo: Path) -> str | None:
        """The ``playdemo`` argument for ``demo`` (relative to game/csgo, no extension): its own path when
        it is inside the game folder, else its name in game/csgo, where ``stage_demo`` saves it.
        A different demo that already has the name is never replaced. None without a game folder."""
        d = self.game_dir()
        if d is None:
            return None
        try:
            return demo.resolve().relative_to(d.resolve()).with_suffix("").as_posix()
        except ValueError:
            pass
        base = re.sub(r"[^A-Za-z0-9_.-]+", "_", demo.stem)
        size = demo.stat().st_size
        name, k = base, 1
        while (d / f"{name}.dem").exists() and (d / f"{name}.dem").stat().st_size != size:
            k += 1
            name = f"{base}_{k}"
        return name

    def saved_copy(self, demo: Path) -> Path | None:
        """The copy of ``demo`` saved in game/csgo, if it has a separate one."""
        rel = self.demo_path(demo)
        if rel is None:
            return None
        p = self.game_dir() / f"{rel}.dem"
        return p if p.exists() and p.resolve() != demo.resolve() else None

    def stage_demo(self, demo: Path) -> str:
        """Save ``demo`` into game/csgo, the only place CS2 opens demos from: a hard link on the same
        drive, else a copy. Returns the ``playdemo`` argument."""
        rel = self.demo_path(demo)
        if rel is None:
            raise ValueError("CS2 game folder not found; set it in the CS2 settings")
        d = self.game_dir()
        target = d / f"{rel}.dem"
        old = d / OLD_STAGED_DIR / f"{demo.stem}.dem"
        try:
            old.unlink(missing_ok=True)
            old.parent.rmdir()
        except OSError:  # missing, not empty, or held open by the game
            pass
        if target.exists():
            return rel
        try:
            os.link(demo, target)
        except OSError:
            tmp = target.with_suffix(".part")
            shutil.copyfile(demo, tmp)
            tmp.replace(target)
        return rel

    def claim(self) -> int:
        """Start a new action: an older one still waiting to run is dropped."""
        with self._lock:
            self._generation += 1
            return self._generation

    # actions
    def _phase(self, gen: int, phase: str, key: str, message: str, **params) -> None:
        """``key`` and ``params`` let the app show ``message`` in its own language."""
        if gen == self._generation:
            self.state = {"phase": phase, "key": key, "params": params, "message": message, "time": time.time()}

    def run(self, load: str, commands: list[str], label: str, reload: bool = False) -> dict:
        """Run ``load`` (``map de_x`` or ``playdemo x``) unless this app already did, then ``commands``:
        right away when there is a link to the game, otherwise after the Steam launch that the
        browser starts with the returned link."""
        with self._lock:
            self._generation += 1
            gen = self._generation
        connected = self.connected()
        if not connected and game_running():  # a Steam link does nothing for a game that is already open
            raise NoConsole(NO_CONSOLE)
        if connected:
            threading.Thread(target=self._send, args=(gen, load, commands, label, reload), daemon=True).start()
            return {"mode": "netcon", "steam_url": None}
        if not self.key_ready():  # the game opens the map or demo, but nothing more can be sent to it
            self._phase(gen, "done", "launched_only", f"Steam is starting CS2 with {load}; commands need the console link", load=load)
            return {"mode": "launch", "steam_url": steam_launch_url(load, self.port)}
        self._phase(gen, "launching", "launching", "Steam is starting CS2: confirm the launch options in the Steam window")
        threading.Thread(target=self._after_launch, args=(gen, load, commands, label), daemon=True).start()
        return {"mode": "launch", "steam_url": steam_launch_url(load, self.port)}

    def _send(self, gen: int, load: str, commands: list[str], label: str, reload: bool) -> None:
        with self._io:
            if gen == self._generation:  # a newer click replaces this one
                self._send_now(gen, load, commands, label, reload)

    def _send_now(self, gen: int, load: str, commands: list[str], label: str, reload: bool) -> None:
        try:
            con = self.open_console()
            try:
                if reload or self.loaded != load or not con.has_log:  # blind: the player may have left it
                    self._phase(gen, "loading", "loading", f"CS2: {load}…", load=load)
                    con.load(load)
                    if not con.wait_for(INGAME, LOAD_WAIT):
                        self._phase(gen, "loading", "load_timeout", "loading took too long, sending the commands anyway")
                    time.sleep(2.0)
                    self.loaded = load
                con.send(*commands)
                self._phase(gen, "done", "done", f"in CS2: {label}", label=label)
            finally:
                con.close()
        except NoConsole as e:
            self._phase(gen, "error", str(e).removeprefix("cs2_"), str(e))
        except OSError as e:
            self._phase(gen, "error", "no_answer", f"CS2 does not answer on port {self.port}: {e}", port=self.port, error=str(e))

    def _after_launch(self, gen: int, load: str, commands: list[str], label: str) -> None:
        end = time.monotonic() + LAUNCH_WAIT
        while time.monotonic() < end and gen == self._generation:
            try:
                con = self.open_console()
                if isinstance(con, KeyConsole) and con.has_log:
                    con.send()  # no answer until the game window is up
            except (OSError, NoConsole):
                time.sleep(2)
                continue
            try:
                self._io.acquire()
                self._phase(gen, "loading", "started", f"CS2 started: {load}…", load=load)
                con.wait_for(INGAME, LOAD_WAIT if isinstance(con, Netcon) else KEY_LOAD_WAIT)
                time.sleep(2.0)
                self.loaded = load
                con.send(*commands)
                self._phase(gen, "done", "done", f"in CS2: {label}", label=label)
            except NoConsole as e:
                self._phase(gen, "error", str(e).removeprefix("cs2_"), str(e))
            except OSError as e:
                self._phase(gen, "error", "lost", f"lost the connection to CS2: {e}", error=str(e))
            finally:
                self._io.release()
                con.close()
            return
        if gen == self._generation:
            self._phase(gen, "error", "no_netcon", f"CS2 did not open the network console on port {self.port} within {int(LAUNCH_WAIT)} s", port=self.port, sec=int(LAUNCH_WAIT))
