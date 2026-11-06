// Clip builder: one player's or one team's rounds from one or several demos of the same map,
// overlaid on a shared round clock or played one after another. A frame is a header (who,
// against whom, round clock), the radar with a grid, and a footer with a caption computed
// from the map's callouts and a legend. Exports go into a zip with a text file of the facts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type MatchOverview, type Replay, type Side } from "../api";
import { canEncodeVideo, download, exportGif, exportMp4, zipWith } from "../clipExport";
import { buyLabel, clockOf, summarize, type ClipInfo, type Summary, type Track } from "../clipSummary";
import { calloutsOn, drawCallouts } from "../callouts";
import { t } from "../i18n";
import {
  RADAR_SIZE, T_COLOR, drawRadar, levelLabel, levelOf, panelLevels, sideColor, sideShort, useMapAssets, worldToPx,
  type MapAssets,
} from "../radar";
import { MatchPicker, mapPretty } from "./MatchPicker";
import { FIRE_SEC, SMOKE_SEC, SMOKE_RADIUS, frameAt, loadReplay, playerState } from "../replayDraw";

const TRAIL_STEP = 3; // draw every n-th frame of a movement trail
const TRACER_TICKS = 6;
const TRACER_MISS = 600; // world units
const LOAD_CONCURRENCY = 4;
const GRID = 16; // radar grid cells per side (A-P, 1-16)
const FRAG = "#ff4040";
const PLANT = "#ff2d75";
const NADE_MARK: Record<string, { fill: string | null; ring: string | null }> = {
  smoke: { fill: "#b8bcc2", ring: null },
  molotov: { fill: "#ff5a1f", ring: null },
  incendiary: { fill: "#ff5a1f", ring: null },
  flashbang: { fill: null, ring: "#ffffff" },
  he: { fill: null, ring: "#ffd23f" },
  decoy: { fill: null, ring: "#8a949e" },
};

type Subject = { kind: "player"; steamid: string } | { kind: "team"; team: string };
type Layout = "overlay" | "sequence";

interface Layers {
  trails: boolean;
  view: boolean;
  shots: boolean;
  nades: boolean;
  kills: boolean;
  others: boolean;
  grid: boolean;
  callouts: boolean; // position names; a clip carries them into the exported video
}

interface Clip {
  tracks: Track[];
  info: ClipInfo;
  summary: Summary;
  layers: Layers;
  colors: Map<string, string>; // team mode: steamid -> colour
}

// ---- clip time ----
// Overlay: clip time T is the same round time in every round. Sequence: rounds play one after another.
const roundLen = (r: Replay) => (r.last_tick - r.freeze_end_tick) / r.tick_rate;

function segments(c: Clip) {
  return c.tracks
    .map((track) => ({ track, t: c.info.from, endT: Math.min(c.info.to, roundLen(track.r)) }))
    .filter((s) => s.endT > s.t);
}

function duration(c: Clip): number {
  if (c.info.layout === "overlay") return Math.max(0, c.info.to - c.info.from);
  return segments(c).reduce((sum, s) => sum + (s.endT - s.t), 0);
}

function activeAt(c: Clip, T: number): { track: Track; t: number; index: number }[] {
  if (c.info.layout === "overlay") return c.tracks.map((track, index) => ({ track, t: c.info.from + T, index }));
  let left = T;
  const segs = segments(c);
  for (const s of segs) {
    const len = s.endT - s.t;
    if (left <= len) return [{ track: s.track, t: s.t + left, index: c.tracks.indexOf(s.track) }];
    left -= len;
  }
  const last = segs[segs.length - 1];
  return last ? [{ track: last.track, t: last.endT, index: c.tracks.indexOf(last.track) }] : [];
}

// ---- frame layout ----
interface FrameLayout {
  u: number; // text scale
  map: number; // radar panel size
  width: number;
  height: number;
  headerH: number;
  footerY: number;
  caption: string[]; // wrapped lines
}

const measure = document.createElement("canvas").getContext("2d")!;

