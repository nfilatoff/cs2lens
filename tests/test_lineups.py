import socket
import threading
import time

import polars as pl
import pytest

from cs2lens.app.cs2 import INGAME, CS2Bridge, KeyConsole, NoConsole, steam_launch_url
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


def _fake_cs2() -> tuple[socket.socket, int, list[str]]:
    """A network console that answers every load (map or playdemo) with the in-game state."""
    received: list[str] = []
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()

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
                    if line.startswith((b"map ", b"playdemo ")):
                        c.sendall(b"ChangeGameUIState: CS2_GAME_UI_STATE_LOADINGSCREEN -> CS2_GAME_UI_STATE_INGAME\n")

    threading.Thread(target=serve, daemon=True).start()
    return srv, srv.getsockname()[1], received


def _wait(cond, sec=8.0):
    end = time.monotonic() + sec
    while time.monotonic() < end and not cond():
        time.sleep(0.05)


def test_stage_demo(tmp_path):
    game = tmp_path / "game" / "csgo"
    (game / "cfg").mkdir(parents=True)
    inside = game / "replays" / "a.dem"
    inside.parent.mkdir()
    inside.write_bytes(b"x" * 10)
    outside = tmp_path / "my demos" / "b c.dem"
    outside.parent.mkdir()
    outside.write_bytes(b"y" * 20)
    settings = {"cs2_dir": str(game)}
    bridge = CS2Bridge(settings.get, settings.__setitem__)
    assert bridge.stage_demo(inside) == "replays/a"
    assert bridge.stage_demo(outside) == "b_c"
    assert (game / "b_c.dem").read_bytes() == b"y" * 20
    assert bridge.stage_demo(outside) == "b_c"  # already there
    other = tmp_path / "my demos" / "b_c.dem"  # same name in game/csgo, different demo: never replaced
    other.write_bytes(b"z" * 30)
    assert bridge.stage_demo(other) == "b_c_2"
    assert (game / "b_c.dem").read_bytes() == b"y" * 20
    assert bridge.saved_copy(other) == game / "b_c_2.dem"


def _fake_game(game, drop=0):
    """Stands in for the game behind the key: runs the cfg and writes console.log."""
    pressed = []

    def press(*_line):
        pressed.append(_line)
        if len(pressed) <= drop:
            return
        lines = (game / "cfg" / "cs2lens_cmd.cfg").read_text(encoding="utf-8").splitlines()
        with (game / "console.log").open("a", encoding="utf-8") as log:
            for line in lines:
                if line.startswith("echo "):
                    log.write(line[5:] + "\n")
                if line.startswith("playdemo"):
                    log.write("ChangeGameUIState: CSGO_GAME_UI_STATE_MAINMENU -> CSGO_GAME_UI_STATE_INGAME\n")

    return press, pressed


def _game_dir(tmp_path):
    game = tmp_path / "game" / "csgo"
    (game / "cfg").mkdir(parents=True)
    return game


def test_key_console(tmp_path):
    game = _game_dir(tmp_path)
    press, pressed = _fake_game(game)
    con = KeyConsole(game, press, press, has_log=True)
    con.send("demo_pause", 'spec_player "ник"')
    cfg = (game / "cfg" / "cs2lens_cmd.cfg").read_text(encoding="utf-8").splitlines()
    assert cfg[0].startswith("echo cs2lens_ack_") and cfg[1:] == ["demo_pause", 'spec_player "ник"']
    assert pressed == [()]  # the key, not the console
    con.load("playdemo x")
    assert pressed[1] == ("exec cs2lens_cmd",)  # typed: the bind does not fire in the main menu
    assert con.wait_for(INGAME, 1)


def test_key_console_retries_and_gives_up(tmp_path, monkeypatch):
    monkeypatch.setattr("cs2lens.app.cs2.ACK_WAIT", 0.1)
    game = _game_dir(tmp_path)
    press, pressed = _fake_game(game, drop=1)  # the first press is lost
    KeyConsole(game, press, press, has_log=True).send("x")
    assert len(pressed) == 2
    with pytest.raises(NoConsole):  # with a log, no answer is an error and not a silent success
        KeyConsole(game, lambda: None, lambda _: None, has_log=True).send("x")


def test_key_console_without_log(tmp_path, monkeypatch):
    """A game without -condebug can't confirm anything: the key is pressed once, nothing is awaited."""
    monkeypatch.setattr("cs2lens.app.cs2.BLIND_RUN", 0)
    monkeypatch.setattr("cs2lens.app.cs2.BLIND_LOAD", 0)
    game = _game_dir(tmp_path)
    pressed = []
    con = KeyConsole(game, lambda: pressed.append(1), lambda _: None, has_log=False)
    con.send("x")
    assert pressed == [1] and con.wait_for(INGAME, 90) is False


def test_tests_cannot_reach_the_game():
    from cs2lens.app import cs2

    with pytest.raises(AssertionError):
        cs2.press_game_key()


def test_real_ingame_line():
    """The line CS2 really logs (from its console.log) still has the old CSGO prefix."""
    assert INGAME.search("ChangeGameUIState: CSGO_GAME_UI_STATE_LOADINGSCREEN -> CSGO_GAME_UI_STATE_INGAME")
    assert not INGAME.search("ChangeGameUIState: CSGO_GAME_UI_STATE_INGAME -> CSGO_GAME_UI_STATE_PAUSEMENU")
