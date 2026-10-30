"""Tactical analysis: T executes, CT setups and CT rotations.

Bomb sites are not hard-coded per map: their centres are the mean plant positions
seen in the demo, so every distance threshold is relative to the A-B distance.
Both sites therefore need at least one plant in the demo.
"""

from __future__ import annotations

import math
from pathlib import Path

import polars as pl

from cs2lens.context import Match, load_match, pct, with_round

SITE_RADIUS = 0.20  # "on the site" radius, as a fraction of the A-B distance
DEFEND_RADIUS = 0.40  # a CT closer than this to a site counts as holding it, else "mid"
SETUP_SEC = 15.0  # CT setup is sampled this long after freeze end (or at first contact if earlier)
EARLY_SEC = 30.0  # execute start (first T utility on the target site) before this: early; at or after LATE_SEC: late
LATE_SEC = 60.0
PACKAGE_SEC = 25.0  # rotation reference when no T utility landed on the site: this long before the plant

_UTIL_EVENTS = [("smokegrenade_detonate", "smoke"), ("flashbang_detonate", "flash"), ("hegrenade_detonate", "he")]
_MOLOTOV_WEAPONS = ("molotov", "incgrenade")


def _site_centers(m: Match) -> dict[str, tuple[float, float]]:
    centers = (
        m.data["bomb"]
        .filter(pl.col("event") == "finish_plant")
        .group_by("bombsite")
        .agg(x=pl.col("x").cast(pl.Float64).mean(), y=pl.col("y").cast(pl.Float64).mean())
    )
    found = {r["bombsite"]: (r["x"], r["y"]) for r in centers.iter_rows(named=True)}
    if set(found) != {"A", "B"}:
        raise ValueError(f"need a plant on both sites to locate them, found {sorted(found)}")
    return found


def _site_dist(x: pl.Expr, y: pl.Expr, site: tuple[float, float]) -> pl.Expr:
    return ((x - site[0]) ** 2 + (y - site[1]) ** 2).sqrt()


def userid_map(m: Match) -> pl.DataFrame:
    """userid -> steamid, from weapon_fire events paired row by row with the shots table."""
    fires = m.event("weapon_fire")
    shots = m.data["shots"]
    if fires is None or fires.height != shots.height or (fires["tick"].cast(pl.Int32) != shots["tick"]).any():
        raise ValueError("cannot map event userids to steam ids (weapon_fire and shots do not line up)")
    return pl.DataFrame({"userid": fires["userid"], "steamid": shots["steamid"]}).unique()


def utility_events(m: Match, userids: pl.DataFrame) -> pl.DataFrame:
    """Every landed grenade: round, seconds since freeze end, type, position, thrower team and side."""
    parts = []
    for name, kind in _UTIL_EVENTS:
        ev = m.event(name)
        if ev is not None:
            parts.append(
                ev.select(
                    "tick",
                    "userid",
                    type=pl.lit(kind),
                    x=pl.col("x").cast(pl.Float64),
                    y=pl.col("y").cast(pl.Float64),
                )
            )

    # Molotov/incendiary fires carry no thrower: pair each with the latest unmatched throw before it.
    thrown = m.event("grenade_thrown")
    if thrown is not None:
        throws = (
            thrown.filter(pl.col("weapon").is_in(_MOLOTOV_WEAPONS))
            .select(tick=pl.col("tick").cast(pl.Int32), userid="userid")
            .sort("tick")
            .rows()
        )
        used: set[int] = set()
        rows = []
        for fire in m.data["fires"].sort("start_tick").iter_rows(named=True):
            cands = [i for i, (t, _) in enumerate(throws) if i not in used and fire["start_tick"] - 6 * m.tick_rate <= t <= fire["start_tick"]]
            if cands:
                i = cands[-1]
                used.add(i)
                rows.append((fire["start_tick"], throws[i][1], "molotov", float(fire["x"]), float(fire["y"])))
        if rows:
            parts.append(pl.DataFrame(rows, schema=["tick", "userid", "type", "x", "y"], orient="row"))

    util = pl.concat(
        [p.with_columns(pl.col("tick").cast(pl.Int32)) for p in parts]
    ).join(userids, on="userid").join(m.teams, on="steamid")
    util = with_round(util, m.rounds).join(m.sides, on=["round_num", "team"])
    return util.with_columns(sec=((pl.col("tick") - pl.col("freeze_end_tick")) / m.tick_rate).round(1))


