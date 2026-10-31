"""Talking to a local CS2: find the game folder, write practice configs into it, and send
console commands over its network console.

CS2 started with ``-netconport <port>`` accepts console commands, one per line, on
127.0.0.1:<port> and streams the console output back. The app uses it to load the map
and put the player on a lineup. When CS2 is not running, the browser opens
``steam://run/730//-netconport <port> +map <map>/`` (Steam asks to confirm the launch
options) and a background thread waits for the game to come up, then sends the lineup.
Without the network console the configs written to ``game/csgo/cfg`` still work with
``exec`` from the in-game console.
"""

from __future__ import annotations

import re
import socket
import threading
import time
from pathlib import Path
from urllib.parse import quote

NETCON_PORT = 29000
CONNECT_TIMEOUT = 0.5
LAUNCH_WAIT = 240.0  # seconds to wait for CS2 to start after a Steam launch
LOAD_WAIT = 90.0  # seconds to wait for a map to load
INGAME = re.compile(r"CS2_GAME_UI_STATE_INGAME|ChangeGameUIState: .*-> CS2_GAME_UI_STATE_INGAME")
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


def steam_launch_url(load: str, port: int) -> str:
    """Steam link that starts CS2 with the network console and runs ``load`` (``map ...``, ``playdemo ...``)."""
    return "steam://run/730//" + quote(f"-netconport {port} +{load}", safe="+/") + "/"


class Netcon:
    """One connection to the CS2 network console."""

    def __init__(self, port: int, timeout: float = CONNECT_TIMEOUT) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.buffer = b""

    def send(self, *commands: str) -> None:
        for c in commands:
            self.sock.sendall(c.encode("utf-8") + b"\n")
            time.sleep(0.03)

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
        self.state = {"phase": "idle", "message": "", "time": time.time()}
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

    def connected(self) -> bool:
        try:
            Netcon(self.port).close()
            return True
        except OSError:
            return False

    def status(self) -> dict:
        d = self.game_dir()
        return {
            "game_dir": str(d) if d else None,
            "cfg_dir": str(d / "cfg") if d else None,
            "port": self.port,
            "connected": self.connected(),
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

    # actions
    def _phase(self, gen: int, phase: str, message: str) -> None:
        if gen == self._generation:
            self.state = {"phase": phase, "message": message, "time": time.time()}

    def run(self, load: str, commands: list[str], label: str, reload: bool = False) -> dict:
        """Run ``load`` (``map de_x`` or ``playdemo x``) unless this app already did, then ``commands``:
        right away when CS2 listens on the network console, otherwise after the Steam launch
        that the browser starts with the returned link."""
        with self._lock:
            self._generation += 1
            gen = self._generation
        if self.connected():
            threading.Thread(target=self._send, args=(gen, load, commands, label, reload), daemon=True).start()
            return {"mode": "netcon", "steam_url": None}
        self._phase(gen, "launching", "Steam запускает CS2 — подтвердите параметры запуска в окне Steam")
        threading.Thread(target=self._after_launch, args=(gen, load, commands, label), daemon=True).start()
        return {"mode": "launch", "steam_url": steam_launch_url(load, self.port)}

    def _send(self, gen: int, load: str, commands: list[str], label: str, reload: bool) -> None:
        with self._io:
            if gen == self._generation:  # a newer click replaces this one
                self._send_now(gen, load, commands, label, reload)

    def _send_now(self, gen: int, load: str, commands: list[str], label: str, reload: bool) -> None:
        try:
            con = Netcon(self.port, timeout=2)
            try:
                if reload or self.loaded != load:
                    self._phase(gen, "loading", f"CS2: {load}…")
                    con.send(load)
                    if not con.wait_for(INGAME, LOAD_WAIT):
                        self._phase(gen, "loading", "не дождался загрузки, отправляю команды")
                    time.sleep(2.0)
                    self.loaded = load
                con.send(*commands)
            finally:
                con.close()
            self._phase(gen, "done", f"в CS2: {label}")
        except OSError as e:
            self._phase(gen, "error", f"CS2 не отвечает на порту {self.port}: {e}")

    def _after_launch(self, gen: int, load: str, commands: list[str], label: str) -> None:
        end = time.monotonic() + LAUNCH_WAIT
        while time.monotonic() < end and gen == self._generation:
            try:
                con = Netcon(self.port, timeout=1)
            except OSError:
                time.sleep(2)
                continue
            try:
                self._io.acquire()
                self._phase(gen, "loading", f"CS2 запущена: {load}…")
                con.wait_for(INGAME, LOAD_WAIT)
                time.sleep(2.0)
                self.loaded = load
                con.send(*commands)
                self._phase(gen, "done", f"в CS2: {label}")
            except OSError as e:
                self._phase(gen, "error", f"связь с CS2 оборвалась: {e}")
            finally:
                self._io.release()
                con.close()
            return
        if gen == self._generation:
            self._phase(gen, "error", f"CS2 не открыла сетевую консоль на порту {self.port} за {int(LAUNCH_WAIT)} с")
