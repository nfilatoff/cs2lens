import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MatchOverview, type Movement, type MovementFilter, type Points, type Row } from "../api";
import { go } from "../App";
import { drawCallouts, useCallouts } from "../callouts";
import { GRID, PALETTES, add, drawHeat, newGrid, type HeatOptions } from "../heat";
import { drawRadar, levelLabel, levelOf, sideShort, useMapAssets, worldToPx, type MapAssets } from "../radar";
import { t, td, type Key } from "../i18n";
import { CalloutToggle } from "./CalloutToggle";
import { SampleBadge } from "./SampleBadge";

const NADE_COLORS: Record<string, string> = { smoke: "#d9d9d9", flash: "#fff35c", he: "#ff5c5c", molotov: "#ff9f1c" };

type Source = "movement" | "kills" | "shots" | "damages" | "blinds" | "plants" | "utility" | "zooms";

// label and note of a mode are mode.<key> and mode.<key>.note in the locales
interface ModeDef {
  key: string;
  source: Source;
  role?: "attacker" | "victim"; // whose position, team, side and name the row stands for
  only?: (r: Row) => boolean;
  weight?: (r: Row) => number;
}

const MODES: ModeDef[] = [
  { key: "movement", source: "movement" },
  { key: "deaths", source: "kills", role: "victim" },
  { key: "kills", source: "kills", role: "attacker" },
  { key: "open_kills", source: "kills", role: "attacker", only: (r) => !!r.opening },
  { key: "open_deaths", source: "kills", role: "victim", only: (r) => !!r.opening },
  { key: "shots", source: "shots" },
  { key: "dmg_taken", source: "damages", role: "victim", weight: (r) => Number(r.dmg) || 0 },
  { key: "dmg_dealt", source: "damages", role: "attacker", weight: (r) => Number(r.dmg) || 0 },
  { key: "blinded", source: "blinds", role: "victim", weight: (r) => Number(r.duration) || 0 },
  { key: "flashers", source: "blinds", role: "attacker", weight: (r) => Number(r.duration) || 0 },
  { key: "plants", source: "plants" },
  { key: "utility", source: "utility" },
  { key: "zooms", source: "zooms" },
];

const BUYS = ["pistol", "eco", "force", "full"];

// [label: a locale key or null for "a–b s"], from, to
const TIME_PRESETS: [Key | null, number, number][] = [
  ["time.all", 0, 300], ["time.freeze", -30, 300], [null, 0, 20], [null, 20, 45], [null, 45, 75], [null, 75, 300],
];
const presetLabel = ([key, a, b]: [Key | null, number, number]) => key ? t(key) : `${a}${b >= 300 ? "+" : `–${b}`} ${t("common.s")}`;
const RADII: [Key, number][] = [["radius.fine", 3], ["radius.medium", 7], ["radius.wide", 12]];

interface Filters {
  team: string;
  side: string;
  player: string;
  weapon: string;
  roundFrom: number;
  roundTo: number;
  tFrom: number;
  tTo: number;
  buy: string;
  oppBuy: string;
  pistol: string; // "" | loss | win: the round right after that team's pistol round
  man: string; // "" | up | even | down: more, as many or fewer players alive
}

/** Field of a row for the mode's role: attacker_x or victim_x, or x for rows of one actor. */
const field = (mode: ModeDef, r: Row, name: string) => r[mode.role ? `${mode.role}_${name}` : name];

/** A row's context is told from its actor (the attacker): the view of the victim turns it around. */
function contextMatches(mode: ModeDef, r: Row, f: Filters): boolean {
  const victim = mode.role === "victim";
  const buy = victim ? r.opp_buy : r.buy, opp = victim ? r.buy : r.opp_buy;
  if (f.buy && buy !== f.buy) return false;
  if (f.oppBuy && opp !== f.oppBuy) return false;
  if (f.pistol) {
    if (r.after_pistol_loss === null || r.after_pistol_loss === undefined) return false;
    if ((f.pistol === "loss") !== (victim ? !r.after_pistol_loss : !!r.after_pistol_loss)) return false;
  }
  if (f.man) {
    if (r.man_diff === null || r.man_diff === undefined) return false;
    const diff = (victim ? -1 : 1) * Number(r.man_diff);
    if (f.man === "up" ? diff <= 0 : f.man === "down" ? diff >= 0 : diff !== 0) return false;
  }
  return true;
}

