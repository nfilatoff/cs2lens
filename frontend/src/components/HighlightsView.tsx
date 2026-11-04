// Highlights of one match: found automatically (aces, multi-kills, clutches, rare kills) or made by
// hand from a round window, previewed on the radar and downloaded as MP4/GIF, one by one or as a zip.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Highlight, type MatchOverview, type Replay } from "../api";
import { go } from "../App";
import { canEncodeVideo, download, exportGif, exportMp4, zipFiles } from "../clipExport";
import { clockOf } from "../clipSummary";
import {
  drawHighlight, hlDuration, hlSubtitle, hlTextLine, hlTitle, kindLabel, prepareFrame, tagLabel, type HlFrame,
} from "../highlightRender";
import { useMapAssets, type MapAssets } from "../radar";
import { loadReplay } from "../replayDraw";
import { t } from "../i18n";
import { RecordPanel, Recordings } from "./RecordPanel";

const KINDS = ["ace", "4k", "3k", "clutch", "double", "special", "custom"] as const;
const SIZES = [512, 768, 1024];
const SPEEDS = [0.5, 1, 2];

interface ExportOpts {
  format: "mp4" | "gif";
  size: number;
  fps: number;
  speed: number;
  zoom: boolean;
  names: boolean;
}

const fileBase = (match: MatchOverview, h: Highlight, name: string | null) =>
  [match.id, `R${h.round}`, name ?? "", h.kind === "custom" ? h.title || "custom" : h.kind]
    .filter(Boolean).join("_").replace(/[^\p{L}\p{N}_+-]+/gu, "_");

async function renderClip(assets: MapAssets, f: HlFrame, o: ExportOpts, onProgress: (p: number) => void, signal: AbortSignal) {
  const job = {
    width: f.width, height: f.height, duration: hlDuration(f.h), speed: o.speed, fps: o.fps,
    render: (ctx: CanvasRenderingContext2D, time: number) => drawHighlight(ctx, assets, f, time),
    onProgress, signal,
  };
  return o.format === "gif" ? exportGif(job) : exportMp4(job);
}