def _positions_at(m: Match, rounds_ticks: pl.DataFrame) -> pl.DataFrame:
    """Living players at a per-round tick. ``rounds_ticks`` has ``round_num`` and ``at_tick``."""
    step = m.snap_step
    snap_ticks = rounds_ticks.select("round_num", snap_tick=(pl.col("at_tick") // step) * step)
    return (
        m.data["snapshots"]
        .select("tick", "steamid", "side", "x", "y", "z", "health")
        .filter(pl.col("health") > 0)
        .join(snap_ticks, left_on="tick", right_on="snap_tick")
        .join(m.teams, on="steamid")
        .with_columns(pl.col("x").cast(pl.Float64), pl.col("y").cast(pl.Float64))
    )


def tactics(directory: str | Path) -> dict[str, pl.DataFrame]:
    """Compute tactical tables.

    Returns ``rounds_t`` (one row per T round), ``executes`` (per team and target site),
    ``setups`` (CT setups with round results) and ``rotations`` (per CT team).
    """
    m = load_match(directory, extra_tables=("damages", "fires", "shots"))
    sites = _site_centers(m)
    d_ab = math.dist(sites["A"], sites["B"])
    site_r, defend_r = SITE_RADIUS * d_ab, DEFEND_RADIUS * d_ab
    rate = m.tick_rate

    util = utility_events(m, userid_map(m))
    util = util.with_columns(
        dA=_site_dist(pl.col("x"), pl.col("y"), sites["A"]), dB=_site_dist(pl.col("x"), pl.col("y"), sites["B"])
    ).with_columns(
        zone=pl.when(pl.col("dA") <= site_r).then(pl.lit("A")).when(pl.col("dB") <= site_r).then(pl.lit("B")).otherwise(pl.lit("other"))
    )

    # Plants, first contact (first cross-side damage) and the teams per round.
    bomb = with_round(m.data["bomb"].select("tick", "event", "bombsite"), m.rounds)
    plants = bomb.filter(pl.col("event") == "finish_plant").select(
        "round_num", plant_site="bombsite", plant_tick="tick", plant_sec=((pl.col("tick") - pl.col("freeze_end_tick")) / rate).round(1)
    )
    contact = (
        with_round(
            m.data["damages"].filter(pl.col("attacker_side").is_not_null() & (pl.col("attacker_side") != pl.col("victim_side"))),
            m.rounds,
        )
        .group_by("round_num")
        .agg(contact_tick=pl.col("tick").min(), freeze_end=pl.col("freeze_end_tick").first())
        .select("round_num", "contact_tick", contact_sec=((pl.col("contact_tick") - pl.col("freeze_end")) / rate).round(1))
    )

    # ---- T side: one row per round with target site, tempo and utility package ----
    t_rounds = (
        m.tr.filter(pl.col("side") == "terrorist")
        .select("round_num", "team", "won", "buy")
        .join(plants, on="round_num", how="left")
        .join(contact, on="round_num", how="left")
    )
    t_util = util.filter(pl.col("side") == "terrorist").join(plants.select("round_num", "plant_tick"), on="round_num", how="left")
    # Utility before the plant (or all of the round's utility when nothing was planted).
    pre = t_util.filter(pl.col("plant_tick").is_null() | (pl.col("tick") <= pl.col("plant_tick")))
    by_zone = pre.group_by("round_num", "zone").len().filter(pl.col("zone") != "other")
    lead = by_zone.sort("len", descending=True).group_by("round_num", maintain_order=True).first().select("round_num", util_site="zone")

    t_rounds = (
        t_rounds.join(lead, on="round_num", how="left")
        .with_columns(target_site=pl.coalesce("plant_site", "util_site"))
    )
    exec_start = (
        pre.join(t_rounds.select("round_num", "target_site"), on="round_num")
        .filter(pl.col("zone") == pl.col("target_site"))
        .group_by("round_num")
        .agg(exec_tick=pl.col("tick").min(), exec_sec=pl.col("sec").min())
    )
    t_rounds = t_rounds.join(exec_start, on="round_num", how="left").with_columns(
        tempo=pl.when(pl.col("exec_sec").is_null()).then(pl.lit("no utility"))
        .when(pl.col("exec_sec") < EARLY_SEC).then(pl.lit("early"))
        .when(pl.col("exec_sec") < LATE_SEC).then(pl.lit("mid"))
        .otherwise(pl.lit("late"))
    )

    # Execute package: utility landed on the planted site from the execute start up to the plant.
    package = (
        t_util.join(t_rounds.select("round_num", "plant_site", "exec_tick"), on="round_num")
        .filter(
            (pl.col("zone") == pl.col("plant_site"))
            & (pl.col("tick") >= pl.col("exec_tick"))
            & (pl.col("tick") <= pl.col("plant_tick"))
        )
        .group_by("round_num")
        .agg(
            smokes=(pl.col("type") == "smoke").sum(),
            flashes=(pl.col("type") == "flash").sum(),
            mollies=(pl.col("type") == "molotov").sum(),
            hes=(pl.col("type") == "he").sum(),
        )
    )
    t_rounds = t_rounds.join(package, on="round_num", how="left").with_columns(
        pl.col(c).fill_null(0) for c in ("smokes", "flashes", "mollies", "hes")
    ).with_columns(
        pl.when(pl.col("plant_site").is_null()).then(None)
        .otherwise(pl.format("{}s {}f {}m {}h", "smokes", "flashes", "mollies", "hes")).alias("package")
    ).sort("team", "round_num")

    executes = (
        t_rounds.filter(pl.col("target_site").is_not_null())
        .group_by("team", "target_site")
        .agg(
            rounds=pl.len(),
            wins=pl.col("won").sum(),
            plants=pl.col("plant_site").is_not_null().sum(),
            avg_exec_start_sec=pl.col("exec_sec").mean().round(1),
            avg_plant_sec=pl.col("plant_sec").mean().round(1),
            smokes=pl.col("smokes").sum(),
            flashes=pl.col("flashes").sum(),
            mollies=pl.col("mollies").sum(),
            hes=pl.col("hes").sum(),
            early=(pl.col("tempo") == "early").sum(),
            mid=(pl.col("tempo") == "mid").sum(),
            late=(pl.col("tempo") == "late").sum(),
        )
        .with_columns(win_pct=pct(pl.col("wins"), pl.col("rounds")))
        .sort("team", "target_site")
    )

    # ---- CT side: setup at SETUP_SEC after freeze end, or at first contact if that comes first ----
    ct_rounds = m.tr.filter(pl.col("side") == "counter-terrorist").select("round_num", "team", "won", "buy").join(
        contact.select("round_num", "contact_tick"), on="round_num", how="left"
    ).join(plants.select("round_num", "plant_site", "plant_tick"), on="round_num", how="left")
    ct_rounds = ct_rounds.join(m.rounds.select("round_num", "freeze_end_tick"), on="round_num").with_columns(
        at_tick=pl.min_horizontal(pl.col("freeze_end_tick") + int(SETUP_SEC * rate), pl.col("contact_tick").fill_null(10**9)).cast(pl.Int32)
    )
    pos = _positions_at(m, ct_rounds.select("round_num", "at_tick"))
    pos = pos.filter(pl.col("side") == "counter-terrorist").with_columns(
        dA=_site_dist(pl.col("x"), pl.col("y"), sites["A"]), dB=_site_dist(pl.col("x"), pl.col("y"), sites["B"])
    ).with_columns(
        zone=pl.when(pl.min_horizontal("dA", "dB") > defend_r).then(pl.lit("M"))
        .when(pl.col("dA") <= pl.col("dB")).then(pl.lit("A")).otherwise(pl.lit("B"))
    )
    counts = pos.group_by("round_num").agg(
        a=(pl.col("zone") == "A").sum(), b=(pl.col("zone") == "B").sum(), mid=(pl.col("zone") == "M").sum()
    )
    setups = (
        ct_rounds.join(counts, on="round_num", how="left")
        .with_columns(setup=pl.format("A{} B{} M{}", "a", "b", "mid"))
        .select("round_num", "team", "setup", "a", "b", "mid", "plant_site", "won", "buy")
        .sort("team", "round_num")
    )

    # ---- Rotations: CTs away from the planted site when the execute starts who later reach it ----
    rot_rounds = (
        ct_rounds.filter(pl.col("plant_site").is_not_null())
        .join(t_rounds.select("round_num", "exec_tick"), on="round_num", how="left")
        .with_columns(ref_tick=pl.coalesce("exec_tick", (pl.col("plant_tick") - int(PACKAGE_SEC * rate)).cast(pl.Int32)))
    )
    at_contact = _positions_at(m, rot_rounds.select("round_num", at_tick=pl.col("ref_tick"))).filter(pl.col("side") == "counter-terrorist")
    at_contact = at_contact.join(rot_rounds.select("round_num", "plant_site", "ref_tick", "plant_tick"), on="round_num").with_columns(
        d_site=pl.when(pl.col("plant_site") == "A")
        .then(_site_dist(pl.col("x"), pl.col("y"), sites["A"]))
        .otherwise(_site_dist(pl.col("x"), pl.col("y"), sites["B"]))
    )
    rotators = at_contact.filter(pl.col("d_site") > site_r).select("round_num", "steamid", "team", "plant_site", "ref_tick", "plant_tick")
    later = (
        m.data["snapshots"].select("tick", "steamid", "x", "y", "health").filter(pl.col("health") > 0)
        .with_columns(pl.col("x").cast(pl.Float64), pl.col("y").cast(pl.Float64))
    )
    arrivals = (
        rotators.join(later, on="steamid")
        .filter(pl.col("tick") > pl.col("ref_tick"))
        .with_columns(
            d_site=pl.when(pl.col("plant_site") == "A")
            .then(_site_dist(pl.col("x"), pl.col("y"), sites["A"]))
            .otherwise(_site_dist(pl.col("x"), pl.col("y"), sites["B"]))
        )
        .filter(pl.col("d_site") <= site_r)
        .join(m.rounds.select("round_num", "end_tick"), on="round_num")
        .filter(pl.col("tick") <= pl.col("end_tick"))
        .group_by("round_num", "steamid")
        .agg(arrive_tick=pl.col("tick").min())
    )
    rotator_rows = rotators.join(arrivals, on=["round_num", "steamid"], how="left").with_columns(
        rot_sec=((pl.col("arrive_tick") - pl.col("ref_tick")) / rate).round(1),
        before_plant=pl.col("arrive_tick") <= pl.col("plant_tick"),
    )
    per_round = rotator_rows.group_by("round_num", "team").agg(
        rotators=pl.len(),
        arrived=pl.col("arrive_tick").is_not_null().sum(),
        arrived_before_plant=pl.col("before_plant").fill_null(False).sum(),
        avg_rot_sec=pl.col("rot_sec").mean(),
    )
    rotations = (
        rot_rounds.select("round_num", "team", "won", "plant_site")
        .join(per_round, on=["round_num", "team"], how="left")
        .with_columns(pl.col("rotators", "arrived", "arrived_before_plant").fill_null(0))
        .group_by("team", "plant_site")
        .agg(
            plants_faced=pl.len(),
            retake_wins=pl.col("won").sum(),
            avg_rotators=pl.col("rotators").mean().round(2),
            avg_arrived=pl.col("arrived").mean().round(2),
            avg_before_plant=pl.col("arrived_before_plant").mean().round(2),
            avg_rot_sec=pl.col("avg_rot_sec").mean().round(1),
        )
        .with_columns(retake_win_pct=pct(pl.col("retake_wins"), pl.col("plants_faced")))
        .sort("team", "plant_site")
    )

    return {"rounds_t": t_rounds, "executes": executes, "setups": setups, "rotations": rotations}
