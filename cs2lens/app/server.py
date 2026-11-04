"""FastAPI backend of the cs2lens app: demo library, match pages, replay data, maps, aggregation.

Every analysis comes from the existing modules (``team_stats``, ``tactics``, ``aggregate``,
``replay``); this layer only loads, caches and serialises. Results are cached in memory
per extract directory and invalidated when its ``manifest.json`` changes.
"""

from __future__ import annotations

import json
import locale
import re
import sys
import shutil
import time
import warnings
from functools import lru_cache
from pathlib import Path

import polars as pl
from awpy import Demo
from awpy import data as awpy_data
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from cs2lens.aggregate import aggregate
from cs2lens.app.archives import is_archive, unpack
from cs2lens.app.cs2 import BIND_COMMAND, CS2Bridge, NoConsole, game_running, steam_account
from cs2lens.app import hlae
from cs2lens.app.recorder import Clip, Recorder, find_ffmpeg, load_index, pick_encoder, save_index
from cs2lens.app.jobs import JobQueue
from cs2lens.context import load_match, with_round
from cs2lens.extract import add_replay, extract
from cs2lens.highlights import add_custom, delete_custom, highlights, kill_clips, load_custom
from cs2lens.lineups import MAP_RE, PRACTICE, cfg_name, lineup_cfg, lineup_commands, list_cfg, safe_text, throws
from cs2lens.maps import load_map_config
from cs2lens.replay import round_payload
from cs2lens.tactics import tactics, userid_map, utility_events
from cs2lens.team_stats import team_stats

STATIC_DIR = Path(__file__).parent / "static"
UPLOADS = "_uploads"
CHUNK = 1 << 20
POV_PREROLL = 1.0  # seconds of the demo played before a highlight window
POV_SEEK_SLACK = 1.5  # seeking takes a moment, so the pause comes a little after the window


def rows(df: pl.DataFrame) -> list[dict]:
    """DataFrame rows as dicts; 64-bit ids become strings (JavaScript numbers lose them)."""
    df = df.with_columns(pl.col(c).cast(pl.String) for c, t in df.schema.items() if t in (pl.UInt64, pl.Int64) and "steamid" in c)
    return df.to_dicts()


def tables(d: dict[str, pl.DataFrame]) -> dict[str, list[dict]]:
    return {k: rows(v) for k, v in d.items()}


class Library:
    """Extract directories under ``out`` plus .dem files found in the configured folders."""

    def __init__(self, out: Path) -> None:
        self.out = out
        self.out.mkdir(parents=True, exist_ok=True)
        self.settings_path = out / "library.json"

    def settings(self) -> dict:
        if not self.settings_path.exists():
            return {}
        return json.loads(self.settings_path.read_text(encoding="utf-8"))

    def setting(self, key: str):
        return self.settings().get(key)

    def set_setting(self, key: str, value) -> None:
        data = self.settings()
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
        self.settings_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def folders(self) -> list[str]:
        return self.settings().get("folders", [])

    def set_folders(self, folders: list[str]) -> None:
        self.set_setting("folders", folders)

    def match_dir(self, match_id: str) -> Path:
        d = self.out / match_id
        if "/" in match_id or "\\" in match_id or match_id.startswith(".") or not (d / "manifest.json").exists():
            raise HTTPException(404, f"no extract named {match_id!r}")
        return d

    def matches(self) -> list[Path]:
        return sorted(p.parent for p in self.out.glob("*/manifest.json"))

    def all_demos(self) -> list[Path]:
        found = []
        for folder in [*self.folders(), str(self.out / UPLOADS)]:
            p = Path(folder)
            if p.is_dir():
                found += sorted(p.glob("*.dem"))
        return found

    def demos(self) -> list[Path]:
        """Each demo once: an upload saved into a library folder (game/csgo) is in both places."""
        seen, out = set(), []
        for p in self.all_demos():
            key = (p.stem, p.stat().st_size)
            if key not in seen:
                seen.add(key)
                out.append(p)
        return out

    def demo_for(self, d: Path) -> Path | None:
        """The .dem an extract came from: the manifest path, else a same-named demo in a folder."""
        manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("demo_path") and Path(manifest["demo_path"]).exists():
            return Path(manifest["demo_path"])
        return next((p for p in self.demos() if p.stem == d.name), None)

    def owns_demo(self, path: Path) -> bool:
        """Only .dem files in the library folders (or uploads) may be deleted through the API."""
        return path.suffix.lower() == ".dem" and path.is_file() and any(path.resolve() == p.resolve() for p in self.all_demos())


@lru_cache(maxsize=1024)
def _demo_map(path: str, _mtime: float) -> str | None:
    """Map name from the demo header (reads only the start of the file)."""
    try:
        return Demo(path).header.get("map_name")
    except Exception:  # noqa: BLE001 - a broken or partial file just has no map
        return None


def _stamp(d: Path) -> float:
    return (d / "manifest.json").stat().st_mtime


