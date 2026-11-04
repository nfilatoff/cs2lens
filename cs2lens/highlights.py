"""Highlights of a match: aces, multi-kills, won clutches, quick doubles and rare kills.

Found from the kill feed alone: who is alive is tracked kill by kill from the round's
rosters, so a clutch is the moment a player becomes the last one alive on their side.
Every highlight is one player in one round, with a time window (seconds after the freeze
end) that the app replays and exports as a clip. Custom highlights made in the app are
stored next to the extract in ``highlights.json``.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

import polars as pl

from cs2lens.context import Match, load_match, with_round

LEAD_SEC = 3.0  # clip starts this long before the first kill
TAIL_SEC = 2.0  # and ends this long after the last one
CLUTCH_TAIL_SEC = 4.0  # a clutch shows the end of the round (defuse, explosion), up to this long after the last kill
MAX_SEC = 60.0
QUICK_SEC = 3.0  # two kills this close make a quick double
SNIPERS = {"awp", "ssg08", "g3sg1", "scar20"}
BASE_SCORE = {"ace": 100, "4k": 75, "3k": 45, "clutch": 30, "double": 15, "special": 12}
CUT_LEAD = 1.5  # after a cut pause: seconds shown before the next kill
CUT_TAIL = 1.0  # before a cut pause: seconds shown after the kill
CUT_LEAD_FIRST = LEAD_SEC  # seconds before the first kill, when the wait before it is cut
NEIGHBOUR_GAP = 0.2  # seconds between two clips of a round: the game needs a moment between takes
CUSTOM_FILE = "highlights.json"
MAX_CUSTOM_SEC = 180.0


def _special(k: dict) -> list[str]:
    w = k["weapon"] or ""
    tags = []
    if k.get("noscope") and w in SNIPERS:
        tags.append("noscope")
    if (k.get("penetrated") or 0) > 0:
        tags.append("wallbang")
    if k.get("thrusmoke"):
        tags.append("thrusmoke")
    if w.startswith("knife") or w == "bayonet":
        tags.append("knife")
    if w == "taser":
        tags.append("zeus")
    return tags


def _round_highlights(m: Match, r: dict, kills: list[dict], rosters: dict[str, set[int]], names: dict[int, str], team_of: dict[int, str]) -> list[dict]:
    rate = m.tick_rate
    sec = lambda tick: round((tick - r["freeze_end_tick"]) / rate, 2)  # noqa: E731
    alive = {side: set(ids) for side, ids in rosters.items()}
    clutch: dict[str, tuple[int, int, int]] = {}  # side -> (steamid, enemies alive, tick)
    per_player: dict[int, list[dict]] = {}
    for k in kills:
        victim, attacker = k["victim_steamid"], k["attacker_steamid"]
        for ids in alive.values():
            ids.discard(victim)
        if attacker and k["attacker_side"] and k["attacker_side"] != k["victim_side"]:
            per_player.setdefault(attacker, []).append(k)
        for side, ids in alive.items():
            other = [s for s in alive if s != side]
            if side not in clutch and len(ids) == 1 and other:
                enemies = len(alive[other[0]])
                if enemies >= 1:
                    clutch[side] = (next(iter(ids)), enemies, k["tick"])

    out = []
    clutchers = {sid: (side, vs, tick) for side, (sid, vs, tick) in clutch.items() if side == r["winner_side"]}
    for sid in set(per_player) | set(clutchers):
        ks = per_player.get(sid, [])
        side = clutchers[sid][0] if sid in clutchers else ks[0]["attacker_side"]
        n = len(ks)
        tags = sorted({t for k in ks for t in _special(k)})
        quick = any(b["tick"] - a["tick"] <= QUICK_SEC * rate for a, b in zip(ks, ks[1:]))
        vs = clutchers[sid][1] if sid in clutchers else None
        kind = "ace" if n >= 5 else "4k" if n == 4 else "3k" if n == 3 else "clutch" if vs else "double" if quick else "special" if tags else None
        if kind is None:
            continue
        headshots = sum(bool(k["headshot"]) for k in ks)
        score = BASE_SCORE[kind] + (12 * vs if vs else 0) + 3 * len(tags) + (5 if n >= 3 and headshots == n else 0) + (10 if quick and n >= 3 else 0)
        ticks = [k["tick"] for k in ks]
        first = min(ticks + ([clutchers[sid][2]] if vs else []))
        last = max(ticks) if ticks else first
        start, end = sec(first) - LEAD_SEC, sec(last) + TAIL_SEC
        if vs:
            end = max(end, min(sec(r["end_tick"]), sec(last) + CLUTCH_TAIL_SEC))
        start = max(start, end - MAX_SEC, sec(r["start_tick"]))
        if quick:
            tags.append("quick")
        if n >= 3 and headshots == n:
            tags.append("all_hs")
        out.append({
            "id": f"r{r['round_num']}-{sid}",
            "kind": kind,
            "round": r["round_num"],
            "steamid": str(sid),
            "name": names.get(sid) or (ks[0]["attacker_name"] if ks else "?"),
            "team": team_of.get(sid),
            "side": side,
            "start": round(start, 2),
            "end": round(end, 2),
            "kills": n,
            "headshots": headshots,
            "weapons": [k["weapon"] for k in ks],
            "clutch": vs,
            "won": side == r["winner_side"],
            "tags": tags,
            "score": score,
            "kill_secs": [sec(t) for t in ticks],
        })
    return out


def highlights(directory: str | Path) -> list[dict]:
    """Automatic highlights of a match, best first."""
    m = load_match(directory)
    kills = with_round(m.data["kills"], m.rounds).sort("tick")
    names = dict(m.data["players"].select("steamid", "name").iter_rows())
    team_of = dict(m.teams.iter_rows())
    out = []
    for r in m.rounds.sort("round_num").iter_rows(named=True):
        rosters: dict[str, set[int]] = {}
        for team, side in m.sides.filter(pl.col("round_num") == r["round_num"]).select("team", "side").iter_rows():
            rosters.setdefault(side, set()).update(m.teams.filter(pl.col("team") == team)["steamid"].to_list())
        rk = kills.filter(pl.col("round_num") == r["round_num"]).to_dicts()
        out += _round_highlights(m, r, rk, rosters, names, team_of)
    return sorted(out, key=lambda h: (-h["score"], h["round"]))


def keep_ranges(start: float, end: float, kill_secs: list[float], gap: float | None) -> list[tuple[float, float]]:
    """What stays of a clip window when pauses longer than ``gap`` seconds between kills are cut:
    (from, to) in seconds from the window's start. One range means nothing is cut."""
    whole = [(0.0, round(end - start, 3))]
    kills = sorted(k for k in kill_secs if start <= k <= end)
    if not gap or not kills:
        return whole
    groups = [[kills[0]]]
    for k in kills[1:]:
        # what is shown around a cut has to fit into the pause, or the video would repeat itself
        if k - groups[-1][-1] > max(gap, CUT_LEAD + CUT_TAIL):
            groups.append([k])
        else:
            groups[-1].append(k)
    # a long wait before the first kill (a clutch shows its beginning) counts as a pause too
    first = kills[0] - CUT_LEAD_FIRST if kills[0] - start > gap + CUT_LEAD_FIRST else start
    ranges = []
    for i, g in enumerate(groups):
        a = first if i == 0 else g[0] - CUT_LEAD
        b = end if i == len(groups) - 1 else g[-1] + CUT_TAIL
        ranges.append((round(a - start, 3), round(b - start, 3)))
    return ranges


