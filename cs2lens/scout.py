"""Opponent dossier: what a team does on a map over its last matches and how to read it fast.

``match_data`` turns one extract into per-round tables for both teams (slow, cached by the
app per match). ``dossier`` selects the rounds of one team under a context (side, buy, last N
rounds) and computes every table and conclusion from them, so all the numbers of a report
always refer to the same rounds. Conclusions are data (a key, parameters, sample size, example
rounds); the interface words them in its language.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import polars as pl

from cs2lens.context import Match, load_match, pct, round_context, with_round
from cs2lens.tactics import SiteZoner, tactics, userid_map, utility_events

LOW_SAMPLE = 5  # fewer rounds than this: the conclusion is marked as thin
MAX_CARDS = 7
MAX_EXAMPLES = 6
START_SEC = 15.0  # a player's "start" in a round: their position this long after the freeze end
ENTER_MIN_SEC = 2.0  # already in the zone just after the freeze end: spawning, not going there
TIMING_BIN = 5  # seconds per column of the timing grid
TIMING_MAX = 115
NEAREST_MAX_SEC = 60.0  # team spacing is measured over the set-up part of a round
JACCARD = 0.5  # a round joins a strat when it shares this much of the strat's grenades
SIGNATURE_TYPES = ("smoke", "molotov")  # flashes and HEs vary too much to identify a strat
BUY_ORDER = {"pistol": 0, "eco": 1, "force": 2, "full": 3}
T, CT = "terrorist", "counter-terrorist"


@dataclass
class MatchData:
    """Per-round tables of one match; ``team`` holds the names as they are in the demo."""

    id: str
    map: str
    date: float
    rounds: pl.DataFrame  # (round, team): context plus T tactics and CT setup
    utility: pl.DataFrame  # every grenade: round, team, side, sec, type, x, y, z, zone
    entries: pl.DataFrame  # first time a team reaches a zone in a round: round, team, side, zone, sec
    players: pl.DataFrame  # (round, player): kills, deaths, trades, openings, damage, spacing
    weapons: pl.DataFrame  # (round, player, weapon): kills
    starts: pl.DataFrame  # (round, player): position START_SEC after the freeze end
    visits: pl.DataFrame  # (round, player, zone): the zones a player went through
    warnings: list[str] = field(default_factory=list)


_T_COLS = ["target_site", "plant_site", "plant_sec", "exec_sec", "tempo", "package", "package_zones", "entry", "smokes", "flashes", "mollies", "hes"]
_NULL_T = {"target_site": pl.String, "plant_site": pl.String, "plant_sec": pl.Float64, "exec_sec": pl.Float64, "tempo": pl.String, "package": pl.String,
           "package_zones": pl.String, "entry": pl.String, "smokes": pl.Int64, "flashes": pl.Int64, "mollies": pl.Int64, "hes": pl.Int64}


def _with_tactics(ctx: pl.DataFrame, directory: Path) -> tuple[pl.DataFrame, list[str]]:
    """Context rows plus the T-side and CT-side columns of ``tactics``; null columns when they cannot be computed."""
    notes: list[str] = []
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            tac = tactics(directory)
        notes += [str(w.message) for w in caught]
    except ValueError as e:
        notes.append(str(e))
        return ctx.with_columns(*[pl.lit(None, t).alias(c) for c, t in _NULL_T.items()], setup=pl.lit(None, pl.String)), notes
    out = ctx.join(tac["rounds_t"].select("round_num", "team", *_T_COLS), on=["round_num", "team"], how="left")
    return out.join(tac["setups"].select("round_num", "team", "setup"), on=["round_num", "team"], how="left"), notes


def _zoner(m: Match) -> SiteZoner | None:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return SiteZoner(m)
    except ValueError:  # no config and no plants on both sites
        return None


def _utility(m: Match, zoner: SiteZoner | None) -> pl.DataFrame:
    empty = pl.DataFrame(schema={"round_num": pl.Int32, "team": pl.String, "side": pl.String, "sec": pl.Float64, "type": pl.String,
                                 "x": pl.Float64, "y": pl.Float64, "z": pl.Float64, "zone": pl.String})
    try:
        util = utility_events(m, userid_map(m))
    except ValueError:
        return empty
    zones = zoner.zone_names(util) if zoner else pl.Series("zone_name", [None] * util.height, dtype=pl.String)
    return util.with_columns(zones.alias("zone")).select(empty.columns)


def _positions(m: Match, zoner: SiteZoner | None) -> pl.DataFrame:
    """Living players at every snapshot of the live part of the rounds, with zone, team and seconds."""
    f = with_round(m.data["snapshots"].select("tick", "steamid", "name", "side", "x", "y", "z", "health").filter(pl.col("health") > 0), m.rounds)
    f = f.filter(pl.col("tick") >= pl.col("freeze_end_tick")).join(m.teams, on="steamid").with_columns(
        sec=((pl.col("tick") - pl.col("freeze_end_tick")) / m.tick_rate).round(1),
        x=pl.col("x").cast(pl.Float64), y=pl.col("y").cast(pl.Float64), z=pl.col("z").cast(pl.Float64),
    )
    zones = zoner.zone_names(f) if zoner else pl.Series("zone_name", [None] * f.height, dtype=pl.String)
    return f.with_columns(zones.alias("zone"))


def _nearest(pos: pl.DataFrame) -> pl.DataFrame:
    """Per (round, player): mean distance to the nearest living teammate over the set-up part of the round."""
    p = pos.filter(pl.col("sec") <= NEAREST_MAX_SEC).select("round_num", "tick", "team", "steamid", "x", "y")
    pairs = p.join(p, on=["round_num", "tick", "team"], suffix="_o").filter(pl.col("steamid") != pl.col("steamid_o"))
    return (
        pairs.with_columns(d=((pl.col("x") - pl.col("x_o")) ** 2 + (pl.col("y") - pl.col("y_o")) ** 2).sqrt())
        .group_by("round_num", "tick", "steamid").agg(pl.col("d").min())
        .group_by("round_num", "steamid").agg(nearest=pl.col("d").mean())
    )


def _player_rounds(m: Match, pos: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Per-round player rows and per-round kills by weapon; cross-team events only."""
    teams_a = m.teams.rename({"steamid": "attacker_steamid", "team": "att_team"})
    teams_v = m.teams.rename({"steamid": "victim_steamid", "team": "vic_team"})
    kills = (
        with_round(m.data["kills"], m.rounds).join(teams_a, on="attacker_steamid", how="left").join(teams_v, on="victim_steamid", how="left")
        .filter(pl.col("att_team").is_not_null() & pl.col("vic_team").is_not_null() & (pl.col("att_team") != pl.col("vic_team")))
    )
    kills = kills.with_columns(opening=pl.col("tick") == pl.col("tick").min().over("round_num"))
    by_att = kills.group_by("round_num", steamid="attacker_steamid").agg(
        kills=pl.len(), trade_kills=pl.col("is_trade").sum(), opening_kills=pl.col("opening").sum(), headshots=pl.col("headshot").sum())
    by_vic = kills.group_by("round_num", steamid="victim_steamid").agg(
        deaths=pl.len(), traded_deaths=pl.col("victim_traded").sum(), opening_deaths=pl.col("opening").sum())
    dmg = (
        with_round(m.data["damages"].filter(pl.col("attacker_side") != pl.col("victim_side")), m.rounds)
        .group_by("round_num", steamid="attacker_steamid").agg(damage=pl.col("dmg_health").sum())
    )
    base = pos.group_by("round_num", "steamid").agg(pl.col("name").last(), pl.col("team").first(), pl.col("side").first())
    counters = ["kills", "trade_kills", "opening_kills", "headshots", "deaths", "traded_deaths", "opening_deaths", "damage"]
    players = (
        base.join(by_att, on=["round_num", "steamid"], how="left").join(by_vic, on=["round_num", "steamid"], how="left")
        .join(dmg, on=["round_num", "steamid"], how="left").join(_nearest(pos), on=["round_num", "steamid"], how="left")
        .with_columns(pl.col(c).fill_null(0).cast(pl.Int64) for c in counters)
    )
    weapons = (
        kills.group_by("round_num", steamid="attacker_steamid", team="att_team", weapon=pl.col("weapon").str.replace("^weapon_", ""))
        .agg(kills=pl.len())
        .join(base.select("round_num", "steamid", "name"), on=["round_num", "steamid"], how="left")
    )
    return players, weapons


