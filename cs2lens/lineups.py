"""Every grenade throw of a match as a lineup: where the thrower stood, where they aimed,
how they threw it and where it landed, plus CS2 console commands and practice configs.

A throw is the ``weapon_fire`` of a grenade (``shots``): the thrower's feet position and
view angles at release. It is paired with the flight path from ``grenades`` that starts
within ``MATCH_TICKS`` after it, of the same type and closest to the thrower. The
technique comes from the replay frames around the release: a rise of the feet above the
ground means a jump throw, the horizontal speed separates standing, walking and running.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import polars as pl

from cs2lens.context import Match, load_match, with_round
from cs2lens.maps import load_map_config

WEAPON_TYPE = {
    "weapon_smokegrenade": "smoke",
    "weapon_flashbang": "flashbang",
    "weapon_hegrenade": "he",
    "weapon_molotov": "molotov",
    "weapon_incgrenade": "molotov",
    "weapon_decoy": "decoy",
}
MATCH_TICKS = 32  # the flight path starts at most this long after the release
MATCH_DIST = 160.0  # and its first point is this close to the thrower (xy)
JUMP_RISE = 8.0  # feet this far above the lowest point around the release: jump throw
WINDOW = 24  # ticks around the release used for the technique
RUN_SPEED = 170.0  # units/s
WALK_SPEED = 40.0
TECHNIQUES = {"stand": "stand", "walk": "walk", "run": "run", "jump": "jumpthrow", "run_jump": "run jumpthrow"}


def throws(directory: str | Path) -> pl.DataFrame:
    """One row per grenade throw of the match (knife rounds excluded)."""
    m = load_match(directory, extra_tables=("shots", "grenades"))
    rate = m.tick_rate
    shots = m.data["shots"].filter(pl.col("weapon").is_in(list(WEAPON_TYPE)))
    t = (
        with_round(shots.select("tick", "steamid", "name", "side", "x", "y", "z", "pitch", "yaw", "weapon"), m.rounds)
        .with_columns(type=pl.col("weapon").replace_strict(WEAPON_TYPE), sec=((pl.col("tick") - pl.col("freeze_end_tick")) / rate).round(1))
        .join(m.teams, on="steamid", how="left")
        .with_row_index("throw")
    )
    paths = _paths(m)
    t = _pair(t, paths, rate)
    t = _technique(m, t)

    cfg = load_map_config(m.map_name)
    if cfg is not None and t.height:
        t = t.with_columns(
            throw_zone=pl.Series(cfg.zone_of(t["x"].to_numpy(), t["y"].to_numpy(), t["z"].to_numpy()), dtype=pl.String),
            land_zone=pl.Series(cfg.zone_of(t["land_x"].fill_null(-1e7).to_numpy(), t["land_y"].fill_null(-1e7).to_numpy(),
                                            t["land_z"].fill_null(0).to_numpy()), dtype=pl.String),
        )
    else:
        t = t.with_columns(throw_zone=pl.lit(None, pl.String), land_zone=pl.lit(None, pl.String))
    return t.select(
        id=pl.format("{}-{}-{}", "round_num", "tick", "steamid"),
        round_num="round_num", tick="tick", sec="sec", steamid="steamid", name="name", team="team", side="side",
        type="type", weapon="weapon", technique="technique", speed=pl.col("speed").round(0),
        x=pl.col("x").round(2), y=pl.col("y").round(2), z=pl.col("ground_z").round(2),
        pitch=pl.col("pitch").round(2), yaw=pl.col("yaw").round(2),
        land_x=pl.col("land_x").round(1), land_y=pl.col("land_y").round(1), land_z=pl.col("land_z").round(1),
        flight_sec=pl.col("flight_sec").round(2), throw_zone="throw_zone", land_zone="land_zone",
    ).sort("round_num", "tick")


def _paths(m: Match) -> pl.DataFrame:
    g = m.data["grenades"].sort("tick")
    return g.group_by("entity_id", "entity_serial").agg(
        ptype=pl.col("type").first(),
        first_tick=pl.col("tick").first(),
        fx=pl.col("x").first(), fy=pl.col("y").first(),
        land_tick=pl.col("tick").last(),
        land_x=pl.col("x").last(), land_y=pl.col("y").last(), land_z=pl.col("z").last(),
    )


def _pair(t: pl.DataFrame, paths: pl.DataFrame, rate: float) -> pl.DataFrame:
    """Attach the flight path of each throw; every path is used once (closest pairs first)."""
    cand = (
        t.select("throw", "tick", "type", "x", "y")
        .join(paths, left_on="type", right_on="ptype")
        .filter((pl.col("first_tick") >= pl.col("tick")) & (pl.col("first_tick") <= pl.col("tick") + MATCH_TICKS))
        .with_columns(d=((pl.col("fx") - pl.col("x")) ** 2 + (pl.col("fy") - pl.col("y")) ** 2).sqrt())
        .filter(pl.col("d") <= MATCH_DIST)
        .sort("d", "first_tick")
    )
    used_t, used_p, keep = set(), set(), []
    for r in cand.select("throw", "entity_id", "entity_serial", "first_tick").iter_rows():
        if r[0] in used_t or (r[1], r[2], r[3]) in used_p:
            continue
        used_t.add(r[0])
        used_p.add((r[1], r[2], r[3]))
        keep.append(r)
    pairs = pl.DataFrame(keep, schema=["throw", "entity_id", "entity_serial", "first_tick"], orient="row",
                         schema_overrides={"throw": pl.UInt32, "entity_id": cand.schema["entity_id"],
                                           "entity_serial": cand.schema["entity_serial"], "first_tick": cand.schema["first_tick"]})
    pairs = pairs.join(paths, on=["entity_id", "entity_serial", "first_tick"]).select("throw", "land_tick", "land_x", "land_y", "land_z")
    return t.join(pairs, on="throw", how="left").with_columns(
        flight_sec=(pl.col("land_tick") - pl.col("tick")) / rate,
    )


def _technique(m: Match, t: pl.DataFrame) -> pl.DataFrame:
    """Technique, speed at release and the ground height under the thrower."""
    path = m.directory / "replay.parquet"
    if not path.exists() or not t.height:
        return t.with_columns(technique=pl.lit(None, pl.String), speed=pl.lit(None, pl.Float64), ground_z=pl.col("z"))
    ids = t["steamid"].unique().implode()
    lo, hi = int(t["tick"].min()) - WINDOW, int(t["tick"].max()) + WINDOW
    frames = (
        pl.scan_parquet(path).select("tick", "steamid", "x", "y", "z")
        .filter(pl.col("steamid").is_in(ids) & pl.col("tick").is_between(lo, hi))
        .collect().sort("steamid", "tick")
    )
    by_player = {sid: (g["tick"].to_numpy(), g["x"].to_numpy(), g["y"].to_numpy(), g["z"].to_numpy())
                 for (sid,), g in frames.group_by("steamid")}
    tech, speed, ground = [], [], []
    for sid, tick, z in t.select("steamid", "tick", "z").iter_rows():
        f = by_player.get(sid)
        if f is None:
            tech.append(None), speed.append(None), ground.append(z)
            continue
        ticks, xs, ys, zs = f
        win = (ticks >= tick - WINDOW) & (ticks <= tick + WINDOW)
        before = np.nonzero((ticks <= tick) & win)[0]
        if len(before) < 3:
            tech.append(None), speed.append(None), ground.append(z)
            continue
        i, j = before[-1], before[-3]  # release frame and two frames earlier
        dt = (ticks[i] - ticks[j]) / m.tick_rate
        v = float(np.hypot(xs[i] - xs[j], ys[i] - ys[j]) / dt) if dt > 0 else 0.0
        low = float(zs[before].min())  # ground before the release; a drop after it is not a jump
        jumping = z - low > JUMP_RISE
        moving = "run" if v > RUN_SPEED else "walk" if v > WALK_SPEED else "stand"
        tech.append(("run_jump" if moving == "run" else "jump") if jumping else moving)
        speed.append(v)
        ground.append(low if jumping else z)  # take-off height for setpos
    return t.with_columns(technique=pl.Series(tech, dtype=pl.String), speed=pl.Series(speed, dtype=pl.Float64),
                          ground_z=pl.Series(ground, dtype=pl.Float64))


# ---- CS2 commands and configs ----

GIVE = set(WEAPON_TYPE)
MAP_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_UNSAFE = re.compile(r"[^A-Za-z0-9 _\-.,!?#+/()]")


def safe_text(text: str | None, limit: int = 60) -> str:
    """ASCII text safe inside ``echo``: no quotes, ``;`` or ``//``, which the console would interpret."""
    s = _UNSAFE.sub(" ", text or "")
    while "//" in s:
        s = s.replace("//", "/")
    s = " ".join(s.split())
    return s[: limit - 2] + ".." if len(s) > limit else s