def kill_clips(directory: str | Path, steamid: str | int, merge_sec: float = 5.0) -> list[dict]:
    """Every kill of one player as a clip window, in game order; kills closer than ``merge_sec``
    in one round share a clip (a double is one clip, not two). Neighbouring windows of a round
    never overlap: they meet halfway between the kills."""
    m = load_match(directory)
    rate = m.tick_rate
    kills = (
        with_round(m.data["kills"], m.rounds)
        .filter((pl.col("attacker_steamid") == int(steamid)) & (pl.col("attacker_side") != pl.col("victim_side")))
        .sort("tick")
    )
    name = dict(m.data["players"].select("steamid", "name").iter_rows()).get(int(steamid), "?")
    groups: list[list[dict]] = []
    for k in kills.iter_rows(named=True):
        last = groups[-1][-1] if groups else None
        if last and last["round_num"] == k["round_num"] and k["tick"] - last["tick"] <= merge_sec * rate:
            groups[-1].append(k)
        else:
            groups.append([k])
    out = []
    for g in groups:
        sec = [(k["tick"] - k["freeze_end_tick"]) / rate for k in g]
        out.append({
            "id": f"k{g[0]['round_num']}-{g[0]['tick']}",
            "kind": "kills",
            "round": g[0]["round_num"],
            "steamid": str(steamid),
            "name": name,
            "start": round(sec[0] - LEAD_SEC, 2),
            "end": round(sec[-1] + TAIL_SEC, 2),
            "kills": len(g),
            "headshots": sum(bool(k["headshot"]) for k in g),
            "weapons": [k["weapon"] for k in g],
            "kill_secs": [round(x, 2) for x in sec],
        })
    for a, b in zip(out, out[1:]):
        if a["round"] == b["round"] and a["end"] + NEIGHBOUR_GAP > b["start"]:
            mid = (a["kill_secs"][-1] + b["kill_secs"][0]) / 2
            a["end"], b["start"] = round(mid - NEIGHBOUR_GAP / 2, 2), round(mid + NEIGHBOUR_GAP / 2, 2)
    return out


