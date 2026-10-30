import polars as pl
import pytest

from cs2lens.aggregate import SPECS, aggregate


@pytest.fixture(scope="module")
def once_twice(request):
    from tests.conftest import FIXTURES

    d = FIXTURES / "dust2_mini"
    return aggregate([d]), aggregate([d, d])


@pytest.mark.parametrize("table", ["summary", "by_side", "by_buy", "opening", "trades", "bomb_t", "bomb_ct", "executes", "rotations"])
def test_same_demo_twice_doubles_counts_keeps_rates(once_twice, table):
    once, twice = once_twice
    spec = SPECS[table]
    a, b = once[table].sort(spec.keys), twice[table].sort(spec.keys)
    assert a.height == b.height > 0
    for col in spec.sums:
        assert (b[col] == a[col] * 2).all(), col
    for col in [name for name, *_ in spec.pcts] + [name for name, *_ in spec.ratios] + list(spec.wmeans):
        assert a[col].to_list() == pytest.approx(b[col].to_list(), nan_ok=True), col
    assert b["matches"].to_list() == [2] * b.height


def test_players_and_aliases(dust2_mini):
    out = aggregate([dust2_mini], {"team_sirena_-": "Sirena"})
    assert "Sirena" in out["summary"]["team"].to_list()
    assert "team_sirena_-" not in out["players"]["team"].to_list()
    twice = aggregate([dust2_mini, dust2_mini])["players"]
    once = aggregate([dust2_mini])["players"]
    joined = once.join(twice, on="name", suffix="_2")
    assert (joined["kills_2"] == joined["kills"] * 2).all()
    assert joined["adr"].to_list() == pytest.approx(joined["adr_2"].to_list())
    assert out["matches"].height == 1 and isinstance(out["matches"], pl.DataFrame)
