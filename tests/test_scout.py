import json
import shutil

import polars as pl
import pytest

from cs2lens.aggregate import aggregate
from cs2lens.app.server import _points, _scouted_points, create_app
from cs2lens.context import load_match
from cs2lens.scout import dossier, match_data, roster_suggestions, select_rounds, similar_rounds


@pytest.fixture(scope="module")
def data():
    from pathlib import Path

    return match_data(Path(__file__).parent / "fixtures" / "dust2_mini", date=100.0)


@pytest.fixture(scope="module")
def team(data):
    """The team on the T side: the fixture is part of one half."""
    return data.rounds.filter(pl.col("side") == "terrorist")["team"][0]


def route(api, path):
    return next(r.endpoint for r in api.routes if getattr(r, "path", "") == path)


def test_selection_filters_rounds_and_every_table(data, team):
    s = select_rounds([data], team, side="terrorist", buy="full")
    assert s.rounds.height > 0
    assert set(s.rounds["side"].to_list()) == {"terrorist"} and set(s.rounds["buy"].to_list()) == {"full"}
    rounds = set(s.rounds["round_num"].to_list())
    for table in (s.utility, s.players, s.starts, s.visits):
        assert set(table["round_num"].to_list()) <= rounds
    assert set(s.players["team"].to_list()) == {team}


def test_rounds_last_keeps_the_newest_rounds_of_the_newest_match(data, team):
    other = match_data_copy(data, "older", 50.0)
    s = select_rounds([data, other], team, rounds_last=3)
    assert s.rounds["match"].to_list() == [data.id] * 3
    assert s.rounds["round_num"].to_list() == sorted(data.rounds.filter(pl.col("team") == team)["round_num"].to_list())[-3:][::-1]


def match_data_copy(data, new_id, date):
    from dataclasses import replace

    return replace(data, id=new_id, date=date)


def test_aliases_join_two_matches_into_one_team(data, team):
    other = match_data_copy(data, "second", 50.0)
    renamed = lambda df: df.with_columns(pl.col("team").replace({team: "old name"}))  # noqa: E731
    from dataclasses import replace

    other = replace(other, **{k: renamed(getattr(other, k)) for k in ("rounds", "utility", "entries", "players", "weapons", "starts")})
    s = select_rounds([data, other], team, aliases={"old name": team})
    one = select_rounds([data], team)
    assert s.rounds.height == 2 * one.rounds.height
    assert s.rounds["match"].n_unique() == 2
    report = dossier(s)
    assert report["sample"]["matches"] == 2
    assert report["sample"]["rounds"] == s.rounds.height


def test_unknown_team_is_an_error(data):
    with pytest.raises(ValueError):
        select_rounds([data], "nobody")


def test_dossier_is_json_and_counts_add_up(data, team):
    report = dossier(select_rounds([data], team))
    sample = report["sample"]
    assert sample["t_rounds"] + sample["ct_rounds"] == sample["rounds"]
    assert 0 < len(report["cards"]) <= 7
    for card in report["cards"]:
        assert card["rounds"] > 0
        assert card["low"] == (card["rounds"] < 5)
        for ex in card["examples"]:
            assert ex["match"] == data.id and ex["round"] in data.rounds["round_num"].to_list()
    by_buy = report["economy"]["by_buy"]
    assert by_buy["rounds"].sum() == sample["rounds"]
    assert by_buy["wins"].sum() == sample["wins"]
    from cs2lens.app.server import _json_ready

    json.dumps(_json_ready(report), allow_nan=False)


def test_ct_team_gets_setups_and_no_t_tables(data, team):
    ct_team = data.rounds.filter(pl.col("team") != team)["team"][0]
    report = dossier(select_rounds([data], ct_team))
    assert report["sample"]["t_rounds"] == 0
    assert report["setups"]["rounds"].sum() == report["sample"]["ct_rounds"]
    assert report["executes_by_buy"].is_empty() and report["playbook"]["strats"] == []
    assert "ct_setup" in [c["key"] for c in report["cards"]]


