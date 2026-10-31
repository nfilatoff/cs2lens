import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatchOverview, Replay } from "../api";
import { go } from "../App";
import { REASONS } from "../pages/Match";
import {
  CT_COLOR, RADAR_SIZE, T_COLOR, drawRadar, levelLabel, levelOf, panelLevels, sideColor, sideShort, useMapAssets, worldToPx,
  type MapAssets,
} from "../radar";
import {
  NADE_COLORS, bombState, drawArea, drawGrenade, drawKillMark, drawPlayer, drawShots, fmtClock, frameAt, killAt, loadReplay,
  playerStates, weaponName, type PlayerState,
} from "../replayDraw";
import { KillCard } from "./KillCard";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const ROUND_TIME = 115; // seconds of round clock after freeze time
const BOMB_TIME = 40;
const KILLFEED_SEC = 6;

interface DrawOpts {
  names: boolean;
  weapons: boolean;
  trails: boolean;
  shots: boolean;
  hoverKill: number; // index into r.kills, -1 for none
}

// ---- drawing ----
function draw(ctx: CanvasRenderingContext2D, assets: MapAssets, r: Replay, tick: number, levels: number[], size: number, opts: DrawOpts) {
  const { meta, images } = assets;
  const states = playerStates(r, tick);
  const bomb = bombState(r, tick);
  const multi = meta.levels.length > 1;
  const k = size / RADAR_SIZE; // screen px per radar px
  const s = 1 / k; // radar px per screen px

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
      drawArea(ctx, "smoke", a.x, a.y, P, meta.scale, Math.min(fadeIn, fadeOut) * vis(a.z));
      const [px, py] = P(a.x, a.y);
      ctx.globalAlpha = vis(a.z);
      ctx.fillStyle = "#222";
      ctx.font = `${10 * s}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(String(Math.ceil((a.end - tick) / r.tick_rate)), px, py + 4 * s);
      ctx.globalAlpha = 1;
    }
    for (const a of r.fires) {
      if (tick >= a.start && tick <= a.end) drawArea(ctx, "fire", a.x, a.y, P, meta.scale, vis(a.z));
    }

    // grenades in flight, with the path so far
    for (const g of r.grenades) {
      if (tick < g.t[0] || tick > g.end + 0.25 * r.tick_rate) continue;
      const z = g.z[frameAt(g.t, tick)[0]];
      drawGrenade(ctx, g, tick, r.tick_rate, P, s, meta.scale, g.side ? sideColor(g.side) : NADE_COLORS[g.type] ?? "#ccc", vis(z), opts.trails);
    }

    // death crosses; the hovered one is drawn last, with the killer and the line of fire
    r.kills.forEach((kill, i) => {
      if (kill.tick <= tick && i !== opts.hoverKill) drawKillMark(ctx, kill, P, s, sideColor(kill.victim_side), 0.9 * vis(kill.vz));
    });

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
      ctx.globalAlpha = 1;
    }

    // bullet tracers: to the player hit, or a fading ray along the view direction
    const zOf = new Map(states.map((st) => [st.p.steamid, st.z]));
    const sideOf = new Map(states.map((st) => [st.p.steamid, st.p.side]));
    if (opts.shots) {
      drawShots(ctx, r, tick, P, s, meta.scale, (id) => vis(zOf.get(id)) === 1, (id) => sideColor(sideOf.get(id)));
    }
    const shooting = new Set<string>();
    for (let q = r.shots.tick.length - 1; q >= 0 && r.shots.tick[q] >= tick - 3; q--) {
      if (r.shots.tick[q] <= tick) shooting.add(r.shots.player[q]);
    }

    // players
    for (const st of states) {
      if (st.hp <= 0 || Number.isNaN(st.x)) continue;
      const [px, py] = P(st.x, st.y);
      drawPlayer(ctx, st, px, py, s, tick, {
        color: sideColor(st.p.side), alpha: vis(st.z), label: opts.names ? st.p.name : null,
        weapon: opts.weapons, cone: true, shooting: shooting.has(st.p.steamid),
      });
    }
    if (opts.hoverKill >= 0) {
      const kill = r.kills[opts.hoverKill];
      drawKillMark(ctx, kill, P, s, sideColor(kill.victim_side), vis(kill.vz) === 1 ? 1 : 0.4, true);
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
  const [opts, setOpts] = useState({ names: true, weapons: true, trails: true, shots: true });
  const [hover, setHover] = useState<{ kill: number; x: number; y: number } | null>(null);
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
    draw(ctx, assets, data, tickRef.current, levels, size, { ...opts, hoverKill: hover?.kill ?? -1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, data, size, levels.join(","), opts, hover?.kill]);

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

  // death crosses under the pointer
  const onStageMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!assets || !data) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const panel = Math.floor(x / size);
    const li = levels[panel];
    if (li === undefined) return setHover(null);
    const k = size / RADAR_SIZE;
    const multi = assets.meta.levels.length > 1;
    const i = killAt(data.kills, tickRef.current, (wx, wy) => worldToPx(assets.meta, wx, wy), (x - panel * size) / k, y / k, 1 / k,
      (kill) => !multi || levelOf(assets.meta, kill.vz) === li);
    setHover(i >= 0 ? { kill: i, x, y } : null);
  };
  const onStageClick = () => {
    if (!hover || !data) return;
    const kill = data.kills[hover.kill];
    setPlaying(false);
    seek(Math.min(kill.duel_start ?? kill.tick, kill.tick - data.tick_rate) - data.tick_rate);
  };

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
        <label className="small"><input type="checkbox" checked={opts.shots} onChange={(e) => setOpts({ ...opts, shots: e.target.checked })} /> выстрелы</label>
      </div>

      <div className="replay-body">
        <TeamPanel states={states.filter((s) => s.p.side === "counter-terrorist")} title={data?.teams["counter-terrorist"] ?? "CT"} color={CT_COLOR} />
        <div className="replay-stage" ref={boxRef}>
          {!data || !assets ? (
            <div className="muted" style={{ height: size }}>Загрузка раунда…</div>
          ) : (
            <div
              style={{ position: "relative", width, height: size, cursor: hover ? "pointer" : undefined }}
              onMouseMove={onStageMove}
              onMouseLeave={() => setHover(null)}
              onClick={onStageClick}
            >
              <canvas ref={canvasRef} width={width * dpr} height={size * dpr} style={{ width, height: size }} />
              <KillFeed r={data} tick={uiTick} />
              {hover && data.kills[hover.kill] && <KillCard r={data} kill={data.kills[hover.kill]} x={hover.x} y={hover.y} maxX={width} />}
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
          <div className="pl-weapon">
            {[
              // the active gun is highlighted in the inventory line below; other active items are named here
              s.hp <= 0 ? "мёртв" : s.p.inv && (s.weapon === s.primary || s.weapon === s.secondary) ? null : weaponName(s.weapon),
              s.p.money !== null ? `$${s.p.money}` : null,
            ].filter(Boolean).join(" · ")}
          </div>
          {s.hp > 0 && (s.primary || s.secondary || s.nades.length > 0) && (
            <div className="pl-inv">
              {[s.primary, s.secondary].filter(Boolean).map((w) => (
                <span key={w} className={w === s.weapon ? "on" : ""}>{weaponName(w)}</span>
              ))}
              {s.nades.map((n, i) => <i key={i} className="nade" style={{ background: NADE_COLORS[n] }} title={n} />)}
            </div>
          )}
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
            {k.flashed ? "◐ " : ""}{weaponName(k.weapon)}{k.headshot ? " ⌖" : ""}{k.wallbang ? " ⇥" : ""}{k.thrusmoke ? " ☁" : ""}
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
          title={`${k.attacker_name ?? "мир"} → ${k.victim_name} (${weaponName(k.weapon)})`}
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