def lineup_commands(lineup: dict) -> list[str]:
    """setpos / setang / give for one lineup (``x, y, z, pitch, yaw, weapon``)."""
    weapon = lineup["weapon"] if lineup.get("weapon") in GIVE else "weapon_smokegrenade"
    x, y, z, pitch, yaw = (float(lineup[k]) for k in ("x", "y", "z", "pitch", "yaw"))
    return [f"setpos {x:.2f} {y:.2f} {z:.2f}", f"setang {pitch:.2f} {yaw:.2f} 0", f"give {weapon}", f"use {weapon}"]


def console_string(lineup: dict) -> str:
    """One line to paste into the CS2 console on a local server."""
    return "; ".join(["sv_cheats 1", *lineup_commands(lineup)])


PRACTICE = [
    "// Local practice server: cheats for setpos / setang / give",
    "sv_cheats 1",
    "sv_infinite_ammo 1",
    "ammo_grenade_limit_total 5",
    "sv_grenade_trajectory_prac_pipreview 1",
    "sv_showimpacts 0",
    "mp_roundtime_defuse 60",
    "mp_freezetime 0",
    "mp_buy_anywhere 1",
    "mp_buytime 9999",
    "mp_warmup_end",
    "bot_kick",
]


def lineup_cfg(map_name: str, lineup: dict, label: str) -> str:
    """``cs2lens_lineup.cfg``: practice settings, then teleport to one lineup."""
    lines = [
        "// cs2lens - one grenade lineup",
        f"// Map: {map_name}. Run on a local server:  exec cs2lens_lineup",
        "",
        *PRACTICE,
        "",
        *lineup_commands(lineup),
        f"echo cs2lens: {safe_text(label)}",
    ]
    return "\n".join(lines) + "\n"