def match_data(directory: str | Path, date: float = 0.0) -> MatchData:
    directory = Path(directory)
    m = load_match(directory, extra_tables=("fires", "shots", "damages"))
    rounds, notes = _with_tactics(round_context(m), directory)
    zoner = _zoner(m)
    pos = _positions(m, zoner)
    entries = (
        pos.filter(pl.col("zone").is_not_null())
        .group_by("round_num", "team", "side", "zone").agg(pl.col("sec").min())
        .filter(pl.col("sec") >= ENTER_MIN_SEC)
    )
    starts = (
        pos.filter(pl.col("sec") <= START_SEC).sort("sec")
        .group_by("round_num", "steamid", maintain_order=True).last()
        .select("round_num", "steamid", "name", "team", "side", "x", "y", "z", "zone", "sec")
    )
    visits = pos.filter(pl.col("zone").is_not_null()).select("round_num", "steamid", "side", "zone").unique()
    players, weapons = _player_rounds(m, pos)
    return MatchData(
        id=directory.name, map=m.map_name, date=date, rounds=rounds, utility=_utility(m, zoner), entries=entries,
        players=players, weapons=weapons, starts=starts, visits=visits, warnings=notes,
    )


# ---- selection ----


@dataclass
class Selection:
    """The rounds of one team under a context, as stacked tables with a ``match`` column; team names are canonical."""

    team: str
    rounds: pl.DataFrame
    utility: pl.DataFrame
    entries: pl.DataFrame
    players: pl.DataFrame
    weapons: pl.DataFrame
    starts: pl.DataFrame
    visits: pl.DataFrame
    matches: list[MatchData]


