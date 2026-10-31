// Clip builder: one player's or one team's rounds on the radar, overlaid on a shared round
// clock or played one after another, exported to GIF or MP4.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatchOverview, Replay, ReplayPlayer, Side } from "../api";
import { canEncodeVideo, download, exportGif, exportMp4 } from "../clipExport";
import {
  RADAR_SIZE, drawRadar, levelLabel, levelOf, panelLevels, sideColor, sideShort, useMapAssets, worldToPx, type MapAssets,
} from "../radar";
import {
  FIRE_SEC, NADE_COLORS, SMOKE_SEC, drawArea, drawGrenade, drawKillMark, drawPlayer, drawShots, fmtClock, frameAt,
  loadReplay, outlinedText, playerState, weaponName,
} from "../replayDraw";

const ROUND_TIME = 115;
const PALETTE = [
  "#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4db6ac", "#f06292",
  "#9fa8da", "#a1887f", "#aed581", "#ff8a65", "#90a4ae", "#ce93d8", "#80deea", "#ffd54f",
];
const TRAIL_STEP = 3; // draw every n-th frame of a movement trail
const FEED_SEC = 4;
const LOAD_CONCURRENCY = 4;

type Subject = { kind: "player"; steamid: string } | { kind: "team"; team: string };
type Layout = "overlay" | "sequence";

interface Layers {
  trails: boolean;
  cone: boolean;
  shots: boolean;
  nades: boolean;
  kills: boolean;
  weapons: boolean;
  labels: boolean;
  others: boolean;
}

interface Track {
  round: number;
  r: Replay;
  players: ReplayPlayer[]; // the subject's players in this round
  ids: Set<string>;
  side: Side | undefined;
  won: boolean;
  color: string; // used when entries are coloured per round
}

interface Clip {
  tracks: Track[];
  subject: Subject;
  title: string;
  layout: Layout;
  from: number; // seconds after freeze end
  to: number;
  layers: Layers;
  playerColor: Map<string, string>;
}

// ---- clip time ----
// Overlay: clip time T is the same round time in every round. Sequence: rounds play one after another.
interface Segment { track: Track; t: number; endT: number }

function roundLen(r: Replay) {
  return (r.last_tick - r.freeze_end_tick) / r.tick_rate;
}

function segments(c: Clip): Segment[] {
  return c.tracks
    .map((track) => ({ track, t: c.from, endT: Math.min(c.to, roundLen(track.r)) }))
    .filter((s) => s.endT > s.t);
}

function duration(c: Clip): number {
  if (c.layout === "overlay") return Math.max(0, c.to - c.from);
  return segments(c).reduce((sum, s) => sum + (s.endT - s.t), 0);
}

/** Which rounds are on screen at clip time T, and at what round time. */
function activeAt(c: Clip, T: number): { track: Track; t: number }[] {
  if (c.layout === "overlay") return c.tracks.map((track) => ({ track, t: c.from + T }));
  let left = T;
  const segs = segments(c);
  for (const s of segs) {
    const len = s.endT - s.t;
    if (left <= len) return [{ track: s.track, t: s.t + left }];
    left -= len;
  }
  const last = segs[segs.length - 1];
  return last ? [{ track: last.track, t: last.endT }] : [];
}

// ---- drawing ----
function entryColor(c: Clip, track: Track, steamid: string): string {
  if (c.subject.kind === "team") return c.playerColor.get(steamid) ?? "#fff";
  return c.layout === "overlay" ? track.color : sideColor(track.side);
}

