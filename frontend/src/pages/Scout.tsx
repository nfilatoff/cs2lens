import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MovementFilter, type MultiroundPlayer, type RoundRef, type Row, type ScoutQuery, type ScoutReport, type ScoutTeam, type SimilarRound, type Strat, type Teams } from "../api";
import { go, hashQuery } from "../App";
import { drawCallouts, useCalloutMode } from "../callouts";
import { CalloutToggle } from "../components/CalloutToggle";
import { ClipView } from "../components/ClipView";
import { DataTable } from "../components/DataTable";
import { buyLabel, cardText, InsightCards, nadeLabel, namedRows, RoundLinks, stratCore, tempoLabel } from "../components/InsightCards";
import { LineupsView } from "../components/LineupsView";
import { HeatmapPanel, type HeatSource } from "../components/MapsView";
import { mapPretty } from "../components/MatchPicker";
import { SampleBadge } from "../components/SampleBadge";
import { drawRadar, levelOf, sideColor, sideShort, useMapAssets, worldToPx, type MapAssets } from "../radar";
import { t, type Key } from "../i18n";
import { dossierMarkdown, download } from "../scoutExport";

const TABS: [string, Key][] = [
  ["summary", "scout.tab.summary"],
  ["timings", "scout.tab.timings"],
  ["playbook", "scout.tab.playbook"],
  ["heatmap", "scout.tab.heatmap"],
  ["economy", "scout.tab.economy"],
  ["players", "scout.tab.players"],
  ["nades", "scout.tab.nades"],
  ["clips", "scout.tab.clips"],
];

const LAST_OPTIONS = [3, 5, 10, 20, 0];
const BUYS = ["pistol", "eco", "force", "full"];
const NADE_COLORS: Record<string, string> = { smoke: "#d9d9d9", flash: "#fff35c", he: "#ff5c5c", molotov: "#ff9f1c" };
const DEFAULT_LAST = 10;
// ready-made selections: the last N rounds of a type
const PRESETS: [string, number][] = [["pistol", 10], ["full", 10], ["force", 10], ["eco", 10]];

interface Filters {
  last: number;
  side: string;
  buy: string;
  rounds: number;
}

function readFilters(): Filters {
  const q = hashQuery();
  const num = (name: string, fallback: number) => {
    const v = Number(q.get(name));
    return q.has(name) && Number.isFinite(v) ? v : fallback;
  };
  return { last: num("last", DEFAULT_LAST), side: q.get("side") ?? "", buy: q.get("buy") ?? "", rounds: num("rounds", 0) };
}

/** Everything of the report's context is in the route, so a link shows a teammate the same thing. */
function scoutHash(team: string, map: string, tab: string, f: Filters): string {
  const q = new URLSearchParams();
  if (f.last !== DEFAULT_LAST) q.set("last", String(f.last));
  if (f.side) q.set("side", f.side);
  if (f.buy) q.set("buy", f.buy);
  if (f.rounds) q.set("rounds", String(f.rounds));
  const qs = q.toString();
  return `#/scout/${encodeURIComponent(team)}/${encodeURIComponent(map)}/${tab}${qs ? `?${qs}` : ""}`;
}

const mostPlayedMap = (team: ScoutTeam) => Object.entries(team.maps).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

