// Highlight clips: one round of the 2D replay between two moments, framed for sharing. A frame
// is a header (who, what, round clock, progress), the radar, optionally zoomed to where the
// action happens, and a kill feed. Drawn the same way for the preview and for the export.
import type { Highlight, MatchOverview, Replay } from "./api";
import { RADAR_SIZE, levelOf, panelLevels, sideColor, worldToPx, type MapAssets } from "./radar";
import { drawRound, playerState, weaponName } from "./replayDraw";
import { clockOf } from "./clipSummary";
import { mapPretty } from "./components/MatchPicker";
import { t, td } from "./i18n";

const ZOOM_PAD = 110; // radar px around the action
const ZOOM_MIN = 420; // smallest square shown, radar px
const KILLFEED_SEC = 5;

export const kindLabel = (h: Highlight) => td(`hl.kind.${h.kind}`, h.kind);
export const tagLabel = (tag: string) => td(`hl.tag.${tag}`, tag);

export function playerName(match: MatchOverview, steamid: string | null | undefined): string | null {
  if (!steamid) return null;
  const p = match.players.find((row) => String(row.steamid) === steamid);
  return p ? String(p.name) : null;
}

/** "AK-47 ×3, Deagle" */
export function weaponSummary(weapons: string[] = []): string {
  const counts = new Map<string, number>();
  for (const w of weapons) counts.set(weaponName(w), (counts.get(weaponName(w)) ?? 0) + 1);
  return [...counts].map(([w, n]) => (n > 1 ? `${w} ×${n}` : w)).join(", ");
}

export function hlTitle(h: Highlight, match: MatchOverview): string {
  if (h.kind === "custom") return [h.title || t("hl.customTitle"), playerName(match, h.steamid)].filter(Boolean).join(" · ");
  const what = h.kind === "clutch" ? t("hl.clutch", { n: h.clutch ?? 1 }) : kindLabel(h);
  const clutch = h.kind !== "clutch" && h.clutch ? ` + ${t("hl.clutch", { n: h.clutch })}` : "";
  return `${h.name ?? "?"} · ${what}${clutch}`;
}

export function hlSubtitle(h: Highlight, match: MatchOverview): string {
  const team = h.team ?? (h.steamid ? String(match.players.find((p) => String(p.steamid) === h.steamid)?.team ?? "") : "");
  return [
    team, mapPretty(match.map), t("common.round", { n: h.round }), weaponSummary(h.weapons),
    h.kind !== "custom" && h.won === false ? t("hl.lostRound") : "",
  ].filter(Boolean).join(" · ");
}

export const hlDuration = (h: Highlight) => Math.max(0.5, h.end - h.start);
const tickAt = (r: Replay, h: Highlight, time: number) =>
  Math.max(r.start_tick, Math.min(r.last_tick, r.freeze_end_tick + (h.start + time) * r.tick_rate));

/** The square of the radar (radar px, on one level) that holds the focused players and their kills during the clip. */
function actionBox(assets: MapAssets, r: Replay, h: Highlight, focus: Set<string>) {
  const meta = assets.meta;
  const t0 = tickAt(r, h, 0), t1 = tickAt(r, h, hlDuration(h));
  const pts: [number, number, number | null][] = [];
  for (const p of r.players) {
    if (!focus.has(p.steamid)) continue;
    for (let tick = t0; tick <= t1; tick += r.tick_rate / 2) {
      const st = playerState(r, p, tick);
      if (st.hp > 0 && !Number.isNaN(st.x)) pts.push([st.x, st.y, st.z]);
    }
  }
  for (const k of r.kills) {
    if (k.tick < t0 || k.tick > t1) continue;
    if (focus.size && !focus.has(k.victim) && !(k.attacker && focus.has(k.attacker))) continue;
    pts.push([k.vx, k.vy, k.vz]);
    if (k.ax !== null && k.ay !== null) pts.push([k.ax, k.ay, k.az]);
  }
  if (!pts.length) return null;
  const perLevel = new Map<number, number>();
  for (const [, , z] of pts) perLevel.set(levelOf(meta, z), (perLevel.get(levelOf(meta, z)) ?? 0) + 1);
  const li = [...perLevel].sort((a, b) => b[1] - a[1])[0][0];
  const px = pts.filter(([, , z]) => levelOf(meta, z) === li).map(([x, y]) => worldToPx(meta, x, y));
  const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const size = Math.min(RADAR_SIZE, Math.max(ZOOM_MIN, Math.max(x1 - x0, y1 - y0) + 2 * ZOOM_PAD));
  const clamp = (c: number) => Math.max(0, Math.min(RADAR_SIZE - size, c - size / 2));
  return { li, x: clamp((x0 + x1) / 2), y: clamp((y0 + y1) / 2), size };
}

export interface HlFrame {
  r: Replay;
  h: Highlight;
  title: string;
  subtitle: string;
  focus: Set<string>;
  names: boolean;
  levels: number[];
  box: { li: number; x: number; y: number; size: number } | null;
  map: number; // radar panel size, px
  width: number;
  height: number;
  headerH: number;
}

const even = (v: number) => Math.ceil(v / 2) * 2; // H.264 needs even frame sizes