function drawClip(ctx: CanvasRenderingContext2D, assets: MapAssets, c: Clip, T: number, levels: number[], size: number) {
  const { meta, images } = assets;
  const multi = meta.levels.length > 1;
  const k = size / RADAR_SIZE;
  const s = 1 / k;
  const active = activeAt(c, T);
  const L = c.layers;

  levels.forEach((li, panel) => {
    const ox = panel * size;
    drawRadar(ctx, images[li], ox, size);
    ctx.fillStyle = "rgba(0,0,0,0.25)"; // dim the radar so the overlay stands out
    ctx.fillRect(ox, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, 0, size, size);
    ctx.clip();
    ctx.translate(ox, 0);
    ctx.scale(k, k);
    const vis = (z: number | null | undefined) => (!multi || levelOf(meta, z) === li ? 1 : 0.15);
    const P = (x: number, y: number) => worldToPx(meta, x, y);

    for (const { track, t } of active) {
      const r = track.r;
      const tick = Math.min(r.last_tick, r.freeze_end_tick + t * r.tick_rate);
      const t0 = Math.max(r.start_tick, r.freeze_end_tick + c.from * r.tick_rate);

      // utility effects: the subject's smokes and fires (everyone's in sequence mode with "others")
      const showAll = L.others && c.layout === "sequence";
      if (L.nades) {
        if (showAll) {
          for (const a of r.smokes) if (tick >= a.start && tick <= a.end) drawArea(ctx, "smoke", a.x, a.y, P, meta.scale, 0.8 * vis(a.z));
          for (const a of r.fires) if (tick >= a.start && tick <= a.end) drawArea(ctx, "fire", a.x, a.y, P, meta.scale, vis(a.z));
        } else {
          for (const g of r.grenades) {
            if (!g.thrower || !track.ids.has(g.thrower) || tick < g.end) continue;
            const life = g.type === "smoke" ? SMOKE_SEC : g.type === "molotov" || g.type === "incendiary" ? FIRE_SEC : 0;
            if (tick > g.end + life * r.tick_rate) continue;
            const n = g.x.length - 1;
            drawArea(ctx, g.type === "smoke" ? "smoke" : "fire", g.x[n], g.y[n], P, meta.scale, 0.8 * vis(g.z[n]));
          }
        }
      }

      // movement trails
      if (L.trails) {
        const [i1] = frameAt(r.ticks, tick);
        const [i0] = frameAt(r.ticks, t0);
        for (const p of track.players) {
          ctx.strokeStyle = entryColor(c, track, p.steamid);
          ctx.lineWidth = 1.6 * s;
          ctx.lineJoin = "round";
          ctx.globalAlpha = 0.55;
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

      // grenades: flight with the path, then a landing marker that stays
      if (L.nades) {
        for (const g of r.grenades) {
          if (!g.thrower || !track.ids.has(g.thrower) || tick < g.t[0] || g.t[0] < t0) continue;
          const color = entryColor(c, track, g.thrower);
          if (tick <= g.end + 0.25 * r.tick_rate) {
            drawGrenade(ctx, g, tick, r.tick_rate, P, s, meta.scale, color, vis(g.z[frameAt(g.t, tick)[0]]), true);
            continue;
          }
          const n = g.x.length - 1;
          const a = vis(g.z[n]);
          ctx.globalAlpha = 0.3 * a;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1 * s;
          ctx.setLineDash([3 * s, 3 * s]);
          ctx.beginPath();
          g.x.forEach((x, q) => (q ? ctx.lineTo(...P(x, g.y[q])) : ctx.moveTo(...P(x, g.y[q]))));
          ctx.stroke();
          ctx.setLineDash([]);
          const [px, py] = P(g.x[n], g.y[n]);
          ctx.globalAlpha = a;
          ctx.fillStyle = NADE_COLORS[g.type] ?? "#ccc";
          ctx.strokeStyle = color;
          ctx.lineWidth = 2 * s;
          ctx.beginPath();
          ctx.arc(px, py, 4.5 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // the subject's kills and deaths
      if (L.kills) {
        for (const kill of r.kills) {
          if (kill.tick > tick || kill.tick < t0) continue;
          if (kill.attacker && track.ids.has(kill.attacker)) {
            const color = entryColor(c, track, kill.attacker);
            if (kill.ax !== null && kill.ay !== null) {
              ctx.globalAlpha = 0.6 * vis(kill.vz);
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.2 * s;
              ctx.beginPath();
              ctx.moveTo(...P(kill.ax, kill.ay));
              ctx.lineTo(...P(kill.vx, kill.vy));
              ctx.stroke();
            }
            drawKillMark(ctx, kill, P, s, color, vis(kill.vz));
          }
          if (track.ids.has(kill.victim)) {
            const [px, py] = P(kill.vx, kill.vy);
            ctx.globalAlpha = vis(kill.vz);
            outlinedText(ctx, "☠", px, py + 5 * s, s, 15, entryColor(c, track, kill.victim));
            ctx.globalAlpha = 1;
          }
        }
      }

      // everyone else, faint, for context
      if (L.others && tick < r.last_tick) {
        for (const p of r.players) {
          if (track.ids.has(p.steamid)) continue;
          const st = playerState(r, p, tick);
          if (st.hp <= 0 || Number.isNaN(st.x)) continue;
          const [px, py] = P(st.x, st.y);
          ctx.globalAlpha = 0.5 * vis(st.z);
          ctx.fillStyle = sideColor(p.side);
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1 * s;
          ctx.beginPath();
          ctx.arc(px, py, 4 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      if (L.shots) {
        drawShots(ctx, r, tick, P, s, meta.scale, (id) => track.ids.has(id), (id) => entryColor(c, track, id));
      }

      // the subject's players
      if (tick < r.last_tick) {
        const shooting = new Set<string>();
        for (let q = r.shots.tick.length - 1; q >= 0 && r.shots.tick[q] >= tick - 3; q--) {
          if (r.shots.tick[q] <= tick) shooting.add(r.shots.player[q]);
        }
        for (const p of track.players) {
          const st = playerState(r, p, tick);
          if (st.hp <= 0 || Number.isNaN(st.x)) continue;
          const [px, py] = P(st.x, st.y);
          const label = !L.labels ? null : c.subject.kind === "team" ? p.name : c.layout === "overlay" ? `R${track.round}` : p.name;
          drawPlayer(ctx, st, px, py, s, tick, {
            color: entryColor(c, track, p.steamid), alpha: vis(st.z), label, weapon: L.weapons, cone: L.cone,
            shooting: L.shots && shooting.has(p.steamid),
          });
        }
      }
    }
    ctx.restore();
    if (multi) {
      ctx.fillStyle = "#fff";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(levelLabel(meta, li), ox + size - 70, 20);
    }
  });
  drawHud(ctx, c, active, size, levels.length);
}

function roundedBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = "rgba(10,12,16,0.78)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.fill();
}

/** Title, round clock, legend and a feed of the subject's kills, drawn into the frame itself. */
function drawHud(ctx: CanvasRenderingContext2D, c: Clip, active: { track: Track; t: number }[], size: number, panels: number) {
  const u = Math.max(0.75, size / 768); // scale text with the frame
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const t = active[0]?.t ?? c.from;
  const clock = t < 0 ? `фризтайм ${fmtClock(-t)}` : fmtClock(ROUND_TIME - t);
  const sub = c.layout === "overlay"
    ? `${c.tracks.length} раунд(ов) наложены · +${Math.max(0, Math.floor(t))} с`
    : active[0]
      ? `раунд ${active[0].track.round} · ${sideShort(active[0].track.side)} · ${active[0].track.won ? "победа" : "поражение"}`
      : "";
  ctx.font = `600 ${13 * u}px system-ui, sans-serif`;
  const w = Math.max(ctx.measureText(c.title).width, 150 * u) + 20 * u;
  roundedBox(ctx, 8, 8, w, 74 * u);
  ctx.fillStyle = "#fff";
  ctx.fillText(c.title, 18, 8 + 18 * u);
  ctx.font = `700 ${28 * u}px system-ui, sans-serif`;
  ctx.fillText(clock, 18, 8 + 50 * u);
  ctx.font = `${11 * u}px system-ui, sans-serif`;
  ctx.fillStyle = "#b9c2ce";
  ctx.fillText(sub, 18, 8 + 67 * u);

  // legend
  const legend: [string, string][] = c.subject.kind === "team"
    ? [...c.playerColor].map(([id, color]) => [color, c.tracks.flatMap((tr) => tr.players).find((p) => p.steamid === id)?.name ?? id])
    : c.layout === "overlay"
      ? c.tracks.map((tr) => [tr.color, `R${tr.round} ${sideShort(tr.side)} ${tr.won ? "W" : "L"}`])
      : [];
  if (legend.length) {
    const row = 15 * u;
    const cols = Math.ceil(legend.length / 12);
    const colW = 92 * u;
    const rows = Math.ceil(legend.length / cols);
    const h = rows * row + 10 * u;
    const y0 = size - h - 8;
    roundedBox(ctx, 8, y0, cols * colW + 10 * u, h);
    ctx.font = `${11 * u}px system-ui, sans-serif`;
    legend.forEach(([color, label], i) => {
      const x = 14 + Math.floor(i / rows) * colW, y = y0 + 5 * u + (i % rows) * row;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + 5 * u, y + row / 2, 4.5 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e6e9ee";
      ctx.fillText(label, x + 14 * u, y + row / 2 + 4 * u);
    });
  }

  // kill feed
  const feed: { text: string; color: string }[] = [];
  for (const { track, t: rt } of active) {
    const r = track.r;
    const tick = r.freeze_end_tick + rt * r.tick_rate;
    for (const kill of r.kills) {
      if (kill.tick > tick || tick - kill.tick > FEED_SEC * r.tick_rate) continue;
      const mine = kill.attacker && track.ids.has(kill.attacker);
      if (!mine && !track.ids.has(kill.victim)) continue;
      feed.push({
        text: `R${track.round}  ${kill.attacker_name ?? "мир"} ✕ ${kill.victim_name} (${weaponName(kill.weapon)}${kill.headshot ? ", HS" : ""})`,
        color: mine ? "#e6e9ee" : "#ff8a80",
      });
    }
  }
  if (feed.length) {
    ctx.font = `${11.5 * u}px system-ui, sans-serif`;
    const lines = feed.slice(-5);
    const w2 = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 16 * u;
    const x = size * panels - w2 - 8;
    lines.forEach((l, i) => {
      const y = 8 + i * 20 * u;
      roundedBox(ctx, x, y, w2, 17 * u);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, x + 8 * u, y + 12.5 * u);
    });
  }
}

// ---- component ----
async function loadAll(id: string, rounds: number[]): Promise<Map<number, Replay>> {
  const out = new Map<number, Replay>();
  let next = 0;
  const worker = async () => {
    while (next < rounds.length) {
      const round = rounds[next++];
      out.set(round, await loadReplay(id, round));
    }
  };
  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
  return out;
}

const SIZES = [512, 768, 1024];

export function ClipView({ match }: { match: MatchOverview }) {
  const { assets, error: mapError } = useMapAssets(match.map);
  const players = useMemo(
    () => match.players.filter((p) => p.steamid).map((p) => ({ steamid: String(p.steamid), name: String(p.name), team: String(p.team ?? "") })),
    [match.players],
  );
  const teams = Object.keys(match.score);
  const [subject, setSubject] = useState<Subject>(() => (players[0] ? { kind: "player", steamid: players[0].steamid } : { kind: "team", team: teams[0] }));
  const subjectTeam = subject.kind === "team" ? subject.team : players.find((p) => p.steamid === subject.steamid)?.team ?? "";
  const sideIn = (round: number) => match.timeline.find((r) => r.round === round)?.teams[subjectTeam]?.side;
  const wonIn = (round: number) => match.timeline.find((r) => r.round === round)?.winner === subjectTeam;
  const [picked, setPicked] = useState<number[]>(() => match.timeline.filter((r) => r.teams[subjectTeam]?.side === "terrorist").map((r) => r.round));
  const [layout, setLayout] = useState<Layout>("overlay");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState<number | null>(null); // null: to the end of the longest round
  const [layers, setLayers] = useState<Layers>({ trails: true, cone: true, shots: true, nades: true, kills: true, weapons: false, labels: true, others: false });
  const [view, setView] = useState<number | "all">("all");
  const [replays, setReplays] = useState<Map<number, Replay>>(new Map());
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

  // another team: its rounds on the same side as before (the picked rounds belonged to the old team)
  const lastTeam = useRef(subjectTeam);
  useEffect(() => {
    if (lastTeam.current === subjectTeam) return;
    const side = picked.length ? match.timeline.find((r) => r.round === picked[0])?.teams[lastTeam.current]?.side : "terrorist";
    lastTeam.current = subjectTeam;
    setPicked(match.timeline.filter((r) => r.teams[subjectTeam]?.side === (side ?? "terrorist")).map((r) => r.round));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectTeam]);

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

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // load the picked rounds (cached across renders and with the replay tab)
  const rounds = useMemo(() => [...picked].sort((a, b) => a - b), [picked]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loadAll(match.id, rounds)
      .then((m) => alive && setReplays(m))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [match.id, rounds]);

  const clip: Clip | null = useMemo(() => {
    if (rounds.some((r) => !replays.has(r))) return null;
    const tracks: Track[] = rounds.map((round, i) => {
      const r = replays.get(round)!;
      const ps = r.players.filter((p) => (subject.kind === "player" ? p.steamid === subject.steamid : p.team === subject.team));
      return { round, r, players: ps, ids: new Set(ps.map((p) => p.steamid)), side: sideIn(round), won: wonIn(round), color: PALETTE[i % PALETTE.length] };
    }).filter((t) => t.players.length > 0);
    const playerColor = new Map<string, string>();
    if (subject.kind === "team") {
      const roster = new Map<string, string>();
      tracks.forEach((t) => t.players.forEach((p) => roster.set(p.steamid, p.name)));
      [...roster].sort((a, b) => a[1].localeCompare(b[1])).forEach(([id], i) => playerColor.set(id, PALETTE[i % PALETTE.length]));
    }
    const longest = Math.max(0, ...tracks.map((t) => roundLen(t.r)));
    const name = subject.kind === "player" ? players.find((p) => p.steamid === subject.steamid)?.name ?? "" : subject.team;
    return {
      tracks, subject, layout, from, to: Math.min(to ?? longest, longest), layers, playerColor,
      title: `${name} · ${match.map.replace("de_", "")} · ${tracks.length} р.`,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replays, rounds, subject, layout, from, to, layers]);

  const total = clip ? duration(clip) : 0;
  const levels = assets ? panelLevels(assets.meta, assets.meta.levels.length > 1 ? view : 0) : [0];
  const size = Math.max(320, Math.min(Math.floor(boxWidth / levels.length), window.innerHeight - 200));

  const render = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !assets || !clip) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawClip(ctx, assets, clip, tRef.current, levels, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, clip, size, levels.join(",")]);
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

  const runExport = async () => {
    if (!clip || !assets) return;
    setPlaying(false);
    const abort = new AbortController();
    setExporting({ progress: 0, abort });
    setExported(null);
    try {
      const job = {
        width: outSize * levels.length, height: outSize, duration: total, speed, fps,
        render: (ctx: CanvasRenderingContext2D, time: number) => drawClip(ctx, assets, clip, time, levels, outSize),
        onProgress: (progress: number) => setExporting({ progress, abort }),
        signal: abort.signal,
      };
      const blob = format === "gif" ? await exportGif(job) : await exportMp4(job);
      const base = clip.title.split(" · ")[0].replace(/[^\p{L}\p{N}_-]+/gu, "_");
      const name = `${match.id}_${base}_${layout}_r${rounds.join("-").slice(0, 40)}.${format}`;
      download(blob, name);
      setExported(`${name} — ${(blob.size / 2 ** 20).toFixed(1)} МБ`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const pick = (pred: (round: number) => boolean) => setPicked(match.timeline.map((r) => r.round).filter(pred));
  const toggle = (round: number) => setPicked((p) => (p.includes(round) ? p.filter((x) => x !== round) : [...p, round]));
  const frames = Math.ceil((total / speed) * fps);

  if (mapError) return <div className="error">{mapError}</div>;
  return (
    <div className="clip">
      <div className="clip-side">
        <h3>Кого показывать</h3>
        <select
          value={subject.kind === "player" ? `p:${subject.steamid}` : `t:${subject.team}`}
          onChange={(e) => {
            const v = e.target.value;
            setSubject(v.startsWith("p:") ? { kind: "player", steamid: v.slice(2) } : { kind: "team", team: v.slice(2) });
          }}
        >
          <optgroup label="Команда целиком">
            {teams.map((t) => <option key={t} value={`t:${t}`}>{t}</option>)}
          </optgroup>
          {teams.map((t) => (
            <optgroup key={t} label={`Игроки — ${t}`}>
              {players.filter((p) => p.team === t).map((p) => <option key={p.steamid} value={`p:${p.steamid}`}>{p.name}</option>)}
            </optgroup>
          ))}
        </select>

        <h3>Раунды ({picked.length})</h3>
        <div className="row small">
          <button className="link" onClick={() => pick(() => true)}>все</button>
          <button className="link" onClick={() => pick((r) => sideIn(r) === "terrorist")}>за T</button>
          <button className="link" onClick={() => pick((r) => sideIn(r) === "counter-terrorist")}>за CT</button>
          <button className="link" onClick={() => pick((r) => wonIn(r))}>победы</button>
          <button className="link" onClick={() => pick((r) => !wonIn(r))}>поражения</button>
          <button className="link" onClick={() => setPicked([])}>сбросить</button>
        </div>
        <div className="round-chips">
          {match.timeline.map((r) => {
            const side = r.teams[subjectTeam]?.side;
            const on = picked.includes(r.round);
            return (
              <button
                key={r.round}
                className={`chip ${on ? "on" : ""} ${r.winner === subjectTeam ? "won" : ""}`}
                style={{ borderColor: sideColor(side), background: on ? sideColor(side) : undefined }}
                title={`${sideShort(side)}, ${r.winner === subjectTeam ? "победа" : "поражение"}${r.plant_site ? `, плант ${r.plant_site}` : ""}`}
                onClick={() => toggle(r.round)}
              >
                {r.round}
              </button>
            );
          })}
        </div>
        <div className="muted small">Цвет рамки — сторона, жирный номер — раунд выигран.</div>

        <h3>Как показывать</h3>
        <span className="seg">
          <button className={layout === "overlay" ? "on" : ""} onClick={() => setLayout("overlay")} title="Все раунды одновременно, по времени раунда">наложение</button>
          <button className={layout === "sequence" ? "on" : ""} onClick={() => setLayout("sequence")} title="Раунды друг за другом">по очереди</button>
        </span>
        <div className="row small">
          с <input type="number" value={from} min={-20} max={170} onChange={(e) => setFrom(Number(e.target.value))} /> с
          до <input type="number" value={to ?? ""} placeholder="конец" min={1} max={200} onChange={(e) => setTo(e.target.value === "" ? null : Number(e.target.value))} /> с
          <span className="muted">от конца фризтайма</span>
        </div>
        <div className="layers small">
          {([
            ["trails", "пути"], ["cone", "обзор"], ["shots", "стрельба"], ["nades", "гранаты"], ["kills", "убийства и смерти"],
            ["weapons", "оружие"], ["labels", "подписи"], ["others", "остальные игроки"],
          ] as [keyof Layers, string][]).map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={layers[key]} onChange={(e) => setLayers({ ...layers, [key]: e.target.checked })} /> {label}
            </label>
          ))}
        </div>

        <h3>Экспорт</h3>
        <div className="row small">
          <span className="seg">
            <button className={format === "mp4" ? "on" : ""} disabled={!canEncodeVideo()} onClick={() => chooseFormat("mp4")}>MP4</button>
            <button className={format === "gif" ? "on" : ""} onClick={() => chooseFormat("gif")}>GIF</button>
          </span>
          <select value={outSize} onChange={(e) => setOutSize(Number(e.target.value))}>
            {SIZES.map((v) => <option key={v} value={v}>{v * levels.length}×{v}</option>)}
          </select>
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {[10, 20, 25, 30].map((v) => <option key={v} value={v}>{v} к/с</option>)}
          </select>
        </div>
        <div className="muted small">
          Скорость {speed}× · {Math.round(total / speed)} с видео · {frames} кадров
          {format === "gif" && frames * outSize * outSize > 400 * 768 * 768 ? " · большой GIF, лучше MP4 или меньше размер" : ""}
        </div>
        <div className="row">
          {exporting ? (
            <>
              <div className="progress grow"><div className="progress-bar" style={{ width: `${exporting.progress * 100}%` }} /><span>кодирую {Math.round(exporting.progress * 100)}%</span></div>
              <button onClick={() => exporting.abort.abort()}>Отмена</button>
            </>
          ) : (
            <button disabled={!clip || !clip.tracks.length || total <= 0} onClick={runExport}>Сохранить {format.toUpperCase()}</button>
          )}
        </div>
        {exported && <div className="small ok-text">Сохранено: {exported}</div>}
        {error && <div className="error small">{error}</div>}
      </div>

      <div className="clip-main" ref={boxRef}>
        <div className="row">
          <button className="play" onClick={() => (T >= total ? (seek(0), setPlaying(true)) : setPlaying((p) => !p))} disabled={!clip}>
            {playing ? "⏸" : "▶"}
          </button>
          <input type="range" className="grow" min={0} max={total || 1} step={0.05} value={T} onChange={(e) => seek(Number(e.target.value))} />
          <span className="muted small clock-small">{T.toFixed(1)} / {total.toFixed(0)} с</span>
          <span className="seg">
            {[1, 2, 4, 8].map((v) => <button key={v} className={speed === v ? "on" : ""} onClick={() => setSpeed(v)}>{v}×</button>)}
          </span>
          {assets && assets.meta.levels.length > 1 && (
            <span className="seg">
              {assets.meta.levels.map((_, i) => <button key={i} className={view === i ? "on" : ""} onClick={() => setView(i)}>{levelLabel(assets.meta, i)}</button>)}
              <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>оба</button>
            </span>
          )}
        </div>
        {!clip || !assets ? (
          <div className="muted" style={{ height: size }}>{loading ? `Загружаю раунды (${replays.size}/${rounds.length})…` : "Выберите раунды."}</div>
        ) : clip.tracks.length === 0 ? (
          <div className="muted">В выбранных раундах этого игрока нет.</div>
        ) : (
          <canvas
            ref={canvasRef}
            width={size * levels.length * (window.devicePixelRatio || 1)}
            height={size * (window.devicePixelRatio || 1)}
            style={{ width: size * levels.length, height: size, borderRadius: 6 }}
          />
        )}
      </div>
    </div>
  );
}
