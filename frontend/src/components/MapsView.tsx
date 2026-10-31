import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MatchOverview, type Movement, type Points, type Row } from "../api";
import { GRID, PALETTES, add, drawHeat, newGrid, type HeatOptions } from "../heat";
import { drawRadar, levelLabel, levelOf, sideShort, useMapAssets, worldToPx, type MapAssets } from "../radar";

const NADE_COLORS: Record<string, string> = { smoke: "#d9d9d9", flash: "#fff35c", he: "#ff5c5c", molotov: "#ff9f1c" };
const NADE_LABELS: Record<string, string> = { smoke: "смоки", flash: "флешки", he: "HE", molotov: "молотовы" };

type Source = "movement" | "kills" | "shots" | "damages" | "blinds" | "plants" | "utility";

interface ModeDef {
  key: string;
  label: string;
  source: Source;
  role?: "attacker" | "victim"; // whose position, team, side and name the row stands for
  only?: (r: Row) => boolean;
  weight?: (r: Row) => number;
  note: string;
}

const MODES: ModeDef[] = [
  { key: "movement", label: "передвижение", source: "movement", note: "Где живые игроки проводят время: каждая позиция раз в 4 тика (16 в секунду)." },
  { key: "deaths", label: "где умирали", source: "kills", role: "victim", note: "Места гибели." },
  { key: "kills", label: "откуда убивали", source: "kills", role: "attacker", note: "Позиции убийц в момент убийства." },
  { key: "open_kills", label: "первые фраги", source: "kills", role: "attacker", only: (r) => !!r.opening, note: "Откуда сделан первый фраг раунда (опенинг)." },
  { key: "open_deaths", label: "первые смерти", source: "kills", role: "victim", only: (r) => !!r.opening, note: "Где погиб первый игрок раунда." },
  { key: "shots", label: "откуда стреляли", source: "shots", note: "Позиции стрелявших: каждая пуля — точка (без ножа и гранат)." },
  { key: "dmg_taken", label: "где получали урон", source: "damages", role: "victim", weight: (r) => Number(r.dmg) || 0, note: "Позиции раненых, вес — нанесённый урон." },
  { key: "dmg_dealt", label: "откуда наносили урон", source: "damages", role: "attacker", weight: (r) => Number(r.dmg) || 0, note: "Позиции атакующих, вес — урон." },
  { key: "blinded", label: "где ослепляли", source: "blinds", role: "victim", weight: (r) => Number(r.duration) || 0, note: "Позиции ослеплённых соперником, вес — длительность ослепления." },
  { key: "flashers", label: "откуда флешили", source: "blinds", role: "attacker", weight: (r) => Number(r.duration) || 0, note: "Позиции бросавших флешку, ослепившую соперника." },
  { key: "plants", label: "планты", source: "plants", note: "Места закладки бомбы." },
  { key: "utility", label: "гранаты", source: "utility", note: "Точка — место, где граната сработала (смок, флешка, HE) или загорелся молотов." },
];

const TIME_PRESETS: [string, number, number][] = [
  ["весь раунд", 0, 300], ["с фризтаймом", -30, 300], ["0–20 с", 0, 20], ["20–45 с", 20, 45], ["45–75 с", 45, 75], ["75+ с", 75, 300],
];
const RADII: [string, number][] = [["мелко", 3], ["средне", 7], ["широко", 12]];

interface Filters {
  team: string;
  side: string;
  player: string;
  weapon: string;
  roundFrom: number;
  roundTo: number;
  tFrom: number;
  tTo: number;
}

/** Field of a row for the mode's role: attacker_x or victim_x, or x for rows of one actor. */
const field = (mode: ModeDef, r: Row, name: string) => r[mode.role ? `${mode.role}_${name}` : name];

