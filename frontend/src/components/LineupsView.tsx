// Grenade lineups: every throw of the chosen demos, grouped into lineups (same grenade,
// same spot, same aim, same landing), on the radar and in a table, with export to CSV,
// JSON and a CS2 practice config, and buttons that put the player on the lineup in CS2.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CS2Status, type Lineup, type MatchOverview, type Throw, type Throws } from "../api";
import { download } from "../clipExport";
import { drawCallouts, useCalloutMode } from "../callouts";
import { CalloutToggle } from "./CalloutToggle";
import { drawRadar, levelLabel, levelOf, sideColor, sideShort, useMapAssets, worldToPx, type MapAssets } from "../radar";
import { MatchPicker } from "./MatchPicker";
import { t, td } from "../i18n";
import { ConsoleSetup } from "./ConsoleSetup";

// grenade type and colour; names are nades.<type> (plural) and nade.<type> in the locales
const TYPES: [string, string][] = [
  ["smoke", "#cfd3d6"], ["flashbang", "#ffffff"], ["he", "#ffd23f"], ["molotov", "#ff5a1f"], ["decoy", "#8a949e"],
];
const TYPE_COLOR = Object.fromEntries(TYPES);
const typeName = (type: string) => td(`nade.${type}`, type);
const TECHS = ["stand", "walk", "run", "jump", "run_jump"];
const techName = (tech: string) => td(`tech.${tech}`, tech);
// labels inside CS2 (echo, practice configs) stay English: the game console has no Cyrillic font
const TYPE_EN: Record<string, string> = { smoke: "smoke", flashbang: "flash", he: "HE", molotov: "molotov", decoy: "decoy" };
const TECH_EN: Record<string, string> = { stand: "stand", walk: "walk", run: "run", jump: "jumpthrow", run_jump: "run jumpthrow" };
const SAME_SPOT = 64; // world units between throw positions of one lineup
const SAME_LANDING = 160;
const SAME_YAW = 8; // degrees

interface MatchThrow extends Throw {
  matchId: string;
  matchNo: number;
  playdemo: string | null;
  tickRate: number;
}

interface Group {
  key: string;
  type: string;
  throws: MatchThrow[];
  rep: MatchThrow; // the throw closest to the others
  technique: string | null;
  from: string;
  to: string;
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const yawDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)] ?? 0;
const fmtSec = (s: number) => (s < 0 ? t("lu.freezeSec", { n: Math.round(-s) }) : t("common.sec", { n: Math.round(s) }));

