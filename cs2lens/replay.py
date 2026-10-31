"""Compact per-round replay data for the app's 2D replay.

One round becomes a JSON document with a shared tick grid and per-player arrays
(``x``, ``y``, ``z``, ``yaw``, ``hp``, ...), inventory changes, grenade trajectories, smokes
and fires with their real lifetimes, blinds, kills with duel details, bomb events and shots
with their direction and hit point. Documents are cached gzipped in
``<extract>/replay/round_<n>.v<FORMAT>.json.gz``.

Frames come from ``replay.parquet`` (every few ticks, written by ``extract``); older
extracts without it fall back to the 0.5 s snapshots. Inventories always come from the snapshots (they change rarely).
"""

from __future__ import annotations

import gzip
import json
from functools import lru_cache
from pathlib import Path

import polars as pl

from cs2lens.context import Match, load_match

FORMAT = 4  # bump when the document changes; old cache files are then ignored
PRE_FREEZE_SEC = 20.0  # replay starts at most this long before freeze end
POST_END_SEC = 4.0  # and runs this long after the round end (capped by the official end)
GRENADE_STEP = 2  # keep every n-th tick of grenade trajectories
THROWER_RADIUS = 120.0  # a player this close to a grenade's first position threw it
NON_GUNS = ("knife", "bayonet", "grenade", "flashbang", "molotov", "decoy", "c4")  # no tracer for these
INV_COLUMNS = ["primary_weapon", "secondary_weapon", "smoke_grenades", "flashbangs", "he_grenades", "fire_grenades", "decoy_grenades", "inventory"]


def cache_path(directory: Path, round_num: int) -> Path:
    return directory / "replay" / f"round_{round_num}.v{FORMAT}.json.gz"


@lru_cache(maxsize=2)
def _match(directory: Path, _stamp: float) -> Match:
    """The loaded match, kept while rounds of it are built (the clip builder asks for many at once)."""
    return load_match(directory, extra_tables=("smokes", "fires", "grenades", "blinds", "shots", "damages"))


def round_payload(directory: str | Path, round_num: int) -> bytes:
    """Gzipped JSON replay of one round, built once and then read from the cache."""
    directory = Path(directory)
    path = cache_path(directory, round_num)
    stamp = (directory / "manifest.json").stat().st_mtime
    if path.exists() and path.stat().st_mtime >= stamp:
        return path.read_bytes()
    doc = build_round(_match(directory, stamp), round_num)
    data = gzip.compress(json.dumps(doc, separators=(",", ":")).encode("utf-8"), compresslevel=6)
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(data)
    return data


def _in(df: pl.DataFrame, col: str, lo: int, hi: int) -> pl.DataFrame:
    return df.filter((pl.col(col) >= lo) & (pl.col(col) <= hi))


def _ints(s: pl.Series) -> list:
    return s.cast(pl.Float64).round(0).cast(pl.Int32).to_list()