function selectRows(points: Points, mode: ModeDef, f: Filters, types: Record<string, boolean>): Row[] {
  if (mode.source === "movement") return [];
  const rows = points[mode.source] as Row[];
  return rows.filter((r) => {
    const round = r.round_num as number, sec = r.sec as number;
    if (round < f.roundFrom || round > f.roundTo || sec < f.tFrom || sec > f.tTo) return false;
    if (mode.only && !mode.only(r)) return false;
    if (f.team && field(mode, r, "team") !== f.team) return false;
    if (f.side && field(mode, r, "side") !== f.side) return false;
    if (f.player && field(mode, r, "name") !== f.player) return false;
    if (f.weapon && "weapon" in r && r.weapon !== f.weapon) return false;
    if (mode.source === "utility" && !types[r.type as string]) return false;
    return field(mode, r, "x") !== null;
  });
}

interface View extends HeatOptions {
  zones: boolean;
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

    if (v.zones) {
      ctx.lineWidth = 1;
      for (const z of meta.zones.filter((z) => meta.levels[li].name === z.level)) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        z.polygon.forEach(([x, y], i) => (i ? ctx.lineTo(...toPx(x, y)) : ctx.moveTo(...toPx(x, y))));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      const seen = new Set<string>();
      for (const z of meta.zones.filter((z) => meta.levels[li].name === z.level)) {
        if (seen.has(z.name)) continue;
        seen.add(z.name);
        const cx = z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length;
        const cy = z.polygon.reduce((a, p) => a + p[1], 0) / z.polygon.length;
        const [px, py] = toPx(cx, cy);
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillText(z.name, px, py);
      }
    }
    if (meta.levels.length > 1) {
      ctx.fillStyle = "#fff";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(levelLabel(meta, li), ox + 10, 20);
    }
  });
}

