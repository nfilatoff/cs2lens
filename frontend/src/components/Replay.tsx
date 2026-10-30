import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type MatchOverview, type Replay, type ReplayPlayer } from "../api";
import { go } from "../App";
import { REASONS } from "../pages/Match";
import {
  CT_COLOR, T_COLOR, drawRadar, levelLabel, levelOf, panelLevels, sideColor, sideShort, useMapAssets, worldToPx,
  type MapAssets,
} from "../radar";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const ROUND_TIME = 115; // seconds of round clock after freeze time
const BOMB_TIME = 40;
const SMOKE_RADIUS = 144; // world units
const FIRE_RADIUS = 110;
const KILLFEED_SEC = 6;
const NADE_COLORS: Record<string, string> = {
  smoke: "#e3e3e3", flashbang: "#ffffff", he: "#ff5c5c", molotov: "#ff9f1c", incendiary: "#ff9f1c", decoy: "#9aa59a",
};

// ---- data cache: a few rounds kept in memory, the next one prefetched ----
const cache = new Map<string, Promise<Replay>>();
function loadReplay(id: string, round: number): Promise<Replay> {
  const key = `${id}#${round}`;
  let p = cache.get(key);
  if (!p) {
    p = api.replay(id, round);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return p;
}

// ---- interpolation helpers ----
function frameAt(ticks: number[], tick: number): [number, number] {
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

function lerp(a: number | null, b: number | null, f: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

function lerpAngle(a: number | null, b: number | null, f: number): number | null {
  if (a === null || b === null) return a ?? b;
  let d = ((b - a + 540) % 360) - 180;
  return a + d * f;
}

interface PlayerState {
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
  defusing: boolean;
  flash: number; // 0..1 remaining blindness
}

function playerStates(r: Replay, tick: number): PlayerState[] {
  const [i, f] = frameAt(r.ticks, tick);
  const j = Math.min(i + 1, r.ticks.length - 1);
  return r.players.map((p) => {
    const x = lerp(p.x[i], p.x[j], f), y = lerp(p.y[i], p.y[j], f), z = lerp(p.z[i], p.z[j], f);
    let flash = 0;
    for (const b of r.blinds) {
      if (b.victim !== p.steamid || b.tick > tick) continue;
      const left = 1 - (tick - b.tick) / (b.duration * r.tick_rate);
      if (left > flash) flash = left;
    }
    return {
      p,
      x: x ?? NaN, y: y ?? NaN, z: z ?? 0,
      yaw: lerpAngle(p.yaw[i], p.yaw[j], f),
      hp: p.hp[i], armor: p.armor[i],
      helmet: !!p.helmet?.[i], kit: !!p.kit?.[i], bomb: !!p.bomb[i],
      weapon: p.weapon[i] >= 0 ? r.weapons[p.weapon[i]] : null,
      defusing: !!p.defusing?.[i],
      flash: Math.min(1, flash),
    };
  });
}

function bombState(r: Replay, tick: number) {
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

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- drawing ----
function draw(
  ctx: CanvasRenderingContext2D, assets: MapAssets, r: Replay, tick: number, levels: number[], size: number,
  opts: { names: boolean; weapons: boolean; trails: boolean },
) {
  const { meta, images } = assets;
  const states = playerStates(r, tick);
  const bomb = bombState(r, tick);
  const multi = meta.levels.length > 1;
  const k = size / 1024; // screen px per radar px
  const s = 1 / k; // radar px per screen px
  const W = (u: number) => u / meta.scale; // world units -> radar px

  levels.forEach((li, panel) => {
    const ox = panel * size;
    drawRadar(ctx, images[li], ox, size);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, 0, size, size);
    ctx.clip();
    ctx.translate(ox, 0);
    ctx.scale(k, k);
    const vis = (z: number | null | undefined) => (!multi || levelOf(meta, z) === li ? 1 : 0.15);
    const P = (x: number, y: number) => worldToPx(meta, x, y);

    // smokes and fires with their real lifetimes
    for (const a of r.smokes) {
      if (tick < a.start || tick > a.end) continue;
      const fadeIn = Math.min(1, (tick - a.start) / r.tick_rate);
      const fadeOut = Math.min(1, (a.end - tick) / (2 * r.tick_rate));
      const [px, py] = P(a.x, a.y);
      ctx.globalAlpha = 0.6 * Math.min(fadeIn, fadeOut) * vis(a.z);
      ctx.fillStyle = "#cfd3d6";
      ctx.beginPath();
      ctx.arc(px, py, W(SMOKE_RADIUS), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = vis(a.z);
      ctx.fillStyle = "#222";
      ctx.font = `${10 * s}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(String(Math.ceil((a.end - tick) / r.tick_rate)), px, py + 4 * s);
    }
    for (const a of r.fires) {
      if (tick < a.start || tick > a.end) continue;
      const [px, py] = P(a.x, a.y);
      ctx.globalAlpha = 0.5 * vis(a.z);
      ctx.fillStyle = "#ff6a1a";
      ctx.beginPath();
      ctx.arc(px, py, W(FIRE_RADIUS), 0, Math.PI * 2);
      ctx.fill();
    }

    // grenades in flight, with the path so far
    for (const g of r.grenades) {
      if (tick < g.t[0] || tick > g.end + 0.25 * r.tick_rate) continue;
      const color = NADE_COLORS[g.type] ?? "#ccc";
      const [gi, gf] = frameAt(g.t, tick);
      const gj = Math.min(gi + 1, g.t.length - 1);
      const hx = lerp(g.x[gi], g.x[gj], gf)!, hy = lerp(g.y[gi], g.y[gj], gf)!, hz = lerp(g.z[gi], g.z[gj], gf)!;
      ctx.globalAlpha = 0.8 * vis(hz);
      if (opts.trails) {
        ctx.strokeStyle = g.side ? sideColor(g.side) : color;
        ctx.lineWidth = 1.2 * s;
        ctx.setLineDash([3 * s, 3 * s]);
        ctx.beginPath();
        for (let q = 0; q <= gi; q++) {
          const [px, py] = P(g.x[q], g.y[q]);
          if (q === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        const [hpx, hpy] = P(hx, hy);
        ctx.lineTo(hpx, hpy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const [hpx, hpy] = P(hx, hy);
      if (tick > g.end && (g.type === "he" || g.type === "flashbang")) {
        const burst = (tick - g.end) / (0.25 * r.tick_rate);
        ctx.globalAlpha = (1 - burst) * vis(hz);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(hpx, hpy, W(g.type === "he" ? 200 : 120) * burst + 3 * s, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = color;
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1 * s;
        ctx.beginPath();
        ctx.arc(hpx, hpy, 3.2 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // kill marks
    ctx.lineWidth = 2 * s;
    for (const kill of r.kills) {
      if (kill.tick > tick) break;
      const [px, py] = P(kill.vx, kill.vy);
      ctx.globalAlpha = 0.85 * vis(kill.vz);
      ctx.strokeStyle = sideColor(kill.victim_side);
      const d = 5 * s;
      ctx.beginPath();
      ctx.moveTo(px - d, py - d);
      ctx.lineTo(px + d, py + d);
      ctx.moveTo(px + d, py - d);
      ctx.lineTo(px - d, py + d);
      ctx.stroke();
    }

    // bomb on the ground or planted
    const b = bomb.planted ?? bomb.dropped;
    if (b) {
      const [px, py] = P(b.x, b.y);
      const blink = bomb.planted && !bomb.defused ? 0.5 + 0.5 * Math.sin(tick / 6) : 1;
      ctx.globalAlpha = vis(b.z) * blink;
      ctx.fillStyle = bomb.defused ? "#3ddc84" : "#ff3030";
      ctx.fillRect(px - 5 * s, py - 4 * s, 10 * s, 8 * s);
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1 * s;
      ctx.strokeRect(px - 5 * s, py - 4 * s, 10 * s, 8 * s);
    }

    // shots: a short tracer in the view direction
    const shotFrom = new Set<string>();
    for (let q = r.shots.tick.length - 1; q >= 0; q--) {
      const t = r.shots.tick[q];
      if (t > tick) continue;
      if (t < tick - 3) break;
      shotFrom.add(r.shots.player[q]);
    }

    // players
    for (const st of states) {
      if (st.hp <= 0 || Number.isNaN(st.x)) continue;
      const [px, py] = P(st.x, st.y);
      const a = vis(st.z);
      const color = sideColor(st.p.side);
      const rad = 6.5 * s;
      ctx.globalAlpha = a;
      if (st.yaw !== null) {
        const ang = (-st.yaw * Math.PI) / 180;
        if (shotFrom.has(st.p.steamid)) {
          ctx.strokeStyle = "#fff59d";
          ctx.lineWidth = 1.5 * s;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(ang) * 60 * s, py + Math.sin(ang) * 60 * s);
          ctx.stroke();
        }
        ctx.fillStyle = color;
        ctx.globalAlpha = a * 0.35;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.arc(px, py, 22 * s, ang - 0.45, ang + 0.45);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = a;
      }
      if (st.flash > 0.05) {
        ctx.fillStyle = `rgba(255,255,255,${0.85 * st.flash})`;
        ctx.beginPath();
        ctx.arc(px, py, rad + 5 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.strokeStyle = st.bomb ? "#ff3030" : "#000";
      ctx.lineWidth = (st.bomb ? 2.5 : 1.2) * s;
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
      // hp bar
      ctx.fillStyle = "#000";
      ctx.fillRect(px - 9 * s, py + rad + 2 * s, 18 * s, 3 * s);
      ctx.fillStyle = st.hp > 50 ? "#3ddc84" : st.hp > 20 ? "#f2c94c" : "#ff5c5c";
      ctx.fillRect(px - 9 * s, py + rad + 2 * s, (18 * s * st.hp) / 100, 3 * s);
      ctx.textAlign = "center";
      ctx.font = `${10 * s}px sans-serif`;
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      if (opts.names) {
        ctx.strokeText(st.p.name, px, py - rad - 4 * s);
        ctx.fillStyle = "#fff";
        ctx.fillText(st.p.name, px, py - rad - 4 * s);
      }
      if (opts.weapons && st.weapon) {
        ctx.font = `${8.5 * s}px sans-serif`;
        ctx.strokeText(st.weapon, px, py + rad + 14 * s);
        ctx.fillStyle = "#cfd8dc";
        ctx.fillText(st.weapon, px, py + rad + 14 * s);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    if (multi) {
      ctx.fillStyle = "#fff";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(levelLabel(meta, li), ox + 10, 20);
    }
  });
}

// ---- component ----
export function ReplayView({ match, round, at }: { match: MatchOverview; round: number; at?: number }) {
  const { assets, error: mapError } = useMapAssets(match.map);
  const [data, setData] = useState<Replay | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<number | "all">("all");
  const [opts, setOpts] = useState({ names: true, weapons: false, trails: true });
  const [uiTick, setUiTick] = useState(0);
  const tickRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(800);

  const rounds = match.timeline.map((r) => r.round);
  const roundIdx = rounds.indexOf(round);

  useEffect(() => {
    setData(null);
    setError(null);
    const t0 = performance.now();
    loadReplay(match.id, round)
      .then((r) => {
        setLoadMs(Math.round(performance.now() - t0));
        tickRef.current = r.freeze_end_tick + (at ?? -1) * r.tick_rate;
        setUiTick(tickRef.current);
        setData(r);
        const next = rounds[roundIdx + 1];
        if (next !== undefined) loadReplay(match.id, next).catch(() => {});
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id, round]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const levels = assets ? panelLevels(assets.meta, assets.meta.levels.length > 1 ? view : 0) : [0];
  const size = Math.max(320, Math.min(Math.floor(boxWidth / levels.length), window.innerHeight - 230));

  const render = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !assets || !data) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, assets, data, tickRef.current, levels, size, opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, data, size, levels.join(","), opts]);

  useEffect(render, [render, uiTick]);

  // playback loop
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0, last = performance.now(), lastUi = 0;
    const frame = (now: number) => {
      tickRef.current += ((now - last) / 1000) * data.tick_rate * speed;
      last = now;
      if (tickRef.current >= data.last_tick) {
        tickRef.current = data.last_tick;
        setPlaying(false);
      }
      render();
      if (now - lastUi > 66) {
        setUiTick(tickRef.current);
        lastUi = now;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, data, render]);

  const seek = useCallback(
    (t: number) => {
      if (!data) return;
      tickRef.current = Math.max(data.start_tick, Math.min(data.last_tick, t));
      setUiTick(tickRef.current);
    },
    [data],
  );

  const stepFrame = useCallback(
    (dir: number) => {
      if (!data) return;
      setPlaying(false);
      const [i, f] = frameAt(data.ticks, tickRef.current);
      const target = dir > 0 ? Math.min(i + 1, data.ticks.length - 1) : f > 0 ? i : Math.max(i - 1, 0);
      seek(data.ticks[target]);
    },
    [data, seek],
  );

  const jumpKill = useCallback(
    (dir: number) => {
      if (!data) return;
      const now = tickRef.current;
      const lead = 2 * data.tick_rate; // land a little before the kill
      const list = dir > 0 ? data.kills.filter((k) => k.tick - lead > now + 1) : data.kills.filter((k) => k.tick - lead < now - 1).reverse();
      if (list[0]) seek(list[0].tick - lead);
    },
    [data, seek],
  );

  const changeSpeed = (dir: number) =>
    setSpeed((s) => SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + dir))]);

  // hotkeys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!data || (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      const sec = data.tick_rate;
      switch (e.key) {
        case " ": setPlaying((p) => !p); break;
        case "ArrowRight": e.shiftKey ? seek(tickRef.current + 5 * sec) : stepFrame(1); break;
        case "ArrowLeft": e.shiftKey ? seek(tickRef.current - 5 * sec) : stepFrame(-1); break;
        case ".": stepFrame(1); break;
        case ",": stepFrame(-1); break;
        case "ArrowUp": case "+": case "=": changeSpeed(1); break;
        case "ArrowDown": case "-": changeSpeed(-1); break;
        case "n": case "N": case "k": case "K": jumpKill(1); break;
        case "p": case "P": case "j": case "J": jumpKill(-1); break;
        case "Home": seek(data.freeze_end_tick); break;
        case "]": if (rounds[roundIdx + 1] !== undefined) go("match", match.id, "replay", rounds[roundIdx + 1]); break;
        case "[": if (roundIdx > 0) go("match", match.id, "replay", rounds[roundIdx - 1]); break;
        case "1": setView(0); break;
        case "2": if (assets && assets.meta.levels.length > 1) setView(1); break;
        case "3": setView("all"); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, seek, stepFrame, jumpKill, roundIdx, assets]);

  const states = useMemo(() => (data ? playerStates(data, uiTick) : []), [data, uiTick]);
  if (error) return <div className="error">{error}</div>;
  if (mapError) return <div className="error">{mapError}</div>;

  const dpr = window.devicePixelRatio || 1;
  const width = size * levels.length;
  const roundInfo = match.timeline[roundIdx];

  return (
    <div className="replay">
      <div className="replay-top">
        <button disabled={roundIdx <= 0} onClick={() => go("match", match.id, "replay", rounds[roundIdx - 1])}>◀ [</button>
        <select value={round} onChange={(e) => go("match", match.id, "replay", e.target.value)}>
          {match.timeline.map((r) => (
            <option key={r.round} value={r.round}>
              Раунд {r.round} — {r.winner ?? sideShort(r.winner_side)} ({REASONS[r.reason] ?? r.reason})
            </option>
          ))}
        </select>
        <button disabled={roundIdx >= rounds.length - 1} onClick={() => go("match", match.id, "replay", rounds[roundIdx + 1])}>] ▶</button>
        {data && <Clock r={data} tick={uiTick} />}
        {loadMs !== null && <span className="muted small">загружено за {loadMs} мс{data?.low_res ? " · шаг 0.5 с (нет replay.parquet)" : ""}</span>}
        <span className="grow" />
        {assets && assets.meta.levels.length > 1 && (
          <span className="seg">
            {assets.meta.levels.map((_, i) => (
              <button key={i} className={view === i ? "on" : ""} onClick={() => setView(i)}>{levelLabel(assets.meta, i)}</button>
            ))}
            <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>оба</button>
          </span>
        )}
        <label className="small"><input type="checkbox" checked={opts.names} onChange={(e) => setOpts({ ...opts, names: e.target.checked })} /> имена</label>
        <label className="small"><input type="checkbox" checked={opts.weapons} onChange={(e) => setOpts({ ...opts, weapons: e.target.checked })} /> оружие</label>
        <label className="small"><input type="checkbox" checked={opts.trails} onChange={(e) => setOpts({ ...opts, trails: e.target.checked })} /> траектории</label>
      </div>

      <div className="replay-body">
        <TeamPanel states={states.filter((s) => s.p.side === "counter-terrorist")} title={data?.teams["counter-terrorist"] ?? "CT"} color={CT_COLOR} />
        <div className="replay-stage" ref={boxRef}>
          {!data || !assets ? (
            <div className="muted" style={{ height: size }}>Загрузка раунда…</div>
          ) : (
            <div style={{ position: "relative", width, height: size }}>
              <canvas ref={canvasRef} width={width * dpr} height={size * dpr} style={{ width, height: size }} />
              <KillFeed r={data} tick={uiTick} />
            </div>
          )}
        </div>
        <TeamPanel states={states.filter((s) => s.p.side === "terrorist")} title={data?.teams.terrorist ?? "T"} color={T_COLOR} />
      </div>

      {data && (
        <>
          <Timeline r={data} tick={uiTick} onSeek={seek} />
          <div className="controls">
            <button onClick={() => stepFrame(-1)} title="Кадр назад (←)">⏮</button>
            <button className="play" onClick={() => setPlaying((p) => !p)} title="Пробел">{playing ? "⏸" : "▶"}</button>
            <button onClick={() => stepFrame(1)} title="Кадр вперёд (→)">⏭</button>
            <button onClick={() => jumpKill(-1)} title="Предыдущее убийство (P)">⟨ убийство</button>
            <button onClick={() => jumpKill(1)} title="Следующее убийство (N)">убийство ⟩</button>
            <span className="seg">
              {SPEEDS.map((s) => (
                <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>{s}×</button>
              ))}
            </span>
            <span className="muted small hotkeys">
              Пробел — пуск/пауза · ←/→ — кадр · Shift+←/→ — 5 с · ↑/↓ — скорость · N/P — убийства · [ ] — раунды · Home — конец фризтайма
              {assets && assets.meta.levels.length > 1 ? " · 1/2/3 — уровни" : ""}
            </span>
          </div>
          {roundInfo && (
            <div className="muted small">
              Победа: {roundInfo.winner} ({sideShort(roundInfo.winner_side)}), {REASONS[roundInfo.reason] ?? roundInfo.reason}
              {roundInfo.plant_site ? `, плант на ${roundInfo.plant_site}` : ""}.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Clock({ r, tick }: { r: Replay; tick: number }) {
  const bomb = bombState(r, tick);
  if (tick < r.freeze_end_tick) return <span className="clock">фризтайм {fmtClock((r.freeze_end_tick - tick) / r.tick_rate)}</span>;
  if (bomb.planted && !bomb.defused) {
    const left = BOMB_TIME - (tick - bomb.planted.tick) / r.tick_rate;
    return <span className="clock bomb">💣 {bomb.planted.site} {fmtClock(left)}</span>;
  }
  if (bomb.defused) return <span className="clock defused">разминирована</span>;
  return <span className="clock">{fmtClock(ROUND_TIME - (tick - r.freeze_end_tick) / r.tick_rate)}</span>;
}

function TeamPanel({ states, title, color }: { states: PlayerState[]; title: string; color: string }) {
  return (
    <div className="team-panel">
      <div className="team-title" style={{ color }}>{title}</div>
      {states.map((s) => (
        <div key={s.p.steamid} className={`pl ${s.hp <= 0 ? "dead" : ""}`}>
          <div className="pl-top">
            <span className="pl-name">{s.p.name}</span>
            <span className="pl-icons">
              {s.bomb && <span title="бомба">💣</span>}
              {s.kit && <span title="дефьюз-кит">✂</span>}
              {s.armor > 0 && <span title={`броня ${s.armor}`}>{s.helmet ? "⛑" : "🛡"}</span>}
            </span>
          </div>
          <div className="hp"><div style={{ width: `${s.hp}%`, background: color }} /><span>{s.hp}</span></div>
          <div className="pl-weapon">{s.hp > 0 ? s.weapon ?? "" : "мёртв"}{s.p.money !== null ? <span className="muted"> · ${s.p.money}</span> : null}</div>
        </div>
      ))}
    </div>
  );
}

function KillFeed({ r, tick }: { r: Replay; tick: number }) {
  const recent = r.kills.filter((k) => k.tick <= tick && tick - k.tick < KILLFEED_SEC * r.tick_rate).slice(-5);
  return (
    <div className="killfeed">
      {recent.map((k, i) => (
        <div key={i} className="kill">
          <span style={{ color: sideColor(k.attacker_side) }}>{k.attacker_name ?? "мир"}</span>
          <span className="weapon">
            {k.flashed ? "◐ " : ""}{k.weapon}{k.headshot ? " ⌖" : ""}{k.wallbang ? " ⇥" : ""}{k.thrusmoke ? " ☁" : ""}
          </span>
          <span style={{ color: sideColor(k.victim_side) }}>{k.victim_name}</span>
        </div>
      ))}
    </div>
  );
}

function Timeline({ r, tick, onSeek }: { r: Replay; tick: number; onSeek: (t: number) => void }) {
  const span = r.last_tick - r.start_tick;
  const pct = (t: number) => `${((t - r.start_tick) / span) * 100}%`;
  const ref = useRef<HTMLDivElement>(null);
  const seekAt = (clientX: number) => {
    const box = ref.current!.getBoundingClientRect();
    onSeek(r.start_tick + ((clientX - box.left) / box.width) * span);
  };
  return (
    <div
      className="timeline"
      ref={ref}
      onMouseDown={(e) => {
        seekAt(e.clientX);
        const move = (ev: MouseEvent) => seekAt(ev.clientX);
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    >
      <div className="tl-freeze" style={{ width: pct(r.freeze_end_tick) }} title="фризтайм" />
      <div className="tl-progress" style={{ width: pct(tick) }} />
      <div className="tl-mark end" style={{ left: pct(r.end_tick) }} title="конец раунда" />
      {r.kills.map((k, i) => (
        <div
          key={i}
          className="tl-kill"
          style={{ left: pct(k.tick), background: sideColor(k.attacker_side) }}
          title={`${k.attacker_name ?? "мир"} → ${k.victim_name} (${k.weapon})`}
        />
      ))}
      {r.bomb.filter((b) => b.event === "finish_plant" || b.event === "defuse").map((b, i) => (
        <div key={i} className="tl-bomb" style={{ left: pct(b.tick) }} title={b.event === "defuse" ? "дефьюз" : `плант ${b.site}`}>
          {b.event === "defuse" ? "✂" : "💣"}
        </div>
      ))}
      <div className="tl-head" style={{ left: pct(tick) }} />
    </div>
  );
}