def build_round(m: Match, round_num: int) -> dict:
    """Replay document for one round of a loaded match."""
    row = m.rounds.filter(pl.col("round_num") == round_num)
    if row.is_empty():
        raise KeyError(f"round {round_num} not found (knife rounds are excluded)")
    info = row.row(0, named=True)
    rate = m.tick_rate
    raw = m.data["rounds"].filter(pl.col("round_num") == round_num).row(0, named=True)
    start = max(int(info["start_tick"]), int(info["freeze_end_tick"] - PRE_FREEZE_SEC * rate))
    end = int(info["end_tick"] + POST_END_SEC * rate)
    if raw.get("official_end_tick"):
        end = min(end, int(raw["official_end_tick"]))

    frames_path = m.directory / "replay.parquet"
    if frames_path.exists():
        frames = pl.scan_parquet(frames_path).filter(pl.col("tick").is_between(start, end)).collect()
        step = int(frames["tick"].unique().sort().diff().drop_nulls().min() or 1)
    else:
        frames = _in(m.data["snapshots"], "tick", start, end)
        step = m.snap_step
    frames = frames.filter(pl.col("steamid").is_not_null() & (pl.col("steamid") != 0))
    ticks = frames["tick"].unique().sort()

    sides = m.sides.filter(pl.col("round_num") == round_num).select("team", "side")
    roster = (
        frames.group_by("steamid").agg(
            pl.col("name").drop_nulls().last(), pl.col("side").drop_nulls().mode().first(), hp=pl.col("health").max()
        )
        .join(m.teams, on="steamid", how="left")
        .filter(pl.col("side").is_in(["terrorist", "counter-terrorist"]) & (pl.col("hp") > 0))
        .sort("side", "name")
    )
    # Coaches have a pawn on the team (alive, in spawn) but no stats row.
    played = m.data["stats"]["steamid"]
    if played.len():
        roster = roster.filter(pl.col("steamid").is_in(played.implode()))
    weapons = sorted(w for w in frames["active_weapon"].unique().to_list() if w)
    weapon_idx = {w: i for i, w in enumerate(weapons)}
    grid = pl.DataFrame({"tick": ticks})

    players = []
    for p in roster.iter_rows(named=True):
        f = grid.join(frames.filter(pl.col("steamid") == p["steamid"]), on="tick", how="left")
        alive = f["health"].fill_null(0) > 0
        players.append({
            "steamid": str(p["steamid"]),
            "name": p["name"],
            "team": p["team"],
            "side": p["side"],
            "x": _ints(f["x"]),
            "y": _ints(f["y"]),
            "z": _ints(f["z"]),
            "yaw": _ints(f["yaw"]),
            "hp": f["health"].fill_null(0).to_list(),
            "armor": f["armor"].fill_null(0).to_list(),
            "helmet": f["has_helmet"].fill_null(False).cast(pl.Int8).to_list() if "has_helmet" in f.columns else None,
            "kit": f["has_defuser"].fill_null(False).cast(pl.Int8).to_list() if "has_defuser" in f.columns else None,
            "bomb": f["has_bomb"].fill_null(False).cast(pl.Int8).to_list(),
            "weapon": [weapon_idx.get(w, -1) if a else -1 for w, a in zip(f["active_weapon"].to_list(), alive.to_list())],
            "defusing": f["is_defusing"].fill_null(False).cast(pl.Int8).to_list() if "is_defusing" in f.columns else None,
            "money": int(f["money"].drop_nulls().first()) if "money" in f.columns and f["money"].drop_nulls().len() else None,
        })

    inventories = _inventories(m, start, end, roster["steamid"])
    items: dict[tuple, int] = {}
    for p in players:
        changes = inventories.get(int(p["steamid"]))
        p["inv"] = [[t, items.setdefault(inv, len(items))] for t, inv in changes] if changes else None

    names = {int(p["steamid"]): p["name"] for p in players}
    return {
        "format": FORMAT,
        "map": m.map_name,
        "round": round_num,
        "tick_rate": rate,
        "start_tick": start,
        "freeze_end_tick": int(info["freeze_end_tick"]),
        "end_tick": int(info["end_tick"]),
        "last_tick": end,
        "winner_side": info["winner_side"],
        "reason": info["reason_name"],
        "step": step,
        "low_res": not frames_path.exists(),
        "ticks": ticks.to_list(),
        "teams": {r["side"]: r["team"] for r in sides.iter_rows(named=True)},
        "weapons": weapons,
        "items": [list(inv) for inv in items],
        "players": players,
        "grenades": _grenades(m, start, end, frames),
        "smokes": _areas(m.data["smokes"], start, end),
        "fires": _areas(m.data["fires"], start, end),
        "blinds": [
            {"tick": r["tick"], "attacker": str(r["attacker_steamid"]), "victim": str(r["victim_steamid"]), "duration": round(float(r["duration"]), 2)}
            for r in _in(m.data["blinds"], "tick", start, end).iter_rows(named=True)
        ],
        "kills": [
            {
                "tick": r["tick"],
                "attacker": str(r["attacker_steamid"]) if r["attacker_steamid"] else None,
                "victim": str(r["victim_steamid"]),
                "assister": str(r["assister_steamid"]) if r["assister_steamid"] else None,
                "attacker_name": r["attacker_name"],
                "victim_name": r["victim_name"],
                "attacker_side": r["attacker_side"],
                "victim_side": r["victim_side"],
                "weapon": r["weapon"],
                "headshot": bool(r["headshot"]),
                "thrusmoke": bool(r["thrusmoke"]),
                "noscope": bool(r["noscope"]),
                "wallbang": bool(r["penetrated"]),
                "flashed": bool(r["assist_flash"]),
                "ax": _r(r["attacker_x"]), "ay": _r(r["attacker_y"]), "az": _r(r["attacker_z"]),
                "vx": _r(r["victim_x"]), "vy": _r(r["victim_y"]), "vz": _r(r["victim_z"]),
                "assister_name": r["assister_name"],
                "hitgroup": r["hitgroup_name"] or r["hitgroup"],
                "trade": bool(r["is_trade"]),
                "traded": bool(r["victim_traded"]),
                **_duel(m, r, start, frames),
            }
            for r in _in(m.data["kills"], "tick", start, end).sort("tick").iter_rows(named=True)
        ],
        "bomb": [
            {"tick": r["tick"], "event": r["event"], "site": r["bombsite"], "player": names.get(r["steamid"]),
             "x": _r(r["x"]), "y": _r(r["y"]), "z": _r(r["z"])}
            for r in _in(m.data["bomb"], "tick", start, end).sort("tick").iter_rows(named=True)
        ],
        "shots": _shots(m, start, end),
    }


