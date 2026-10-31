"""FastAPI backend of the cs2lens app: demo library, match pages, replay data, maps, aggregation.

Every analysis comes from the existing modules (``team_stats``, ``tactics``, ``aggregate``,
``replay``); this layer only loads, caches and serialises. Results are cached in memory
per extract directory and invalidated when its ``manifest.json`` changes.
"""

from __future__ import annotations

import json
import re
import shutil
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
from cs2lens.app.jobs import JobQueue
from cs2lens.context import load_match, with_round
from cs2lens.extract import add_replay, extract
from cs2lens.maps import load_map_config
from cs2lens.replay import round_payload
from cs2lens.tactics import tactics, userid_map, utility_events
from cs2lens.team_stats import team_stats

STATIC_DIR = Path(__file__).parent / "static"
UPLOADS = "_uploads"
CHUNK = 1 << 20


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

    def folders(self) -> list[str]:
        if not self.settings_path.exists():
            return []
        return json.loads(self.settings_path.read_text(encoding="utf-8")).get("folders", [])

    def set_folders(self, folders: list[str]) -> None:
        self.settings_path.write_text(json.dumps({"folders": folders}, indent=2), encoding="utf-8")

    def match_dir(self, match_id: str) -> Path:
        d = self.out / match_id
        if "/" in match_id or "\\" in match_id or match_id.startswith(".") or not (d / "manifest.json").exists():
            raise HTTPException(404, f"no extract named {match_id!r}")
        return d

    def matches(self) -> list[Path]:
        return sorted(p.parent for p in self.out.glob("*/manifest.json"))

    def demos(self) -> list[Path]:
        found = []
        for folder in [*self.folders(), str(self.out / UPLOADS)]:
            p = Path(folder)
            if p.is_dir():
                found += sorted(p.glob("*.dem"))
        return found

    def demo_for(self, d: Path) -> Path | None:
        """The .dem an extract came from: the manifest path, else a same-named demo in a folder."""
        manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("demo_path") and Path(manifest["demo_path"]).exists():
            return Path(manifest["demo_path"])
        return next((p for p in self.demos() if p.stem == d.name), None)

    def owns_demo(self, path: Path) -> bool:
        """Only .dem files in the library folders (or uploads) may be deleted through the API."""
        return path.suffix.lower() == ".dem" and path.is_file() and any(path.resolve() == p.resolve() for p in self.demos())


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
def _points(d: Path, _stamp: float) -> dict:
    m = load_match(d, extra_tables=("fires", "shots"))
    names = m.data["players"].select("steamid", "name")
    kills = with_round(m.data["kills"], m.rounds).join(
        m.teams.rename({"steamid": "attacker_steamid", "team": "attacker_team"}), on="attacker_steamid", how="left"
    ).join(m.teams.rename({"steamid": "victim_steamid", "team": "victim_team"}), on="victim_steamid", how="left")
    kills = kills.select(
        "round_num", "tick", "weapon", "headshot",
        "attacker_steamid", "attacker_name", "attacker_side", "attacker_team", "attacker_x", "attacker_y", "attacker_z",
        "victim_steamid", "victim_name", "victim_side", "victim_team", "victim_x", "victim_y", "victim_z",
    )
    try:
        util = utility_events(m, userid_map(m)).join(names, on="steamid", how="left")
        util = util.select("round_num", "tick", "sec", "type", "x", "y", "z", "steamid", "name", "team", "side")
        util_error = None
    except ValueError as e:
        util, util_error = pl.DataFrame(), str(e)
    return {"map": m.map_name, "kills": rows(kills), "utility": rows(util), "utility_error": util_error}


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
    api = FastAPI(title="cs2lens")

    def queue_extract(demo: Path) -> dict:
        target = lib.out / demo.stem
        job = jobs.submit("extract", str(demo), demo.stem, lambda progress: extract(demo, target, progress=progress))
        return {"job": job.id}

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
        for cached in (_overview, _tactics, _points):
            cached.cache_clear()
        deleted_demo = None
        if source is not None and lib.owns_demo(source):
            source.unlink()
            deleted_demo = str(source)
        return {"deleted": match_id, "demo": deleted_demo}

    @api.delete("/api/demos")
    def delete_demo(path: str) -> dict:
        p = Path(path)
        if not lib.owns_demo(p):
            raise HTTPException(404, f"not a demo of the library: {path}")
        if jobs.active_for(str(p)):
            raise HTTPException(409, "the demo is being processed; wait for the job to finish")
        p.unlink()
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

    @api.get("/api/matches/{match_id}/rounds/{round_num}/replay")
    def replay(match_id: str, round_num: int) -> Response:
        d = lib.match_dir(match_id)
        try:
            payload = round_payload(d, round_num)
        except KeyError as e:
            raise HTTPException(404, str(e)) from e
        return Response(payload, media_type="application/json", headers={"Content-Encoding": "gzip", "Cache-Control": "no-cache"})

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
