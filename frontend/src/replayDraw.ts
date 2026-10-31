// Replay state and canvas primitives shared by the round replay and the clip builder.
// Drawing happens in radar pixels (1024 per radar); `s` is radar px per screen px, so
// sizes written as `n * s` stay n screen pixels at any zoom.
import { api, type Replay, type ReplayKill, type ReplayPlayer } from "./api";

export const SMOKE_RADIUS = 144; // world units
export const FIRE_RADIUS = 110;
export const SMOKE_SEC = 18;
export const FIRE_SEC = 7;
export const UNITS_PER_METER = 39.37; // a Source unit is about an inch
export const NADE_COLORS: Record<string, string> = {
  smoke: "#e3e3e3", flashbang: "#ffffff", he: "#ff5c5c", molotov: "#ff9f1c", incendiary: "#ff9f1c", decoy: "#9aa59a",
};
const ITEM_NADE: Record<string, string> = {
  smokegrenade: "smoke", flashbang: "flashbang", hegrenade: "he", molotov: "molotov", incendiary: "incendiary", decoy: "decoy",
};
const WEAPON_NAMES: Record<string, string> = {
  ak47: "AK-47", m4a1: "M4A4", m4a1_silencer: "M4A1-S", awp: "AWP", ssg08: "Scout", galilar: "Galil", famas: "FAMAS",
  aug: "AUG", sg556: "SG 553", g3sg1: "G3SG1", scar20: "SCAR-20", mac10: "MAC-10", mp9: "MP9", mp7: "MP7", mp5sd: "MP5",
  ump45: "UMP", p90: "P90", bizon: "Bizon", nova: "Nova", xm1014: "XM1014", mag7: "MAG-7", sawedoff: "Sawed-Off",
  m249: "M249", negev: "Negev", glock: "Glock", usp_silencer: "USP-S", hkp2000: "P2000", p250: "P250", fiveseven: "Five-SeveN",
  tec9: "Tec-9", cz75a: "CZ75", deagle: "Deagle", revolver: "R8", elite: "Dualies", taser: "Zeus", c4: "C4",
  smokegrenade: "смок", flashbang: "флешка", hegrenade: "HE", molotov: "молотов", incendiary: "зажигалка", decoy: "декой",
  inferno: "огонь", planted_c4: "бомба", world: "мир",
};
export const weaponName = (w: string | null | undefined) =>
  !w ? "" : w.startsWith("knife") || w === "bayonet" ? "нож" : WEAPON_NAMES[w] ?? w;
export const nadeOfItem = (item: string) => ITEM_NADE[item];

// ---- data cache: rounds kept in memory, shared by the replay and the clip builder ----
const cache = new Map<string, Promise<Replay>>();
const CACHE_ROUNDS = 40;
export function loadReplay(id: string, round: number): Promise<Replay> {
  const key = `${id}#${round}`;
  let p = cache.get(key);
  if (p) {
    cache.delete(key); // re-insert: most recently used last
  } else {
    p = api.replay(id, round);
    p.catch(() => cache.delete(key));
  }
  cache.set(key, p);
  while (cache.size > CACHE_ROUNDS) cache.delete(cache.keys().next().value!);
  return p;
}

// ---- interpolation ----
export function frameAt(ticks: number[], tick: number): [number, number] {
  // index i with ticks[i] <= tick < ticks[i+1], and the fraction between them
  let lo = 0, hi = ticks.length - 1;
  if (tick <= ticks[0]) return [0, 0];
  if (tick >= ticks[hi]) return [hi, 0];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] <= tick) lo = mid;
    else hi = mid;
  }
  return [lo, (tick - ticks[lo]) / (ticks[lo + 1] - ticks[lo])];
}