def _stack(frames: list[pl.DataFrame]) -> pl.DataFrame:
    return pl.concat(frames, how="diagonal_relaxed")


def select_rounds(
    matches: list[MatchData], team: str, aliases: dict[str, str] | None = None,
    side: str = "", buy: str = "", rounds_last: int = 0,
) -> Selection:
    """``matches`` newest first. ``rounds_last`` keeps only the latest N rounds that pass the other filters."""
    aliases = aliases or {}
    canon = lambda df: df.with_columns(pl.col("team").replace(aliases))  # noqa: E731
    tagged = lambda md, df: canon(df).filter(pl.col("team") == team).with_columns(match=pl.lit(md.id))  # noqa: E731
    used = [md for md in matches if team in {aliases.get(t, t) for t in md.rounds["team"].unique().to_list()}]
    if not used:
        raise ValueError(f"no matches of {team}")
    rounds = _stack([
        tagged(md, md.rounds).with_columns(match_no=pl.lit(i), date=pl.lit(md.date)) for i, md in enumerate(used)
    ]).sort("match_no", "round_num", descending=[False, True])
    if side:
        rounds = rounds.filter(pl.col("side") == side)
    if buy:
        rounds = rounds.filter(pl.col("buy") == buy)
    if rounds_last > 0:
        rounds = rounds.head(rounds_last)
    keys = rounds.select("match", "round_num")

    def part(name: str) -> pl.DataFrame:
        return _stack([tagged(md, getattr(md, name)) for md in used]).join(keys, on=["match", "round_num"], how="semi")

    players = part("players")
    # visits carry no team: the player's rounds in the selection say whose they are
    visits = _stack([md.visits.with_columns(match=pl.lit(md.id)) for md in used]).join(
        players.select("match", "round_num", "steamid"), on=["match", "round_num", "steamid"], how="semi"
    )
    return Selection(
        team=team, rounds=rounds, utility=part("utility"), entries=part("entries"), players=players, weapons=part("weapons"),
        starts=part("starts"), visits=visits, matches=used,
    )


# ---- tables ----


def _example(r: dict, sec: float | None = None) -> dict:
    """A round to open in the replay; ``sec`` is a few seconds before what the conclusion is about."""
    return {"match": r["match"], "round": r["round_num"], "sec": max(0, int(sec) - 3) if sec is not None else 0}


def _examples(df: pl.DataFrame, sec_col: str | None = None) -> list[dict]:
    return [_example(r, r[sec_col] if sec_col else None) for r in df.head(MAX_EXAMPLES).iter_rows(named=True)]


def _win_table(df: pl.DataFrame, keys: list[str]) -> pl.DataFrame:
    return (
        df.group_by(keys).agg(rounds=pl.len(), wins=pl.col("won").sum(), avg_equip=pl.col("equip").mean().round(0))
        .with_columns(win_pct=pct(pl.col("wins"), pl.col("rounds")))
        .sort(keys)
    )


