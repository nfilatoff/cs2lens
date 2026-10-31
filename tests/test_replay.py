import gzip
import json
import shutil

from cs2lens.context import load_match
from cs2lens.replay import build_round, round_payload


def test_round_document(dust2_mini):
    m = load_match(dust2_mini, extra_tables=("smokes", "fires", "grenades", "blinds", "shots"))
    doc = build_round(m, 5)
    n = len(doc["ticks"])
    assert doc["low_res"]  # the fixture has no replay.parquet, so 0.5 s snapshots are used
    assert len(doc["players"]) == 10
    assert {p["side"] for p in doc["players"]} == {"terrorist", "counter-terrorist"}
    for p in doc["players"]:
        assert all(len(p[k]) == n for k in ("x", "y", "yaw", "hp", "weapon", "bomb"))
    assert doc["start_tick"] <= doc["freeze_end_tick"] < doc["end_tick"] <= doc["last_tick"]
    assert all(doc["start_tick"] <= k["tick"] <= doc["last_tick"] for k in doc["kills"])
    assert any(b["event"] == "finish_plant" and b["site"] == "A" for b in doc["bomb"])
    json.dumps(doc)  # serialisable as is


def test_payload_is_cached(dust2_mini, tmp_path):
    d = tmp_path / "m"
    shutil.copytree(dust2_mini, d)
    first = round_payload(d, 3)
    assert list((d / "replay").glob("round_3.*.json.gz"))
    assert round_payload(d, 3) == first
    assert json.loads(gzip.decompress(first))["round"] == 3


def test_inventory_shots_and_duels(dust2_mini):
    m = load_match(dust2_mini, extra_tables=("smokes", "fires", "grenades", "blinds", "shots", "damages"))
    doc = build_round(m, 5)
    for p in doc["players"]:
        assert p["inv"] and all(0 <= i < len(doc["items"]) for _, i in p["inv"])
    assert any(len(inv) > 2 for inv in doc["items"])  # somebody carries grenades
    shots = doc["shots"]
    assert len({len(v) for v in shots.values()}) == 1
    assert any(h is not None for h in shots["hx"])  # some shots hit a player
    for k in doc["kills"]:
        assert set(k) >= {"dist", "attacker_hp", "victim_weapon", "given", "taken", "trade", "traded"}
        if k["attacker"] and k["weapon"] not in ("hegrenade", "inferno", "molotov"):
            assert k["given"][0] >= 1 and k["given"][1] > 0
