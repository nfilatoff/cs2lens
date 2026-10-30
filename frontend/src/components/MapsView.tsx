import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MatchOverview, type Points, type Row } from "../api";
import { drawRadar, levelLabel, levelOf, sideShort, useMapAssets, worldToPx, type MapAssets } from "../radar";

const NADE_COLORS: Record<string, string> = { smoke: "#d9d9d9", flash: "#fff35c", he: "#ff5c5c", molotov: "#ff9f1c" };
const NADE_LABELS: Record<string, string> = { smoke: "смоки", flash: "флешки", he: "HE", molotov: "молотовы" };

type Mode = "deaths" | "kills" | "utility";

// A small "inferno"-like ramp for the heatmap.
const RAMP: [number, [number, number, number]][] = [
  [0, [0, 0, 0]], [0.25, [87, 16, 110]], [0.5, [188, 55, 84]], [0.75, [249, 142, 9]], [1, [252, 255, 164]],
];
function ramp(v: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    if (v <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i];
      const f = (v - a) / (b - a);
      return [0, 1, 2].map((c) => ca[c] + (cb[c] - ca[c]) * f) as [number, number, number];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

function drawHeat(ctx: CanvasRenderingContext2D, pts: [number, number][], ox: number, size: number) {
  if (!pts.length) return;
  const off = document.createElement("canvas");
  off.width = off.height = size;
  const o = off.getContext("2d")!;
  const r = size / 28;
  o.globalCompositeOperation = "lighter";
  for (const [x, y] of pts) {
    const g = o.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.18)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    o.fillStyle = g;
    o.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  const img = o.getImageData(0, 0, size, size);
  let max = 1;
  for (let i = 3; i < img.data.length; i += 4) max = Math.max(max, img.data[i]);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i + 3] / max;
    if (v < 0.03) {
      img.data[i + 3] = 0;
      continue;
    }
    const [cr, cg, cb] = ramp(v);
    img.data[i] = cr;
    img.data[i + 1] = cg;
    img.data[i + 2] = cb;
    img.data[i + 3] = Math.min(255, 60 + v * 200);
  }
  o.putImageData(img, 0, 0);
  ctx.drawImage(off, ox, 0);
}