def test_a_cards_sample_is_the_rounds_its_percentage_rests_on(data, team):
    twin = match_data_copy(data, "twin", 50.0)
    t_report = dossier(select_rounds([data, twin], team))
    strat = next(c for c in t_report["cards"] if c["key"] == "top_strat")
    assert strat["rounds"] == strat["params"]["n"] == t_report["playbook"]["strats"][0]["rounds"]
    ct_team = data.rounds.filter(pl.col("team") != team)["team"][0]
    ct_report = dossier(select_rounds([data], ct_team))
    setup = next(c for c in ct_report["cards"] if c["key"] == "ct_setup")
    assert setup["rounds"] == ct_report["setups"]["rounds"][0]
    assert setup["low"] == (setup["rounds"] < 5)


def test_after_pistol_table_matches_the_rounds(data, team):
    report = dossier(select_rounds([data], team))
    pistol = data.rounds.filter(pl.col("team") == team).sort("round_num").row(0, named=True)
    rows = report["economy"]["after_pistol"].to_dicts()
    assert {r["pistol"] for r in rows} == {"win" if pistol["won"] else "loss"}
    assert sum(r["rounds"] for r in rows) == 1


def test_executes_by_buy_cover_the_t_rounds_with_a_target(data, team):
    s = select_rounds([data], team, side="terrorist")
    table = dossier(s)["executes_by_buy"]
    assert table["rounds"].sum() == s.rounds.filter(pl.col("target_site").is_not_null()).height
    assert "buy" in table.columns


def test_players_rates(data, team):
    players = dossier(select_rounds([data], team))["players"]
    assert players.height == 5
    assert (players["kd"] >= 0).all()
    assert players["nearest_mate"].drop_nulls().min() > 0
    assert players["trade_kill_pct"].drop_nulls().is_between(0, 100).all()


def test_timing_cells_count_rounds(data, team):
    s = select_rounds([data], team, side="terrorist")
    grid = dossier(s)["timings"]
    assert grid["totals"]["terrorist"] == s.rounds.height
    assert grid["cells"], "de_dust2 has a config: there are zones"
    for c in grid["cells"]:
        assert c["bin"] % grid["step"] == 0 and 0 <= c["bin"] < grid["max"]
        assert 0 < c["rounds"] <= s.rounds.height
        assert c["examples"]
    assert any(c["kind"] == "enter" for c in grid["cells"])


def test_playbook_groups_same_grenades_together(data, team):
    report = dossier(select_rounds([data, match_data_copy(data, "twin", 50.0)], team, side="terrorist"))
    book = report["playbook"]
    # the same match twice: every round has an identical twin, so nothing stays alone
    assert book["strats"]
    assert book["one_offs"] == 0
    assert sum(st["rounds"] for st in book["strats"]) == book["total"]
    for st in book["strats"]:
        assert st["rounds"] >= 2 and st["site"] in ("A", "B")
        assert {ex["match"] for ex in st["examples"]} <= {data.id, "twin"}


def test_multiround_lists_starts_and_unvisited_zones(data, team):
    report = dossier(select_rounds([data], team, side="terrorist"))
    assert len(report["multiround"]) == 5
    for p in report["multiround"]:
        assert p["rounds"] == len(p["spots"]) > 0
        assert sum(z["rounds"] for z in p["zones"]) <= p["rounds"]
        assert set(p["never"]).isdisjoint({z["zone"] for z in p["zones"]})


def test_similar_rounds_finds_the_identical_twin_first(data, team):
    twin = match_data_copy(data, "twin", 50.0)
    t_round = data.rounds.filter((pl.col("team") == team) & (pl.col("side") == "terrorist"))["round_num"][0]
    found = similar_rounds([data, twin], data.id, t_round, team, n=3)
    assert found[0]["match"] == "twin" and found[0]["round"] == t_round
    assert found[0]["score"] == pytest.approx(1.0)
    assert all(f["side"] == "terrorist" for f in found)
    assert not any(f["match"] == data.id and f["round"] == t_round for f in found)