export function MapsView({ match }: { match: MatchOverview }) {
  const { assets, error: mapError } = useMapAssets(match.map);
  const [points, setPoints] = useState<Points | null>(null);
  const [movement, setMovement] = useState<Movement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modeKey, setModeKey] = useState("movement");
  const maxRound = match.timeline.length ? match.timeline[match.timeline.length - 1].round : 1;
  const [f, setF] = useState<Filters>({ team: "", side: "", player: "", weapon: "", roundFrom: 1, roundTo: maxRound, tFrom: 0, tTo: 300 });
  const [types, setTypes] = useState<Record<string, boolean>>({ smoke: true, flash: true, he: true, molotov: true });
  const [view, setView] = useState<View>({ radius: 7, palette: "inferno", opacity: 0.85, scale: "log", zones: false, dots: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = MODES.find((m) => m.key === modeKey)!;
  const set = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }));

  useEffect(() => {
    api.points(match.id).then(setPoints).catch((e: Error) => setError(e.message));
  }, [match.id]);

  // the movement density is binned on the server (hundreds of thousands of positions)
  useEffect(() => {
    if (mode.source !== "movement") return;
    let alive = true;
    const t = setTimeout(() => {
      api.movement(match.id, { team: f.team, side: f.side, player: f.player, round_from: f.roundFrom, round_to: f.roundTo, t_from: f.tFrom, t_to: f.tTo })
        .then((mv) => alive && setMovement(mv))
        .catch((e: Error) => alive && setError(e.message));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [match.id, mode.source, f.team, f.side, f.player, f.roundFrom, f.roundTo, f.tFrom, f.tTo]);

  const teams = Object.keys(match.score);
  const players = useMemo(() => [...new Set(match.players.map((p) => String(p.name)))].sort((a, b) => a.localeCompare(b)), [match.players]);
  const weapons = useMemo(() => {
    if (!points || !["kills", "shots", "damages"].includes(mode.source)) return [];
    const rows = points[mode.source as "kills" | "shots" | "damages"];
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
    if (canvasRef.current && assets) render(canvasRef.current, assets, mode, rows, movement, size, view);
  }, [assets, mode, rows, movement, size, view]);

  if (error || mapError) return <div className="error">{error ?? mapError}</div>;
  if (!points || !assets) return <div>Загрузка…</div>;
  const dpr = window.devicePixelRatio || 1;
  const count = mode.source === "movement"
    ? movement ? `${Math.round(movement.player_seconds / 60)} игроко-минут` : "…"
    : `точек: ${rows.length}`;

  return (
    <div>
      <div className="filters">
        <span className="seg wrap">
          {MODES.map((m) => (
            <button key={m.key} className={modeKey === m.key ? "on" : ""} onClick={() => setModeKey(m.key)}>{m.label}</button>
          ))}
        </span>
      </div>
      <div className="filters">
        <select value={f.team} onChange={(e) => set({ team: e.target.value })}>
          <option value="">все команды</option>
          {teams.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={f.side} onChange={(e) => set({ side: e.target.value })}>
          <option value="">обе стороны</option>
          <option value="terrorist">T</option>
          <option value="counter-terrorist">CT</option>
        </select>
        <select value={f.player} onChange={(e) => set({ player: e.target.value })}>
          <option value="">все игроки</option>
          {players.map((p) => <option key={p}>{p}</option>)}
        </select>
        {weapons.length > 0 && (
          <select value={f.weapon} onChange={(e) => set({ weapon: e.target.value })}>
            <option value="">любое оружие</option>
            {weapons.map((w) => <option key={w}>{w}</option>)}
          </select>
        )}
        <label className="small">
          раунды{" "}
          <input type="number" min={1} max={maxRound} value={f.roundFrom} onChange={(e) => set({ roundFrom: Number(e.target.value) })} />–
          <input type="number" min={1} max={maxRound} value={f.roundTo} onChange={(e) => set({ roundTo: Number(e.target.value) })} />
        </label>
      </div>
      <div className="filters">
        <span className="small muted">время раунда:</span>
        <span className="seg">
          {TIME_PRESETS.map(([label, a, b]) => (
            <button key={label} className={f.tFrom === a && f.tTo === b ? "on" : ""} onClick={() => set({ tFrom: a, tTo: b })}>{label}</button>
          ))}
        </span>
        <label className="small">
          с <input type="number" value={f.tFrom} onChange={(e) => set({ tFrom: Number(e.target.value) })} /> до{" "}
          <input type="number" value={f.tTo} onChange={(e) => set({ tTo: Number(e.target.value) })} /> с после фризтайма
        </label>
        {mode.source === "utility" &&
          Object.keys(types).map((t) => (
            <label key={t} className="small" style={{ color: NADE_COLORS[t] }}>
              <input type="checkbox" checked={types[t]} onChange={(e) => setTypes({ ...types, [t]: e.target.checked })} /> {NADE_LABELS[t]}
            </label>
          ))}
      </div>
      {mode.source !== "utility" && (
        <div className="filters small">
          <span className="seg">
            {RADII.map(([label, r]) => <button key={label} className={view.radius === r ? "on" : ""} onClick={() => setView({ ...view, radius: r })}>{label}</button>)}
          </span>
          <select value={view.palette} onChange={(e) => setView({ ...view, palette: e.target.value })}>
            {Object.entries(PALETTES).map(([k, p]) => <option key={k} value={k}>палитра: {p.label}</option>)}
          </select>
          <span className="seg">
            <button className={view.scale === "log" ? "on" : ""} onClick={() => setView({ ...view, scale: "log" })} title="Видно и редкие места">лог. шкала</button>
            <button className={view.scale === "linear" ? "on" : ""} onClick={() => setView({ ...view, scale: "linear" })} title="Видны только самые частые места">линейная</button>
          </span>
          <label>
            прозрачность <input type="range" min={0.3} max={1} step={0.05} value={view.opacity} onChange={(e) => setView({ ...view, opacity: Number(e.target.value) })} />
          </label>
          {mode.source !== "movement" && (
            <label><input type="checkbox" checked={view.dots} onChange={(e) => setView({ ...view, dots: e.target.checked })} /> точки</label>
          )}
        </div>
      )}
      <div className="filters small">
        <label><input type="checkbox" checked={view.zones} onChange={(e) => setView({ ...view, zones: e.target.checked })} /> зоны карты</label>
        <span className="muted">{count}</span>
      </div>
      {mode.source === "utility" && points.utility_error && <div className="warn">Гранаты недоступны: {points.utility_error}</div>}
      <canvas ref={canvasRef} width={size * n * dpr} height={size * dpr} style={{ width: size * n, height: size }} />
      <div className="muted small">
        {mode.note}
        {f.side ? ` Сторона: ${sideShort(f.side)}.` : ""}
      </div>
    </div>
  );
}