function groupThrows(throws: MatchThrow[]): Group[] {
  const groups: { type: string; throws: MatchThrow[] }[] = [];
  for (const t of throws) {
    if (t.land_x === null || t.land_y === null) continue;
    const g = groups.find((g) => {
      const r = g.throws[0];
      return r.type === t.type && dist(r.x, r.y, t.x, t.y) <= SAME_SPOT && dist(r.land_x!, r.land_y!, t.land_x!, t.land_y!) <= SAME_LANDING &&
        yawDiff(r.yaw, t.yaw) <= SAME_YAW && Math.abs(r.z - t.z) < 40;
    });
    if (g) g.throws.push(t);
    else groups.push({ type: t.type, throws: [t] });
  }
  return groups.map((g, i) => {
    let rep = g.throws[0], best = Infinity;
    for (const a of g.throws) {
      const sum = g.throws.reduce((s, b) => s + dist(a.x, a.y, b.x, b.y) + dist(a.land_x!, a.land_y!, b.land_x!, b.land_y!) / 4, 0);
      if (sum < best) {
        best = sum;
        rep = a;
      }
    }
    const techs = new Map<string, number>();
    g.throws.forEach((t) => t.technique && techs.set(t.technique, (techs.get(t.technique) ?? 0) + 1));
    return {
      key: `${g.type}-${i}`, type: g.type, throws: g.throws, rep,
      technique: [...techs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      from: rep.throw_zone ?? "?", to: rep.land_zone ?? "?",
    };
  }).sort((a, b) => b.throws.length - a.throws.length || a.type.localeCompare(b.type));
}

function lineupOfThrow(t: Throw): Lineup {
  return {
    x: t.x, y: t.y, z: t.z, pitch: t.pitch, yaw: t.yaw, weapon: t.weapon,
    label: `${TYPE_EN[t.type] ?? t.type} ${t.throw_zone ?? "?"} -> ${t.land_zone ?? "?"}${t.technique ? ` (${TECH_EN[t.technique] ?? t.technique})` : ""}`,
  };
}

const lineupOf = (g: Group) => lineupOfThrow(g.rep);

function consoleString(lu: Lineup): string {
  const f = (v: number) => v.toFixed(2);
  return `sv_cheats 1; setpos ${f(lu.x)} ${f(lu.y)} ${f(lu.z)}; setang ${f(lu.pitch)} ${f(lu.yaw)} 0; give ${lu.weapon}; use ${lu.weapon}`;
}

function csv(throws: MatchThrow[]): string {
  const cols: (keyof MatchThrow)[] = [
    "matchId", "round_num", "sec", "name", "team", "side", "type", "technique", "throw_zone", "land_zone",
    "x", "y", "z", "pitch", "yaw", "land_x", "land_y", "land_z", "flight_sec", "speed", "tick", "weapon",
  ];
  const esc = (v: unknown) => (v === null || v === undefined ? "" : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = throws.map((t) => [...cols.map((c) => esc(t[c])), esc(consoleString(lineupOfThrow(t)))].join(","));
  return "\ufeff" + [[...cols, "console"].join(","), ...rows].join("\r\n"); // BOM: Excel reads it as UTF-8
}

function jsonExport(map: string, throws: MatchThrow[]) {
  return {
    map,
    throws: throws.map(({ playdemo: _demo, tickRate: _rate, matchNo: _no, ...t }) => ({ ...t, console: consoleString(lineupOfThrow(t)) })),
  };
}

function drawLineups(canvas: HTMLCanvasElement, assets: MapAssets, groups: Group[], selected: Group | null, size: number, callouts: boolean) {
  const { meta, images } = assets;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = size / 1024;
  meta.levels.forEach((_, li) => {
    const ox = li * size;
    drawRadar(ctx, images[li], ox, size);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(ox, 0, size, size);
    if (callouts) drawCallouts(ctx, meta, li, ox, size);
    const P = (x: number, y: number): [number, number] => {
      const [px, py] = worldToPx(meta, x, y);
      return [ox + px * k, py * k];
    };
    const on = (z: number | null) => meta.levels.length === 1 || levelOf(meta, z) === li;
    for (const g of groups) {
      if (g === selected) continue;
      const t = g.rep;
      if (!on(t.land_z)) continue;
      const [lx, ly] = P(t.land_x!, t.land_y!);
      if (on(t.z)) {
        const [tx, ty] = P(t.x, t.y);
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(lx, ly);
        ctx.stroke();
      }
      ctx.fillStyle = TYPE_COLOR[g.type] ?? "#ccc";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5 + Math.min(5, Math.sqrt(g.throws.length) * 1.3), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (selected) {
      for (const t of selected.throws) {
        if (!on(t.z)) continue;
        const [tx, ty] = P(t.x, t.y);
        const [lx, ly] = P(t.land_x!, t.land_y!);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(lx, ly);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const t = selected.rep;
      const [tx, ty] = P(t.x, t.y);
      const [lx, ly] = P(t.land_x!, t.land_y!);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(lx, ly);
      ctx.stroke();
      // where the thrower stands and looks
      const ang = (-t.yaw * Math.PI) / 180;
      ctx.strokeStyle = sideColor(t.side);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(ang) * 22, ty + Math.sin(ang) * 22);
      ctx.stroke();
      ctx.fillStyle = sideColor(t.side);
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tx, ty, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = TYPE_COLOR[selected.type];
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lx, ly, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (meta.levels.length > 1) {
      ctx.fillStyle = "#fff";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(levelLabel(meta, li), ox + 10, 20);
    }
  });
}

export function LineupsView({ initial, scope }: { initial?: MatchOverview; scope?: { map: string; ids: string[] } }) {
  const [map, setMap] = useState(scope?.map ?? initial?.map ?? "");
  const [ids, setIds] = useState<string[]>(scope?.ids ?? (initial ? [initial.id] : []));
  const [data, setData] = useState<Map<string, Throws>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { assets, error: mapError } = useMapAssets(map || undefined);

  const [types, setTypes] = useState<Record<string, boolean>>({ smoke: true, flashbang: true, he: true, molotov: true, decoy: false });
  const [side, setSide] = useState("");
  const [team, setTeam] = useState("");
  const [player, setPlayer] = useState("");
  const [technique, setTechnique] = useState("");
  const [landZone, setLandZone] = useState("");
  const [minCount, setMinCount] = useState(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [listName, setListName] = useState("");
  const [status, setStatus] = useState<CS2Status | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const missing = ids.filter((id) => !data.has(id));
    if (!missing.length) return;
    Promise.all(missing.map((id) => api.throws(id).then((t) => [id, t] as const)))
      .then((pairs) => setData((cur) => new Map([...cur, ...pairs])))
      .catch((e: Error) => setError(e.message));
  }, [ids, data]);

  // CS2 status: refreshed every few seconds (also shows the progress of an "open in CS2")
  useEffect(() => {
    let alive = true;
    const poll = () => api.cs2().then((s) => alive && setStatus(s)).catch(() => {});
    poll();
    const t = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const all: MatchThrow[] = useMemo(() => ids.flatMap((id, i) => {
    const d = data.get(id);
    return d ? d.throws.map((t) => ({ ...t, matchId: id, matchNo: i + 1, playdemo: d.playdemo, tickRate: d.tick_rate })) : [];
  }), [ids, data]);
  const teams = [...new Set(all.map((t) => t.team).filter((t): t is string => !!t))].sort();
  const players = [...new Set(all.filter((t) => !team || t.team === team).map((t) => t.name))].sort((a, b) => a.localeCompare(b));
  const zones = [...new Set(all.map((t) => t.land_zone).filter((z): z is string => !!z))].sort();

  const filtered = useMemo(() => all.filter((t) =>
    types[t.type] && (!side || t.side === side) && (!team || t.team === team) && (!player || t.name === player) &&
    (!technique || t.technique === technique) && (!landZone || t.land_zone === landZone)),
  [all, types, side, team, player, technique, landZone]);
  const groups = useMemo(() => groupThrows(filtered).filter((g) => g.throws.length >= minCount), [filtered, minCount]);
  const selected = groups.find((g) => g.key === selectedKey) ?? null;

  const n = assets?.meta.levels.length ?? 1;
  const size = Math.min(720, Math.floor((window.innerWidth - 480) / n));
  const callouts = useCalloutMode();
  useEffect(() => {
    if (canvasRef.current && assets) drawLineups(canvasRef.current, assets, groups, selected, size, callouts !== "off");
  }, [assets, groups, selected, size, callouts]);

  const pickAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!assets) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const li = Math.floor(x / size);
    const k = size / 1024;
    let best: Group | null = null, bestD = 14;
    for (const g of groups) {
      for (const [wx, wy, wz] of [[g.rep.land_x!, g.rep.land_y!, g.rep.land_z], [g.rep.x, g.rep.y, g.rep.z]] as [number, number, number | null][]) {
        if (assets.meta.levels.length > 1 && levelOf(assets.meta, wz) !== li) continue;
        const [px, py] = worldToPx(assets.meta, wx, wy);
        const d = Math.hypot(li * size + px * k - x, py * k - y);
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
    }
    setSelectedKey(best?.key ?? null);
  };

  const cs2 = async (p: Promise<{ mode: string; steam_url: string | null }>, what: string) => {
    setError(null);
    try {
      const r = await p;
      if (r.mode === "launch" && r.steam_url) {
        window.location.href = r.steam_url; // Steam asks to confirm the launch options
        setNote(t("lu.viaSteam", { what }));
      } else setNote(t("lu.sent", { what }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => setNote(t("lu.copied", { what }))).catch(() => setNote(text));

  const exportName = listName.trim() || `${map.replace(/^de_/, "")}_${player || team || "all"}`;
  const listCfg = async (install: boolean) => {
    try {
      const r = await api.cs2List(map, exportName, groups.map(lineupOf), install);
      if (install) setNote(t("lu.installed", { path: r.path, exec: r.exec }));
      else download(new Blob([r.text], { type: "text/plain" }), r.file);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const mapError2 = mapError && map ? mapError : null;
  return (
    <div className="lineups">
      <div className="clip-side">
        <h3>{t("common.demos")}</h3>
        <MatchPicker map={map} setMap={(m) => { setMap(m); setSelectedKey(null); }} ids={ids} setIds={setIds} onError={setError} />

        <h3>{t("lu.filters")}</h3>
        <div className="row small">
          {TYPES.map(([k, color]) => (
            <label key={k} style={{ color }}>
              <input type="checkbox" checked={types[k]} onChange={(e) => setTypes({ ...types, [k]: e.target.checked })} /> {td(`nades.${k}`, k)}
            </label>
          ))}
        </div>
        <div className="row small">
          <select value={side} onChange={(e) => setSide(e.target.value)}>
            <option value="">{t("common.bothSides")}</option>
            <option value="terrorist">T</option>
            <option value="counter-terrorist">CT</option>
          </select>
          <select value={team} onChange={(e) => { setTeam(e.target.value); setPlayer(""); }}>
            <option value="">{t("common.allTeams")}</option>
            {teams.map((tm) => <option key={tm}>{tm}</option>)}
          </select>
          <select value={player} onChange={(e) => setPlayer(e.target.value)}>
            <option value="">{t("common.allPlayers")}</option>
            {players.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={technique} onChange={(e) => setTechnique(e.target.value)}>
            <option value="">{t("lu.anyTechnique")}</option>
            {TECHS.map((k) => <option key={k} value={k}>{techName(k)}</option>)}
          </select>
          <select value={landZone} onChange={(e) => setLandZone(e.target.value)}>
            <option value="">{t("lu.anywhere")}</option>
            {zones.map((z) => <option key={z}>{z}</option>)}
          </select>
          <label>
            {t("lu.atLeast")} <input type="number" min={1} max={20} value={minCount} onChange={(e) => setMinCount(Math.max(1, Number(e.target.value)))} /> {t("lu.throwsWord")}
          </label>
        </div>
        <div className="muted small">{t("lu.counts", { n: filtered.length, g: groups.length })}</div>

        <h3>{t("lu.export")}</h3>
        <div className="row small">
          <input placeholder={t("lu.listName", { name: exportName })} value={listName} onChange={(e) => setListName(e.target.value)} />
        </div>
        <div className="row small">
          <button onClick={() => download(new Blob([csv(filtered)], { type: "text/csv" }), `${exportName}_throws.csv`)} disabled={!filtered.length}>CSV</button>
          <button onClick={() => download(new Blob([JSON.stringify(jsonExport(map, filtered), null, 1)], { type: "application/json" }), `${exportName}_throws.json`)} disabled={!filtered.length}>JSON</button>
          <button onClick={() => listCfg(false)} disabled={!groups.length} title={t("lu.cfgTitle")}>.cfg</button>
          <button onClick={() => listCfg(true)} disabled={!groups.length || !status?.cfg_dir}>{t("lu.install")}</button>
          <button onClick={() => cs2(api.cs2RunList(map, exportName), t("lu.listWhat", { name: exportName }))} disabled={!groups.length || !status?.cfg_dir} title={t("lu.runListTitle")}>{t("lu.runList")}</button>
        </div>
        <div className="muted small">{t("lu.exportHint")}</div>

        <CS2Panel status={status} show={showSettings} setShow={setShowSettings} onStatus={setStatus} onError={setError} />
        {note && <div className="small ok-text">{note}</div>}
        {error && <div className="error small">{error}</div>}
      </div>

      <div className="clip-main">
        {mapError2 ? <div className="error">{mapError2}</div> : !ids.length ? (
          <div className="muted">{t("common.pickDemos")}</div>
        ) : !assets ? <div className="muted">{t("common.loading")}</div> : (
          <>
            <CalloutToggle meta={assets.meta} />
            <canvas
              ref={canvasRef}
              width={size * n * (window.devicePixelRatio || 1)}
              height={size * (window.devicePixelRatio || 1)}
              style={{ width: size * n, height: size, borderRadius: 6, cursor: "pointer" }}
              onClick={pickAt}
            />
          </>
        )}
        {selected && (
          <div className="lineup-card">
            <div className="lc-head">
              <b style={{ color: TYPE_COLOR[selected.type] }}>{typeName(selected.type)}</b> {selected.from} → {selected.to}
              <span className="muted"> · {t("lu.throws", { n: selected.throws.length })}
                {selected.technique ? ` · ${techName(selected.technique)}` : ""} · {sideShort(selected.rep.side)}
                {" · "}{t("lu.afterFreeze", { t: fmtSec(median(selected.throws.map((th) => th.sec))) })}</span>
            </div>
            <div className="row small">
              <button className="primary" onClick={() => cs2(api.cs2Open(map, lineupOf(selected)), t("lu.lineupWhat"))}>{t("lu.open")}</button>
              <button onClick={() => copy(consoleString(lineupOf(selected)), t("lu.lineupCmd"))}>{t("lu.copy")}</button>
              <code className="console">{consoleString(lineupOf(selected))}</code>
            </div>
            <table className="lc-throws">
              <tbody>
                {selected.throws.map((th) => (
                  <tr key={`${th.matchId}-${th.id}`}>
                    <td>{ids.length > 1 ? `M${th.matchNo} ` : ""}R{th.round_num}</td>
                    <td>{fmtSec(th.sec)}</td>
                    <td style={{ color: sideColor(th.side) }}>{th.name}</td>
                    <td className="muted">{th.technique ? techName(th.technique) : ""}</td>
                    <td className="muted">{th.flight_sec !== null ? t("lu.flight", { n: th.flight_sec.toFixed(1) }) : ""}</td>
                    <td>
                      <button className="link small" disabled={!th.playdemo} title={th.playdemo ? t("lu.demoTitle") : t("lu.demoOutside")}
                        onClick={() => cs2(api.cs2Demo(th.matchId, Math.round(th.tick - 5 * th.tickRate), th.name), t("lu.demoWhat", { round: th.round_num }))}>
                        {t("lu.demoBtn")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table>
            <thead>
              <tr><th>{t("lu.th.nade")}</th><th>{t("lu.th.from")}</th><th>{t("lu.th.to")}</th><th>{t("lu.th.count")}</th><th>{t("lu.th.tech")}</th><th>{t("lu.th.when")}</th><th>{t("lu.th.who")}</th><th /></tr>
            </thead>
            <tbody>
              {groups.slice(0, 300).map((g) => (
                <tr key={g.key} className={`clickable ${g === selected ? "sel" : ""}`} onClick={() => setSelectedKey(g.key)}>
                  <td style={{ color: TYPE_COLOR[g.type] }}>{typeName(g.type)}</td>
                  <td>{g.from}</td>
                  <td>{g.to}</td>
                  <td className="num">{g.throws.length}</td>
                  <td className="muted">{g.technique ? techName(g.technique) : ""}</td>
                  <td className="muted">{fmtSec(median(g.throws.map((th) => th.sec)))}</td>
                  <td className="muted">{[...new Set(g.throws.map((th) => th.name))].slice(0, 3).join(", ")}</td>
                  <td>
                    <button className="link small" title={t("lu.openTitle")} onClick={(e) => { e.stopPropagation(); cs2(api.cs2Open(map, lineupOf(g)), t("lu.lineupWhat")); }}>▶ CS2</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CS2Panel({ status, show, setShow, onStatus, onError }: {
  status: CS2Status | null; show: boolean; setShow: (v: boolean) => void; onStatus: (s: CS2Status) => void; onError: (m: string) => void;
}) {
  const [dir, setDir] = useState("");
  const [port, setPort] = useState("");
  if (!status) return null;
  const st = status.state;
  return (
    <div className="cs2-panel small">
      <h3>CS2</h3>
      <div>{status.game_dir ? <>{t("cs2.gameDir")} <span className="muted">{status.game_dir}</span></> : <span className="warn">{t("cs2.noDir")}</span>}</div>
      <div>
        {t("cs2.netcon", { port: status.port })}{" "}
        {status.connected ? <span className="ok-text">{t("cs2.connected")}</span> : <span className="muted">{t("cs2.notConnected")}</span>}
      </div>
      {!status.connected && (
        <ConsoleSetup bindCommand={status.bind_command} running={status.running} onLinked={() => api.cs2().then(onStatus)} />
      )}
      {st.phase !== "idle" && (
        <div className={st.phase === "error" ? "error" : st.phase === "done" ? "ok-text" : "warn"}>{td(`cs2.msg.${st.key}`, st.message, st.params)}</div>
      )}
      <button className="link small" onClick={() => setShow(!show)}>{show ? t("cs2.hide") : t("cs2.howto")}</button>
      {show && (
        <div>
          <p className="muted">
            {t("cs2.help1")} <code>-netconport {status.port}</code> {t("cs2.help2")}
          </p>
          <div className="row">
            <input placeholder={status.game_dir ?? "...\\Counter-Strike Global Offensive\\game\\csgo"} value={dir} onChange={(e) => setDir(e.target.value)} />
            <input type="number" placeholder={String(status.port)} value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 80 }} />
            <button onClick={() => api.cs2Settings(dir || null, port ? Number(port) : null).then(onStatus).catch((e: Error) => onError(e.message))}>{t("common.save")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