def list_cfg(map_name: str, name: str, lineups: list[dict], next_key: str = "]", prev_key: str = "[") -> str:
    """A practice list: one alias per lineup, ``next_key`` / ``prev_key`` cycle through them."""
    n = len(lineups)
    if not n:
        raise ValueError("no lineups")
    lines = [
        f"// cs2lens - {n} grenade lineups on {map_name}: {safe_text(name)}",
        f"// 1. Start a local server:  map {map_name}",
        f"// 2. In the console:  exec {cfg_name(name)}",
        f"// 3. {next_key} - next lineup, {prev_key} - previous lineup",
        "",
        *PRACTICE,
        "",
    ]
    for i, lu in enumerate(lineups, start=1):
        nxt, prv = i % n + 1, (i - 2) % n + 1
        body = "; ".join([
            *lineup_commands(lu),
            f"echo [{i}/{n}] {safe_text(lu.get('label'))}",
            f"alias cs2lens_next cs2lens_{nxt}",
            f"alias cs2lens_prev cs2lens_{prv}",
        ])
        lines.append(f'alias cs2lens_{i} "{body}"')
    lines += ["", f'bind "{next_key}" "cs2lens_next"', f'bind "{prev_key}" "cs2lens_prev"', "cs2lens_1", ""]
    return "\n".join(lines)


def cfg_name(name: str) -> str:
    """``cs2lens_<slug>``: the file name (without .cfg) and the ``exec`` argument."""
    slug = re.sub(r"[^a-z0-9_]+", "_", (name or "list").lower()).strip("_")[:40] or "list"
    return f"cs2lens_{slug}"