function render(
  canvas: HTMLCanvasElement, assets: MapAssets, mode: Mode, rows: Row[], size: number, showZones: boolean,
) {
  const { meta, images } = assets;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = size / 1024;
  meta.levels.forEach((_, li) => {
    const ox = li * size;
    drawRadar(ctx, images[li], ox, size);
    const toPx = (x: number, y: number): [number, number] => {
      const [px, py] = worldToPx(meta, x, y);
      return [ox + px * k, py * k];
    };
    if (showZones) {
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
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillText(z.name, px, py);
      }
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#00ff66";
      for (const s of meta.sites.filter((s) => meta.levels[li].name === s.level)) {
        ctx.beginPath();
        s.polygon.forEach(([x, y], i) => (i ? ctx.lineTo(...toPx(x, y)) : ctx.moveTo(...toPx(x, y))));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (mode === "utility") {
      for (const r of rows) {
        if (levelOf(meta, r.z as number) !== li) continue;
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
      const role = mode === "deaths" ? "victim" : "attacker";
      const pts = rows
        .filter((r) => r[`${role}_x`] !== null && levelOf(meta, r[`${role}_z`] as number) === li)
        .map((r) => {
          const [px, py] = worldToPx(meta, r[`${role}_x`] as number, r[`${role}_y`] as number);
          return [px * k, py * k] as [number, number];
        });
      drawHeat(ctx, pts, ox, size);
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
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("deaths");
  const [team, setTeam] = useState("");
  const [side, setSide] = useState("");
  const [player, setPlayer] = useState("");
  const [roundFrom, setRoundFrom] = useState(1);
  const [roundTo, setRoundTo] = useState(99);
  const [types, setTypes] = useState<Record<string, boolean>>({ smoke: true, flash: true, he: true, molotov: true });
  const [zones, setZones] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api.points(match.id).then(setPoints).catch((e: Error) => setError(e.message));
  }, [match.id]);

  const teams = Object.keys(match.score);
  const players = useMemo(() => {
    if (!points) return [];
    const names = new Set<string>();
    for (const k of points.kills) {
      if (k.attacker_name) names.add(k.attacker_name as string);
      if (k.victim_name) names.add(k.victim_name as string);
    }
    return [...names].sort();
  }, [points]);

  const rows = useMemo(() => {
    if (!points) return [];
    const inRound = (r: Row) => (r.round_num as number) >= roundFrom && (r.round_num as number) <= roundTo;
    if (mode === "utility") {
      return points.utility.filter(
        (r) => inRound(r) && types[r.type as string] && (!team || r.team === team) && (!side || r.side === side) && (!player || r.name === player),
      );
    }
    const role = mode === "deaths" ? "victim" : "attacker";
    return points.kills.filter(
      (r) => inRound(r) && (!team || r[`${role}_team`] === team) && (!side || r[`${role}_side`] === side) && (!player || r[`${role}_name`] === player),
    );
  }, [points, mode, team, side, player, roundFrom, roundTo, types]);

  const n = assets?.meta.levels.length ?? 1;
  const size = Math.min(760, Math.floor((window.innerWidth - 80) / n));
  useEffect(() => {
    if (canvasRef.current && assets) render(canvasRef.current, assets, mode, rows, size, zones);
  }, [assets, mode, rows, size, zones]);

  if (error || mapError) return <div className="error">{error ?? mapError}</div>;
  if (!points || !assets) return <div>Загрузка…</div>;
  const dpr = window.devicePixelRatio || 1;
  const maxRound = match.timeline.length ? match.timeline[match.timeline.length - 1].round : 1;

  return (
    <div>
      <div className="filters">
        <span className="seg">
          {(["deaths", "kills", "utility"] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m === "deaths" ? "где умирали" : m === "kills" ? "откуда убивали" : "гранаты"}
            </button>
          ))}
        </span>
        <select value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">все команды</option>
          {teams.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="">обе стороны</option>
          <option value="terrorist">T</option>
          <option value="counter-terrorist">CT</option>
        </select>
        <select value={player} onChange={(e) => setPlayer(e.target.value)}>
          <option value="">все игроки</option>
          {players.map((p) => <option key={p}>{p}</option>)}
        </select>
        <label className="small">
          раунды{" "}
          <input type="number" min={1} max={maxRound} value={roundFrom} onChange={(e) => setRoundFrom(Number(e.target.value))} />–
          <input type="number" min={1} max={maxRound} value={Math.min(roundTo, maxRound)} onChange={(e) => setRoundTo(Number(e.target.value))} />
        </label>
        {mode === "utility" &&
          Object.keys(types).map((t) => (
            <label key={t} className="small" style={{ color: NADE_COLORS[t] }}>
              <input type="checkbox" checked={types[t]} onChange={(e) => setTypes({ ...types, [t]: e.target.checked })} /> {NADE_LABELS[t]}
            </label>
          ))}
        <label className="small">
          <input type="checkbox" checked={zones} onChange={(e) => setZones(e.target.checked)} /> зоны карты
        </label>
        <span className="muted small">точек: {rows.length}</span>
      </div>
      {mode === "utility" && points.utility_error && <div className="warn">Гранаты недоступны: {points.utility_error}</div>}
      <canvas ref={canvasRef} width={size * n * dpr} height={size * dpr} style={{ width: size * n, height: size }} />
      <div className="muted small">
        {mode === "utility"
          ? "Точка — место, где граната сработала (смок, флешка, HE) или загорелся молотов."
          : `Плотность ${mode === "deaths" ? "мест гибели" : "позиций убийц"}${side ? ` (${sideShort(side)})` : ""}.`}
      </div>
    </div>
  );
}