export function lerp(a: number | null, b: number | null, f: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

function lerpAngle(a: number | null, b: number | null, f: number): number | null {
  if (a === null || b === null) return a ?? b;
  const d = ((b - a + 540) % 360) - 180;
  return a + d * f;
}

export interface PlayerState {
  p: ReplayPlayer;
  x: number;
  y: number;
  z: number;
  yaw: number | null;
  hp: number;
  armor: number;
  helmet: boolean;
  kit: boolean;
  bomb: boolean;
  weapon: string | null;
  primary: string | null;
  secondary: string | null;
  nades: string[]; // grenade types (smoke, flashbang, he, molotov, incendiary, decoy), one per carried copy
  defusing: boolean;
  flash: number; // 0..1 remaining blindness
}

function inventoryAt(r: Replay, p: ReplayPlayer, tick: number): (string | null)[] | null {
  if (!p.inv?.length) return null;
  let i = 0;
  while (i + 1 < p.inv.length && p.inv[i + 1][0] <= tick) i++;
  return r.items[p.inv[i][1]];
}

export function playerState(r: Replay, p: ReplayPlayer, tick: number): PlayerState {
  const [i, f] = frameAt(r.ticks, tick);
  const j = Math.min(i + 1, r.ticks.length - 1);
  const x = lerp(p.x[i], p.x[j], f), y = lerp(p.y[i], p.y[j], f), z = lerp(p.z[i], p.z[j], f);
  let flash = 0;
  for (const b of r.blinds) {
    if (b.victim !== p.steamid || b.tick > tick) continue;
    const left = 1 - (tick - b.tick) / (b.duration * r.tick_rate);
    if (left > flash) flash = left;
  }
  const inv = inventoryAt(r, p, tick);
  return {
    p,
    x: x ?? NaN, y: y ?? NaN, z: z ?? 0,
    yaw: lerpAngle(p.yaw[i], p.yaw[j], f),
    hp: p.hp[i], armor: p.armor[i],
    helmet: !!p.helmet?.[i], kit: !!p.kit?.[i], bomb: !!p.bomb[i],
    weapon: p.weapon[i] >= 0 ? r.weapons[p.weapon[i]] : null,
    primary: inv?.[0] ?? null,
    secondary: inv?.[1] ?? null,
    nades: inv ? (inv.slice(2) as string[]).map((n) => ITEM_NADE[n] ?? n) : [],
    defusing: !!p.defusing?.[i],
    flash: Math.min(1, flash),
  };
}

export const playerStates = (r: Replay, tick: number) => r.players.map((p) => playerState(r, p, tick));

export function bombState(r: Replay, tick: number) {
  let planted: { x: number; y: number; z: number; tick: number; site: string | null } | null = null;
  let dropped: { x: number; y: number; z: number } | null = null;
  let defused: number | null = null;
  for (const e of r.bomb) {
    if (e.tick > tick) break;
    if (e.event === "finish_plant") planted = { x: e.x, y: e.y, z: e.z, tick: e.tick, site: e.site };
    else if (e.event === "drop") dropped = { x: e.x, y: e.y, z: e.z };
    else if (e.event === "pickup") dropped = null;
    else if (e.event === "defuse") defused = e.tick;
  }
  return { planted, dropped: planted ? null : dropped, defused };
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- primitives ----
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type ToPx = (x: number, y: number) => [number, number];

function withAlpha(color: string, a: number): string {
  // #rrggbb -> rgba(); other colour strings are returned unchanged
  if (color[0] !== "#" || color.length !== 7) return color;
  const n = parseInt(color.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

export function outlinedText(ctx: Ctx, text: string, x: number, y: number, s: number, size: number, color = "#fff", bold = false) {
  ctx.font = `${bold ? "600 " : ""}${size * s}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export interface PlayerStyle {
  color: string;
  alpha: number;
  label: string | null; // drawn above the icon
  weapon: boolean; // active weapon and grenades below the icon
  cone: boolean;
  shooting: boolean;
  bombOutline?: boolean;
}

const RAD = 6.5; // player icon radius, screen px
const CONE_LEN = 64; // view cone length, screen px
const CONE_HALF = 0.5; // half angle, rad (CS:GO's horizontal FOV is 90°)

/** A player icon: view cone, flash, body, HP bar, name, active weapon and carried grenades. */
export function drawPlayer(ctx: Ctx, st: PlayerState, px: number, py: number, s: number, tick: number, style: PlayerStyle) {
  const rad = RAD * s;
  const a = style.alpha;
  if (style.cone && st.yaw !== null) {
    const ang = (-st.yaw * Math.PI) / 180;
    const len = CONE_LEN * s;
    const g = ctx.createRadialGradient(px, py, rad * 0.6, px, py, len);
    g.addColorStop(0, withAlpha(style.color, 0.7 * a));
    g.addColorStop(0.55, withAlpha(style.color, 0.32 * a));
    g.addColorStop(1, withAlpha(style.color, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, len, ang - CONE_HALF, ang + CONE_HALF);
    ctx.closePath();
    ctx.fill();
    // bright edges and the aim line make the direction readable at a glance
    ctx.globalAlpha = 0.9 * a;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 1.3 * s;
    ctx.beginPath();
    for (const e of [-CONE_HALF, CONE_HALF]) {
      ctx.moveTo(px + Math.cos(ang + e) * rad, py + Math.sin(ang + e) * rad);
      ctx.lineTo(px + Math.cos(ang + e) * len * 0.8, py + Math.sin(ang + e) * len * 0.8);
    }
    ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.moveTo(px + Math.cos(ang) * rad, py + Math.sin(ang) * rad);
    ctx.lineTo(px + Math.cos(ang) * (rad + 16 * s), py + Math.sin(ang) * (rad + 16 * s));
    ctx.stroke();
  }
  ctx.globalAlpha = a;
  if (st.flash > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${0.85 * st.flash})`;
    ctx.beginPath();
    ctx.arc(px, py, rad + 5 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  if (style.shooting) {
    ctx.fillStyle = "rgba(255,240,140,0.9)";
    ctx.beginPath();
    ctx.arc(px, py, rad + 3 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  const bomb = st.bomb && style.bombOutline !== false;
  ctx.fillStyle = style.color;
  ctx.strokeStyle = bomb ? "#ff3030" : "#000";
  ctx.lineWidth = (bomb ? 2.5 : 1.2) * s;
  ctx.beginPath();
  ctx.arc(px, py, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (st.defusing) {
    ctx.strokeStyle = "#3ddc84";
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.arc(px, py, rad + 4 * s, 0, ((tick % 64) / 64) * Math.PI * 2);
    ctx.stroke();
  }
  // HP bar
  const by = py + rad + 2 * s;
  ctx.fillStyle = "#000";
  ctx.fillRect(px - 9 * s, by, 18 * s, 3 * s);
  ctx.fillStyle = st.hp > 50 ? "#3ddc84" : st.hp > 20 ? "#f2c94c" : "#ff5c5c";
  ctx.fillRect(px - 9 * s, by, (18 * s * st.hp) / 100, 3 * s);
  if (style.label) outlinedText(ctx, style.label, px, py - rad - 4 * s, s, 10, "#fff");
  if (style.weapon) {
    let y = by + 13 * s;
    if (st.weapon) {
      outlinedText(ctx, weaponName(st.weapon), px, y, s, 9, "#e8edf2", true);
      y += 3 * s;
    }
    const pips = [...st.nades, ...(st.bomb ? ["c4"] : []), ...(st.kit ? ["kit"] : [])];
    const step = 6 * s;
    let x = px - ((pips.length - 1) * step) / 2;
    for (const n of pips) {
      drawItemPip(ctx, n, x, y + 3.5 * s, s, st.weapon !== null && nadeName(st.weapon) === n);
      x += step;
    }
  }
  ctx.globalAlpha = 1;
}

const nadeName = (weapon: string) => ITEM_NADE[weapon] ?? null;

/** A small marker for a carried item: grenades as coloured dots, C4 as a red square, a kit as a green one. */
function drawItemPip(ctx: Ctx, item: string, x: number, y: number, s: number, active: boolean) {
  const r = 2.4 * s;
  ctx.lineWidth = 1 * s;
  ctx.strokeStyle = active ? "#fff" : "#000";
  if (item === "c4" || item === "kit") {
    ctx.fillStyle = item === "c4" ? "#ff3030" : "#3ddc84";
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
    return;
  }
  ctx.fillStyle = NADE_COLORS[item] ?? "#ccc";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

const TRACER_TICKS = 10; // a tracer stays this long after the shot
const TRACER_MISS = 900; // world units drawn along the view direction when the shot hit nobody

/** Bullet tracers: from the shooter to the hit player, or a fading ray along the view direction. */
export function drawShots(
  ctx: Ctx, r: Replay, tick: number, P: ToPx, s: number, scale: number,
  filter: (player: string) => boolean, color: (player: string) => string, alpha: (z: number | null) => number = () => 1,
) {
  const sh = r.shots;
  for (let q = sh.tick.length - 1; q >= 0; q--) {
    const t = sh.tick[q];
    if (t > tick) continue;
    if (t < tick - TRACER_TICKS) break;
    if (!filter(sh.player[q])) continue;
    const age = (tick - t) / TRACER_TICKS;
    const [x0, y0] = P(sh.x[q], sh.y[q]);
    const hit = sh.hx[q] !== null;
    let x1: number, y1: number;
    if (hit) [x1, y1] = P(sh.hx[q]!, sh.hy[q]!);
    else {
      const ang = (-sh.yaw[q] * Math.PI) / 180;
      x1 = x0 + Math.cos(ang) * (TRACER_MISS / scale);
      y1 = y0 + Math.sin(ang) * (TRACER_MISS / scale);
    }
    const head = Math.min(1, 0.3 + age * 1.5); // the brightest point runs from the muzzle to the target
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    const c = color(sh.player[q]);
    g.addColorStop(0, withAlpha("#fff6b0", 0.55));
    g.addColorStop(head * 0.999, withAlpha("#ffffff", 1));
    g.addColorStop(1, hit ? withAlpha("#ff5050", 1) : withAlpha(c, 0.25));
    ctx.globalAlpha = (1 - age * 0.6) * alpha(null);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.6)"; // dark outline keeps the tracer visible on light radar areas
    ctx.lineWidth = 4 * s;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.strokeStyle = g;
    ctx.lineWidth = 2 * s;
    ctx.stroke();
    ctx.lineCap = "butt";
    if (hit) {
      ctx.fillStyle = "#ff5050";
      ctx.beginPath();
      ctx.arc(x1, y1, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // arrow head at the end of the visible ray
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const mx = x0 + (x1 - x0) * 0.55, my = y0 + (y1 - y0) * 0.55;
      ctx.fillStyle = withAlpha("#fff6b0", 0.8);
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * 5 * s, my + Math.sin(ang) * 5 * s);
      ctx.lineTo(mx + Math.cos(ang + 2.5) * 4 * s, my + Math.sin(ang + 2.5) * 4 * s);
      ctx.lineTo(mx + Math.cos(ang - 2.5) * 4 * s, my + Math.sin(ang - 2.5) * 4 * s);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

export const KILL_MARK = 5; // half size of the death cross, screen px

/** Death cross; a highlighted one also shows the killer's position and the line of fire. */
export function drawKillMark(ctx: Ctx, kill: ReplayKill, P: ToPx, s: number, color: string, alpha: number, highlight = false) {
  const [px, py] = P(kill.vx, kill.vy);
  if (highlight && kill.ax !== null && kill.ay !== null) {
    const [ax, ay] = P(kill.ax, kill.ay);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fff";
    ctx.setLineDash([5 * s, 4 * s]);
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = kill.attacker_side === "counter-terrorist" ? "#5aa9ff" : "#f2b134";
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ax, ay, 5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  const d = (highlight ? 7 : KILL_MARK) * s;
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = (highlight ? 5 : 4) * s;
  ctx.beginPath();
  ctx.moveTo(px - d, py - d);
  ctx.lineTo(px + d, py + d);
  ctx.moveTo(px + d, py - d);
  ctx.lineTo(px - d, py + d);
  ctx.stroke();
  ctx.strokeStyle = highlight ? "#fff" : color;
  ctx.lineWidth = (highlight ? 3 : 2.2) * s;
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.globalAlpha = 1;
}

/** Index of the death cross under a point (radar px), or -1. */
export function killAt(kills: ReplayKill[], tick: number, P: ToPx, rx: number, ry: number, s: number, visible: (k: ReplayKill) => boolean): number {
  let best = -1, bestD = (KILL_MARK + 5) * s;
  kills.forEach((k, i) => {
    if (k.tick > tick || !visible(k)) return;
    const [px, py] = P(k.vx, k.vy);
    const d = Math.hypot(px - rx, py - ry);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** A grenade: dashed flight path so far and the grenade itself, a burst for HE and flashes. */
export function drawGrenade(
  ctx: Ctx, g: Replay["grenades"][number], tick: number, rate: number, P: ToPx, s: number, scale: number,
  pathColor: string, alpha: number, trail: boolean,
) {
  const color = NADE_COLORS[g.type] ?? "#ccc";
  const [gi, gf] = frameAt(g.t, tick);
  const gj = Math.min(gi + 1, g.t.length - 1);
  const [hpx, hpy] = P(lerp(g.x[gi], g.x[gj], gf)!, lerp(g.y[gi], g.y[gj], gf)!);
  if (trail) {
    ctx.globalAlpha = 0.8 * alpha;
    ctx.strokeStyle = pathColor;
    ctx.lineWidth = 1.2 * s;
    ctx.setLineDash([3 * s, 3 * s]);
    ctx.beginPath();
    for (let q = 0; q <= gi; q++) {
      const [px, py] = P(g.x[q], g.y[q]);
      if (q === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineTo(hpx, hpy);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (tick > g.end && (g.type === "he" || g.type === "flashbang")) {
    const burst = Math.min(1, (tick - g.end) / (0.25 * rate));
    ctx.globalAlpha = (1 - burst) * alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(hpx, hpy, (g.type === "he" ? 200 : 120) / scale * burst + 3 * s, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    ctx.arc(hpx, hpy, 3.2 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A smoke cloud or a fire area, fading in and out over its lifetime. */
export function drawArea(ctx: Ctx, kind: "smoke" | "fire", x: number, y: number, P: ToPx, scale: number, alpha: number) {
  const [px, py] = P(x, y);
  ctx.globalAlpha = (kind === "smoke" ? 0.6 : 0.5) * alpha;
  ctx.fillStyle = kind === "smoke" ? "#cfd3d6" : "#ff6a1a";
  ctx.beginPath();
  ctx.arc(px, py, (kind === "smoke" ? SMOKE_RADIUS : FIRE_RADIUS) / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