function wrap(text: string, font: string, width: number): string[] {
  measure.font = font;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (measure.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const even = (v: number) => Math.ceil(v / 2) * 2; // H.264 needs even frame sizes

function frameLayout(map: number, panels: number, caption: string | null): FrameLayout {
  const u = map / 760;
  const width = even(map * panels);
  const headerH = Math.round(126 * u);
  const lines = caption ? wrap(caption, captionFont(u), width - 24 * u) : [];
  const footerH = Math.round(14 * u + lines.length * 24 * u + (lines.length ? 10 * u : 0) + 2 * 24 * u + 10 * u);
  return { u, map, width, height: even(headerH + map + footerH), headerH, footerY: headerH + map, caption: lines };
}

const captionFont = (u: number) => `700 ${17 * u}px system-ui, sans-serif`;

// ---- markers (also used by the legend) ----
type C2D = CanvasRenderingContext2D;

function playerMark(ctx: C2D, x: number, y: number, yaw: number | null, color: string, s: number, view: boolean) {
  if (view && yaw !== null) {
    const ang = (-yaw * Math.PI) / 180;
    const x2 = x + Math.cos(ang) * 16 * s, y2 = y + Math.sin(ang) * 16 * s;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 3.6 * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * s;
    ctx.stroke();
    ctx.lineCap = "butt";
  }
  ctx.fillStyle = color;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.4 * s;
  ctx.beginPath();
  ctx.arc(x, y, 5.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function fragMark(ctx: C2D, x: number, y: number, s: number) {
  ctx.fillStyle = FRAG;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.arc(x, y, 4 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function deathMark(ctx: C2D, x: number, y: number, s: number) {
  const d = 5 * s;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - d, y - d);
  ctx.lineTo(x + d, y + d);
  ctx.moveTo(x + d, y - d);
  ctx.lineTo(x - d, y + d);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 4 * s;
  ctx.stroke();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  ctx.lineCap = "butt";
}

function nadeMark(ctx: C2D, type: string, x: number, y: number, s: number) {
  const m = NADE_MARK[type] ?? NADE_MARK.decoy;
  ctx.beginPath();
  ctx.arc(x, y, 4.5 * s, 0, Math.PI * 2);
  if (m.fill) {
    ctx.fillStyle = m.fill;
    ctx.fill();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1 * s;
    ctx.stroke();
  } else {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3.4 * s;
    ctx.stroke();
    ctx.strokeStyle = m.ring!;
    ctx.lineWidth = 1.8 * s;
    ctx.stroke();
  }
}

function plantMark(ctx: C2D, x: number, y: number, s: number) {
  ctx.fillStyle = PLANT;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1 * s;
  ctx.fillRect(x - 4 * s, y - 4 * s, 8 * s, 8 * s);
  ctx.strokeRect(x - 4 * s, y - 4 * s, 8 * s, 8 * s);
}

// ---- drawing ----
// a player in the side colour; in team mode every player has a colour of their own
const color = (c: Clip, track: Track, steamid: string) => c.colors.get(steamid) ?? sideColor(track.side);
const PLAYER_PALETTE = ["#f2b134", "#5aa9ff", "#7bd389", "#ff7b9c", "#c792ea", "#ffe066", "#4dd0e1", "#ff8a65", "#a1887f", "#b0bec5"];

function drawMap(ctx: C2D, assets: MapAssets, c: Clip, active: ReturnType<typeof activeAt>, li: number, size: number) {
  const { meta } = assets;
  const multi = meta.levels.length > 1;
  const k = size / RADAR_SIZE;
  const s = 1 / k;
  const L = c.layers;
  const vis = (z: number | null | undefined) => (!multi || levelOf(meta, z) === li ? 1 : 0.15);
  const P = (x: number, y: number) => worldToPx(meta, x, y);
  ctx.scale(k, k);

  if (L.grid) {
    const cell = RADAR_SIZE / GRID;
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    for (let i = 1; i < GRID; i++) {
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, RADAR_SIZE);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(RADAR_SIZE, i * cell);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = `${11 * s}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (let i = 0; i < GRID; i++) {
      ctx.fillText(String.fromCharCode(65 + i), (i + 0.5) * cell, 14 * s);
      if (i) ctx.fillText(String(i + 1), 9 * s, (i + 0.5) * cell + 4 * s);
    }
  }

  for (const { track, t } of active) {
    const r = track.r;
    const tick = Math.min(r.last_tick, r.freeze_end_tick + t * r.tick_rate);
    const t0 = Math.max(r.start_tick, r.freeze_end_tick + c.info.from * r.tick_rate);

    // smoke clouds and fires of the subject's grenades while they last
    if (L.nades) {
      for (const g of r.grenades) {
        if (!g.thrower || !track.ids.has(g.thrower) || tick < g.end || g.t[0] < t0) continue;
        const life = g.type === "smoke" ? SMOKE_SEC : g.type === "molotov" || g.type === "incendiary" ? FIRE_SEC : 0;
        if (tick > g.end + life * r.tick_rate) continue;
        const n = g.x.length - 1;
        const [px, py] = P(g.x[n], g.y[n]);
        ctx.globalAlpha = 0.22 * vis(g.z[n]);
        ctx.fillStyle = g.type === "smoke" ? "#cfd3d6" : "#ff6a1a";
        ctx.beginPath();
        ctx.arc(px, py, (g.type === "smoke" ? SMOKE_RADIUS : 110) / meta.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    if (L.trails) {
      const [i1] = frameAt(r.ticks, tick);
      const [i0] = frameAt(r.ticks, t0);
      for (const p of track.players) {
        ctx.strokeStyle = color(c, track, p.steamid);
        ctx.lineWidth = 1.3 * s;
        ctx.lineJoin = "round";
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        let started = false;
        for (let q = i0; q < i1 + TRAIL_STEP; q += TRAIL_STEP) {
          const i = Math.min(q, i1); // always end the trail at the current frame
          const x = p.x[i], y = p.y[i];
          if (x === null || y === null || p.hp[i] <= 0 || (multi && levelOf(meta, p.z[i]) !== li)) {
            started = false;
            continue;
          }
          const [px, py] = P(x, y);
          if (started) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
          started = true;
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // grenades: the flight, then a marker where it landed (kept to the end)
    if (L.nades) {
      for (const g of r.grenades) {
        if (!g.thrower || !track.ids.has(g.thrower) || tick < g.t[0] || g.t[0] < t0) continue;
        const [gi] = frameAt(g.t, tick);
        if (tick <= g.end) {
          ctx.globalAlpha = 0.6 * vis(g.z[gi]);
          ctx.strokeStyle = color(c, track, g.thrower);
          ctx.lineWidth = 1 * s;
          ctx.setLineDash([3 * s, 3 * s]);
          ctx.beginPath();
          for (let q = 0; q <= gi; q++) (q ? ctx.lineTo(...P(g.x[q], g.y[q])) : ctx.moveTo(...P(g.x[q], g.y[q])));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = vis(g.z[gi]);
          nadeMark(ctx, g.type, ...P(g.x[gi], g.y[gi]), s * 0.7);
        } else {
          const n = g.x.length - 1;
          ctx.globalAlpha = vis(g.z[n]);
          nadeMark(ctx, g.type, ...P(g.x[n], g.y[n]), s);
        }
        ctx.globalAlpha = 1;
      }
      const names = new Set(track.players.map((p) => p.name));
      for (const b of r.bomb) {
        if (b.event !== "finish_plant" || b.tick > tick || b.tick < t0 || !b.player || !names.has(b.player)) continue;
        ctx.globalAlpha = vis(b.z);
        plantMark(ctx, ...P(b.x, b.y), s);
        ctx.globalAlpha = 1;
      }
    }

    if (L.kills) {
      for (const kill of r.kills) {
        if (kill.tick > tick || kill.tick < t0) continue;
        ctx.globalAlpha = vis(kill.vz);
        if (kill.attacker && track.ids.has(kill.attacker)) fragMark(ctx, ...P(kill.vx, kill.vy), s);
        if (track.ids.has(kill.victim)) deathMark(ctx, ...P(kill.vx, kill.vy), s);
        ctx.globalAlpha = 1;
      }
    }

    if (L.others && tick < r.last_tick) {
      for (const p of r.players) {
        if (track.ids.has(p.steamid)) continue;
        const st = playerState(r, p, tick);
        if (st.hp <= 0 || Number.isNaN(st.x)) continue;
        const [px, py] = P(st.x, st.y);
        ctx.globalAlpha = 0.4 * vis(st.z);
        ctx.fillStyle = sideColor(p.side);
        ctx.beginPath();
        ctx.arc(px, py, 3.5 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    if (L.shots) {
      const sh = r.shots;
      for (let q = sh.tick.length - 1; q >= 0; q--) {
        if (sh.tick[q] > tick) continue;
        if (sh.tick[q] < tick - TRACER_TICKS) break;
        if (!track.ids.has(sh.player[q])) continue;
        const [x0, y0] = P(sh.x[q], sh.y[q]);
        let x1: number, y1: number;
        if (sh.hx[q] !== null) [x1, y1] = P(sh.hx[q]!, sh.hy[q]!);
        else {
          const ang = (-sh.yaw[q] * Math.PI) / 180;
          [x1, y1] = [x0 + (Math.cos(ang) * TRACER_MISS) / meta.scale, y0 + (Math.sin(ang) * TRACER_MISS) / meta.scale];
        }
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, "rgba(255,243,176,0.9)");
        g.addColorStop(1, sh.hx[q] !== null ? "rgba(255,64,64,0.9)" : "rgba(255,243,176,0)");
        ctx.globalAlpha = 1 - (tick - sh.tick[q]) / (TRACER_TICKS + 1);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.3 * s;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    if (tick < r.last_tick) {
      for (const p of track.players) {
        const st = playerState(r, p, tick);
        if (st.hp <= 0 || Number.isNaN(st.x)) continue;
        ctx.globalAlpha = vis(st.z);
        playerMark(ctx, ...P(st.x, st.y), st.yaw, color(c, track, p.steamid), s, L.view);
        ctx.globalAlpha = 1;
      }
    }
  }
}

function drawFrame(ctx: C2D, assets: MapAssets, c: Clip, T: number, levels: number[], lay: FrameLayout, speed: number) {
  const { u } = lay;
  const active = activeAt(c, T);
  ctx.fillStyle = "#0d0f13";
  ctx.fillRect(0, 0, lay.width, lay.height);

  levels.forEach((li, panel) => {
    const ox = panel * lay.map;
    ctx.save();
    ctx.translate(0, lay.headerH);
    drawRadar(ctx, assets.images[li], ox, lay.map);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(ox, 0, lay.map, lay.map);
    ctx.beginPath();
    ctx.rect(ox, 0, lay.map, lay.map);
    ctx.clip();
    ctx.translate(ox, 0);
    if (c.layers.callouts) drawCallouts(ctx, assets.meta, li, 0, lay.map);
    drawMap(ctx, assets, c, active, li, lay.map);
    ctx.restore();
    if (assets.meta.levels.length > 1) {
      ctx.fillStyle = "#fff";
      ctx.font = `${13 * u}px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillText(levelLabel(assets.meta, li), ox + lay.map - 10 * u, lay.headerH + 20 * u);
    }
  });

  // header
  const pad = 12 * u;
  const now = active[0]?.t ?? c.info.from;
  let alive = 0, total = 0;
  for (const { track, t: rt } of active) {
    for (const p of track.players) {
      total++;
      const tick = track.r.freeze_end_tick + rt * track.r.tick_rate;
      if (tick < track.r.last_tick && playerState(track.r, p, tick).hp > 0) alive++;
    }
  }
  ctx.fillStyle = "#121418";
  ctx.fillRect(0, 0, lay.width, lay.headerH);
  ctx.textAlign = "right";
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${46 * u}px system-ui, sans-serif`;
  ctx.fillText(clockOf(now), lay.width - pad, 48 * u);
  ctx.font = `${15 * u}px system-ui, sans-serif`;
  ctx.fillStyle = "#c9cdd3";
  ctx.fillText(t("clip.alive", { a: alive, t: total, s: speed }), lay.width - pad, 108 * u);
  const rightW = Math.max(measureWith(ctx, `700 ${46 * u}px system-ui, sans-serif`, "1:55"), measureWith(ctx, `${15 * u}px system-ui, sans-serif`, t("clip.alive", { a: total, t: total, s: speed })));
  const textW = lay.width - rightW - 3 * pad;
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  fitText(ctx, title(c), pad, 44 * u, textW, 700, 34 * u);
  ctx.fillStyle = "#c9cdd3";
  fitText(ctx, subtitle(c), pad, 78 * u, textW, 400, 17 * u);
  ctx.fillStyle = "#8a94a3";
  const line3 = c.info.layout === "overlay"
    ? t("clip.overlaid", { n: c.tracks.length })
    : active[0] ? t("clip.seqLine", {
      label: active[0].track.label, opp: active[0].track.opponent ?? "?", i: active[0].index + 1, n: c.tracks.length,
      result: active[0].track.won ? t("common.win") : t("common.loss"),
    }) : "";
  fitText(ctx, line3, pad, 108 * u, textW, 400, 15 * u);

  // footer: caption and legend
  let y = lay.footerY + 14 * u;
  ctx.textAlign = "left";
  if (lay.caption.length) {
    ctx.fillStyle = "#f6d77a";
    ctx.font = captionFont(u);
    for (const line of lay.caption) {
      y += 20 * u;
      ctx.fillText(line, pad, y);
      y += 4 * u;
    }
    y += 10 * u;
  }
  const sideCol = c.tracks[0] ? sideColor(c.tracks[0].side) : T_COLOR;
  const items: [(x: number, yy: number) => void, string][][] = [
    [
      [(x, yy) => playerMark(ctx, x - 3 * u, yy + 3 * u, 50, sideCol, u, true), c.info.kind === "team" ? t("clip.lg.players") : t("clip.lg.player")],
      [(x, yy) => fragMark(ctx, x, yy, u), c.info.kind === "team" ? t("clip.lg.theirKill") : t("clip.lg.hisKill")],
      [(x, yy) => deathMark(ctx, x, yy, u), c.info.kind === "team" ? t("clip.lg.theirDeath") : t("clip.lg.hisDeath")],
    ],
    [
      [(x, yy) => nadeMark(ctx, "smoke", x, yy, u), t("nade.smoke")],
      [(x, yy) => nadeMark(ctx, "molotov", x, yy, u), t("nade.molotov")],
      [(x, yy) => nadeMark(ctx, "flashbang", x, yy, u), t("nade.flashbang")],
      [(x, yy) => nadeMark(ctx, "he", x, yy, u), t("nade.he")],
      [(x, yy) => plantMark(ctx, x, yy, u), t("clip.lg.plant")],
    ],
  ];
  ctx.font = `${14 * u}px system-ui, sans-serif`;
  for (const row of items) {
    y += 22 * u;
    let x = pad + 6 * u;
    for (const [mark, label] of row) {
      mark(x, y - 5 * u);
      ctx.fillStyle = "#c9cdd3";
      ctx.textAlign = "left";
      ctx.font = `${14 * u}px system-ui, sans-serif`;
      ctx.fillText(label, x + 14 * u, y);
      x += 14 * u + ctx.measureText(label).width + 18 * u;
    }
  }
}

function measureWith(ctx: C2D, font: string, text: string) {
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Text in one line, shrunk to fit ``width``. */
function fitText(ctx: C2D, text: string, x: number, y: number, width: number, weight: number, size: number) {
  let px = size;
  ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  while (ctx.measureText(text).width > width && px > size * 0.55) {
    px *= 0.94;
    ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  }
  ctx.fillText(text, x, y);
}

function title(c: Clip) {
  return [c.info.name, c.summary.side, c.summary.mainZone ?? mapPretty(c.info.map)].filter(Boolean).join(" · ");
}

function subtitle(c: Clip) {
  const vs = c.summary.opponents.length ? t("clip.vsList", { list: c.summary.opponents.join(", ") }) : "";
  const buy = c.info.buy ? buyLabel(c.info.buy) : "";
  return [c.info.kind === "player" ? c.info.team : "", mapPretty(c.info.map), [buy, vs].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

// ---- data ----
const overviewCache = new Map<string, Promise<MatchOverview>>();
function loadOverview(id: string) {
  let p = overviewCache.get(id);
  if (!p) {
    p = api.match(id);
    p.catch(() => overviewCache.delete(id));
    overviewCache.set(id, p);
  }
  return p;
}

async function loadRounds(keys: { matchId: string; round: number; key: string }[], onLoaded: (n: number) => void): Promise<Map<string, Replay>> {
  const out = new Map<string, Replay>();
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const k = keys[next++];
      out.set(k.key, await loadReplay(k.matchId, k.round));
      onLoaded(out.size);
    }
  };
  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
  return out;
}

interface RoundOption {
  key: string;
  matchId: string;
  no: number;
  round: number;
  team: string;
  side: Side | undefined;
  won: boolean;
  buy: string | null;
  opponent: string | null;
}

const SIZES = [512, 768, 1024];

// ---- component ----
export function ClipView({ initial, scope }: { initial?: MatchOverview; scope?: { map: string; ids: string[]; side?: string; buy?: string } }) {
  const [map, setMap] = useState(scope?.map ?? initial?.map ?? "");
  const [matchIds, setMatchIds] = useState<string[]>(scope?.ids ?? (initial ? [initial.id] : []));
  const [overviews, setOverviews] = useState<Map<string, MatchOverview>>(new Map(initial ? [[initial.id, initial]] : []));
  const { assets, error: mapError } = useMapAssets(map || undefined);

  const [subject, setSubject] = useState<Subject | null>(null);
  const [sideFilter, setSideFilter] = useState<Side | "">((scope?.side as Side | undefined) || "terrorist");
  const [resultFilter, setResultFilter] = useState<"" | "won" | "lost">("");
  const [buyFilter, setBuyFilter] = useState(scope?.buy ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [layout, setLayout] = useState<Layout>("overlay");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState<number | null>(null);
  const [layers, setLayers] = useState<Layers>({ trails: true, view: true, shots: true, nades: true, kills: true, others: false, grid: true, callouts: calloutsOn() });
  const [view, setView] = useState<number | "all">("all");
  const [replays, setReplays] = useState<Map<string, Replay>>(new Map());
  const [loaded, setLoaded] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [T, setT] = useState(0);
  const tRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);

  const [format, setFormat] = useState<"gif" | "mp4">(canEncodeVideo() ? "mp4" : "gif");
  const [outSize, setOutSize] = useState(canEncodeVideo() ? 768 : 512);
  const [fps, setFps] = useState(canEncodeVideo() ? 30 : 10);
  const [exporting, setExporting] = useState<{ progress: number; abort: AbortController } | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(800);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const missing = matchIds.filter((id) => !overviews.has(id));
    if (!missing.length) return;
    Promise.all(missing.map((id) => loadOverview(id).then((ov) => [id, ov] as const)))
      .then((pairs) => setOverviews((cur) => new Map([...cur, ...pairs])))
      .catch((e: Error) => setError(e.message));
  }, [matchIds, overviews]);

  const selected = matchIds.map((id) => overviews.get(id)).filter((ov): ov is MatchOverview => !!ov);

  // players over all selected matches (a player is the same steamid in every demo)
  const roster = useMemo(() => {
    const byId = new Map<string, { steamid: string; name: string; teams: Map<string, number>; matches: number }>();
    for (const ov of selected) {
      for (const p of ov.players) {
        if (!p.steamid) continue;
        const id = String(p.steamid);
        const e = byId.get(id) ?? { steamid: id, name: String(p.name), teams: new Map(), matches: 0 };
        e.name = String(p.name);
        e.matches++;
        const team = String(p.team ?? "");
        e.teams.set(team, (e.teams.get(team) ?? 0) + 1);
        byId.set(id, e);
      }
    }
    return [...byId.values()].map((e) => ({ ...e, team: [...e.teams].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "" }))
      .sort((a, b) => b.matches - a.matches || a.team.localeCompare(b.team) || a.name.localeCompare(b.name));
  }, [selected]);
  const teams = useMemo(() => [...new Set(selected.flatMap((ov) => Object.keys(ov.score)))].sort(), [selected]);

  useEffect(() => {
    if (matchIds.some((id) => !overviews.has(id))) return; // keep the choice while matches load
    if (subject && (subject.kind === "team" ? teams.includes(subject.team) : roster.some((p) => p.steamid === subject.steamid))) return;
    // a real player of the match: bots are in the roster too, without a team of the match
    const first = roster.find((p) => teams.includes(p.team));
    setSubject(first ? { kind: "player", steamid: first.steamid } : teams[0] ? { kind: "team", team: teams[0] } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, teams, subject]);

  // rounds of the subject's team in every selected match
  const options: RoundOption[] = useMemo(() => {
    if (!subject) return [];
    return matchIds.flatMap((id, i) => {
      const ov = overviews.get(id);
      if (!ov) return [];
      const team = subject.kind === "team" ? subject.team : String(ov.players.find((p) => String(p.steamid) === subject.steamid)?.team ?? "");
      if (!team || !(team in ov.score)) return [];
      const opponent = Object.keys(ov.score).find((t) => t !== team) ?? null;
      return ov.timeline.map((r) => ({
        key: `${id}#${r.round}`, matchId: id, no: i + 1, round: r.round, team, side: r.teams[team]?.side,
        won: r.winner === team, buy: r.teams[team]?.buy ?? null, opponent,
      }));
    });
  }, [subject, matchIds, overviews]);

  // filters pick the rounds; chips then add or remove single rounds
  const optionKeys = options.map((o) => o.key).join(",");
  useEffect(() => {
    setPicked(new Set(options.filter((o) =>
      (!sideFilter || o.side === sideFilter) && (!resultFilter || (resultFilter === "won") === o.won) && (!buyFilter || o.buy === buyFilter),
    ).map((o) => o.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKeys, sideFilter, resultFilter, buyFilter]);

  const chosen = useMemo(() => options.filter((o) => picked.has(o.key)), [options, picked]);
  const chosenKeys = chosen.map((o) => o.key).join(",");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoaded(0);
    setError(null);
    loadRounds(chosen, (n) => alive && setLoaded(n))
      .then((m) => alive && setReplays(m))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKeys]);

  const clip: Clip | null = useMemo(() => {
    if (!subject || !assets || chosen.some((o) => !replays.has(o.key))) return null;
    const tracks: Track[] = chosen.map((o) => {
      const r = replays.get(o.key)!;
      const ps = r.players.filter((p) => (subject.kind === "player" ? p.steamid === subject.steamid : p.team === subject.team));
      return {
        key: o.key, matchId: o.matchId, matchNo: o.no, round: o.round, label: matchIds.length > 1 ? `M${o.no} R${o.round}` : `R${o.round}`,
        r, players: ps, ids: new Set(ps.map((p) => p.steamid)), team: o.team, side: o.side, won: o.won, buy: o.buy, opponent: o.opponent,
      };
    }).filter((t) => t.players.length > 0);
    const colors = new Map<string, string>();
    if (subject.kind === "team") {
      const names = new Map<string, string>();
      tracks.forEach((t) => t.players.forEach((p) => names.set(p.steamid, p.name)));
      [...names].sort((a, b) => a[1].localeCompare(b[1])).forEach(([id], i) => colors.set(id, PLAYER_PALETTE[i % PLAYER_PALETTE.length]));
    }
    const longest = Math.max(0, ...tracks.map((t) => roundLen(t.r)));
    const player = subject.kind === "player" ? roster.find((p) => p.steamid === subject.steamid) : null;
    const info: ClipInfo = {
      kind: subject.kind,
      name: player ? player.name : subject.kind === "team" ? subject.team : "",
      team: player ? player.team : subject.kind === "team" ? subject.team : "",
      map, from, to: Math.min(to ?? longest, longest), layout, buy: buyFilter || null,
      matches: matchIds.map((id, i) => ({ no: i + 1, id, opponent: options.find((o) => o.matchId === id)?.opponent ?? null })),
    };
    return { tracks, info, summary: summarize(tracks, assets.meta, info), layers, colors };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replays, chosenKeys, subject, assets, layout, from, to, layers, buyFilter]);

  const total = clip ? duration(clip) : 0;
  const levels = assets ? panelLevels(assets.meta, assets.meta.levels.length > 1 ? view : 0) : [0];
  const lay = useMemo(() => frameLayout(outSize, levels.length, clip?.summary.caption ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outSize, levels.length, clip?.summary.caption]);
  const scale = Math.min(boxWidth / lay.width, (window.innerHeight - 130) / lay.height);

  const render = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !assets || !clip) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    drawFrame(ctx, assets, clip, tRef.current, levels, lay, speed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, clip, lay, scale, speed, levels.join(",")]);
  useEffect(render, [render, T]);

  useEffect(() => {
    if (!total) return; // not loaded yet
    tRef.current = Math.min(tRef.current, total);
    setT(tRef.current);
  }, [total]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), lastUi = 0;
    const frame = (now: number) => {
      tRef.current += ((now - last) / 1000) * speed;
      last = now;
      if (tRef.current >= total) {
        tRef.current = total;
        setPlaying(false);
      }
      render();
      if (now - lastUi > 100) {
        setT(tRef.current);
        lastUi = now;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, total, render]);

  const seek = (v: number) => {
    tRef.current = Math.max(0, Math.min(total, v));
    setT(tRef.current);
  };

  const chooseFormat = (f: "gif" | "mp4") => {
    setFormat(f);
    // GIF has no inter-frame compression: smaller frames and fewer of them keep the file sane
    if (f === "gif") {
      setFps(10);
      setOutSize((v) => Math.min(v, 512));
    } else {
      setFps(30);
      setOutSize(768);
    }
  };

  const runExport = async () => {
    if (!clip || !assets) return;
    setPlaying(false);
    const abort = new AbortController();
    setExporting({ progress: 0, abort });
    setExported(null);
    try {
      const job = {
        width: lay.width, height: lay.height, duration: total, speed, fps,
        render: (ctx: CanvasRenderingContext2D, time: number) => drawFrame(ctx, assets, clip, time, levels, lay, speed),
        onProgress: (progress: number) => setExporting({ progress, abort }),
        signal: abort.signal,
      };
      const media = format === "gif" ? await exportGif(job) : await exportMp4(job);
      const base = [clip.info.name, clip.info.map.replace(/^de_/, ""), clip.summary.side, `${clip.tracks.length}r`, clip.info.layout]
        .join("_").replace(/[^\p{L}\p{N}_+-]+/gu, "_");
      const zip = await zipWith(`${base}.${format}`, media, `${base}.txt`, clip.summary.text);
      download(zip, `${base}.zip`);
      setExported(t("clip.savedWhat", { file: `${base}.zip`, mb: (zip.size / 2 ** 20).toFixed(1), fmt: format.toUpperCase() }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const toggleRound = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const frames = Math.ceil((total / speed) * fps);
  const buys = [...new Set(options.map((o) => o.buy).filter((b): b is string => !!b))];

  return (
    <div className="clip">
      <div className="clip-side">
        <h3>{t("common.demos")}</h3>
        <MatchPicker map={map} setMap={setMap} ids={matchIds} setIds={setMatchIds} onError={setError} />

        <h3>{t("clip.who")}</h3>
        <select
          value={subject ? (subject.kind === "player" ? `p:${subject.steamid}` : `t:${subject.team}`) : ""}
          onChange={(e) => {
            const v = e.target.value;
            setSubject(v.startsWith("p:") ? { kind: "player", steamid: v.slice(2) } : { kind: "team", team: v.slice(2) });
          }}
        >
          <optgroup label={t("clip.wholeTeam")}>
            {teams.map((tm) => <option key={tm} value={`t:${tm}`}>{tm}</option>)}
          </optgroup>
          {[...new Set(roster.map((p) => p.team))].map((team) => (
            <optgroup key={team} label={t("clip.playersOf", { team })}>
              {roster.filter((p) => p.team === team).map((p) => (
                <option key={p.steamid} value={`p:${p.steamid}`}>{p.name}{matchIds.length > 1 ? t("clip.ofMatches", { n: p.matches, m: matchIds.length }) : ""}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <h3>{t("clip.rounds", { n: chosen.length })}</h3>
        <div className="row small">
          <select value={sideFilter} onChange={(e) => setSideFilter(e.target.value as Side | "")}>
            <option value="">{t("common.bothSides")}</option>
            <option value="terrorist">{t("clip.asT")}</option>
            <option value="counter-terrorist">{t("clip.asCT")}</option>
          </select>
          <select value={resultFilter} onChange={(e) => setResultFilter(e.target.value as "" | "won" | "lost")}>
            <option value="">{t("clip.anyResult")}</option>
            <option value="won">{t("clip.wins")}</option>
            <option value="lost">{t("clip.losses")}</option>
          </select>
          <select value={buyFilter} onChange={(e) => setBuyFilter(e.target.value)}>
            <option value="">{t("clip.anyBuy")}</option>
            {buys.map((b) => <option key={b} value={b}>{buyLabel(b)}</option>)}
          </select>
        </div>
        {matchIds.map((id, i) => {
          const rows = options.filter((o) => o.matchId === id);
          return (
            <div key={id}>
              {matchIds.length > 1 && <div className="muted small">{t("clip.mVs", { no: i + 1, opp: rows[0]?.opponent ?? "?" })}</div>}
              <div className="round-chips">
                {rows.map((o) => (
                  <button
                    key={o.key}
                    className={`chip ${picked.has(o.key) ? "on" : ""} ${o.won ? "won" : ""}`}
                    style={{ borderColor: sideColor(o.side), background: picked.has(o.key) ? sideColor(o.side) : undefined }}
                    title={`${sideShort(o.side)}, ${buyLabel(o.buy)}, ${o.won ? t("common.win") : t("common.loss")}`}
                    onClick={() => toggleRound(o.key)}
                  >
                    {o.round}
                  </button>
                ))}
                {!rows.length && <span className="muted small">{overviews.has(id) ? t("clip.notPlayed") : t("common.loadingLower")}</span>}
              </div>
            </div>
          );
        })}
        <div className="muted small">{t("clip.chipsHint")}</div>

        <h3>{t("clip.how")}</h3>
        <span className="seg">
          <button className={layout === "overlay" ? "on" : ""} onClick={() => setLayout("overlay")} title={t("clip.overlayTitle")}>{t("clip.overlay")}</button>
          <button className={layout === "sequence" ? "on" : ""} onClick={() => setLayout("sequence")} title={t("clip.sequenceTitle")}>{t("clip.sequence")}</button>
        </span>
        <div className="row small">
          {t("common.from")} <input type="number" value={from} min={-20} max={170} onChange={(e) => setFrom(Number(e.target.value))} /> {t("common.s")}
          {" "}{t("common.to")} <input type="number" value={to ?? ""} placeholder={t("clip.end")} min={1} max={200} onChange={(e) => setTo(e.target.value === "" ? null : Number(e.target.value))} /> {t("common.s")}
          <span className="muted">{t("clip.afterFreeze")}</span>
        </div>
        <div className="layers small">
          {(["trails", "view", "shots", "nades", "kills", "others", "grid", "callouts"] as const).map((key) => (
            <label key={key}>
              <input type="checkbox" checked={layers[key]} onChange={(e) => setLayers({ ...layers, [key]: e.target.checked })} /> {t(`clip.layer.${key}`)}
            </label>
          ))}
        </div>

        <h3>{t("clip.export")}</h3>
        <div className="row small">
          <span className="seg">
            <button className={format === "mp4" ? "on" : ""} disabled={!canEncodeVideo()} onClick={() => chooseFormat("mp4")}>MP4</button>
            <button className={format === "gif" ? "on" : ""} onClick={() => chooseFormat("gif")}>GIF</button>
          </span>
          <select value={outSize} onChange={(e) => setOutSize(Number(e.target.value))}>
            {SIZES.map((v) => <option key={v} value={v}>{v} px</option>)}
          </select>
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {[10, 20, 25, 30].map((v) => <option key={v} value={v}>{t("clip.fps", { n: v })}</option>)}
          </select>
        </div>
        <div className="muted small">
          {t("clip.stats", { w: lay.width, h: lay.height, s: speed, sec: Math.round(total / speed), frames })}
          {format === "gif" && frames * lay.width * lay.height > 400 * 768 * 1000 ? t("clip.bigGif") : ""}
        </div>
        <div className="row">
          {exporting ? (
            <>
              <div className="progress grow"><div className="progress-bar" style={{ width: `${exporting.progress * 100}%` }} /><span>{t("clip.encoding", { p: Math.round(exporting.progress * 100) })}</span></div>
              <button onClick={() => exporting.abort.abort()}>{t("common.cancel")}</button>
            </>
          ) : (
            <button disabled={!clip || !clip.tracks.length || total <= 0} onClick={runExport}>{t("clip.save", { fmt: format.toUpperCase() })}</button>
          )}
        </div>
        {exported && <div className="small ok-text">{t("clip.saved", { what: exported })}</div>}
        {clip && (
          <details className="small">
            <summary>{t("clip.chatText")}</summary>
            <pre className="clip-text">{clip.summary.text}</pre>
          </details>
        )}
        {error && <div className="error small">{error}</div>}
      </div>

      <div className="clip-main" ref={boxRef}>
        <div className="row">
          <button className="play" onClick={() => (T >= total ? (seek(0), setPlaying(true)) : setPlaying((p) => !p))} disabled={!clip}>
            {playing ? "⏸" : "▶"}
          </button>
          <input type="range" className="grow" min={0} max={total || 1} step={0.05} value={T} onChange={(e) => seek(Number(e.target.value))} />
          <span className="muted small clock-small">{T.toFixed(1)} / {total.toFixed(0)} {t("common.s")}</span>
          <span className="seg">
            {[1, 2, 4, 8].map((v) => <button key={v} className={speed === v ? "on" : ""} onClick={() => setSpeed(v)}>{v}×</button>)}
          </span>
          {assets && assets.meta.levels.length > 1 && (
            <span className="seg">
              {assets.meta.levels.map((_, i) => <button key={i} className={view === i ? "on" : ""} onClick={() => setView(i)}>{levelLabel(assets.meta, i)}</button>)}
              <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>{t("common.both")}</button>
            </span>
          )}
        </div>
        {mapError ? (
          <div className="error">{mapError}</div>
        ) : !matchIds.length ? (
          <div className="muted">{t("common.pickDemos")}</div>
        ) : !clip ? (
          <div className="muted">{loading ? t("clip.loadingRounds", { a: loaded, b: chosen.length }) : chosen.length ? t("clip.preparing") : t("clip.noRounds")}</div>
        ) : clip.tracks.length === 0 ? (
          <div className="muted">{t("clip.noPlayer")}</div>
        ) : (
          <canvas
            ref={canvasRef}
            width={Math.round(lay.width * scale * (window.devicePixelRatio || 1))}
            height={Math.round(lay.height * scale * (window.devicePixelRatio || 1))}
            style={{ width: lay.width * scale, height: lay.height * scale, borderRadius: 6 }}
          />
        )}
      </div>
    </div>
  );
}