@lru_cache(maxsize=64)
def _overview(d: Path, _stamp: float) -> dict:
    m = load_match(d)
    ts = team_stats(d)
    rate = m.tick_rate
    bomb = with_round(m.data["bomb"].select("tick", "event", "bombsite"), m.rounds)
    plants = bomb.filter(pl.col("event") == "finish_plant").group_by("round_num").agg(plant_site=pl.col("bombsite").first(), plant_tick=pl.col("tick").first())
    defuses = bomb.filter(pl.col("event") == "defuse").group_by("round_num").agg(defused=pl.lit(True))
    kills = (
        with_round(m.data["kills"], m.rounds)
        .join(m.teams.rename({"steamid": "attacker_steamid", "team": "att_team"}), on="attacker_steamid", how="left")
        .group_by("round_num", "att_team").len()
    )
    timeline = []
    for r in m.rounds.join(plants, on="round_num", how="left").join(defuses, on="round_num", how="left").sort("round_num").iter_rows(named=True):
        per_team = m.tr.filter(pl.col("round_num") == r["round_num"])
        teams = {}
        winner = None
        for t in per_team.iter_rows(named=True):
            k = kills.filter((pl.col("round_num") == r["round_num"]) & (pl.col("att_team") == t["team"]))
            teams[t["team"]] = {"side": t["side"], "buy": t["buy"], "equip": t["equip"], "kills": int(k["len"].sum()) if k.height else 0}
            if t["won"]:
                winner = t["team"]
        timeline.append({
            "round": r["round_num"],
            "winner_side": r["winner_side"],
            "winner": winner,
            "reason": r["reason_name"],
            "plant_site": r["plant_site"],
            "defused": bool(r["defused"]),
            "duration": round((r["end_tick"] - r["freeze_end_tick"]) / rate, 1),
            "teams": teams,
        })
    players = m.data["stats"].join(m.teams, on="steamid", how="left").sort("team", "adr", descending=[False, True])
    manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    return {
        "id": d.name,
        "map": m.map_name,
        "tick_rate": rate,
        "has_config": load_map_config(m.map_name) is not None,
        "has_replay": (d / "replay.parquet").exists(),
        "header": {k: manifest["header"].get(k) for k in ("server_name", "client_name", "map_name", "demo_version_name")},
        "score": {r["team"]: r["rounds_won"] for r in ts["summary"].iter_rows(named=True)},
        "timeline": timeline,
        "team_stats": tables(ts),
        "players": rows(players),
    }


@lru_cache(maxsize=64)
def _tactics(d: Path, _stamp: float) -> dict:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            result = {"tables": tables(tactics(d)), "error": None}
        except ValueError as e:
            result = {"tables": None, "error": str(e)}
    result["warnings"] = [str(w.message) for w in caught]
    return result


@lru_cache(maxsize=64)
def _highlights(d: Path, _stamp: float) -> list[dict]:
    return highlights(d)


def system_locale() -> str | None:
    """The OS user interface language, e.g. ``ru_RU`` (the browser may be set to another one)."""
    if sys.platform == "win32":
        try:
            import ctypes

            lang_id = ctypes.windll.kernel32.GetUserDefaultUILanguage()
            return locale.windows_locale.get(lang_id)
        except (AttributeError, OSError):
            pass
    loc = locale.getlocale()[0]
    return loc or None


def _sec(df: pl.DataFrame, rate: float) -> pl.DataFrame:
    """Seconds after the freeze end, for rows that went through ``with_round``."""
    return df.with_columns(sec=((pl.col("tick") - pl.col("freeze_end_tick")) / rate).round(1))


def _teams_for(df: pl.DataFrame, teams: pl.DataFrame, *roles: str) -> pl.DataFrame:
    for role in roles:
        df = df.join(teams.rename({"steamid": f"{role}_steamid", "team": f"{role}_team"}), on=f"{role}_steamid", how="left")
    return df