def _r(v) -> int | None:
    return None if v is None else round(float(v))


def _areas(df: pl.DataFrame, start: int, end: int) -> list[dict]:
    rows = df.filter((pl.col("start_tick") <= end) & (pl.col("end_tick") >= start))
    return [
        {"start": r["start_tick"], "end": r["end_tick"], "x": _r(r["x"]), "y": _r(r["y"]), "z": _r(r["z"])}
        for r in rows.sort("start_tick").iter_rows(named=True)
    ]


def _grenades(m: Match, start: int, end: int, frames: pl.DataFrame) -> list[dict]:
    """Flight paths per grenade entity; the thrower is the nearest player to the first point."""
    g = _in(m.data["grenades"], "tick", start, end).sort("tick")
    if g.is_empty():
        return []
    paths = (
        g.group_by("entity_id", "entity_serial", maintain_order=True)
        .agg(
            pl.col("type").first(),
            pl.col("tick").gather_every(GRENADE_STEP).alias("t"),
            pl.col("x").gather_every(GRENADE_STEP),
            pl.col("y").gather_every(GRENADE_STEP),
            pl.col("z").gather_every(GRENADE_STEP),
            last_tick=pl.col("tick").last(),
            first_tick=pl.col("tick").first(),
            fx=pl.col("x").first(),
            fy=pl.col("y").first(),
        )
    )
    alive = frames.filter(pl.col("health") > 0).select("tick", "steamid", "side", "x", "y")
    frame_ticks = alive["tick"].unique().sort()
    out = []
    for r in paths.iter_rows(named=True):
        thrower, side = None, None
        if frame_ticks.len():
            idx = min(frame_ticks.search_sorted(r["first_tick"]), frame_ticks.len() - 1)
            near = alive.filter(pl.col("tick") == frame_ticks[idx]).with_columns(
                d=((pl.col("x") - r["fx"]) ** 2 + (pl.col("y") - r["fy"]) ** 2).sqrt()
            ).sort("d")
            if near.height and near["d"][0] <= THROWER_RADIUS:
                thrower, side = str(near["steamid"][0]), near["side"][0]
        out.append({
            "type": r["type"],
            "thrower": thrower,
            "side": side,
            "t": r["t"],
            "x": [round(v) for v in r["x"]],
            "y": [round(v) for v in r["y"]],
            "z": [round(v) for v in r["z"]],
            "end": r["last_tick"],
        })
    return out