def test_roster_suggestions():
    rosters = {"a": {"1", "2", "3", "4"}, "b": {"2", "3", "4", "9"}, "c": {"1", "7"}}
    assert roster_suggestions(rosters, {}) == [{"a": "a", "b": "b", "common": 3}]
    assert roster_suggestions(rosters, {"a": "b"}) == []


def test_points_have_context(dust2_mini):
    points = _points(dust2_mini, 0.0)
    assert points["zooms"] == []  # the fixture has no weapon_zoom event
    for kind in ("kills", "shots", "damages", "blinds", "plants", "utility"):
        assert points[kind], kind
        for col in ("buy", "opp_buy", "after_pistol_loss", "man_diff"):
            assert col in points[kind][0], (kind, col)
    # a first kill of a round is taken with both sides complete
    first = min((k for k in points["kills"] if k["round_num"] == 2), key=lambda k: k["sec"])
    assert first["man_diff"] == 0
    # both views of a round agree: what one team bought is the other's enemy buy
    m = load_match(dust2_mini)
    row = m.tr.filter(pl.col("round_num") == 2).row(0, named=True)
    kill = next(k for k in points["kills"] if k["round_num"] == 2 and k["attacker_team"] == row["team"])
    assert (kill["buy"], kill["opp_buy"]) == (row["buy"], row["opp_buy"])
    json.dumps(points, allow_nan=False)


def test_zooms_from_the_event(dust2_mini, tmp_path):
    d = tmp_path / "m"
    shutil.copytree(dust2_mini, d)
    m = load_match(d)
    snaps = m.data["snapshots"]
    # someone holding a gun in a live round, pretending it is an AWP
    freeze = int(m.rounds.filter(pl.col("round_num") == 3)["freeze_end_tick"][0])
    row = snaps.filter((pl.col("tick") > freeze) & (pl.col("health") > 0) & pl.col("active_weapon").is_not_null()).row(0, named=True)
    snaps.with_columns(
        pl.when(pl.col("steamid") == row["steamid"]).then(pl.lit("awp")).otherwise(pl.col("active_weapon")).alias("active_weapon")
    ).write_parquet(d / "snapshots.parquet")
    fires = pl.read_parquet(d / "events" / "weapon_fire.parquet")
    shots = pl.read_parquet(d / "shots.parquet")
    userid = pl.DataFrame({"userid": fires["userid"], "steamid": shots["steamid"]}).filter(pl.col("steamid") == row["steamid"])["userid"][0]
    t0 = row["tick"] + 64
    pl.DataFrame({"tick": [t0, t0 + 20, t0 + 40, t0 + 400], "userid": [userid] * 4}).write_parquet(d / "events" / "weapon_zoom.parquet")
    zooms = _points(d, 1.0)["zooms"]
    # two chains: the three quick clicks count once
    assert [z["name"] for z in zooms] == [row["name"]] * 2
    assert zooms[0]["weapon"] == "awp" and zooms[0]["round_num"] == 3
    assert zooms[1]["sec"] - zooms[0]["sec"] > 5


def test_scouted_points_keep_the_teams_rows_only():
    points = {
        "kills": [
            {"round_num": 1, "attacker_team": "raw", "victim_team": "x"},
            {"round_num": 2, "attacker_team": "raw", "victim_team": "x"},
            {"round_num": 1, "attacker_team": "x", "victim_team": "y"},
            {"round_num": 1, "attacker_team": "x", "victim_team": "raw"},
        ],
        "shots": [{"round_num": 1, "team": "raw"}, {"round_num": 1, "team": "x"}],
    }
    out = _scouted_points(points, {1}, {"raw"}, {"raw": "Team"}, "m1")
    assert [(k["attacker_team"], k["victim_team"]) for k in out["kills"]] == [("Team", "x"), ("x", "Team")]
    assert out["shots"] == [{"round_num": 1, "team": "Team", "match_id": "m1"}]