def economy(s: Selection) -> dict[str, pl.DataFrame]:
    """How the team buys and fares by the previous rounds."""
    r = s.rounds
    after = r.filter(pl.col("after_pistol_loss").is_not_null()).with_columns(
        pistol=pl.when(pl.col("after_pistol_loss")).then(pl.lit("loss")).otherwise(pl.lit("win"))
    )
    after_pistol = _win_table(after, ["pistol", "buy"]).with_columns(
        share_pct=pct(pl.col("rounds"), pl.col("rounds").sum().over("pistol"))
    )
    buckets = r.filter(~pl.col("is_pistol")).with_columns(streak=pl.col("loss_streak").clip(0, 3))
    streak = _win_table(buckets, ["streak", "buy"]).with_columns(share_pct=pct(pl.col("rounds"), pl.col("rounds").sum().over("streak")))
    return {"by_buy": _win_table(r, ["side", "buy"]), "after_pistol": after_pistol, "loss_streak": streak}


def executes_by_buy(s: Selection) -> pl.DataFrame:
    """Which site the team goes for on each type of round (T side)."""
    t = s.rounds.filter((pl.col("side") == T) & pl.col("target_site").is_not_null())
    return (
        t.group_by("buy", "target_site")
        .agg(
            rounds=pl.len(), wins=pl.col("won").sum(), plants=pl.col("plant_site").is_not_null().sum(),
            avg_exec_sec=pl.col("exec_sec").mean().round(1), avg_plant_sec=pl.col("plant_sec").mean().round(1),
            early=(pl.col("tempo") == "early").sum(), mid=(pl.col("tempo") == "mid").sum(), late=(pl.col("tempo") == "late").sum(),
        )
        .with_columns(win_pct=pct(pl.col("wins"), pl.col("rounds")), share_pct=pct(pl.col("rounds"), pl.col("rounds").sum().over("buy")))
        .sort("buy", "rounds", descending=[False, True])
    )


def player_table(s: Selection) -> pl.DataFrame:
    """Per player, over the selected rounds: rates, trade rates and spacing."""
    if s.players.is_empty():
        return pl.DataFrame()
    best = (
        s.weapons.group_by("steamid", "weapon").agg(pl.col("kills").sum())
        .sort("kills", descending=True).group_by("steamid", maintain_order=True)
        .agg(top_weapons=pl.format("{} {}", "weapon", "kills").head(3).str.join(", "), awp_kills=pl.col("kills").filter(pl.col("weapon") == "awp").sum())
    )
    return (
        s.players.group_by("steamid")
        .agg(
            pl.col("name").last(), rounds=pl.len(), matches=pl.col("match").n_unique(),
            *[pl.col(c).sum() for c in ("kills", "deaths", "headshots", "trade_kills", "traded_deaths", "opening_kills", "opening_deaths", "damage")],
            nearest_mate=pl.col("nearest").mean().round(0),
        )
        .join(best, on="steamid", how="left")
        .with_columns(
            kd=(pl.col("kills") / pl.max_horizontal(pl.col("deaths"), 1)).round(2),
            adr=(pl.col("damage") / pl.col("rounds")).round(1),
            kpr=(pl.col("kills") / pl.col("rounds")).round(2),
            trade_kill_pct=pct(pl.col("trade_kills"), pl.col("kills")),
            traded_death_pct=pct(pl.col("traded_deaths"), pl.col("deaths")),
            opening_win_pct=pct(pl.col("opening_kills"), pl.col("opening_kills") + pl.col("opening_deaths")),
            hs_pct=pct(pl.col("headshots"), pl.col("kills")),
        )
        .select("steamid", "name", "matches", "rounds", "kills", "deaths", "kd", "adr", "kpr", "hs_pct", "opening_kills", "opening_deaths",
                "opening_win_pct", "trade_kill_pct", "traded_death_pct", "nearest_mate", "top_weapons", "awp_kills")
        .sort("adr", descending=True)
    )


def weapon_table(s: Selection) -> pl.DataFrame:
    """Kills by weapon for each player."""
    if s.weapons.is_empty():
        return pl.DataFrame()
    return (
        s.weapons.group_by("steamid", "weapon").agg(pl.col("name").drop_nulls().last(), pl.col("kills").sum())
        .with_columns(share_pct=pct(pl.col("kills"), pl.col("kills").sum().over("steamid")))
        .sort("name", "kills", descending=[False, True])
    )


