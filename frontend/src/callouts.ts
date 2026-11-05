// Position names over a radar: the zones of the map config, one label per zone and level.
// The switch is shared by every radar of the app and remembered in this browser.
import { useSyncExternalStore } from "react";
import type { MapMeta } from "./api";
import { RADAR_SIZE, worldToPx } from "./radar";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Pt = [number, number];

const STORAGE = "cs2lens.callouts";

function saved(): boolean {
  try {
    return localStorage.getItem(STORAGE) === "1";
  } catch {
    return false;
  }
}

let current = saved();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const calloutsOn = () => current;
export function setCallouts(on: boolean) {
  current = on;
  try {
    localStorage.setItem(STORAGE, on ? "1" : "0");
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
  listeners.forEach((l) => l());
}
export const useCallouts = () => useSyncExternalStore(subscribe, calloutsOn);

// ---- where a label goes ----

function area(poly: Pt[]): number {
  let a = 0;
  poly.forEach(([x, y], i) => {
    const [nx, ny] = poly[(i + 1) % poly.length];
    a += x * ny - nx * y;
  });
  return Math.abs(a) / 2;
}

function inside(poly: Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function edgeDistance(poly: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay;
    const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - f * dx, y - ay - f * dy));
  }
  return best;
}

/** The point deepest inside a polygon: the mean of its corners can fall outside a bent zone. */
function deepestPoint(poly: Pt[]): Pt {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const N = 16;
  let best: Pt = [(x0 + x1) / 2, (y0 + y1) / 2], bestD = -1;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const x = x0 + ((x1 - x0) * i) / N, y = y0 + ((y1 - y0) * j) / N;
      if (!inside(poly, x, y)) continue;
      const d = edgeDistance(poly, x, y);
      if (d > bestD) [best, bestD] = [[x, y], d];
    }
  }
  return best;
}

interface Label {
  name: string;
  x: number; // radar px
  y: number;
  area: number;
}

interface LevelZones {
  polys: { name: string; poly: Pt[] }[]; // radar px
  labels: Label[]; // smallest zone first: it has the least room to move
}

const zoneCache = new WeakMap<MapMeta, Map<number, LevelZones>>();

function levelZones(meta: MapMeta, li: number): LevelZones {
  let byLevel = zoneCache.get(meta);
  if (!byLevel) zoneCache.set(meta, (byLevel = new Map()));
  let out = byLevel.get(li);
  if (out) return out;
  const levelName = meta.levels[li].name;
  const polys = meta.zones.filter((z) => z.level === levelName).map((z) => ({
    name: z.name,
    poly: z.polygon.map(([x, y]) => worldToPx(meta, x, y)) as Pt[],
  }));
  // a zone of several parts is labelled in its largest part
  const largest = new Map<string, Pt[]>();
  for (const { name, poly } of polys) {
    const cur = largest.get(name);
    if (!cur || area(poly) > area(cur)) largest.set(name, poly);
  }
  const labels = [...largest].map(([name, poly]) => {
    const [x, y] = deepestPoint(poly);
    return { name, x, y, area: area(poly) };
  }).sort((a, b) => a.area - b.area);
  out = { polys, labels };
  byLevel.set(li, out);
  return out;
}

interface Placed {
  name: string;
  x: number; // label centre, px of the panel
  y: number;
  w: number;
  ax: number; // the zone's own point
  ay: number;
}

const placeCache = new WeakMap<MapMeta, Map<string, Placed[]>>();

/** Label boxes in panel px: a label that would cover another one moves to the nearest free spot. */
function placeLabels(ctx: Ctx, meta: MapMeta, li: number, size: number, h: number): Placed[] {
  let cache = placeCache.get(meta);
  if (!cache) placeCache.set(meta, (cache = new Map()));
  const key = `${li}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const k = size / RADAR_SIZE;
  const placed: Placed[] = [];
  const overlap = (x: number, y: number, w: number, skip?: Placed) => placed.reduce((sum, p) => {
    if (p === skip) return sum;
    const ox = (w + p.w) / 2 + 1 - Math.abs(x - p.x), oy = h + 1 - Math.abs(y - p.y);
    return ox > 0 && oy > 0 ? sum + ox * oy : sum;
  }, 0);
  for (const label of levelZones(meta, li).labels) {
    const w = ctx.measureText(label.name).width + 6;
    const ax = label.x * k, ay = label.y * k;
    let best: Pt = [ax, ay], bestScore = Infinity;
    for (let ring = 0; ring <= 4 && bestScore > 0; ring++) {
      const dy = ring * (h + 1), dx = ring * (w / 2 + 2);
      const options: Pt[] = ring === 0 ? [[0, 0]] : [[0, -dy], [0, dy], [dx, 0], [-dx, 0], [dx, -dy], [-dx, -dy], [dx, dy], [-dx, dy]];
      for (const [ox, oy] of options) {
        const x = Math.max(w / 2, Math.min(size - w / 2, ax + ox)), y = Math.max(h / 2, Math.min(size - h / 2, ay + oy));
        const score = overlap(x, y, w);
        if (score < bestScore) [best, bestScore] = [[x, y], score];
        if (score === 0) break;
      }
    }
    placed.push({ name: label.name, x: best[0], y: best[1], w, ax, ay });
  }
  cache.set(key, placed);
  return placed;
}

// ---- drawing ----

export interface CalloutOptions {
  highlight?: string | null; // a zone to fill
  labels?: boolean; // default true
}

/** Zone outlines and names on one radar panel of `size` px at (ox, 0); draw it under the players. */
export function drawCallouts(ctx: Ctx, meta: MapMeta, li: number, ox: number, size: number, o: CalloutOptions = {}) {
  if (!meta.zones.length) return;
  const k = size / RADAR_SIZE;
  const { polys } = levelZones(meta, li);
  ctx.save();
  ctx.translate(ox, 0);
  ctx.lineWidth = 1;
  for (const { name, poly } of polys) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    ctx.closePath();
    const lit = name === o.highlight;
    if (lit) {
      ctx.fillStyle = "rgba(255,85,0,0.4)";
      ctx.fill();
    }
    ctx.strokeStyle = lit ? "#ff5500" : "rgba(255,255,255,0.28)";
    ctx.stroke();
  }
  if (o.labels !== false) {
    const font = Math.max(9, Math.min(14, size * 0.0135));
    const h = Math.round(font * 1.35);
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labels = placeLabels(ctx, meta, li, size, h);
    for (const p of labels) {
      if (Math.hypot(p.x - p.ax, p.y - p.ay) <= h) continue;
      // moved away from its zone: a line says where it belongs
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.beginPath();
      ctx.moveTo(p.ax, p.ay);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    for (const p of labels) {
      ctx.fillStyle = p.name === o.highlight ? "#ff5500" : "rgba(0,0,0,0.68)";
      ctx.fillRect(p.x - p.w / 2, p.y - h / 2, p.w, h);
      ctx.fillStyle = "#fff";
      ctx.fillText(p.name, p.x, p.y + 0.5);
    }
  }
  ctx.restore();
}