def library_app(tmp_path, dust2_mini, names=("m1", "m2")):
    out = tmp_path / "out"
    for n in names:
        shutil.copytree(dust2_mini, out / n)
    return create_app(out), out


def test_teams_api_saves_aliases_in_the_library(tmp_path, dust2_mini):
    api, out = library_app(tmp_path, dust2_mini)
    teams = route(api, "/api/teams")()
    assert all(t["matches"] == 2 for t in teams["teams"])
    assert all(t["maps"] == {"de_dust2": 2} for t in teams["teams"])
    raw = teams["teams"][0]["name"]
    route(api, "/api/teams/alias")(raw=raw, name="Canon")
    assert json.loads((out / "library.json").read_text())["team_aliases"] == {raw: "Canon"}
    after = route(api, "/api/teams")()
    assert "Canon" in [t["name"] for t in after["teams"]] and raw not in [t["name"] for t in after["teams"]]
    route(api, "/api/teams/alias")(raw=raw, name=None)
    assert "team_aliases" not in json.loads((out / "library.json").read_text())
    route(api, "/api/teams/own")(name="Canon")
    assert route(api, "/api/teams")()["own"] == "Canon"


def test_scout_api_spans_matches(tmp_path, dust2_mini):
    api, _out = library_app(tmp_path, dust2_mini)
    team = route(api, "/api/teams")()["teams"][0]["name"]
    report = route(api, "/api/scout/report")(team=team, map="de_dust2", last=10)
    assert report["sample"]["matches"] == 2
    one = route(api, "/api/scout/report")(team=team, map="de_dust2", last=1)
    assert one["sample"]["matches"] == 1 and report["sample"]["rounds"] == 2 * one["sample"]["rounds"]
    points = route(api, "/api/scout/points")(team=team, map="de_dust2", last=10, buy="full")
    assert {p["match_id"] for p in points["kills"]} == {"m1", "m2"}
    full = {(r["match"], r["round_num"]) for r in route(api, "/api/scout/report")(team=team, map="de_dust2", last=10, buy="full")["rounds"]}
    assert {(p["match_id"], p["round_num"]) for p in points["shots"]} <= full
    assert all(p["team"] == team for p in points["shots"])
    insights = route(api, "/api/matches/{match_id}/insights")("m1")
    assert team in insights and insights[team]["cards"]
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        route(api, "/api/scout/report")(team="nobody", map="de_dust2")


def test_maps_api_lists_the_pool(tmp_path):
    maps = route(create_app(tmp_path), "/api/maps")()
    assert {"de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"} <= set(maps)


def test_executes_by_buy_in_tactics_and_aggregate(dust2_mini):
    result = aggregate([dust2_mini])
    table = result["executes_by_buy"]
    assert {"map", "team", "buy", "target_site", "rounds", "win_pct"} <= set(table.columns)
    assert table["rounds"].sum() == result["executes"]["rounds"].sum()


def test_movement_context_filters_split_the_positions(dust2_mini):
    from cs2lens.app.server import _map_meta, _movement
    from cs2lens.app.server import awpy_data

    if not awpy_data.local_versions():
        pytest.skip("no awpy-data cache")
    _map_meta("de_dust2")
    args = (dust2_mini, 0.0, "", "", "", 1, 99, -30.0, 300.0)
    total = _movement(*args)["samples"]
    parts = [_movement(*args, man=m)["samples"] for m in ("up", "even", "down")]
    assert sum(parts) == total and all(parts)
    buys = [_movement(*args, buy=b)["samples"] for b in ("pistol", "eco", "force", "full")]
    assert sum(buys) == total
    assert _movement(*args, pistol="loss")["samples"] + _movement(*args, pistol="win")["samples"] > 0