def nade_table(s: Selection) -> pl.DataFrame:
    """The team's usual grenades: how often a type lands in a zone per round of that side, and when."""
    u = s.utility.filter(pl.col("zone").is_not_null())
    if u.is_empty():
        return pl.DataFrame()
    per_side = s.rounds.group_by("side").agg(side_rounds=pl.len())
    per_round = u.group_by("match", "round_num", "side", "type", "zone").agg(sec=pl.col("sec").min())
    return (
        per_round.group_by("side", "type", "zone").agg(rounds=pl.len(), median_sec=pl.col("sec").median().round(1))
        .join(per_side, on="side")
        .with_columns(per_round_pct=pct(pl.col("rounds"), pl.col("side_rounds")))
        .sort("rounds", descending=True)
    )


def setup_table(s: Selection) -> pl.DataFrame:
    ct = s.rounds.filter((pl.col("side") == CT) & pl.col("setup").is_not_null())
    if ct.is_empty():
        return pl.DataFrame()
    return (
        ct.group_by("setup").agg(rounds=pl.len(), wins=pl.col("won").sum())
        .with_columns(win_pct=pct(pl.col("wins"), pl.col("rounds")), share_pct=pct(pl.col("rounds"), pl.col("rounds").sum()))
        .sort("rounds", descending=True)
    )