@lru_cache(maxsize=64)
def _points(d: Path, _stamp: float) -> dict:
    """Event positions for the heatmaps: kills, utility, gun shots, damage, blinds, plants."""
    m = load_match(d, extra_tables=("fires", "shots", "damages", "blinds"))
    rate = m.tick_rate
    names = m.data["players"].select("steamid", "name")
    kills = _sec(_teams_for(with_round(m.data["kills"], m.rounds), m.teams, "attacker", "victim"), rate)
    # opening duel: the first kill between the two teams in each round
    kills = kills.with_columns(
        opening=(pl.col("tick") == pl.col("tick").filter(pl.col("attacker_team") != pl.col("victim_team")).min().over("round_num"))
        & (pl.col("attacker_team") != pl.col("victim_team"))
    )
    kills = kills.select(
        "round_num", "tick", "sec", "weapon", "headshot", "opening",
        "attacker_steamid", "attacker_name", "attacker_side", "attacker_team", "attacker_x", "attacker_y", "attacker_z",
        "victim_steamid", "victim_name", "victim_side", "victim_team", "victim_x", "victim_y", "victim_z",
    )
    shots = _sec(with_round(m.data["shots"], m.rounds), rate).with_columns(weapon=pl.col("weapon").str.replace("^weapon_", ""))
    shots = shots.filter(~pl.col("weapon").str.contains("knife|bayonet|grenade|flashbang|molotov|decoy|c4")).join(m.teams, on="steamid", how="left")
    shots = shots.select("round_num", "sec", "steamid", "name", "side", "team", "weapon",
                         x=pl.col("x").round(0), y=pl.col("y").round(0), z=pl.col("z").round(0))
    dmg = _sec(_teams_for(with_round(m.data["damages"], m.rounds), m.teams, "attacker", "victim"), rate).select(
        "round_num", "sec", "weapon", dmg=pl.col("dmg_health"),
        attacker_name="attacker_name", attacker_side="attacker_side", attacker_team="attacker_team",
        attacker_x=pl.col("attacker_x").round(0), attacker_y=pl.col("attacker_y").round(0), attacker_z=pl.col("attacker_z").round(0),
        victim_name="victim_name", victim_side="victim_side", victim_team="victim_team",
        victim_x=pl.col("victim_x").round(0), victim_y=pl.col("victim_y").round(0), victim_z=pl.col("victim_z").round(0),
    )
    blinds = _sec(_teams_for(with_round(m.data["blinds"], m.rounds), m.teams, "attacker", "victim"), rate).filter(
        pl.col("attacker_team") != pl.col("victim_team")
    ).select(
        "round_num", "sec", duration=pl.col("duration").round(2),
        attacker_name="attacker_name", attacker_side="attacker_side", attacker_team="attacker_team",
        attacker_x=pl.col("attacker_x").round(0), attacker_y=pl.col("attacker_y").round(0), attacker_z=pl.col("attacker_z").round(0),
        victim_name="victim_name", victim_side="victim_side", victim_team="victim_team",
        victim_x=pl.col("victim_x").round(0), victim_y=pl.col("victim_y").round(0), victim_z=pl.col("victim_z").round(0),
    )
    plants = _sec(with_round(m.data["bomb"].filter(pl.col("event") == "finish_plant"), m.rounds), rate).join(m.teams, on="steamid", how="left")
    plants = plants.select("round_num", "sec", "name", "team", site=pl.col("bombsite"), side=pl.lit("terrorist"),
                           x=pl.col("x").round(0), y=pl.col("y").round(0), z=pl.col("z").round(0))
    try:
        util = utility_events(m, userid_map(m)).join(names, on="steamid", how="left")
        util = util.select("round_num", "tick", "sec", "type", "x", "y", "z", "steamid", "name", "team", "side")
        util_error = None
    except ValueError as e:
        util, util_error = pl.DataFrame(), str(e)
    return {"map": m.map_name, "kills": rows(kills), "utility": rows(util), "utility_error": util_error,
            "shots": rows(shots), "damages": rows(dmg), "blinds": rows(blinds), "plants": rows(plants)}


HEAT_CELL = 4  # radar px per movement-heatmap cell (1024 px radar -> 256 x 256)


@lru_cache(maxsize=2)
def _frames(d: Path, _stamp: float) -> tuple[pl.DataFrame, float, str]:
    """Alive player positions over the whole match with round, seconds after freeze end and team."""
    m = load_match(d)
    path = d / "replay.parquet"
    src = pl.read_parquet(path, columns=["tick", "steamid", "name", "side", "x", "y", "z", "health"]) if path.exists() else m.data["snapshots"]
    f = src.select("tick", "steamid", "name", "side", "x", "y", "z", "health").filter(pl.col("health") > 0)
    f = _sec(with_round(f, m.rounds), m.tick_rate).join(m.teams, on="steamid", how="inner")
    step = float(f["tick"].unique().sort().diff().drop_nulls().min() or 1)
    return f.select("round_num", "sec", "name", "side", "team", "x", "y", "z"), step / m.tick_rate, m.map_name