export function ScoutPage({ team, map, tab, onOwn }: { team?: string; map?: string; tab: string; onOwn: (own: string | null) => void }) {
  const [teams, setTeams] = useState<Teams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reloadTeams = () => api.teams().then((d) => {
    setTeams(d);
    onOwn(d.own);
  }).catch((e: Error) => setError(e.message));
  useEffect(() => {
    reloadTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="page error">{error}</div>;
  if (!teams) return <div className="page">{t("common.loading")}</div>;
  if (!team) return <TeamsLanding teams={teams} reload={reloadTeams} />;
  const entry = teams.teams.find((x) => x.name === team);
  if (!entry) return <div className="page"><div className="error">{t("scout.noTeam", { team })}</div><a href="#/scout">{t("scout.allTeams")}</a></div>;
  const activeMap = map ?? mostPlayedMap(entry);
  return <TeamReport key={team} teams={teams} entry={entry} map={activeMap} tab={tab} reload={reloadTeams} />;
}

// ---- start: pick a team, tell the app which names are one team ----

function TeamsLanding({ teams, reload }: { teams: Teams; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="page">
      <div className="pagehead"><h1>{t("scout.title")}</h1><div className="sub">{t("scout.sub")}</div></div>
      {teams.suggestions.length > 0 && <Suggestions teams={teams} reload={reload} />}
      {teams.teams.length === 0 ? (
        <div className="muted">{t("scout.noTeams")}</div>
      ) : (
        <div className="team-grid">
          {teams.teams.map((x) => (
            <a key={x.name} className="team-card" href={`#/scout/${encodeURIComponent(x.name)}`}>
              <b>{x.name === teams.own ? "★ " : ""}{x.name}</b>
              <span>{t("scout.matchesCount", { n: x.matches })} · {Object.entries(x.maps).map(([m, n]) => `${mapPretty(m)} ${n}`).join(", ")}</span>
            </a>
          ))}
        </div>
      )}
      <div className="row">
        <button onClick={() => setEditing(!editing)}>{t("scout.manageNames")}</button>
        <span className="grow" />
        <span className="muted small">{t("scout.oldPages")}</span>
        <a className="small" href="#/aggregate">{t("nav.matches")}</a>
        <a className="small" href="#/clip">{t("nav.clips")}</a>
        <a className="small" href="#/lineups">{t("nav.lineups")}</a>
      </div>
      {editing && <AliasEditor teams={teams} reload={reload} />}
    </div>
  );
}

function Suggestions({ teams, reload }: { teams: Teams; reload: () => void }) {
  return (
    <div className="warn">
      <b>{t("scout.suggestTitle")}</b>
      {teams.suggestions.map((s) => (
        <div key={`${s.a}|${s.b}`} className="row">
          {t("scout.suggestLine", { a: s.a, b: s.b, n: s.common })}
          <button className="small-btn" onClick={() => api.teamAlias(s.b, s.a).then(reload)}>{t("scout.merge")}</button>
        </div>
      ))}
    </div>
  );
}

function AliasEditor({ teams, reload }: { teams: Teams; reload: () => void }) {
  const raws = teams.teams.flatMap((x) => x.raw.map((raw) => ({ raw, name: x.name })));
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <div>
      <h3>{t("scout.namesTitle")}</h3>
      <div className="muted small">{t("scout.namesHint")}</div>
      <datalist id="team-names">{teams.teams.map((x) => <option key={x.name} value={x.name} />)}</datalist>
      {raws.map(({ raw, name }) => (
        <div key={raw} className="alias-row">
          <code>{raw}</code>→
          <input list="team-names" value={draft[raw] ?? (name === raw ? "" : name)} placeholder={raw}
            onChange={(e) => setDraft({ ...draft, [raw]: e.target.value })} />
          <button className="small-btn" disabled={draft[raw] === undefined}
            onClick={() => api.teamAlias(raw, draft[raw] || null).then(() => {
              setDraft(({ [raw]: _saved, ...rest }) => rest);
              reload();
            })}>
            {t("common.save")}
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- the report ----

function TeamReport({ teams, entry, map, tab, reload }: { teams: Teams; entry: ScoutTeam; map: string; tab: string; reload: () => void }) {
  const f = readFilters();
  const query: ScoutQuery = useMemo(
    () => ({ team: entry.name, map, last: f.last, side: f.side, buy: f.buy, rounds_last: f.rounds }),
    [entry.name, map, f.last, f.side, f.buy, f.rounds],
  );
  const [report, setReport] = useState<ScoutReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    api.scoutReport(query).then((r) => alive && setReport(r)).catch((e: Error) => {
      if (!alive) return;
      setReport(null);
      setError(e.message);
    });
    return () => {
      alive = false;
    };
  }, [query]);
  const nav = (patch: Partial<Filters>) => {
    window.location.hash = scoutHash(entry.name, map, tab, { ...f, ...patch });
  };
  const toggleOwn = () => api.teamOwn(teams.own === entry.name ? null : entry.name).then(reload);

  return (
    <div className="page">
      <div className="ctxbar">
        <select value={entry.name} aria-label={t("scout.team")} onChange={(e) => go("scout", e.target.value)}>
          {teams.teams.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        <button className={`star ${teams.own === entry.name ? "on" : ""}`} title={t("scout.ownTitle")} aria-label={t("scout.ownTitle")} onClick={toggleOwn}>★</button>
        <select value={map} aria-label={t("scout.map")} onChange={(e) => { window.location.hash = scoutHash(entry.name, e.target.value, tab, f); }}>
          {Object.entries(entry.maps).map(([m, n]) => <option key={m} value={m}>{mapPretty(m)} ({n})</option>)}
        </select>
        <select value={f.last} aria-label={t("scout.last")} onChange={(e) => nav({ last: Number(e.target.value) })}>
          {LAST_OPTIONS.map((n) => <option key={n} value={n}>{n ? t("scout.lastN", { n }) : t("scout.lastAll")}</option>)}
        </select>
        <span className="seg">
          {[["", t("common.both")], ["terrorist", "T"], ["counter-terrorist", "CT"]].map(([v, label]) => (
            <button key={v} className={f.side === v ? "on" : ""} onClick={() => nav({ side: v })}>{label}</button>
          ))}
        </span>
        <span className="seg">
          {["", ...BUYS].map((b) => (
            <button key={b} className={f.buy === b && !f.rounds ? "on" : ""} onClick={() => nav({ buy: b, rounds: 0 })}>{b ? buyLabel(b) : t("scout.allRounds")}</button>
          ))}
        </span>
        <span className="grow" />
        <button className="small-btn screen-only" disabled={!report} title={t("scout.exportMdTitle")}
          onClick={() => report && download(`${entry.name}-${map}.md`, dossierMarkdown(report, query))}>MD</button>
        <button className="small-btn screen-only" disabled={!report} title={t("scout.exportPdfTitle")} onClick={() => window.print()}>PDF</button>
        <a className="small screen-only" href="#/scout">{t("scout.allTeams")}</a>
        <div className="ctx-presets" style={{ flexBasis: "100%" }}>
          <span className="muted small">{t("scout.routines")}</span>
          {PRESETS.map(([buy, n]) => {
            const on = f.buy === buy && f.rounds === n;
            return <button key={buy} className={on ? "on" : ""} onClick={() => nav(on ? { buy: "", rounds: 0 } : { buy, rounds: n, last: 0 })}>{t("scout.preset", { n, buy: buyLabel(buy) })}</button>;
          })}
        </div>
      </div>
      <div className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} href={scoutHash(entry.name, map, key, f)} className={tab === key ? "active" : ""}>{t(label)}</a>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {!report && !error && <div>{t("common.loading")}</div>}
      {report && (
        <>
          <SampleLine report={report} />
          {report.warnings.map((w) => <div key={w} className="warn">{w}</div>)}
          <div className="screen-only">
            {tab === "summary" && <Summary report={report} />}
            {tab === "timings" && <Timings report={report} side={f.side} />}
            {tab === "playbook" && <Playbook report={report} map={map} team={entry.name} />}
            {tab === "heatmap" && <ScoutHeat report={report} query={query} />}
            {tab === "economy" && <Economy report={report} />}
            {tab === "players" && <Players report={report} map={map} />}
            {tab === "nades" && <Nades report={report} map={map} />}
            {tab === "clips" && <ClipView key={report.matches.map((m) => m.id).join()} scope={{ map, ids: report.matches.map((m) => m.id), side: f.side, buy: f.buy }} />}
          </div>
          <PrintDossier report={report} query={query} />
        </>
      )}
    </div>
  );
}

function SampleLine({ report }: { report: ScoutReport }) {
  const s = report.sample;
  return (
    <div className="sample-line">
      <span><b>{s.matches}</b> {t("scout.matchesWord", { n: s.matches })}</span>
      <span><b>{s.rounds}</b> {t("scout.roundsWord", { n: s.rounds })} ({s.t_rounds} T · {s.ct_rounds} CT)</span>
      {s.win_pct !== null && <span><b>{s.win_pct}%</b> {t("scout.winsWord")}</span>}
      {s.low && <span className="sample-low">{t("scout.lowData")}</span>}
    </div>
  );
}

function Summary({ report }: { report: ScoutReport }) {
  return (
    <div>
      {report.rounds.length === 0 ? <div className="muted">{t("scout.noRounds")}</div> : <InsightCards cards={report.cards} />}
      {report.more_cards.length > 0 && (
        <details className="data-more">
          <summary>{t("scout.moreConclusions")}</summary>
          <InsightCards cards={report.more_cards} />
        </details>
      )}
      <details className="data-more">
        <summary>{t("scout.showData")}</summary>
        <div className="grid2">
          <DataTable title={t("scout.executesByBuy")} rows={namedRows(report.executes_by_buy)} columns={["buy", "target_site", "rounds", "share_pct", "win_pct", "plants", "avg_exec_sec", "avg_plant_sec", "early", "mid", "late"]} />
          <DataTable title={t("scout.setups")} rows={report.setups} columns={["setup", "rounds", "share_pct", "win_pct"]} maxHeight={320} />
        </div>
      </details>
    </div>
  );
}

// ---- timings: zone x second ----

const heatColor = (share: number) => `rgba(255, 85, 0, ${(0.14 + 0.86 * Math.min(share, 1)).toFixed(3)})`;

function Timings({ report, side }: { report: ScoutReport; side: string }) {
  const { step, max, cells, totals } = report.timings;
  const [viewSide, setViewSide] = useState(side || (report.sample.t_rounds ? "terrorist" : "counter-terrorist"));
  const [kind, setKind] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<{ zone: string; bin: number } | null>(null);
  useEffect(() => {
    if (side) setViewSide(side);
  }, [side]);

  const shown = useMemo(() => cells.filter((c) => c.side === viewSide && (kind === "all" ? c.kind !== "enter" : c.kind === kind)), [cells, viewSide, kind]);
  // grenades of several types in a cell: rounds are counted per type, so the sum is "events" and the color caps at the side's rounds
  const merged = useMemo(() => {
    const grid = new Map<string, { zone: string; bin: number; rounds: number; examples: RoundRef[] }>();
    for (const c of shown) {
      const key = `${c.zone}|${c.bin}`;
      const e = grid.get(key) ?? { zone: c.zone, bin: c.bin, rounds: 0, examples: [] as RoundRef[] };
      e.rounds += c.rounds;
      e.examples.push(...c.examples);
      grid.set(key, e);
    }
    return grid;
  }, [shown]);
  const zones = useMemo(() => {
    const byZone = new Map<string, { total: number; timeSum: number }>();
    for (const c of merged.values()) {
      const e = byZone.get(c.zone) ?? { total: 0, timeSum: 0 };
      e.total += c.rounds;
      e.timeSum += c.bin * c.rounds;
      byZone.set(c.zone, e);
    }
    return [...byZone.entries()].map(([zone, v]) => ({ zone, ...v, avg: v.timeSum / v.total }));
  }, [merged]);
  const ranked = useMemo(() => [...zones].sort((a, b) => b.total - a.total), [zones]);
  const visible = useMemo(() => (showAll ? ranked : ranked.slice(0, 14)).sort((a, b) => a.avg - b.avg), [ranked, showAll]);
  const bins = useMemo(() => Array.from({ length: Math.ceil(max / step) }, (_, i) => i * step), [max, step]);
  const total = totals[viewSide] ?? 0;
  const sel = picked && merged.get(`${picked.zone}|${picked.bin}`);
  const top = ranked[0];

  return (
    <div>
      {top && (
        <div className="conclusion">
          {kind === "enter" ? t("scout.timingEnterTop", { zone: top.zone, sec: Math.round(top.avg) }) : t("scout.timingNadeTop", { zone: top.zone, sec: Math.round(top.avg), n: top.total })}
        </div>
      )}
      <div className="filters">
        <span className="seg">
          {["terrorist", "counter-terrorist"].map((s) => <button key={s} className={viewSide === s ? "on" : ""} onClick={() => setViewSide(s)}>{sideShort(s)}</button>)}
        </span>
        <span className="seg">
          {["all", "smoke", "flash", "molotov", "he", "enter"].map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "all" ? t("scout.allNades") : k === "enter" ? t("scout.entries") : nadeLabel(k)}
            </button>
          ))}
        </span>
        <SampleBadge rounds={total} />
      </div>
      {cells.length === 0 ? <div className="muted">{t("scout.noZones")}</div> : (
        <>
          <div className="timing-wrap">
            <table className="timing">
              <thead>
                <tr>
                  <th className="zone">{t("scout.zoneSec")}</th>
                  {bins.map((b) => <th key={b}>{b}</th>)}
                </tr>
              </thead>
              <tbody>
                {visible.map(({ zone }) => (
                  <tr key={zone}>
                    <td className="zone">{zone}</td>
                    {bins.map((b) => {
                      const c = merged.get(`${zone}|${b}`);
                      if (!c) return <td key={b}><span className="tcell empty" /></td>;
                      const isSel = picked?.zone === zone && picked.bin === b;
                      return (
                        <td key={b}>
                          <button className={`tcell ${isSel ? "sel" : ""}`} style={{ background: heatColor(c.rounds / Math.max(total * 0.4, 1)), color: "#fff" }}
                            title={t("scout.timingCell", { zone, from: b, to: b + step, n: c.rounds })}
                            onClick={() => setPicked(isSel ? null : { zone, bin: b })}>
                            {c.rounds}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ranked.length > 14 && <button className="link small" onClick={() => setShowAll(!showAll)}>{showAll ? t("scout.showFewer") : t("scout.showAllZones", { n: ranked.length })}</button>}
          {sel && (
            <div className="row small">
              <b>{t("scout.timingCell", { zone: sel.zone, from: sel.bin, to: sel.bin + step, n: sel.rounds })}</b>
              <RoundLinks rounds={dedupe(sel.examples).slice(0, 12)} />
            </div>
          )}
          <div className="muted small">{t("scout.timingHint")}</div>
        </>
      )}
    </div>
  );
}

const dedupe = (rounds: RoundRef[]) => [...new Map(rounds.map((r) => [`${r.match}:${r.round}`, r])).values()];

// ---- playbook ----

function drawSpots(canvas: HTMLCanvasElement, assets: MapAssets, size: number, spots: { x: number; y: number; z: number; color: string; r?: number }[], callouts = false) {
  const { meta, images } = assets;
  const n = meta.levels.length;
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = size / 1024;
  meta.levels.forEach((_, li) => {
    const ox = li * size;
    drawRadar(ctx, images[li], ox, size);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(ox, 0, size, size);
    if (callouts) drawCallouts(ctx, meta, li, ox, size);
    for (const s of spots) {
      if (n > 1 && levelOf(meta, s.z) !== li) continue;
      const [px, py] = worldToPx(meta, s.x, s.y);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(ox + px * k, py * k, s.r ?? 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function StratCard({ st, assets }: { st: Strat; assets: MapAssets | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levels = assets?.meta.levels.length ?? 1;
  const size = levels > 1 ? 110 : 180;
  useEffect(() => {
    if (ref.current && assets) drawSpots(ref.current, assets, size, st.spots.map((s) => ({ ...s, color: NADE_COLORS[s.type] ?? "#ccc", r: 2.6 })));
  }, [assets, st, size]);
  const dpr = window.devicePixelRatio || 1;
  return (
    <div className="strat">
      <canvas ref={ref} width={size * levels * dpr} height={size * dpr} style={{ width: size * levels, height: size }} />
      <div className="strat-body">
        <div className="strat-head">{t("scout.stratTitle", { id: st.id, site: st.site })}</div>
        <div className="small">{t("scout.stratLine", { n: st.rounds, share: st.share_pct, win: st.win_pct })}</div>
        {st.core.length ? (
          <ul>
            {st.core.map((c) => (
              <li key={`${c.type}:${c.zone}`}><span className="nade-dot" style={{ background: NADE_COLORS[c.type] ?? "#ccc" }} />{nadeLabel(c.type)} {c.zone} <span className="muted">{c.share_pct}%</span></li>
            ))}
          </ul>
        ) : <div className="muted small">{t("scout.noSmokes")}</div>}
        <div className="muted small">
          {Object.entries(st.tempo).map(([k, n]) => `${tempoLabel(k)} ${n}`).join(" · ")}
          {st.median_exec_sec !== null && ` · ${t("scout.medianExec", { sec: st.median_exec_sec })}`}
          {st.median_plant_sec !== null && ` · ${t("scout.medianPlant", { sec: st.median_plant_sec })}`}
        </div>
        <div className="muted small">{t("scout.stratEnds", { plants: st.plants, n: st.rounds, sites: st.plant_sites.join(", ") || "–", buys: st.buys.map(buyLabel).join(", ") })}</div>
        <div className="insight-foot"><RoundLinks rounds={st.examples} /></div>
      </div>
    </div>
  );
}

function Playbook({ report, map, team }: { report: ScoutReport; map: string; team: string }) {
  const { assets } = useMapAssets(map);
  const { strats, total, one_offs } = report.playbook;
  const covered = strats.reduce((a, s) => a + s.rounds, 0);
  return (
    <div>
      {strats[0] ? (
        <div className="conclusion">{t("scout.playbookTop", { n: strats.length, covered, total, site: strats[0].site, core: stratCore(strats[0].core.slice(0, 3)) || t("scout.noSmokes") })}</div>
      ) : <div className="muted">{t("scout.noStrats")}</div>}
      <div className="strats">{strats.map((s) => <StratCard key={s.id} st={s} assets={assets} />)}</div>
      {one_offs > 0 && <div className="muted small">{t("scout.oneOffs", { n: one_offs })}</div>}
      <RoundsBrowser report={report} map={map} team={team} />
    </div>
  );
}

function RoundsBrowser({ report, map, team }: { report: ScoutReport; map: string; team: string }) {
  const [similar, setSimilar] = useState<{ of: Row; rows: SimilarRound[] } | null>(null);
  const matchNo = useMemo(() => new Map(report.matches.map((m, i) => [m.id, i + 1])), [report.matches]);
  const [error, setError] = useState<string | null>(null);
  const find = (r: Row) => {
    setError(null);
    api.scoutSimilar(team, map, String(r.match), Number(r.round_num)).then((rows) => setSimilar({ of: r, rows })).catch((e: Error) => setError(e.message));
  };
  return (
    <details className="data-more">
      <summary>{t("scout.allRoundsList", { n: report.rounds.length })}</summary>
      <div className="muted small">{t("scout.similarHint")}</div>
      {error && <div className="error">{error}</div>}
      {similar && (
        <div className="similar-list">
          <h3>{t("scout.similarTitle", { round: Number(similar.of.round_num) })}</h3>
          <div className="row small">
            <RoundLinks rounds={[{ match: String(similar.of.match), round: Number(similar.of.round_num), sec: 0 }]} />
          </div>
          <DataTable
            rows={namedRows(similar.rows.map((s) => ({ ...s, score: Math.round(s.score * 100) } as unknown as Row)))}
            columns={["score", "team", "round", "buy", "target_site", "tempo", "package", "setup", "won"]}
            onRowClick={(s) => go("match", String(s.match), "replay", Number(s.round), Number(s.sec))}
          />
        </div>
      )}
      <DataTable
        rows={namedRows(report.rounds).map((r) => ({ ...r, match_no: `M${matchNo.get(String(r.match))}` }))}
        columns={["match_no", "round_num", "side", "buy", "opp_buy", "won", "target_site", "plant_site", "exec_sec", "plant_sec", "tempo", "package", "entry", "setup"]}
        maxHeight={420}
        onRowClick={find}
      />
    </details>
  );
}

// ---- heatmap ----

function ScoutHeat({ report, query }: { report: ScoutReport; query: ScoutQuery }) {
  const source = useMemo<HeatSource>(() => ({
    key: JSON.stringify(query),
    map: query.map,
    points: () => api.scoutPoints(query),
    movement: (f: MovementFilter) => api.scoutMovement(query, { player: f.player, t_from: f.t_from, t_to: f.t_to, opp_buy: f.opp_buy, pistol: f.pistol, man: f.man }),
    teams: [query.team],
    players: report.players.map((p) => String(p.name)).sort((a, b) => a.localeCompare(b)),
    maxRound: null,
    fixedTeam: query.team,
    fixedBuy: true,
  }), [query, report.players]);
  return <HeatmapPanel key={source.key} source={source} />;
}

// ---- economy ----

function Economy({ report }: { report: ScoutReport }) {
  const { after_pistol, loss_streak, by_buy } = report.economy;
  const pistol = report.cards.concat(report.more_cards).find((c) => c.key === "after_pistol");
  return (
    <div>
      {pistol && <div className="conclusion">{cardText(pistol)}</div>}
      <div className="grid2">
        <DataTable title={t("scout.afterPistol")} rows={namedRows(after_pistol)} columns={["pistol", "buy", "rounds", "share_pct", "win_pct", "avg_equip"]} />
        <DataTable title={t("scout.lossStreak")} rows={namedRows(loss_streak)} columns={["streak", "buy", "rounds", "share_pct", "win_pct", "avg_equip"]} />
        <DataTable title={t("scout.bySideBuy")} rows={namedRows(by_buy)} columns={["side", "buy", "rounds", "wins", "win_pct", "avg_equip"]} />
        <DataTable title={t("scout.executesByBuy")} rows={namedRows(report.executes_by_buy)} columns={["buy", "target_site", "rounds", "share_pct", "win_pct", "plants", "avg_exec_sec"]} />
      </div>
      <div className="muted small">{t("scout.streakHint")}</div>
    </div>
  );
}

// ---- players ----

function MultiroundView({ players, map }: { players: MultiroundPlayer[]; map: string }) {
  const { assets } = useMapAssets(map);
  const [key, setKey] = useState(players[0] ? `${players[0].steamid}|${players[0].side}` : "");
  const ref = useRef<HTMLCanvasElement>(null);
  const sel = players.find((p) => `${p.steamid}|${p.side}` === key) ?? players[0];
  const levels = assets?.meta.levels.length ?? 1;
  const size = Math.min(480, Math.floor((window.innerWidth - 180) / levels));
  const callouts = useCalloutMode();
  useEffect(() => {
    if (ref.current && assets && sel) drawSpots(ref.current, assets, size, sel.spots.map((s) => ({ ...s, color: sideColor(sel.side), r: 4 })), callouts !== "off");
  }, [assets, sel, size, callouts]);
  if (!sel) return null;
  const dpr = window.devicePixelRatio || 1;
  // a click on a start opens that round
  const open = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!assets) return;
    const box = e.currentTarget.getBoundingClientRect();
    const k = size / 1024, x = e.clientX - box.left, y = e.clientY - box.top, li = Math.floor(x / size);
    let best: MultiroundPlayer["spots"][number] | null = null, bestD = 12 * 12;
    for (const s of sel.spots) {
      if (levels > 1 && levelOf(assets.meta, s.z) !== li) continue;
      const [px, py] = worldToPx(assets.meta, s.x, s.y);
      const d = (li * size + px * k - x) ** 2 + (py * k - y) ** 2;
      if (d < bestD) [best, bestD] = [s, d];
    }
    if (best) go("match", best.match, "replay", best.round, 10);
  };
  return (
    <div>
      <h2>{t("scout.multiround")}</h2>
      <div className="filters">
        <select value={key} onChange={(e) => setKey(e.target.value)}>
          {players.map((p) => <option key={`${p.steamid}|${p.side}`} value={`${p.steamid}|${p.side}`}>{p.name} · {sideShort(p.side)}</option>)}
        </select>
        <SampleBadge rounds={sel.rounds} />
        <CalloutToggle meta={assets?.meta} />
      </div>
      <div className="multi">
        <canvas ref={ref} width={size * levels * dpr} height={size * dpr} style={{ width: size * levels, height: size, cursor: "pointer" }} onClick={open} title={t("maps.clickOpens")} />
        <div className="multi-info">
          <h3>{t("scout.startsIn")}</h3>
          <div className="zone-chips">{sel.zones.slice(0, 10).map((z) => <span key={z.zone}>{z.zone} <b>{Math.round(z.share_pct)}%</b></span>)}</div>
          <h3>{t("scout.neverIn")}</h3>
          {sel.never.length ? <div className="zone-chips">{sel.never.map((z) => <span key={z}>{z}</span>)}</div> : <div className="muted small">{t("scout.neverNone")}</div>}
          <div className="muted small">{t("scout.multiHint")}</div>
        </div>
      </div>
    </div>
  );
}

function Players({ report, map }: { report: ScoutReport; map: string }) {
  const weak = report.cards.concat(report.more_cards).find((c) => c.key === "weak_player");
  const [player, setPlayer] = useState("");
  const weapons = player ? report.weapons.filter((w) => String(w.name) === player) : report.weapons;
  return (
    <div>
      {weak && <div className="conclusion">{cardText(weak)}</div>}
      <DataTable
        rows={report.players}
        columns={["name", "matches", "rounds", "kills", "deaths", "kd", "adr", "kpr", "hs_pct", "opening_kills", "opening_deaths", "opening_win_pct", "trade_kill_pct", "traded_death_pct", "nearest_mate", "top_weapons"]}
        onRowClick={(r) => setPlayer(player === String(r.name) ? "" : String(r.name))}
      />
      <div className="muted small">{t("scout.playersHint")}</div>
      <MultiroundView players={report.multiround} map={map} />
      <details className="data-more" open={!!player}>
        <summary>{player ? t("scout.weaponsOf", { name: player }) : t("scout.weapons")}</summary>
        <DataTable rows={weapons} columns={["name", "weapon", "kills", "share_pct"]} maxHeight={360} />
      </details>
    </div>
  );
}

// ---- grenades ----

function Nades({ report, map }: { report: ScoutReport; map: string }) {
  const rows = namedRows(report.nades);
  const top = report.cards.concat(report.more_cards).find((c) => c.key === "top_nade");
  return (
    <div>
      {top && <div className="conclusion">{cardText(top)}</div>}
      <details className="data-more">
        <summary>{t("scout.showData")}</summary>
        <DataTable rows={rows} columns={["side", "type", "zone", "rounds", "per_round_pct", "median_sec"]} maxHeight={360} />
      </details>
      <h2>{t("scout.nadeLineups")}</h2>
      <LineupsView key={report.matches.map((m) => m.id).join()} scope={{ map, ids: report.matches.map((m) => m.id) }} />
    </div>
  );
}

// ---- what is printed ----

function PrintDossier({ report, query }: { report: ScoutReport; query: ScoutQuery }) {
  return (
    <div className="print-only">
      <h1>{t("scout.exportTitle", { team: report.team, map: mapPretty(query.map) })}</h1>
      <h2>{t("scout.tab.summary")}</h2>
      <InsightCards cards={report.cards.concat(report.more_cards)} />
      {report.playbook.strats.length > 0 && (
        <>
          <h2>{t("scout.tab.playbook")}</h2>
          <ul>
            {report.playbook.strats.map((st) => (
              <li key={st.id}><b>{t("scout.stratTitle", { id: st.id, site: st.site })}</b> {t("scout.stratLine", { n: st.rounds, share: st.share_pct, win: st.win_pct })}: {stratCore(st.core) || t("scout.noSmokes")}</li>
            ))}
          </ul>
        </>
      )}
      <DataTable title={t("scout.executesByBuy")} rows={namedRows(report.executes_by_buy)} columns={["buy", "target_site", "rounds", "share_pct", "win_pct", "plants", "avg_exec_sec"]} />
      <DataTable title={t("scout.afterPistol")} rows={namedRows(report.economy.after_pistol)} columns={["pistol", "buy", "rounds", "share_pct", "win_pct"]} />
      <DataTable title={t("scout.setups")} rows={report.setups.slice(0, 10)} columns={["setup", "rounds", "share_pct", "win_pct"]} />
      <DataTable title={t("scout.tab.players")} rows={report.players} columns={["name", "rounds", "kd", "adr", "opening_win_pct", "trade_kill_pct", "top_weapons"]} />
    </div>
  );
}