def timings(s: Selection) -> dict:
    """The grid "zone x second": in how many rounds something first happened there in each time bin.

    ``kind`` is a grenade type or ``enter`` (the first player of the team reaching the zone).
    """
    nades = (
        s.utility.filter(pl.col("zone").is_not_null())
        .group_by("match", "round_num", "side", "zone", kind="type").agg(sec=pl.col("sec").min())
    )
    enters = s.entries.select("match", "round_num", "side", "zone", kind=pl.lit("enter"), sec=pl.col("sec").cast(nades.schema["sec"]))
    events = pl.concat([nades, enters]).filter(pl.col("sec").is_between(0, TIMING_MAX, closed="left"))
    cells = []
    if events.height:
        events = events.with_columns(bin=(pl.col("sec") // TIMING_BIN * TIMING_BIN).cast(pl.Int32)).sort("sec")
        for (side, zone, kind, b), g in events.group_by("side", "zone", "kind", "bin", maintain_order=True):
            cells.append({"side": side, "zone": zone, "kind": kind, "bin": b, "rounds": g.height, "examples": _examples(g, "sec")})
    totals = {r["side"]: r["len"] for r in s.rounds.group_by("side").len().iter_rows(named=True)}
    return {"step": TIMING_BIN, "max": TIMING_MAX, "cells": cells, "totals": totals}


def _signature(u: pl.DataFrame) -> set[str]:
    return {f"{t}:{z}" for t, z in u.select("type", "zone").unique().iter_rows()}


def playbook(s: Selection) -> dict:
    """T rounds grouped into recurring strats: the same site with mostly the same smokes and molotovs."""
    t = s.rounds.filter((pl.col("side") == T) & pl.col("target_site").is_not_null()).sort("match_no", "round_num")
    util = s.utility.filter((pl.col("side") == T) & pl.col("zone").is_not_null())
    parts = {k: g for k, g in util.group_by("match", "round_num")}
    entries = []
    for r in t.iter_rows(named=True):
        u = parts.get((r["match"], r["round_num"]))
        if u is None:
            sig: set[str] = set()
            nades: pl.DataFrame | None = None
        else:
            if r["plant_sec"] is not None:
                u = u.filter(pl.col("sec") <= r["plant_sec"])
            sig = _signature(u.filter(pl.col("type").is_in(SIGNATURE_TYPES)))
            nades = u
        entries.append((r, sig, nades))

    # Largest signatures first, so a strat grows around its fullest version.
    clusters: list[dict] = []
    for r, sig, nades in sorted(entries, key=lambda e: (-len(e[1]), e[0]["match_no"], e[0]["round_num"])):
        best, best_score = None, 0.0
        for c in clusters:
            if c["site"] != r["target_site"]:
                continue
            core = c["core"]
            score = 1.0 if not sig and not core else (len(sig & core) / len(sig | core) if sig | core else 0.0)
            if score >= JACCARD and score > best_score:
                best, best_score = c, score
        if best is None:
            best = {"site": r["target_site"], "core": set(sig), "members": []}
            clusters.append(best)
        best["members"].append((r, sig, nades))
        counts: dict[str, int] = {}
        for _, member_sig, _ in best["members"]:
            for item in member_sig:
                counts[item] = counts.get(item, 0) + 1
        best["core"] = {k for k, v in counts.items() if v * 2 >= len(best["members"])}

    strats = []
    one_offs = sum(len(c["members"]) == 1 for c in clusters)
    for c in sorted((c for c in clusters if len(c["members"]) >= 2), key=lambda c: -len(c["members"])):
        rows = [m[0] for m in c["members"]]
        n = len(rows)
        counts = {}
        for _, member_sig, _ in c["members"]:
            for item in member_sig:
                counts[item] = counts.get(item, 0) + 1
        core = sorted(({"type": k.split(":", 1)[0], "zone": k.split(":", 1)[1], "share_pct": round(v / n * 100)} for k, v in counts.items() if v * 2 >= n),
                      key=lambda x: (-x["share_pct"], x["type"], x["zone"]))
        tempos = {}
        for r in rows:
            tempos[r["tempo"]] = tempos.get(r["tempo"], 0) + 1
        nade_rows = [m[2] for m in c["members"] if m[2] is not None]
        spots = pl.concat(nade_rows).select("type", "x", "y", "z").to_dicts() if nade_rows else []
        exec_secs = [r["exec_sec"] for r in rows if r["exec_sec"] is not None]
        plant_secs = [r["plant_sec"] for r in rows if r["plant_sec"] is not None]
        strats.append({
            "id": len(strats) + 1, "site": c["site"], "core": core, "rounds": n, "share_pct": round(n / max(t.height, 1) * 100),
            "wins": sum(r["won"] for r in rows), "win_pct": round(sum(r["won"] for r in rows) / n * 100),
            "plants": sum(r["plant_site"] is not None for r in rows), "plant_sites": sorted({r["plant_site"] for r in rows if r["plant_site"]}),
            "tempo": tempos, "median_exec_sec": round(float(np.median(exec_secs)), 1) if exec_secs else None,
            "median_plant_sec": round(float(np.median(plant_secs)), 1) if plant_secs else None,
            "buys": sorted({r["buy"] for r in rows if r["buy"]}, key=lambda b: BUY_ORDER.get(b, 9)),
            "examples": [_example(r, r["exec_sec"]) for r in rows[:MAX_EXAMPLES]], "spots": spots,
        })
    return {"total": t.height, "one_offs": one_offs, "strats": strats}


def multiround(s: Selection) -> list[dict]:
    """For each player and side: where they start rounds and which zones they never go through."""
    if s.starts.is_empty():
        return []
    all_zones = s.visits.group_by("side").agg(pl.col("zone").unique())
    team_zones = {r["side"]: set(r["zone"]) for r in all_zones.iter_rows(named=True)}
    out = []
    for (steamid, side), g in s.starts.group_by("steamid", "side", maintain_order=True):
        zones = (
            g.filter(pl.col("zone").is_not_null()).group_by("zone").len().sort("len", "zone", descending=[True, False])
            .with_columns(share_pct=pct(pl.col("len"), pl.lit(g.height))).rename({"len": "rounds"})
        )
        visited = set(s.visits.filter((pl.col("steamid") == steamid) & (pl.col("side") == side))["zone"].to_list())
        out.append({
            "steamid": str(steamid), "name": g["name"].drop_nulls().last(), "side": side, "rounds": g.height, "zones": zones.to_dicts(),
            "never": sorted(team_zones.get(side, set()) - visited),
            "spots": [{"x": r["x"], "y": r["y"], "z": r["z"], "match": r["match"], "round": r["round_num"]} for r in g.iter_rows(named=True)],
        })
    return sorted(out, key=lambda p: (p["side"], p["name"] or ""))


# ---- conclusions ----


def _card(key: str, sample: int, examples: list[dict] | None = None, **params) -> dict:
    return {"key": key, "params": params, "rounds": sample, "low": sample < LOW_SAMPLE, "examples": examples or []}


def _top_share(df: pl.DataFrame, col: str) -> tuple[str, int, int] | None:
    """Most common value of a column: (value, its rows, all rows); ties by value, so results are stable."""
    known = df.filter(pl.col(col).is_not_null())
    if known.is_empty():
        return None
    top = known.group_by(col).len().sort("len", col, descending=[True, False]).row(0)
    return top[0], top[1], known.height


def _site_card(s: Selection) -> dict | None:
    t = s.rounds.filter(pl.col("side") == T)
    bought = t.filter(pl.col("buy") != "pistol")  # pistol rounds say little about the plan, unless they are all that is selected
    t = bought if bought.height else t
    top = _top_share(t, "target_site")
    if top is None:
        return None
    site, n, total = top
    return _card("fav_site", total, _examples(t.filter(pl.col("target_site") == site), "exec_sec"), site=site, pct=round(n / total * 100), n=n, total=total)


def _site_by_buy_card(s: Selection) -> dict | None:
    t = s.rounds.filter((pl.col("side") == T) & (pl.col("buy") == "force"))
    top = _top_share(t, "target_site")
    if top is None:
        return None
    site, n, total = top
    return _card("force_site", total, _examples(t.filter(pl.col("target_site") == site), "exec_sec"), site=site, pct=round(n / total * 100), n=n, total=total)


def _tempo_card(s: Selection) -> dict | None:
    t = s.rounds.filter((pl.col("side") == T) & pl.col("exec_sec").is_not_null())
    top = _top_share(t, "tempo")
    if top is None:
        return None
    tempo, n, total = top
    return _card("tempo", total, _examples(t.filter(pl.col("tempo") == tempo), "exec_sec"), tempo=tempo, pct=round(n / total * 100), sec=round(float(t["exec_sec"].median())))


def _nade_card(s: Selection) -> dict | None:
    table = nade_table(s)
    if table.is_empty():
        return None
    t = table.filter((pl.col("side") == T) & pl.col("type").is_in(SIGNATURE_TYPES))
    if t.is_empty():
        return None
    r = t.row(0, named=True)
    rows = s.utility.filter((pl.col("side") == T) & (pl.col("type") == r["type"]) & (pl.col("zone") == r["zone"]))
    return _card("top_nade", r["side_rounds"], _examples(rows, "sec"), type=r["type"], zone=r["zone"], pct=round(r["per_round_pct"]), sec=round(r["median_sec"]))


def _weak_player_card(s: Selection, players: pl.DataFrame) -> dict | None:
    if players.is_empty():
        return None
    regular = players.filter(pl.col("rounds") >= pl.col("rounds").max() * 0.3)
    r = regular.sort("adr", "name").row(0, named=True)
    deaths = s.players.filter((pl.col("steamid").cast(pl.String) == str(r["steamid"])) & (pl.col("opening_deaths") > 0))
    return _card("weak_player", r["rounds"], _examples(deaths), name=r["name"], adr=r["adr"], kd=r["kd"], opening_deaths=r["opening_deaths"])


def _pistol_card(s: Selection) -> dict | None:
    after = s.rounds.filter(pl.col("after_pistol_loss").fill_null(False))
    top = _top_share(after, "buy")
    if top is None:
        return None
    buy, n, total = top
    wins = int(after["won"].sum())
    return _card("after_pistol", total, _examples(after), buy=buy, pct=round(n / total * 100), win_pct=round(wins / total * 100))


def _setup_card(s: Selection) -> dict | None:
    table = setup_table(s)
    if table.is_empty():
        return None
    r = table.row(0, named=True)
    rows = s.rounds.filter((pl.col("side") == CT) & (pl.col("setup") == r["setup"]))
    return _card("ct_setup", r["rounds"], _examples(rows), setup=r["setup"], pct=round(r["share_pct"]), win_pct=round(r["win_pct"]))


def _strat_card(book: dict) -> dict | None:
    if not book["strats"]:
        return None
    st = book["strats"][0]
    return _card("top_strat", st["rounds"], st["examples"], site=st["site"], n=st["rounds"], total=book["total"], win_pct=st["win_pct"], core=st["core"][:3], id=st["id"])


def dossier(s: Selection) -> dict:
    """Every table and conclusion of a report on the selected rounds."""
    r = s.rounds
    players = player_table(s)
    book = playbook(s)
    cards = [
        _site_card(s), _strat_card(book), _tempo_card(s), _nade_card(s), _weak_player_card(s, players), _pistol_card(s), _setup_card(s), _site_by_buy_card(s),
    ]
    all_cards = [c for c in cards if c is not None]
    used_ids = r["match"].unique().to_list()
    return {
        "team": s.team,
        "sample": {
            "matches": len(used_ids), "rounds": r.height, "wins": int(r["won"].sum()),
            "t_rounds": r.filter(pl.col("side") == T).height, "ct_rounds": r.filter(pl.col("side") == CT).height,
            "win_pct": round(float(r["won"].mean()) * 100, 1) if r.height else None, "low": r.height < LOW_SAMPLE,
        },
        "matches": [{"id": md.id, "date": md.date} for md in s.matches if md.id in used_ids],
        "warnings": sorted({w for md in s.matches for w in md.warnings}),
        "cards": all_cards[:MAX_CARDS],
        "more_cards": all_cards[MAX_CARDS:],
        "economy": economy(s),
        "executes_by_buy": executes_by_buy(s),
        "setups": setup_table(s),
        "nades": nade_table(s),
        "players": players,
        "weapons": weapon_table(s),
        "timings": timings(s),
        "playbook": book,
        "multiround": multiround(s),
        "rounds": r.select(
            "match", "round_num", "side", "buy", "opp_buy", "won", "loss_streak", "after_pistol_loss", "target_site", "plant_site", "exec_sec", "plant_sec",
            "tempo", "package", "entry", "setup", "reason_name",
        ),
    }


# ---- similar rounds ----


def _round_vectors(matches: list[MatchData], side: str) -> tuple[list[tuple[str, int, str]], np.ndarray]:
    """One feature vector per round of a side: site, tempo, buy, utility counts and the bag of grenade zones."""
    keys: list[tuple[str, int, str]] = []
    rows: list[dict] = []
    vocab: dict[str, int] = {}
    for md in matches:
        r = md.rounds.filter(pl.col("side") == side)
        util = md.utility.filter((pl.col("side") == side) & pl.col("zone").is_not_null())
        parts = {k[0]: g for k, g in util.group_by("round_num")}
        for row in r.iter_rows(named=True):
            u = parts.get(row["round_num"])
            bag = _signature(u.filter(pl.col("type").is_in(SIGNATURE_TYPES))) if u is not None else set()
            for item in bag:
                vocab.setdefault(item, len(vocab))
            keys.append((md.id, row["round_num"], row["team"]))
            rows.append({**row, "bag": bag})
    head = 9
    vec = np.zeros((len(rows), head + len(vocab)))
    for i, row in enumerate(rows):
        vec[i, 0] = row["target_site"] == "A"
        vec[i, 1] = row["target_site"] == "B"
        vec[i, 2] = min((row["exec_sec"] if row["exec_sec"] is not None else 60.0) / 60.0, 2.0)
        vec[i, 3] = min((row["plant_sec"] if row["plant_sec"] is not None else 0.0) / 60.0, 2.0)
        vec[i, 4] = BUY_ORDER.get(row["buy"], 2) / 3.0
        vec[i, 5] = (row["smokes"] or 0) / 3.0
        vec[i, 6] = (row["flashes"] or 0) / 4.0
        vec[i, 7] = (row["mollies"] or 0) / 2.0
        vec[i, 8] = (row["hes"] or 0) / 2.0
        for item in row["bag"]:
            vec[i, head + vocab[item]] = 1.0
    return keys, vec


def similar_rounds(matches: list[MatchData], match_id: str, round_num: int, team: str, n: int = 8) -> list[dict]:
    """The rounds of a corpus (one map) closest to a round of a raw team name, by cosine similarity, same side only."""
    md = next((m for m in matches if m.id == match_id), None)
    if md is None:
        raise KeyError(match_id)
    row = md.rounds.filter((pl.col("round_num") == round_num) & (pl.col("team") == team))
    if row.is_empty():
        raise KeyError(f"round {round_num} of {team}")
    side = row["side"].item()
    keys, vec = _round_vectors(matches, side)
    i = keys.index((match_id, round_num, team))
    norms = np.linalg.norm(vec, axis=1)
    scores = vec @ vec[i] / np.maximum(norms * norms[i], 1e-9)
    order = [j for j in np.argsort(-scores) if j != i][:n]
    by_id = {m.id: m for m in matches}
    out = []
    for j in order:
        mid, rnd, tm = keys[j]
        r = by_id[mid].rounds.filter((pl.col("round_num") == rnd) & (pl.col("team") == tm)).row(0, named=True)
        out.append({"match": mid, "round": rnd, "team": tm, "side": side, "score": round(float(scores[j]), 3), "buy": r["buy"], "won": r["won"],
                    "target_site": r["target_site"], "tempo": r["tempo"], "package": r["package"], "setup": r["setup"], "sec": max(0, int(r["exec_sec"] or 0) - 3)})
    return out


# ---- teams ----


def roster_suggestions(rosters: dict[str, set[str]], aliases: dict[str, str], min_common: int = 3) -> list[dict]:
    """Team names from different demos that share enough players to be the same team, not merged yet."""
    names = sorted(rosters)
    out = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            common = rosters[a] & rosters[b]
            if len(common) >= min_common and aliases.get(a, a) != aliases.get(b, b):
                out.append({"a": a, "b": b, "common": len(common)})
    return sorted(out, key=lambda x: -x["common"])