def _inventories(m: Match, start: int, end: int, steamids: pl.Series) -> dict[int, list[tuple[int, tuple]]]:
    """Per player, the ticks where the inventory changes and the new inventory.

    An inventory is ``(primary, secondary, *grenades)``; a grenade appears once per carried copy.
    """
    snaps = m.data["snapshots"]
    if any(c not in snaps.columns for c in INV_COLUMNS):
        return {}
    s = _in(snaps, "tick", start, end).filter(pl.col("steamid").is_in(steamids.implode()) & (pl.col("health") > 0)).sort("tick")
    out: dict[int, list[tuple[int, tuple]]] = {}
    for r in s.select("tick", "steamid", *INV_COLUMNS).iter_rows(named=True):
        inv = r["inventory"] or ""
        fire = "incendiary" if "incendiary" in inv else "molotov"
        key = (
            r["primary_weapon"], r["secondary_weapon"],
            *["smokegrenade"] * (r["smoke_grenades"] or 0), *["flashbang"] * (r["flashbangs"] or 0),
            *["hegrenade"] * (r["he_grenades"] or 0), *[fire] * (r["fire_grenades"] or 0), *["decoy"] * (r["decoy_grenades"] or 0),
        )
        changes = out.setdefault(r["steamid"], [])
        if not changes or changes[-1][1] != key:
            changes.append((r["tick"], key))
    return out


def _duel(m: Match, kill: dict, start: int, frames: pl.DataFrame) -> dict:
    """Damage both ways between killer and victim this round, distance, killer HP and the victim's weapon."""
    a, v, tick = kill["attacker_steamid"], kill["victim_steamid"], kill["tick"]
    dmg = m.data["damages"].filter(pl.col("tick").is_between(start, tick)) if "damages" in m.data else None
    out: dict = {"dist": None, "attacker_hp": None, "victim_weapon": None, "given": [0, 0], "taken": [0, 0], "duel_start": None}
    if None not in (kill["attacker_x"], kill["victim_x"]):
        out["dist"] = round(((kill["attacker_x"] - kill["victim_x"]) ** 2 + (kill["attacker_y"] - kill["victim_y"]) ** 2
                             + (kill["attacker_z"] - kill["victim_z"]) ** 2) ** 0.5)
    if a and a != v and dmg is not None:
        given = dmg.filter((pl.col("attacker_steamid") == a) & (pl.col("victim_steamid") == v))
        taken = dmg.filter((pl.col("attacker_steamid") == v) & (pl.col("victim_steamid") == a))
        out["given"] = [given.height, int(given["dmg_health"].sum())]
        out["taken"] = [taken.height, int(taken["dmg_health"].sum())]
        both = pl.concat([given["tick"], taken["tick"]])
        out["duel_start"] = int(both.min()) if both.len() else None
        hurt = dmg.filter(pl.col("victim_steamid") == a)
        out["attacker_hp"] = int(hurt["health_post"].min()) if hurt.height else 100
    last = frames.filter((pl.col("steamid") == v) & (pl.col("tick") <= tick) & (pl.col("health") > 0)).sort("tick").tail(1)
    if last.height:
        out["victim_weapon"] = last["active_weapon"][0]
    return out


def _shots(m: Match, start: int, end: int) -> dict:
    """Gun shots: shooter, position, view yaw and, when it hit someone on the same tick, the victim's position."""
    s = _in(m.data["shots"], "tick", start, end).with_columns(weapon=pl.col("weapon").str.replace("^weapon_", ""))
    s = s.filter(~pl.col("weapon").str.contains("|".join(NON_GUNS))).sort("tick")
    if "damages" in m.data:
        hits = (
            _in(m.data["damages"], "tick", start, end)
            .select("tick", steamid=pl.col("attacker_steamid"), hx=pl.col("victim_x"), hy=pl.col("victim_y"))
            .unique(["tick", "steamid"], keep="first")
        )
        s = s.join(hits, on=["tick", "steamid"], how="left")
    else:
        s = s.with_columns(hx=pl.lit(None, pl.Float64), hy=pl.lit(None, pl.Float64))
    return {
        "tick": s["tick"].to_list(),
        "player": [str(v) for v in s["steamid"].to_list()],
        "x": _ints(s["x"]),
        "y": _ints(s["y"]),
        "yaw": _ints(s["yaw"]),
        "hx": [None if v is None else round(v) for v in s["hx"].to_list()],
        "hy": [None if v is None else round(v) for v in s["hy"].to_list()],
    }
