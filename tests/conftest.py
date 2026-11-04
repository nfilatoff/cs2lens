from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def no_real_game(monkeypatch):
    """Tests never touch a CS2 that happens to be running on this computer: no keys, no focus."""
    from cs2lens.app import cs2, hlae, recorder

    def forbidden(*_args, **_kwargs):
        raise AssertionError("a test tried to send keys to the real game")

    monkeypatch.setattr(cs2, "game_running", lambda: False)
    monkeypatch.setattr(recorder, "game_running", lambda: False)
    monkeypatch.setattr(hlae, "close_game", forbidden)
    monkeypatch.setattr(cs2, "bind_saved", lambda: False)
    monkeypatch.setattr(cs2, "press_game_key", forbidden)
    monkeypatch.setattr(cs2, "type_in_console", forbidden)


@pytest.fixture
def dust2_mini() -> Path:
    """Rounds 1-8 of a de_dust2 match (see make_fixture.py); snapshot ticks start at 1, not 0."""
    return FIXTURES / "dust2_mini"