# ---- custom highlights ----
def load_custom(directory: str | Path) -> list[dict]:
    p = Path(directory) / CUSTOM_FILE
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("custom", [])
    except (ValueError, AttributeError):
        return []


def _save_custom(directory: Path, items: list[dict]) -> None:
    p = directory / CUSTOM_FILE
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"custom": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def add_custom(directory: str | Path, round_num: int, start: float, end: float, title: str = "", steamid: str | None = None) -> dict:
    """Store a highlight made in the app; raises ValueError on a bad round or window."""
    directory = Path(directory)
    rounds = pl.read_parquet(directory / "rounds.parquet", columns=["round_num"])["round_num"].to_list()
    if round_num not in rounds:
        raise ValueError(f"no round {round_num} in this match")
    if not (end > start and end - start <= MAX_CUSTOM_SEC and start >= -60):
        raise ValueError(f"the window must be 0-{int(MAX_CUSTOM_SEC)} s long")
    if steamid is not None and not str(steamid).isdigit():
        raise ValueError("bad steamid")
    title = " ".join(str(title).split())[:80]
    start, end, steamid = round(float(start), 2), round(float(end), 2), str(steamid) if steamid else None
    for h in load_custom(directory):  # saving the same moment twice keeps one highlight
        if (h["round"], h["start"], h["end"], h["steamid"], h["title"]) == (round_num, start, end, steamid, title):
            return h
    item = {
        "id": f"c{uuid.uuid4().hex[:10]}",
        "kind": "custom",
        "round": round_num,
        "steamid": steamid,
        "title": title,
        "start": start,
        "end": end,
        "created": int(time.time()),
    }
    _save_custom(directory, [*load_custom(directory), item])
    return item


def delete_custom(directory: str | Path, highlight_id: str) -> bool:
    directory = Path(directory)
    items = load_custom(directory)
    kept = [h for h in items if h.get("id") != highlight_id]
    if len(kept) == len(items):
        return False
    _save_custom(directory, kept)
    return True
