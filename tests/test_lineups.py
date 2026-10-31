import socket
import threading
import time

import polars as pl

from cs2lens.app.cs2 import CS2Bridge, steam_launch_url
from cs2lens.lineups import cfg_name, console_string, list_cfg, safe_text, throws


def test_throws(dust2_mini):
    t = throws(dust2_mini)
    assert t.height > 50
    assert t["land_x"].null_count() / t.height < 0.05  # almost every throw has its flight path
    assert set(t["type"].unique()) <= {"smoke", "flashbang", "he", "molotov", "decoy"}
    assert t["throw_zone"].null_count() < t.height  # dust2 has a zone config
    assert t["pitch"].is_between(-90, 90).all()
    assert t.filter(pl.col("round_num") > 8).is_empty()


def test_commands_are_safe():
    lu = {"x": 1, "y": 2.5, "z": -3, "pitch": -10, "yaw": 90, "weapon": "weapon_smokegrenade; quit", "label": 'a"; quit // x'}
    s = console_string(lu)
    assert s.startswith("sv_cheats 1; setpos 1.00 2.50 -3.00; setang -10.00 90.00 0; give weapon_smokegrenade")
    assert "quit" not in s  # an unknown weapon falls back to a smoke
    assert safe_text('a"; quit // x') == "a quit / x"
    cfg = list_cfg("de_dust2", "My list!", [lu, lu | {"weapon": "weapon_flashbang"}])
    assert 'alias cs2lens_2 "setpos' in cfg and 'bind "]" "cs2lens_next"' in cfg
    assert cfg.count('"') % 2 == 0
    assert cfg_name("My list!") == "cs2lens_my_list"


def test_netcon_bridge(tmp_path):
    """The bridge loads the map once, waits for the in-game state and sends the lineup."""
    received: list[str] = []
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]

    def serve():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            buf = b""
            while chunk := c.recv(4096):
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    received.append(line.decode())
                    if line.startswith(b"map "):
                        c.sendall(b"ChangeGameUIState: CS2_GAME_UI_STATE_LOADINGSCREEN -> CS2_GAME_UI_STATE_INGAME\n")

    threading.Thread(target=serve, daemon=True).start()
    settings = {"netcon_port": port}
    bridge = CS2Bridge(settings.get, settings.__setitem__)
    assert bridge.run("map de_dust2", ["setpos 1 2 3"], "x")["mode"] == "netcon"
    for _ in range(100):
        if bridge.state["phase"] == "done":
            break
        time.sleep(0.05)
    bridge.run("map de_dust2", ["setpos 4 5 6"], "y")
    for _ in range(100):
        if received[-1:] == ["setpos 4 5 6"]:
            break
        time.sleep(0.05)
    srv.close()
    assert received == ["map de_dust2", "setpos 1 2 3", "setpos 4 5 6"]  # the map is loaded only once


def test_steam_url():
    assert steam_launch_url("map de_dust2", 29000) == "steam://run/730//-netconport%2029000%20+map%20de_dust2/"