export function HighlightsView({ match, round, at }: { match: MatchOverview; round?: number; at?: number }) {
  const { assets, error: mapError } = useMapAssets(match.map);
  const [data, setData] = useState<{ auto: Highlight[]; custom: Highlight[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [team, setTeam] = useState("");
  const [player, setPlayer] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const rounds = match.timeline.map((r) => r.round);
  const [form, setForm] = useState(() => ({
    round: round ?? rounds[0] ?? 1,
    from: at !== undefined ? Math.max(-15, at - 4) : 0,
    to: at !== undefined ? at + 5 : 15,
    steamid: "",
    title: "",
  }));
  const formRef = useRef<HTMLDivElement>(null);

  const [opts, setOpts] = useState<ExportOpts>({
    format: canEncodeVideo() ? "mp4" : "gif", size: canEncodeVideo() ? 768 : 512, fps: canEncodeVideo() ? 30 : 15, speed: 1, zoom: true, names: true,
  });
  const [exporting, setExporting] = useState<{ i: number; n: number; progress: number; abort: AbortController } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(0); // bumped when a recording session ends
  const [created, setCreated] = useState<string | null>(null); // title of the highlight just saved

  useEffect(() => {
    api.highlights(match.id).then(setData).catch((e: Error) => setError(e.message));
  }, [match.id]);
  useEffect(() => {
    if (round !== undefined) formRef.current?.scrollIntoView({ block: "center" });
  }, [round]);

  const all = useMemo(() => (data ? [...data.custom].reverse().concat(data.auto) : []), [data]);
  const players = useMemo(() => match.players.map((p) => ({ steamid: String(p.steamid), name: String(p.name), team: String(p.team ?? "") }))
    .sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)), [match.players]);
  const teamOf = (h: Highlight) => h.team ?? players.find((p) => p.steamid === h.steamid)?.team ?? null;
  const list = all.filter((h) =>
    (!kind || h.kind === kind) && (!team || teamOf(h) === team) && (!player || h.steamid === player));
  const selected = all.find((h) => h.id === selectedId) ?? list[0] ?? null;

  // the form starts from the selected highlight, so editing means adjusting what is on screen;
  // a moment opened from the replay keeps its own values until another highlight is picked
  const fromReplay = round !== undefined && selectedId === null;
  useEffect(() => {
    if (!selected || fromReplay) return;
    setForm({
      round: selected.round, from: Math.floor(selected.start * 10) / 10, to: Math.ceil(selected.end * 10) / 10,
      steamid: selected.steamid ?? "", title: selected.title ?? "",
    });
    setCreated(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // ---- preview ----
  const [replay, setReplay] = useState<Replay | null>(null);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setReplay(null);
    loadReplay(match.id, selected.round).then((r) => alive && setReplay(r)).catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [match.id, selected?.round, selected?.id]);

  const frame = useMemo(
    () => (assets && replay && selected && replay.round === selected.round
      ? prepareFrame(assets, replay, selected, match, opts.size, { zoom: opts.zoom, names: opts.names }) : null),
    [assets, replay, selected, match, opts.size, opts.zoom, opts.names],
  );
  const total = selected ? hlDuration(selected) : 0;
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
  const scale = frame ? Math.min(boxWidth / frame.width, (window.innerHeight - 150) / frame.height, 1.5) : 1;

  const tRef = useRef(0);
  const [T, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const render = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !assets || !frame) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    drawHighlight(ctx, assets, frame, tRef.current);
  }, [assets, frame, scale]);
  useEffect(render, [render, T]);
  useEffect(() => {
    tRef.current = 0;
    setT(0);
    setPlaying(true);
  }, [selected?.id]);
  useEffect(() => {
    if (!playing || !frame) return;
    let raf = 0, last = performance.now(), lastUi = 0;
    const tick = (now: number) => {
      tRef.current += ((now - last) / 1000) * opts.speed;
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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frame, total, opts.speed, render]);
  const seek = (v: number) => {
    tRef.current = Math.max(0, Math.min(total, v));
    setT(tRef.current);
  };

  // ---- create / delete ----
  const create = async () => {
    setError(null);
    try {
      const h = await api.createHighlight(match.id, {
        round: form.round, start: form.from, end: form.to, title: form.title, steamid: form.steamid || null,
      });
      setData((d) => (d && !d.custom.some((x) => x.id === h.id) ? { ...d, custom: [...d.custom, h] } : d));
      setKind("");
      setTeam("");
      setPlayer("");
      setSelectedId(h.id);
      window.setTimeout(() => setCreated(hlTitle(h, match))); // after the form has followed the new selection
      setForm((f) => ({ ...f, title: "" }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (h: Highlight) => {
    if (!window.confirm(t("hl.deleteConfirm", { title: hlTitle(h, match) }))) return;
    try {
      await api.deleteHighlight(match.id, h.id);
      setData((d) => (d ? { ...d, custom: d.custom.filter((x) => x.id !== h.id) } : d));
      setChecked((c) => new Set([...c].filter((id) => id !== h.id)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ---- downloads ----
  const chooseFormat = (format: "mp4" | "gif") =>
    // GIF has no inter-frame compression: smaller and fewer frames keep the file sane
    setOpts((o) => ({ ...o, format, fps: format === "gif" ? 15 : 30, size: format === "gif" ? Math.min(o.size, 512) : 768 }));

  const exportList = async (items: Highlight[]) => {
    if (!assets || !items.length) return;
    setPlaying(false);
    setSaved(null);
    setError(null);
    const abort = new AbortController();
    const files: [string, Blob | string][] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        const h = items[i];
        setExporting({ i: i + 1, n: items.length, progress: 0, abort });
        const r = await loadReplay(match.id, h.round);
        const f = prepareFrame(assets, r, h, match, opts.size, { zoom: opts.zoom, names: opts.names });
        const media = await renderClip(assets, f, opts, (progress) => setExporting({ i: i + 1, n: items.length, progress, abort }), abort.signal);
        const name = h.kind === "custom" ? players.find((p) => p.steamid === h.steamid)?.name ?? null : h.name ?? null;
        let file = `${fileBase(match, h, name)}.${opts.format}`;
        for (let k = 2; files.some(([n]) => n === file); k++) file = `${fileBase(match, h, name)}_${k}.${opts.format}`;
        files.push([file, media]);
      }
      let blob: Blob, file: string;
      if (files.length === 1) [file, blob] = files[0] as [string, Blob];
      else {
        files.push(["highlights.txt", items.map((h) => hlTextLine(h, match)).join("\n") + "\n"]);
        blob = await zipFiles(files);
        file = `${match.id}_highlights.zip`.replace(/[^\p{L}\p{N}_.+-]+/gu, "_");
      }
      download(blob, file);
      setSaved(t("hl.saved", { file, mb: (blob.size / 2 ** 20).toFixed(1) }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const toggle = (id: string) => setChecked((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const teams = Object.keys(match.score);
  const dpr = window.devicePixelRatio || 1;

  return (
    <div className="clip">
      <div className="clip-side">
        <h3>{t("highlights.title")} <span className="muted small">{data ? list.length : ""}</span></h3>
        <div className="row small">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t("hl.allKinds")}</option>
            {KINDS.map((k) => <option key={k} value={k}>{t(`hl.kind.${k}`)}</option>)}
          </select>
          <select value={team} onChange={(e) => { setTeam(e.target.value); setPlayer(""); }}>
            <option value="">{t("common.allTeams")}</option>
            {teams.map((tm) => <option key={tm}>{tm}</option>)}
          </select>
          <select value={player} onChange={(e) => setPlayer(e.target.value)}>
            <option value="">{t("common.allPlayers")}</option>
            {players.filter((p) => !team || p.team === team).map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}
          </select>
        </div>
        <div className="hl-list">
          {!data && !error && <div className="muted small">{t("common.loading")}</div>}
          {data && !list.length && <div className="muted small">{t("hl.none")}</div>}
          {list.map((h) => (
            <div key={h.id} className={`hl-item ${selected?.id === h.id ? "sel" : ""}`} onClick={() => setSelectedId(h.id)}>
              <input type="checkbox" checked={checked.has(h.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(h.id)} />
              <div className="grow">
                <div className="hl-top">
                  <span className={`hl-kind k-${h.kind}`}>{h.kind === "clutch" ? t("hl.clutch", { n: h.clutch ?? 1 }) : kindLabel(h)}</span>
                  <b>{h.kind === "custom" ? hlTitle(h, match) : h.name}</b>
                </div>
                <div className="muted small">{t("hl.window", { round: h.round, from: clockOf(h.start), to: clockOf(h.end), len: Math.round(hlDuration(h)) })}</div>
                <div className="muted small">{hlSubtitle(h, match).split(" · ").slice(-2).join(" · ")}</div>
                {!!h.tags?.length && <div className="kc-tags">{h.tags.map((tag) => <span key={tag}>{tagLabel(tag)}</span>)}</div>}
              </div>
              {h.kind === "custom" && (
                <button className="link small" title={t("common.delete")} onClick={(e) => { e.stopPropagation(); remove(h); }}>✕</button>
              )}
            </div>
          ))}
        </div>

        <h3>{t("hl.export")}</h3>
        <div className="row small">
          <span className="seg">
            <button className={opts.format === "mp4" ? "on" : ""} disabled={!canEncodeVideo()} onClick={() => chooseFormat("mp4")}>MP4</button>
            <button className={opts.format === "gif" ? "on" : ""} onClick={() => chooseFormat("gif")}>GIF</button>
          </span>
          <select value={opts.size} onChange={(e) => setOpts({ ...opts, size: Number(e.target.value) })}>
            {SIZES.map((v) => <option key={v} value={v}>{v} px</option>)}
          </select>
          <select value={opts.fps} onChange={(e) => setOpts({ ...opts, fps: Number(e.target.value) })}>
            {[10, 15, 20, 25, 30, 60].map((v) => <option key={v} value={v}>{t("clip.fps", { n: v })}</option>)}
          </select>
        </div>
        <div className="row small">
          {t("hl.speed")}
          <span className="seg">
            {SPEEDS.map((v) => <button key={v} className={opts.speed === v ? "on" : ""} onClick={() => setOpts({ ...opts, speed: v })}>{v}×</button>)}
          </span>
        </div>
        <div className="row small">
          <label><input type="checkbox" checked={opts.zoom} onChange={(e) => setOpts({ ...opts, zoom: e.target.checked })} /> {t("hl.zoom")}</label>
          <label><input type="checkbox" checked={opts.names} onChange={(e) => setOpts({ ...opts, names: e.target.checked })} /> {t("hl.names")}</label>
        </div>
        <div className="row">
          {exporting ? (
            <>
              <div className="progress grow">
                <div className="progress-bar" style={{ width: `${((exporting.i - 1 + exporting.progress) / exporting.n) * 100}%` }} />
                <span>{t("hl.rendering", { i: exporting.i, n: exporting.n, p: Math.round(exporting.progress * 100) })}</span>
              </div>
              <button onClick={() => exporting.abort.abort()}>{t("common.cancel")}</button>
            </>
          ) : (
            <>
              <button className="primary" disabled={!selected || !assets} onClick={() => selected && exportList([selected])}>
                {t("hl.download", { fmt: opts.format.toUpperCase() })}
              </button>
              <button disabled={!checked.size || !assets} onClick={() => exportList(all.filter((h) => checked.has(h.id)))}>
                {t("hl.downloadChecked", { n: checked.size })}
              </button>
            </>
          )}
        </div>
        {saved && <div className="small ok-text">{saved}</div>}

        <RecordPanel match={match} checked={all.filter((h) => checked.has(h.id))} onFinished={() => setRecorded((n) => n + 1)} />

        <div ref={formRef}>
          <h3>{t("hl.create")}</h3>
          <div className="muted small">{t("hl.createHint")}</div>
          <div className="row small">
            <select value={form.round} onChange={(e) => setForm({ ...form, round: Number(e.target.value) })}>
              {rounds.map((r) => <option key={r} value={r}>{t("common.round", { n: r })}</option>)}
            </select>
            {t("common.from")} <input type="number" step={0.5} value={form.from} min={-15} max={175} onChange={(e) => setForm({ ...form, from: Number(e.target.value) })} />
            {t("common.to")} <input type="number" step={0.5} value={form.to} min={-14} max={180} onChange={(e) => setForm({ ...form, to: Number(e.target.value) })} /> {t("common.s")}
            <span className="muted">{t("hl.formClock", { from: clockOf(form.from), to: clockOf(form.to), len: Math.max(0, Math.round(form.to - form.from)) })}</span>
          </div>
          <div className="row small">
            {t("hl.focus")}
            <select value={form.steamid} onChange={(e) => setForm({ ...form, steamid: e.target.value })}>
              <option value="">{t("hl.noFocus")}</option>
              {players.map((p) => <option key={p.steamid} value={p.steamid}>{p.name} ({p.team})</option>)}
            </select>
          </div>
          <div className="row small">
            <input className="grow" maxLength={80} placeholder={t("hl.titlePh")} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <button disabled={form.to <= form.from} onClick={create}>{t("hl.add")}</button>
          </div>
          {created && <div className="small ok-text">{t("hl.createdNote", { title: created })}</div>}
        </div>
        {error && <div className="error small">{error}</div>}
      </div>

      <div className="clip-main" ref={boxRef}>
        {selected && (
          <div className="row">
            <button className="play" disabled={!frame} onClick={() => (T >= total ? (seek(0), setPlaying(true)) : setPlaying((p) => !p))}>
              {playing ? "⏸" : "▶"}
            </button>
            <input type="range" className="grow" min={0} max={total || 1} step={0.05} value={T} onChange={(e) => seek(Number(e.target.value))} />
            <span className="muted small clock-small">{T.toFixed(1)} / {total.toFixed(1)} {t("common.s")}</span>
            <button className="link small" onClick={() => go("match", match.id, "replay", selected.round, Math.floor(selected.start))}>{t("hl.openReplay")}</button>
          </div>
        )}
        {mapError ? <div className="error">{mapError}</div> : !selected ? (
          <div className="muted">{data ? t("hl.pick") : t("common.loading")}</div>
        ) : !frame ? (
          <div className="muted">{t("replay.loadingRound")}</div>
        ) : (
          <canvas
            ref={canvasRef}
            width={Math.round(frame.width * scale * dpr)}
            height={Math.round(frame.height * scale * dpr)}
            style={{ width: frame.width * scale, height: frame.height * scale, borderRadius: 8, border: "1px solid var(--line)" }}
          />
        )}
        <Recordings match={match} refresh={recorded} />
      </div>
    </div>
  );
}