export function prepareFrame(
  assets: MapAssets, r: Replay, h: Highlight, match: MatchOverview, map: number, opts: { zoom: boolean; names: boolean },
): HlFrame {
  const focus = new Set(h.steamid ? [h.steamid] : []);
  const box = opts.zoom ? actionBox(assets, r, h, focus) : null;
  const levels = box ? [box.li] : panelLevels(assets.meta, "all");
  const headerH = even(map * 0.115);
  return {
    r, h, title: hlTitle(h, match), subtitle: hlSubtitle(h, match), focus, names: opts.names, levels, box, map,
    width: even(map * levels.length), height: even(headerH + map), headerH,
  };
}

/** Draw the frame at `time` seconds into the clip. */
export function drawHighlight(ctx: CanvasRenderingContext2D, assets: MapAssets, f: HlFrame, time: number) {
  const { r, h, map, headerH } = f;
  const u = map / 760;
  const tick = tickAt(r, h, time);
  ctx.fillStyle = "#0d0f13";
  ctx.fillRect(0, 0, f.width, f.height);

  // radar
  const opts = { names: f.names, weapons: false, trails: true, shots: true, hoverKill: -1, focus: f.focus };
  ctx.save();
  ctx.translate(0, headerH);
  ctx.beginPath();
  ctx.rect(0, 0, f.width, map);
  ctx.clip();
  if (f.box) {
    const size = (map * RADAR_SIZE) / f.box.size;
    ctx.translate((-f.box.x * size) / RADAR_SIZE, (-f.box.y * size) / RADAR_SIZE);
    drawRound(ctx, assets, r, tick, f.levels, size, { ...opts, levelLabels: false });
  } else {
    drawRound(ctx, assets, r, tick, f.levels, map, opts);
  }
  ctx.restore();
  drawKillFeed(ctx, f, tick, u);

  // header: title and details on the left, round clock on the right, progress along the bottom
  const pad = 14 * u;
  ctx.fillStyle = "#121418";
  ctx.fillRect(0, 0, f.width, headerH);
  ctx.fillStyle = "#ff5500";
  ctx.fillRect(0, 0, 5 * u, headerH);
  const sec = (tick - r.freeze_end_tick) / r.tick_rate;
  ctx.textAlign = "right";
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${34 * u}px system-ui, sans-serif`;
  ctx.fillText(clockOf(sec), f.width - pad, 44 * u);
  const clockW = ctx.measureText(clockOf(-30)).width;
  ctx.textAlign = "left";
  fitText(ctx, f.title, pad + 4 * u, 40 * u, f.width - clockW - 3 * pad, 700, 30 * u, "#fff");
  fitText(ctx, f.subtitle, pad + 4 * u, 70 * u, f.width - 2 * pad, 400, 16 * u, "#c9cdd3");
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, headerH - 3 * u, f.width, 3 * u);
  ctx.fillStyle = "#ff5500";
  ctx.fillRect(0, headerH - 3 * u, (f.width * Math.min(1, time / hlDuration(h))), 3 * u);

  ctx.textAlign = "right";
  ctx.font = `700 ${12 * u}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillText("CS2LENS", f.width - 10 * u, f.height - 10 * u);
}

function drawKillFeed(ctx: CanvasRenderingContext2D, f: HlFrame, tick: number, u: number) {
  const recent = f.r.kills.filter((k) => k.tick <= tick && tick - k.tick < KILLFEED_SEC * f.r.tick_rate).slice(-5);
  const font = `600 ${14 * u}px system-ui, sans-serif`;
  let y = f.headerH + 12 * u;
  for (const k of recent) {
    const parts: [string, string][] = [
      [k.attacker_name ?? "World", sideColor(k.attacker_side)],
      [`${weaponName(k.weapon)}${k.headshot ? " ⌖" : ""}${k.wallbang ? " ⇥" : ""}${k.thrusmoke ? " ☁" : ""}`, "#ddd"],
      [k.victim_name, sideColor(k.victim_side)],
    ];
    ctx.font = font;
    const gap = 9 * u;
    const w = parts.reduce((s, [text]) => s + ctx.measureText(text).width, 0) + gap * 2 + 20 * u;
    const h = 24 * u;
    const x = f.width - 10 * u - w;
    const mine = (k.attacker && f.focus.has(k.attacker)) || f.focus.has(k.victim);
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(x, y, w, h);
    if (mine) {
      ctx.strokeStyle = "#ff5500";
      ctx.lineWidth = 2 * u;
      ctx.strokeRect(x + u, y + u, w - 2 * u, h - 2 * u);
    }
    let cx = x + 10 * u;
    ctx.textAlign = "left";
    for (const [text, color] of parts) {
      ctx.fillStyle = color;
      ctx.fillText(text, cx, y + 17 * u);
      cx += ctx.measureText(text).width + gap;
    }
    y += h + 4 * u;
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, weight: number, size: number, color: string) {
  let px = size;
  ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  while (ctx.measureText(text).width > width && px > size * 0.55) {
    px *= 0.94;
    ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** A line of the highlights.txt that goes into a zip of several clips. */
export function hlTextLine(h: Highlight, match: MatchOverview): string {
  return [
    `R${h.round}`, `${clockOf(h.start)} → ${clockOf(h.end)}`, hlTitle(h, match), hlSubtitle(h, match),
    ...(h.tags ?? []).map(tagLabel),
  ].join("  ·  ");
}