function selectRows(points: Points, mode: ModeDef, f: Filters, types: Record<string, boolean>): Row[] {
  if (mode.source === "movement") return [];
  const rows = (points[mode.source] ?? []) as Row[];
  return rows.filter((r) => {
    const round = r.round_num as number, sec = r.sec as number;
    if (round < f.roundFrom || round > f.roundTo || sec < f.tFrom || sec > f.tTo) return false;
    if (mode.only && !mode.only(r)) return false;
    if (f.team && field(mode, r, "team") !== f.team) return false;
    if (f.side && field(mode, r, "side") !== f.side) return false;
    if (f.player && field(mode, r, "name") !== f.player) return false;
    if (f.weapon && "weapon" in r && r.weapon !== f.weapon) return false;
    if (mode.source === "utility" && !types[r.type as string]) return false;
    if (!contextMatches(mode, r, f)) return false;
    return field(mode, r, "x") !== null;
  });
}

interface View extends HeatOptions {
  callouts: boolean;
  dots: boolean;
}

function render(canvas: HTMLCanvasElement, assets: MapAssets, mode: ModeDef, rows: Row[], movement: Movement | null, size: number, v: View) {
  const { meta, images } = assets;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = size / 1024;
  meta.levels.forEach((_, li) => {
    const ox = li * size;
    drawRadar(ctx, images[li], ox, size);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(ox, 0, size, size);
    const toPx = (x: number, y: number): [number, number] => {
      const [px, py] = worldToPx(meta, x, y);
      return [ox + px * k, py * k];
    };
    const onLevel = (r: Row) => meta.levels.length === 1 || levelOf(meta, field(mode, r, "z") as number) === li;

    if (mode.source === "utility") {
      for (const r of rows) {
        if (!onLevel(r)) continue;
        const [px, py] = toPx(r.x as number, r.y as number);
        ctx.fillStyle = NADE_COLORS[r.type as string] ?? "#ccc";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      const grid = newGrid();
      if (mode.source === "movement") {
        for (const [i, j, n] of movement?.levels[li] ?? []) grid[j * GRID + i] += n;
      } else {
        for (const r of rows) {
          if (!onLevel(r)) continue;
          const [px, py] = worldToPx(meta, field(mode, r, "x") as number, field(mode, r, "y") as number);
          add(grid, px, py, mode.weight ? mode.weight(r) : 1);
        }
      }
      drawHeat(ctx, grid, ox, size, v);
      if (v.dots && mode.source !== "movement") {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        for (const r of rows) {
          if (!onLevel(r)) continue;
          const [px, py] = toPx(field(mode, r, "x") as number, field(mode, r, "y") as number);
          ctx.fillRect(px - 1.2, py - 1.2, 2.4, 2.4);
        }
      }
    }

    if (v.callouts) drawCallouts(ctx, meta, li, ox, size);
    if (meta.levels.length > 1) {
      ctx.fillStyle = "#fff";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(levelLabel(meta, li), ox + 10, 20);
    }
  });
}

/** What a heatmap shows: one match, or the rounds of a team over several matches. */
export interface HeatSource {
  key: string; // data is loaded again when this changes
  map: string;
  points: () => Promise<Points>;
  movement: (f: MovementFilter) => Promise<Movement>;
  teams: string[];
  players: string[];
  maxRound: number | null; // null: rounds of many matches, no round range
  fixedTeam?: string; // the team is set outside: no team choice, and rows are its point of view
  fixedBuy?: boolean; // the buy is set outside
  matchId?: string; // for rows without their own match_id
}

export function MapsView({ match }: { match: MatchOverview }) {
  const source = useMemo<HeatSource>(() => ({
    key: match.id,
    map: match.map,
    points: () => api.points(match.id),
    movement: (f) => api.movement(match.id, f),
    teams: Object.keys(match.score),
    players: [...new Set(match.players.map((p) => String(p.name)))].sort((a, b) => a.localeCompare(b)),
    maxRound: match.timeline.length ? match.timeline[match.timeline.length - 1].round : 1,
    matchId: match.id,
  }), [match]);
  return <HeatmapPanel source={source} />;
}

export function HeatmapPanel({ source }: { source: HeatSource }) {
  const { assets, error: mapError } = useMapAssets(source.map);
  const [points, setPoints] = useState<Points | null>(null);
  const [movement, setMovement] = useState<Movement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modeKey, setModeKey] = useState("movement");
  const maxRound = source.maxRound ?? 999;
  const [f, setF] = useState<Filters>({
    team: source.fixedTeam ?? "", side: "", player: "", weapon: "", roundFrom: 1, roundTo: maxRound, tFrom: 0, tTo: 300, buy: "", oppBuy: "", pistol: "", man: "",
  });
  const [types, setTypes] = useState<Record<string, boolean>>({ smoke: true, flash: true, he: true, molotov: true });
  const [view, setView] = useState<Omit<View, "callouts">>({ radius: 7, palette: "inferno", opacity: 0.85, scale: "log", dots: false });
  const callouts = useCallouts();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = MODES.find((m) => m.key === modeKey)!;
  const set = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }));

  useEffect(() => {
    setPoints(null);
    source.points().then(setPoints).catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.key]);

  // the movement density is binned on the server (hundreds of thousands of positions)
  useEffect(() => {
    if (mode.source !== "movement") return;
    let alive = true;
    const t = setTimeout(() => {
      source.movement({
        team: f.team, side: f.side, player: f.player, round_from: f.roundFrom, round_to: f.roundTo, t_from: f.tFrom, t_to: f.tTo,
        buy: f.buy, opp_buy: f.oppBuy, pistol: f.pistol, man: f.man,
      })
        .then((mv) => alive && setMovement(mv))
        .catch((e: Error) => alive && setError(e.message));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.key, mode.source, f.team, f.side, f.player, f.roundFrom, f.roundTo, f.tFrom, f.tTo, f.buy, f.oppBuy, f.pistol, f.man]);

  const { teams, players } = source;
  const weapons = useMemo(() => {
    if (!points || !["kills", "shots", "damages", "zooms"].includes(mode.source)) return [];
    const rows = points[mode.source as "kills" | "shots" | "damages" | "zooms"] ?? [];
    const counts = new Map<string, number>();
    for (const r of rows) if (r.weapon) counts.set(String(r.weapon), (counts.get(String(r.weapon)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  }, [points, mode.source]);
  useEffect(() => {
    if (f.weapon && !weapons.includes(f.weapon)) set({ weapon: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weapons]);

  const rows = useMemo(() => (points ? selectRows(points, mode, f, types) : []), [points, mode, f, types]);

  const n = assets?.meta.levels.length ?? 1;
  const size = Math.min(760, Math.floor((window.innerWidth - 80) / n));
  useEffect(() => {
    if (canvasRef.current && assets) render(canvasRef.current, assets, mode, rows, movement, size, { ...view, callouts });
  }, [assets, mode, rows, movement, size, view, callouts]);

  if (error || mapError) return <div className="error">{error ?? mapError}</div>;
  if (!points || !assets) return <div>{t("common.loading")}</div>;
  const dpr = window.devicePixelRatio || 1;
  const count = mode.source === "movement"
    ? movement ? t("maps.playerMinutes", { n: Math.round(movement.player_seconds / 60) }) : "…"
    : t("maps.points", { n: rows.length });
  // rounds behind what is on the map: a conclusion needs to show its sample
  const roundsShown = mode.source === "movement" ? null : new Set(rows.map((r) => `${r.match_id ?? ""}:${r.round_num}`)).size;

  // a click on a point of the map opens its round in the replay
  const openNearest = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode.source === "movement") return;
    const box = e.currentTarget.getBoundingClientRect();
    const k = size / 1024, x = e.clientX - box.left, y = e.clientY - box.top;
    const li = Math.floor(x / size);
    let best: Row | null = null, bestD = 14 * 14;
    for (const r of rows) {
      if (assets.meta.levels.length > 1 && levelOf(assets.meta, field(mode, r, "z") as number) !== li) continue;
      const [px, py] = worldToPx(assets.meta, field(mode, r, "x") as number, field(mode, r, "y") as number);
      const d = (li * size + px * k - x) ** 2 + (py * k - y) ** 2;
      if (d < bestD) [best, bestD] = [r, d];
    }
    const id = best && ((best.match_id as string | undefined) ?? source.matchId);
    if (best && id) go("match", id, "replay", best.round_num as number, Math.max(0, Math.floor(best.sec as number) - 3));
  };

  return (
    <div>
      <div className="filters">
        <span className="seg wrap">
          {MODES.map((m) => (
            <button key={m.key} className={modeKey === m.key ? "on" : ""} onClick={() => setModeKey(m.key)}>{td(`mode.${m.key}`, m.key)}</button>
          ))}
        </span>
      </div>
      <div className="filters">
        {!source.fixedTeam && (
          <>
            <select value={f.team} onChange={(e) => set({ team: e.target.value })}>
              <option value="">{t("common.allTeams")}</option>
              {teams.map((tm) => <option key={tm}>{tm}</option>)}
            </select>
            <select value={f.side} onChange={(e) => set({ side: e.target.value })}>
              <option value="">{t("common.bothSides")}</option>
              <option value="terrorist">T</option>
              <option value="counter-terrorist">CT</option>
            </select>
          </>
        )}
        <select value={f.player} onChange={(e) => set({ player: e.target.value })}>
          <option value="">{t("common.allPlayers")}</option>
          {players.map((p) => <option key={p}>{p}</option>)}
        </select>
        {weapons.length > 0 && (
          <select value={f.weapon} onChange={(e) => set({ weapon: e.target.value })}>
            <option value="">{t("maps.anyWeapon")}</option>
            {weapons.map((w) => <option key={w}>{w}</option>)}
          </select>
        )}
        {source.maxRound !== null && (
          <label className="small">
            {t("maps.rounds")}{" "}
            <input type="number" min={1} max={maxRound} value={f.roundFrom} onChange={(e) => set({ roundFrom: Number(e.target.value) })} />–
            <input type="number" min={1} max={maxRound} value={f.roundTo} onChange={(e) => set({ roundTo: Number(e.target.value) })} />
          </label>
        )}
      </div>
      <div className="filters">
        {!source.fixedBuy && (
          <select value={f.buy} onChange={(e) => set({ buy: e.target.value })} title={t("maps.buyTitle")}>
            <option value="">{t("maps.anyBuy")}</option>
            {BUYS.map((b) => <option key={b} value={b}>{td(`buy.${b}`, b)}</option>)}
          </select>
        )}
        <select value={f.oppBuy} onChange={(e) => set({ oppBuy: e.target.value })} title={t("maps.oppBuyTitle")}>
          <option value="">{t("maps.anyOppBuy")}</option>
          {BUYS.map((b) => <option key={b} value={b}>{t("maps.oppBuy", { buy: td(`buy.${b}`, b) })}</option>)}
        </select>
        <select value={f.pistol} onChange={(e) => set({ pistol: e.target.value })}>
          <option value="">{t("maps.anyPistol")}</option>
          <option value="loss">{t("maps.afterPistolLoss")}</option>
          <option value="win">{t("maps.afterPistolWin")}</option>
        </select>
        <span className="seg" title={t("maps.manTitle")}>
          {([["", "maps.manAny"], ["up", "maps.manUp"], ["even", "maps.manEven"], ["down", "maps.manDown"]] as [string, Key][]).map(([v, label]) => (
            <button key={v} className={f.man === v ? "on" : ""} onClick={() => set({ man: v })}>{t(label)}</button>
          ))}
        </span>
      </div>
      <div className="filters">
        <span className="small muted">{t("maps.roundTime")}</span>
        <span className="seg">
          {TIME_PRESETS.map((p) => (
            <button key={`${p[1]}-${p[2]}`} className={f.tFrom === p[1] && f.tTo === p[2] ? "on" : ""} onClick={() => set({ tFrom: p[1], tTo: p[2] })}>{presetLabel(p)}</button>
          ))}
        </span>
        <label className="small">
          {t("common.from")} <input type="number" value={f.tFrom} onChange={(e) => set({ tFrom: Number(e.target.value) })} /> {t("common.to")}{" "}
          <input type="number" value={f.tTo} onChange={(e) => set({ tTo: Number(e.target.value) })} /> {t("maps.afterFreeze")}
        </label>
        {mode.source === "utility" &&
          Object.keys(types).map((ty) => (
            <label key={ty} className="small" style={{ color: NADE_COLORS[ty] }}>
              <input type="checkbox" checked={types[ty]} onChange={(e) => setTypes({ ...types, [ty]: e.target.checked })} /> {td(`nades.${ty}`, ty)}
            </label>
          ))}
      </div>
      {mode.source !== "utility" && (
        <div className="filters small">
          <span className="seg">
            {RADII.map(([label, r]) => <button key={label} className={view.radius === r ? "on" : ""} onClick={() => setView({ ...view, radius: r })}>{t(label)}</button>)}
          </span>
          <select value={view.palette} onChange={(e) => setView({ ...view, palette: e.target.value })}>
            {Object.keys(PALETTES).map((k) => <option key={k} value={k}>{t("maps.palette", { name: td(`palette.${k}`, k) })}</option>)}
          </select>
          <span className="seg">
            <button className={view.scale === "log" ? "on" : ""} onClick={() => setView({ ...view, scale: "log" })} title={t("maps.logTitle")}>{t("maps.log")}</button>
            <button className={view.scale === "linear" ? "on" : ""} onClick={() => setView({ ...view, scale: "linear" })} title={t("maps.linearTitle")}>{t("maps.linear")}</button>
          </span>
          <label>
            {t("maps.opacity")} <input type="range" min={0.3} max={1} step={0.05} value={view.opacity} onChange={(e) => setView({ ...view, opacity: Number(e.target.value) })} />
          </label>
          {mode.source !== "movement" && (
            <label><input type="checkbox" checked={view.dots} onChange={(e) => setView({ ...view, dots: e.target.checked })} /> {t("maps.dots")}</label>
          )}
        </div>
      )}
      <div className="filters small">
        <CalloutToggle meta={assets.meta} />
        <span className="muted">{count}</span>
        {roundsShown !== null && <SampleBadge rounds={roundsShown} />}
      </div>
      {mode.source === "utility" && points.utility_error && <div className="warn">{t("maps.nadesUnavailable", { error: points.utility_error })}</div>}
      <canvas
        ref={canvasRef} width={size * n * dpr} height={size * dpr} style={{ width: size * n, height: size, cursor: mode.source === "movement" ? undefined : "pointer" }}
        onClick={openNearest} title={mode.source === "movement" ? undefined : t("maps.clickOpens")}
      />
      <div className="muted small">
        {td(`mode.${mode.key}.note`, "")}
        {f.side ? t("maps.sideNote", { side: sideShort(f.side) }) : ""}
      </div>
    </div>
  );
}