@lru_cache(maxsize=256)
def _movement(d: Path, _stamp: float, team: str, side: str, player: str, r0: int, r1: int, t0: float, t1: float) -> dict:
    f, dt, map_name = _frames(d, _stamp)
    f = f.filter(pl.col("round_num").is_between(r0, r1) & pl.col("sec").is_between(t0, t1))
    if team:
        f = f.filter(pl.col("team") == team)
    if side:
        f = f.filter(pl.col("side") == side)
    if player:
        f = f.filter(pl.col("name") == player)
    meta = _map_meta(map_name)
    out = []
    for lv in meta["levels"]:
        g = f.filter((pl.col("z") >= lv["z_min"]) & (pl.col("z") < lv["z_max"])) if len(meta["levels"]) > 1 else f
        cells = (
            g.select(
                i=((pl.col("x") - meta["pos_x"]) / meta["scale"] / HEAT_CELL).floor().cast(pl.Int32),
                j=((meta["pos_y"] - pl.col("y")) / meta["scale"] / HEAT_CELL).floor().cast(pl.Int32),
            )
            .filter(pl.col("i").is_between(0, 1024 // HEAT_CELL - 1) & pl.col("j").is_between(0, 1024 // HEAT_CELL - 1))
            .group_by("i", "j").len()
        )
        out.append(cells.select("i", "j", "len").rows())
    return {"cell": HEAT_CELL, "levels": out, "samples": f.height, "player_seconds": round(f.height * dt)}


@lru_cache(maxsize=64)
def _throws(d: Path, _stamp: float) -> list[dict]:
    return rows(throws(d))


def _radar_file(name: str) -> Path | None:
    """A cached radar image; never downloads (``name`` is e.g. ``de_nuke`` or ``de_nuke_lower``)."""
    if not re.fullmatch(r"[a-z0-9_]+", name):
        return None
    for version in reversed(awpy_data.local_versions()):
        p = awpy_data.data_dir(int(version) if version.isdigit() else None) / "radars" / f"{name}.png"
        if p.exists():
            return p
    return None


def _map_meta(map_name: str) -> dict:
    versions = awpy_data.local_versions()
    if not versions:
        raise HTTPException(404, "no awpy-data cache in ~/.awpy (run `awpy get` once)")
    meta = awpy_data.map_data(int(versions[-1]) if versions[-1].isdigit() else None).get(map_name)
    if meta is None:
        raise HTTPException(404, f"no map data for {map_name}")
    cfg = load_map_config(map_name)
    sections = meta.get("verticalsections") or {}
    if cfg is not None:
        levels = [{"name": lv.name, "z_min": lv.z_min, "z_max": lv.z_max, "radar": lv.radar} for lv in cfg.levels]
    elif "lower" in sections:
        split = float(sections["lower"]["AltitudeMax"])
        levels = [{"name": "default", "z_min": split, "z_max": 1e9, "radar": map_name},
                  {"name": "lower", "z_min": -1e9, "z_max": split, "radar": f"{map_name}_lower"}]
    else:
        levels = [{"name": "default", "z_min": -1e9, "z_max": 1e9, "radar": map_name}]
    for lv in levels:
        lv["has_image"] = _radar_file(lv["radar"]) is not None
    poly = lambda a: [[float(x), float(y)] for x, y in a.polygon]  # noqa: E731
    return {
        "map": map_name,
        "pos_x": meta["pos_x"],
        "pos_y": meta["pos_y"],
        "scale": meta["scale"],
        "levels": levels,
        "config_source": cfg.source if cfg else None,
        "sites": [{"site": s.name, "level": s.level, "polygon": poly(s)} for s in cfg.sites] if cfg else [],
        "zones": [{"name": z.name, "group": z.group, "level": z.level, "polygon": poly(z)} for z in cfg.zones] if cfg else [],
    }


def create_app(out: str | Path = "out") -> FastAPI:
    lib = Library(Path(out))
    jobs = JobQueue()
    cs2 = CS2Bridge(lib.setting, lib.set_setting)
    recorder = Recorder(cs2)
    api = FastAPI(title="cs2lens")

    @api.exception_handler(NoConsole)
    def no_console(_request: Request, e: NoConsole) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, status_code=409)

    def queue_extract(demo: Path) -> dict:
        target = lib.out / demo.stem

        def work(progress) -> None:
            extract(demo, target, progress=progress)
            try:  # CS2 only opens demos from its own folder
                cs2.stage_demo(demo)
            except (ValueError, OSError):  # no game folder or no space: the analysis is still fine
                pass

        job = jobs.submit("extract", str(demo), demo.stem, work)
        return {"job": job.id}

    def remove_demo(p: Path) -> None:
        """Delete a demo with its copies: in the library folders, the uploads and game/csgo."""
        size = p.stat().st_size
        saved = cs2.saved_copy(p)
        for q in [q for q in lib.all_demos() if q.stem == p.stem and q.stat().st_size == size] + ([saved] if saved else []) + [p]:
            q.unlink(missing_ok=True)

    def queue_new(demo: Path) -> int | None:
        """Extract a demo unless it already has an extract."""
        return None if (lib.out / demo.stem / "manifest.json").exists() else queue_extract(demo)["job"]

    def unpack_then_extract(archive: Path, progress) -> None:
        try:
            demos = unpack(archive, archive.parent, progress)
        finally:
            archive.unlink(missing_ok=True)
        for demo in demos:
            queue_new(demo)

    @api.get("/api/system")
    def system() -> dict:
        return {"locale": system_locale()}

    @api.get("/api/library")
    def library() -> dict:
        matches = []
        for d in lib.matches():
            if d.name in (UPLOADS,):
                continue
            manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
            if "header" not in manifest:  # e.g. an aggregate directory
                continue
            entry = {"id": d.name, "map": manifest["header"].get("map_name"), "has_replay": (d / "replay.parquet").exists(),
                     "modified": _stamp(d), "busy": jobs.active_for_match(d.name) is not None}
            try:
                ov = _overview(d, _stamp(d))
                entry |= {"score": ov["score"], "rounds": len(ov["timeline"])}
            except Exception as e:  # noqa: BLE001 - a broken extract should not hide the others
                entry["error"] = f"{type(e).__name__}: {e}"
            matches.append(entry)
        demos = []
        for p in lib.demos():
            job = jobs.active_for(str(p))
            st = p.stat()
            demos.append({"path": str(p), "name": p.name, "size_mb": round(st.st_size / 2**20, 1), "map": _demo_map(str(p), st.st_mtime),
                          "match_id": p.stem, "uploaded": p.parent == lib.out / UPLOADS,
                          "extracted": (lib.out / p.stem / "manifest.json").exists(), "job": job.id if job else None})
        return {"out": str(lib.out.resolve()), "folders": lib.folders(), "matches": matches, "demos": demos}

    @api.post("/api/library/folders")
    def add_folder(path: str = Body(..., embed=True)) -> dict:
        p = Path(path).expanduser()
        if not p.is_dir():
            raise HTTPException(400, f"not a folder: {path}")
        folders = [f for f in lib.folders() if Path(f) != p] + [str(p)]
        lib.set_folders(folders)
        return {"folders": folders}

    @api.delete("/api/library/folders")
    def remove_folder(path: str) -> dict:
        folders = [f for f in lib.folders() if f != path]
        lib.set_folders(folders)
        return {"folders": folders}

    @api.post("/api/extract")
    def extract_demo(path: str = Body(..., embed=True)) -> dict:
        p = Path(path)
        if p.suffix.lower() != ".dem" or not p.is_file():
            raise HTTPException(400, f"not a .dem file: {path}")
        return queue_extract(p)

    @api.put("/api/upload")
    async def upload(request: Request, name: str) -> dict:
        """Stream a .dem or an archive with demos into ``out/_uploads`` and queue the work.

        The body goes to a ``.part`` file first, so a broken upload never shows up as a demo.
        A demo already there with the same size is not written again, and a demo that already
        has an extract is not parsed again. Archives are unpacked by a job that then queues
        the extraction of every demo inside.
        """
        safe = Path(name.replace("\\", "/")).name
        archive = is_archive(safe)
        if not (safe.lower().endswith(".dem") or archive):
            raise HTTPException(400, "only .dem files or archives (.zip, .rar, .7z, .tar.*, .gz, .bz2, .xz, .zst)")
        folder = lib.out / UPLOADS
        folder.mkdir(exist_ok=True)
        target = folder / safe
        if jobs.active_for(str(target)):
            raise HTTPException(409, f"{safe} is being processed; wait for the job to finish")
        size = int(request.headers.get("content-length") or -1)
        if not archive and target.exists() and target.stat().st_size == size:
            return {"job": queue_new(target), "name": safe}
        part = target.with_name(target.name + ".part")
        try:
            with part.open("wb", buffering=CHUNK) as f:
                async for chunk in request.stream():
                    f.write(chunk)
            part.replace(target)
        finally:
            part.unlink(missing_ok=True)
        if archive:
            job = jobs.submit("unpack", str(target), target.stem, lambda progress: unpack_then_extract(target, progress))
            return {"job": job.id, "name": safe}
        return {"job": queue_extract(target)["job"], "name": safe}

    @api.delete("/api/matches/{match_id}")
    def delete_match(match_id: str, demo: bool = False) -> dict:
        """Delete an extract; with ``demo=true`` also its source .dem if it is in the library."""
        d = lib.match_dir(match_id)
        if jobs.active_for_match(match_id):
            raise HTTPException(409, "the match is being processed; wait for the job to finish")
        source = lib.demo_for(d) if demo else None
        shutil.rmtree(d)
        for cached in (_overview, _tactics, _points, _highlights):
            cached.cache_clear()
        deleted_demo = None
        if source is not None and lib.owns_demo(source):
            remove_demo(source)
            deleted_demo = str(source)
        return {"deleted": match_id, "demo": deleted_demo}

    @api.delete("/api/demos")
    def delete_demo(path: str) -> dict:
        p = Path(path)
        if not lib.owns_demo(p):
            raise HTTPException(404, f"not a demo of the library: {path}")
        if jobs.active_for(str(p)):
            raise HTTPException(409, "the demo is being processed; wait for the job to finish")
        remove_demo(p)
        return {"deleted": str(p)}

    @api.get("/api/jobs")
    def list_jobs() -> list[dict]:
        return jobs.list()

    @api.post("/api/matches/{match_id}/replay-data")
    def build_replay_data(match_id: str) -> dict:
        d = lib.match_dir(match_id)
        demo = lib.demo_for(d)
        if demo is None:
            raise HTTPException(404, "the source .dem was not found; add its folder to the library")
        job = jobs.submit("replay", str(demo), match_id, lambda progress: add_replay(demo, d))
        return {"job": job.id}

    @api.get("/api/matches/{match_id}")
    def match(match_id: str) -> dict:
        d = lib.match_dir(match_id)
        return _overview(d, _stamp(d))

    @api.get("/api/matches/{match_id}/tactics")
    def match_tactics(match_id: str) -> dict:
        d = lib.match_dir(match_id)
        return _tactics(d, _stamp(d))

    @api.get("/api/matches/{match_id}/points")
    def match_points(match_id: str) -> dict:
        d = lib.match_dir(match_id)
        return _points(d, _stamp(d))

    @api.get("/api/matches/{match_id}/kills")
    def match_kill_clips(match_id: str, steamid: str) -> list[dict]:
        """Every kill of a player cut into clip windows (close kills share one)."""
        if not steamid.isdigit():
            raise HTTPException(400, "bad steamid")
        return kill_clips(lib.match_dir(match_id), steamid)

    # ---- automatic recording: CS2 plays, ffmpeg records ----
    @api.get("/api/recorder")
    def recorder_status() -> dict:
        ffmpeg = find_ffmpeg()
        return {
            "state": recorder.state, "ffmpeg": ffmpeg, "encoder": pick_encoder(ffmpeg) if ffmpeg else None,
            "connected": cs2.connected(), "running": game_running(), "bind_command": BIND_COMMAND, "me": steam_account(),
            "hlae": str(hlae.find_hlae()) if hlae.find_hlae() else None,
        }

    @api.post("/api/recorder/start")
    def recorder_start(
        match_id: str = Body(...), clips: list[dict] = Body(...), capture: str = Body("screen"), fps: int = Body(60),
        clean: bool = Body(True), close_game: bool = Body(False),
    ) -> dict:
        d = lib.match_dir(match_id)
        if capture not in ("screen", "window", "hlae") or fps not in (30, 60) or not 1 <= len(clips) <= 200:
            raise HTTPException(400, "capture: screen | window | hlae, fps: 30 | 60, 1-200 clips")
        rounds = pl.read_parquet(d / "rounds.parquet", columns=["round_num", "freeze_end_tick", "is_knife_round"]).filter(~pl.col("is_knife_round"))
        freeze = dict(rounds.select("round_num", "freeze_end_tick").iter_rows())
        rate = float(json.loads((d / "manifest.json").read_text(encoding="utf-8"))["tick_rate"])
        names = {str(k): v for k, v in pl.read_parquet(d / "players.parquet", columns=["steamid", "name"]).iter_rows()}
        todo = []
        for c in clips:
            r, start, end = int(c.get("round", -1)), float(c.get("start", 0)), float(c.get("end", 0))
            if r not in freeze or not 0 < end - start <= 180:
                raise HTTPException(400, f"bad clip: round {r}, {start}-{end} s")
            sid = str(c["steamid"]) if c.get("steamid") else None
            todo.append(Clip(
                round=r, start=start, end=end, tick=max(0, int(freeze[r] + (start - 1.0) * rate)),
                player=re.sub(r'["\n\r;]|//', " ", names[sid])[:64] if sid in names else None,
                title=str(c.get("title") or "clip")[:80], kind=str(c.get("kind") or "clip")[:20], steamid=sid, rate=rate,
            ))
        if capture == "hlae":
            exe, game = hlae.find_hlae(), cs2.game_dir()
            if exe is None:
                raise HTTPException(409, "cs2_hlae_missing")
            if game is None:
                raise HTTPException(409, "cs2_not_front")
            if not hlae.steam_running():
                raise HTTPException(409, "cs2_no_steam")
            if recorder.running():
                raise HTTPException(409, "a recording is already running")
            if game_running():
                if not close_game:  # the player's own game: closing it is their call
                    raise HTTPException(409, "cs2_running")
                hlae.close_game()
                time.sleep(2)
            try:
                return recorder.start_hlae(match_id, d / "recordings", playable(match_id), game, exe, todo, fps, clean)
            except RuntimeError as e:
                raise HTTPException(409, str(e)) from e
        try:
            return recorder.start(match_id, d / "recordings", playable(match_id), todo, capture, fps, clean)
        except RuntimeError as e:
            raise HTTPException(409, str(e)) from e

    @api.post("/api/cs2/console-test")
    def cs2_console_test() -> dict:
        """Press the bound key in the game and check that it answers; remembers the link when it does."""
        return {"mode": cs2.test_console()}

    @api.post("/api/hlae/install")
    def hlae_install() -> dict:
        """Download HLAE from its official GitHub releases (checked against the release's SHA-256)."""
        try:
            return hlae.install()
        except (OSError, ValueError) as e:
            raise HTTPException(502, f"HLAE was not installed: {e}") from e

    @api.post("/api/recorder/cancel")
    def recorder_cancel() -> dict:
        recorder.cancel()
        return recorder.state

    @api.get("/api/matches/{match_id}/recordings")
    def recordings(match_id: str) -> list[dict]:
        folder = lib.match_dir(match_id) / "recordings"
        return [r for r in load_index(folder) if (folder / r["file"]).exists()]

    def recording_file(match_id: str, name: str) -> Path:
        folder = lib.match_dir(match_id) / "recordings"
        p = folder / name
        if p.parent.resolve() != folder.resolve() or p.suffix != ".mp4" or not p.is_file():
            raise HTTPException(404, f"no recording {name}")
        return p

    @api.get("/api/matches/{match_id}/recordings/{name}")
    def recording(match_id: str, name: str, download: bool = False) -> FileResponse:
        p = recording_file(match_id, name)
        return FileResponse(p, media_type="video/mp4", filename=p.name if download else None)

    @api.delete("/api/matches/{match_id}/recordings/{name}")
    def delete_recording(match_id: str, name: str) -> dict:
        p = recording_file(match_id, name)
        if recorder.running() and recorder.state.get("match_id") == match_id:
            raise HTTPException(409, "a recording of this match is running")
        p.unlink()
        save_index(p.parent, [r for r in load_index(p.parent) if r["file"] != name])
        return {"deleted": name}

    @api.get("/api/matches/{match_id}/highlights")
    def match_highlights(match_id: str) -> dict:
        d = lib.match_dir(match_id)
        return {"auto": _highlights(d, _stamp(d)), "custom": load_custom(d)}

    @api.post("/api/matches/{match_id}/highlights")
    def create_highlight(
        match_id: str, round: int = Body(...), start: float = Body(...), end: float = Body(...),
        title: str = Body(""), steamid: str | None = Body(None),
    ) -> dict:
        d = lib.match_dir(match_id)
        try:
            return add_custom(d, round, start, end, title, steamid)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    @api.delete("/api/matches/{match_id}/highlights/{highlight_id}")
    def remove_highlight(match_id: str, highlight_id: str) -> dict:
        if not delete_custom(lib.match_dir(match_id), highlight_id):
            raise HTTPException(404, f"no custom highlight {highlight_id}")
        return {"deleted": highlight_id}

    @api.get("/api/matches/{match_id}/rounds/{round_num}/replay")
    def replay(match_id: str, round_num: int) -> Response:
        d = lib.match_dir(match_id)
        try:
            payload = round_payload(d, round_num)
        except KeyError as e:
            raise HTTPException(404, str(e)) from e
        return Response(payload, media_type="application/json", headers={"Content-Encoding": "gzip", "Cache-Control": "no-cache"})

    @api.get("/api/matches/{match_id}/movement")
    def match_movement(
        match_id: str, team: str = "", side: str = "", player: str = "",
        round_from: int = 1, round_to: int = 999, t_from: float = -30, t_to: float = 300,
    ) -> dict:
        d = lib.match_dir(match_id)
        return _movement(d, _stamp(d), team, side, player, round_from, round_to, t_from, t_to)

    @api.get("/api/matches/{match_id}/throws")
    def match_throws(match_id: str) -> dict:
        d = lib.match_dir(match_id)
        manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        demo = lib.demo_for(d)
        playdemo = cs2.demo_path(demo) if demo else None  # a demo outside the game folder is staged on use
        return {"map": manifest["header"].get("map_name"), "tick_rate": manifest["tick_rate"],
                "playdemo": playdemo, "throws": _throws(d, _stamp(d))}

    # ---- CS2 ----
    def check_map(map_name: str) -> str:
        if not MAP_RE.match(map_name or ""):
            raise HTTPException(400, f"bad map name: {map_name!r}")
        return map_name

    def check_lineup(lu: dict) -> dict:
        try:
            out = {k: float(lu[k]) for k in ("x", "y", "z", "pitch", "yaw")}
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(400, f"bad lineup: {e}") from e
        if not all(abs(v) < 1e5 for v in out.values()):
            raise HTTPException(400, "lineup coordinates out of range")
        return out | {"weapon": str(lu.get("weapon") or ""), "label": safe_text(str(lu.get("label") or ""))}

    @api.get("/api/cs2")
    def cs2_status() -> dict:
        return cs2.status()

    @api.post("/api/cs2/settings")
    def cs2_settings(game_dir: str | None = Body(None), port: int | None = Body(None)) -> dict:
        try:
            cs2.configure(game_dir, port)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return cs2.status()

    @api.post("/api/cs2/open")
    def cs2_open(map: str = Body(...), lineup: dict = Body(...), reload: bool = Body(False)) -> dict:
        """Teleport the player in CS2 to a lineup (loading the map, launching CS2 if needed)."""
        map_name, lu = check_map(map), check_lineup(lineup)
        path = cs2.write_cfg("cs2lens_lineup", lineup_cfg(map_name, lu, lu["label"]))
        commands = [c for c in PRACTICE if not c.startswith("//")] + lineup_commands(lu) + [f"echo cs2lens: {lu['label']}"]
        return cs2.run(f"map {map_name}", commands, lu["label"] or "lineup", reload) | {"cfg": str(path) if path else None}

    @api.post("/api/cs2/list")
    def cs2_list(
        map: str = Body(...), name: str = Body("lineups"), lineups: list[dict] = Body(...), install: bool = Body(False),
        next_key: str = Body("]"), prev_key: str = Body("["),
    ) -> dict:
        """A practice config with many lineups (``]`` / ``[`` cycle); written into CS2 with ``install``."""
        map_name = check_map(map)
        keys = {next_key, prev_key}
        if len(keys) != 2 or not all(re.fullmatch(r"[A-Za-z0-9\[\]\-=,./]|f\d{1,2}", k) for k in keys):
            raise HTTPException(400, "keys: one character or f1-f12")
        lus = [check_lineup(lu) | {"label": safe_text(str(lu.get("label") or ""))} for lu in lineups[:500]]
        if not lus:
            raise HTTPException(400, "no lineups")
        exec_name = cfg_name(name)
        text = list_cfg(map_name, name, lus, next_key, prev_key)
        path = cs2.write_cfg(exec_name, text) if install else None
        if install and path is None:
            raise HTTPException(404, "CS2 game folder not found; set it in the CS2 settings or download the .cfg")
        return {"text": text, "file": f"{exec_name}.cfg", "exec": f"exec {exec_name}", "path": str(path) if path else None}

    @api.post("/api/cs2/run-list")
    def cs2_run_list(map: str = Body(...), name: str = Body("lineups")) -> dict:
        """Load the map in CS2 and exec an installed practice list."""
        map_name = check_map(map)
        exec_name = cfg_name(name)
        return cs2.run(f"map {map_name}", [f"exec {exec_name}"], exec_name)

    @api.post("/api/cs2/demo")
    def cs2_demo(match_id: str = Body(...), tick: int = Body(...), player: str = Body("")) -> dict:
        """Open the match demo in CS2 a few seconds before ``tick``, watching ``player``."""
        commands = [f"demo_gototick {max(0, int(tick))}"]
        if player:
            commands.append(spec_player(player))
        return cs2.run(f"playdemo {playable(match_id)}", commands, f"demo, tick {tick}")

    def playable(match_id: str) -> str:
        """The ``playdemo`` argument of a match's demo, linking or copying it into the game folder if needed."""
        demo = lib.demo_for(lib.match_dir(match_id))
        if demo is None:
            raise HTTPException(404, "the source .dem was not found; add its folder to the library")
        try:
            return cs2.stage_demo(demo)
        except (ValueError, OSError) as e:
            raise HTTPException(404, str(e)) from e

    def spec_player(name: str) -> str:
        # names may be non-ASCII; only what would break the console line goes
        clean = re.sub(r'["\n\r;]|//', " ", name).strip()[:64]
        return f'spec_player "{clean}"'

    @api.post("/api/cs2/pov")
    def cs2_pov(
        match_id: str = Body(...), round: int = Body(...), start: float = Body(...), end: float = Body(...),
        steamid: str | None = Body(None), speed: float = Body(1.0),
    ) -> dict:
        """Play a highlight in CS2 from the player's eyes: seek the demo to the window, watch the player,
        and pause at the end of the window."""
        d = lib.match_dir(match_id)
        if not (end > start and 0.1 <= speed <= 4):
            raise HTTPException(400, "bad window or speed")
        rounds = pl.read_parquet(d / "rounds.parquet", columns=["round_num", "freeze_end_tick", "is_knife_round"])
        r = rounds.filter((pl.col("round_num") == round) & ~pl.col("is_knife_round"))
        if not r.height:
            raise HTTPException(404, f"no round {round} in this match")
        rate = float(json.loads((d / "manifest.json").read_text(encoding="utf-8"))["tick_rate"])
        tick = max(0, int(r["freeze_end_tick"][0] + (start - POV_PREROLL) * rate))
        commands = [f"demo_gototick {tick}"]
        if steamid:
            players = pl.read_parquet(d / "players.parquet", columns=["steamid", "name"])
            name = players.filter(pl.col("steamid").cast(pl.String) == str(steamid))["name"]
            if name.len():
                commands.append(spec_player(name[0]))
        commands += [f"demo_timescale {speed:g}", "demo_resume"]
        pause_after = (end - start + POV_PREROLL) / speed + POV_SEEK_SLACK
        return cs2.run(f"playdemo {playable(match_id)}", commands, f"POV, round {round}", then=(pause_after, ["demo_pause"]))

    @api.get("/api/maps/{map_name}")
    def map_meta(map_name: str) -> dict:
        return _map_meta(map_name)

    @api.get("/api/radar/{name}.png")
    def radar(name: str) -> FileResponse:
        p = _radar_file(name)
        if p is None:
            raise HTTPException(404, f"radar {name} is not in the local awpy cache")
        return FileResponse(p, media_type="image/png", headers={"Cache-Control": "max-age=86400"})

    @api.post("/api/aggregate")
    def aggregate_matches(ids: list[str] = Body(...), aliases: dict[str, str] = Body(default_factory=dict)) -> JSONResponse:
        dirs = [lib.match_dir(i) for i in ids]
        if not dirs:
            raise HTTPException(400, "pick at least one match")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = aggregate(dirs, aliases)
        return JSONResponse({"tables": tables(result), "warnings": [str(w.message) for w in caught]})

    if STATIC_DIR.exists():
        api.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    else:
        @api.get("/")
        def no_frontend() -> Response:
            return Response("Frontend is not built: cd frontend && npm install && npm run build", media_type="text/plain")

    return api
