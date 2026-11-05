"""Tactical analysis: T executes, CT setups and CT rotations.

Positions are classified with the map config (``cs2lens.maps``): a point belongs to
site A when it is inside a zone of group ``A`` (the site and the CT positions around
it), and so on. Maps without a config fall back to a heuristic: site centres are the
mean plant positions in the demo (so both sites need a plant) and every radius is a
fraction of the A-B distance. A warning is issued when the fallback is used.
"""

from __future__ import annotations

import math
import warnings
from pathlib import Path

import numpy as np
import polars as pl

from cs2lens.context import Match, load_match, pct, with_round
from cs2lens.maps import MapConfig, load_map_config

SITE_RADIUS = 0.20  # fallback only: "on the site" radius, as a fraction of the A-B distance
DEFEND_RADIUS = 0.40  # fallback only: a CT closer than this to a site counts as holding it, else "mid"
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


class SiteZoner:
    """Classifies positions relative to the bomb sites.

    Uses the map config when it has both sites, else the plant-centre heuristic.
    Every method takes a frame with ``x``, ``y`` (and ``z`` when available) and returns a Series.
    """

    def __init__(self, m: Match):
        cfg = load_map_config(m.map_name)
        if cfg is not None and {s.name for s in cfg.sites} >= {"A", "B"}:
            self.cfg: MapConfig | None = cfg
            self.centers = cfg.site_centers()
        else:
            warnings.warn(
                f"{m.map_name}: no map config, using the plant-centre heuristic for sites (tuned on de_anubis)",
                stacklevel=2,
            )
            self.cfg = None
            self.centers = _site_centers(m)
            d_ab = math.dist(self.centers["A"], self.centers["B"])
            self.site_r, self.defend_r = SITE_RADIUS * d_ab, DEFEND_RADIUS * d_ab

    @staticmethod
    def _xyz(df: pl.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
        z = df["z"].cast(pl.Float64).to_numpy() if "z" in df.columns else None
        return df["x"].cast(pl.Float64).to_numpy(), df["y"].cast(pl.Float64).to_numpy(), z

    def _dists(self, df: pl.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        x, y, _ = self._xyz(df)
        (ax, ay), (bx, by) = self.centers["A"], self.centers["B"]
        return np.hypot(x - ax, y - ay), np.hypot(x - bx, y - by)

    def _groups(self, df: pl.DataFrame) -> np.ndarray:
        return np.array(self.cfg.group_of(*self._xyz(df)), dtype=object)

    def zone_names(self, df: pl.DataFrame) -> pl.Series:
        """Callout name for each row (``None`` without a config)."""
        if self.cfg is None or df.is_empty():
            return pl.Series("zone_name", [None] * df.height, dtype=pl.String)
        return pl.Series("zone_name", self.cfg.zone_of(*self._xyz(df)), dtype=pl.String)

    def site_area(self, df: pl.DataFrame) -> pl.Series:
        """``A``/``B`` when the point is on a site or a CT position around it, else ``None``.

        With a config, CT spawn counts for the nearer site (CT smokes in executes).
        """
        if df.is_empty():
            return pl.Series("site_area", [], dtype=pl.String)
        da, db = self._dists(df)
        if self.cfg is None:
            out = np.where(da <= self.site_r, "A", np.where(db <= self.site_r, "B", None))
        else:
            g = self._groups(df)
            out = np.where(np.isin(g, ["A", "B"]), g, np.where(g == "ct_spawn", np.where(da <= db, "A", "B"), None))
        return pl.Series("site_area", out.tolist(), dtype=pl.String)

    def holding(self, df: pl.DataFrame) -> pl.Series:
        """Where a CT plays: ``A``/``B`` (the site, around it or pushed into its approach), else ``M``."""
        if df.is_empty():
            return pl.Series("zone", [], dtype=pl.String)
        if self.cfg is None:
            da, db = self._dists(df)
            out = np.where(np.minimum(da, db) > self.defend_r, "M", np.where(da <= db, "A", "B"))
        else:
            g = self._groups(df)
            out = np.where(np.isin(g, ["A", "A_approach"]), "A", np.where(np.isin(g, ["B", "B_approach"]), "B", "M"))
        return pl.Series("zone", out.tolist(), dtype=pl.String)


def userid_map(m: Match) -> pl.DataFrame:
    """userid -> steamid, from weapon_fire events paired row by row with the shots table."""
    fires = m.event("weapon_fire")
    shots = m.data["shots"]
    if fires is None or fires.height != shots.height or (fires["tick"].cast(pl.Int32) != shots["tick"]).any():
        raise ValueError("cannot map event userids to steam ids (weapon_fire and shots do not line up)")
    return pl.DataFrame({"userid": fires["userid"], "steamid": shots["steamid"]}).unique()


def utility_events(m: Match, userids: pl.DataFrame) -> pl.DataFrame:
    """Every landed grenade: round, seconds since freeze end, type, position (x, y, z), thrower team and side."""
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
                    z=pl.col("z").cast(pl.Float64),
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
                rows.append((fire["start_tick"], throws[i][1], "molotov", float(fire["x"]), float(fire["y"]), float(fire["z"])))
        if rows:
            parts.append(pl.DataFrame(rows, schema=["tick", "userid", "type", "x", "y", "z"], orient="row"))

    util = pl.concat(
        [p.with_columns(pl.col("tick").cast(pl.Int32)) for p in parts]
    ).join(userids, on="userid").join(m.teams, on="steamid")
    util = with_round(util, m.rounds).join(m.sides, on=["round_num", "team"])
    return util.with_columns(sec=((pl.col("tick") - pl.col("freeze_end_tick")) / m.tick_rate).round(1))


def _positions_at(m: Match, rounds_ticks: pl.DataFrame) -> pl.DataFrame:
    """Living players at a per-round tick. ``rounds_ticks`` has ``round_num`` and ``at_tick``."""
    snap_ticks = rounds_ticks.select("round_num", snap_tick=m.snap_floor(pl.col("at_tick")))
    return (
        m.data["snapshots"]
        .select("tick", "steamid", "side", "x", "y", "z", "health")
        .filter(pl.col("health") > 0)
        .join(snap_ticks, left_on="tick", right_on="snap_tick")
        .join(m.teams, on="steamid")
        .with_columns(pl.col("x").cast(pl.Float64), pl.col("y").cast(pl.Float64))
    )


def _package_zones(package_util: pl.DataFrame) -> pl.DataFrame:
    """Per round, the callouts the execute utility landed in: ``smoke: CT Spawn, Jungle; flash: A Site``."""
    return (
        package_util.filter(pl.col("zone_name").is_not_null())
        .group_by("round_num", "type")
        .agg(pl.col("zone_name").unique().sort().str.join(", "))
        .sort("round_num", "type")
        .group_by("round_num", maintain_order=True)
        .agg(package_zones=pl.format("{}: {}", "type", "zone_name").str.join("; "))
    )


def _entry(m: Match, zoner: SiteZoner, t_rounds: pl.DataFrame, rate: float) -> pl.DataFrame:
    """Per round, where the living Ts were when the execute started: ``A Main 3, Palace Interior 2``.

    Without an execute start the reference is ``PACKAGE_SEC`` before the plant.
    """
    ref = t_rounds.select(
        "round_num", at_tick=pl.coalesce("exec_tick", (pl.col("plant_tick") - int(PACKAGE_SEC * rate)).cast(pl.Int32))
    ).filter(pl.col("at_tick").is_not_null())
    pos = _positions_at(m, ref).filter(pl.col("side") == "terrorist")
    pos = pos.with_columns(zoner.zone_names(pos)).filter(pl.col("zone_name").is_not_null())
    return (
        pos.group_by("round_num", "zone_name")
        .len()
        .sort("round_num", "len", "zone_name", descending=[False, True, False])
        .group_by("round_num", maintain_order=True)
        .agg(entry=pl.format("{} {}", "zone_name", "len").str.join(", "))
    )


def tactics(directory: str | Path) -> dict[str, pl.DataFrame]:
    """Compute tactical tables.

    Returns ``rounds_t`` (one row per T round), ``executes`` (per team and target site),
    ``executes_by_buy`` (the same per type of round), ``setups`` (CT setups with round results) and ``rotations`` (per CT team).
    """
    m = load_match(directory, extra_tables=("damages", "fires", "shots"))
    zoner = SiteZoner(m)
    rate = m.tick_rate

    util = utility_events(m, userid_map(m))
    util = util.with_columns(zoner.site_area(util).fill_null("other").alias("zone"), zoner.zone_names(util))

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
    package_util = t_util.join(t_rounds.select("round_num", "plant_site", "exec_tick"), on="round_num").filter(
        (pl.col("zone") == pl.col("plant_site"))
        & (pl.col("tick") >= pl.col("exec_tick"))
        & (pl.col("tick") <= pl.col("plant_tick"))
    )
    package = (
        package_util
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
    )
    t_rounds = t_rounds.join(_package_zones(package_util), on="round_num", how="left").join(
        _entry(m, zoner, t_rounds, rate), on="round_num", how="left"
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

    executes_by_buy = (
        t_rounds.filter(pl.col("target_site").is_not_null())
        .group_by("team", "buy", "target_site")
        .agg(
            rounds=pl.len(),
            wins=pl.col("won").sum(),
            plants=pl.col("plant_site").is_not_null().sum(),
            avg_exec_start_sec=pl.col("exec_sec").mean().round(1),
            avg_plant_sec=pl.col("plant_sec").mean().round(1),
        )
        .with_columns(win_pct=pct(pl.col("wins"), pl.col("rounds")))
        .sort("team", "buy", "target_site")
    )

    # ---- CT side: setup at SETUP_SEC after freeze end, or at first contact if that comes first ----
    ct_rounds = m.tr.filter(pl.col("side") == "counter-terrorist").select("round_num", "team", "won", "buy").join(
        contact.select("round_num", "contact_tick"), on="round_num", how="left"
    ).join(plants.select("round_num", "plant_site", "plant_tick"), on="round_num", how="left")
    ct_rounds = ct_rounds.join(m.rounds.select("round_num", "freeze_end_tick"), on="round_num").with_columns(
        at_tick=pl.min_horizontal(pl.col("freeze_end_tick") + int(SETUP_SEC * rate), pl.col("contact_tick").fill_null(10**9)).cast(pl.Int32)
    )
    pos = _positions_at(m, ct_rounds.select("round_num", "at_tick"))
    pos = pos.filter(pl.col("side") == "counter-terrorist")
    pos = pos.with_columns(zoner.holding(pos))
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
    at_contact = at_contact.join(rot_rounds.select("round_num", "plant_site", "ref_tick", "plant_tick"), on="round_num")
    at_contact = at_contact.with_columns(zoner.site_area(at_contact))
    rotators = at_contact.filter(pl.col("site_area").is_null() | (pl.col("site_area") != pl.col("plant_site"))).select(
        "round_num", "steamid", "team", "plant_site", "ref_tick", "plant_tick"
    )
    later = (
        m.data["snapshots"].select("tick", "steamid", "x", "y", "z", "health").filter(pl.col("health") > 0)
        .with_columns(pl.col("x").cast(pl.Float64), pl.col("y").cast(pl.Float64))
    )
    arrivals = rotators.join(later, on="steamid").filter(pl.col("tick") > pl.col("ref_tick"))
    arrivals = (
        arrivals.with_columns(zoner.site_area(arrivals))
        .filter(pl.col("site_area") == pl.col("plant_site"))
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

    return {"rounds_t": t_rounds, "executes": executes, "executes_by_buy": executes_by_buy, "setups": setups, "rotations": rotations}
