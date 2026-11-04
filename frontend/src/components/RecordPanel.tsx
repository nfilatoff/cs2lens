// Automatic recording, like a clip service but on your own PC: the open CS2 plays the demo from the
// player's eyes and the backend records the screen with ffmpeg, clip by clip (cs2lens/app/recorder.py).
import { useEffect, useRef, useState } from "react";
import { api, cs2Error, recordingUrl, type Highlight, type MatchOverview, type Recording, type RecorderStatus } from "../api";
import { ConsoleSetup } from "./ConsoleSetup";
import { hlTitle } from "../highlightRender";
import { t, td } from "../i18n";

type Source = "checked" | "kills";

export function RecordPanel({ match, checked, onFinished }: { match: MatchOverview; checked: Highlight[]; onFinished: () => void }) {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [source, setSource] = useState<Source>(checked.length ? "checked" : "kills");
  const [player, setPlayer] = useState("");
  const [capture, setCapture] = useState<"screen" | "window" | "hlae">("screen");
  const [installing, setInstalling] = useState(false);
  const [cut, setCut] = useState(true);
  const [gap, setGap] = useState(3);
  const [fps, setFps] = useState(60);
  const [clean, setClean] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  const players = match.players.map((p) => ({ steamid: String(p.steamid), name: String(p.name), team: String(p.team ?? "") }));
  const st = status?.state;
  const busy = st?.status === "running";

  // status: often while a session runs, rarely otherwise (CS2 may be started or closed meanwhile)
  useEffect(() => {
    let alive = true;
    const poll = () => api.recorder().then((s) => alive && setStatus(s)).catch(() => {});
    poll();
    const timer = setInterval(poll, busy ? 1000 : 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) onFinished(); // new clips in the gallery
    wasBusy.current = busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // your own account is the default player, when you played this match
  useEffect(() => {
    if (player || !status) return;
    const me = status.me && players.find((p) => p.steamid === status.me!.steamid);
    const top = [...match.players].sort((a, b) => Number(b.kills ?? 0) - Number(a.kills ?? 0))[0];
    setPlayer(me ? me.steamid : top ? String(top.steamid) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.me?.steamid]);
  useEffect(() => {
    if (checked.length) setSource("checked");
  }, [checked.length]);

  const start = async () => {
    setError(null);
    setPreparing(true);
    try {
      const cutGap = cut && gap >= 1 ? gap : null;
      const list = source === "checked" ? checked : await api.killClips(match.id, player, cutGap);
      const clips = list.map((h) => ({
        round: h.round, start: h.start, end: h.end, steamid: h.steamid, kind: h.kind, kill_secs: h.kill_secs,
        title: h.kind === "kills" ? `${h.name} ${t("hl.killsN", { n: h.kills ?? 1 })}` : hlTitle(h, match),
      }));
      if (!clips.length) throw new Error(t("rec.nothing"));
      // HLAE starts its own game: an open one has to close first, and that is the player's call
      const closeGame = capture === "hlae" && !!status?.running;
      if (closeGame && !window.confirm(t("rec.hlae.closeConfirm"))) return;
      await api.recorderStart(match.id, clips, capture, fps, clean, closeGame, cutGap);
      setStatus(await api.recorder());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const installHlae = async () => {
    if (!window.confirm(t("rec.hlae.installConfirm"))) return;
    setInstalling(true);
    setError(null);
    try {
      await api.hlaeInstall();
      setStatus(await api.recorder());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const hlaeMode = capture === "hlae";
  const meHere = status?.me && players.some((p) => p.steamid === status.me!.steamid);
  return (
    <div className="rec-panel">
      <h3>{t("rec.title")}</h3>
      {status && !status.ffmpeg && <div className="warn small">{t("rec.noFfmpeg")}</div>}
      {status && !status.connected && !hlaeMode && (
        <ConsoleSetup bindCommand={status.bind_command} running={status.running} onLinked={() => api.recorder().then(setStatus)} />
      )}
      {status && (
        <div className="muted small">
          CS2: {status.connected ? <span className="ok-text">{t("rec.cs2On")}</span> : t("rec.cs2Off")}
          {status.encoder ? ` · ${t("rec.encoder", { enc: status.encoder })}` : ""}
          {status.me ? ` · ${t("rec.account", { name: status.me.name })}` : ""}
        </div>
      )}
      <div className="row small">
        <span className="seg">
          <button className={source === "checked" ? "on" : ""} disabled={!checked.length} onClick={() => setSource("checked")}>
            {t("rec.checked", { n: checked.length })}
          </button>
          <button className={source === "kills" ? "on" : ""} onClick={() => setSource("kills")}>{t("rec.kills")}</button>
        </span>
        {source === "kills" && (
          <select value={player} onChange={(e) => setPlayer(e.target.value)}>
            {players.map((p) => (
              <option key={p.steamid} value={p.steamid}>
                {p.name}{meHere && p.steamid === status?.me?.steamid ? ` (${t("rec.me")})` : ""}{p.team ? ` · ${p.team}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="row small">
        {t("rec.capture")}
        <span className="seg">
          <button className={capture === "screen" ? "on" : ""} onClick={() => setCapture("screen")}>{t("rec.screen")}</button>
          <button className={capture === "window" ? "on" : ""} onClick={() => setCapture("window")}>{t("rec.window")}</button>
          <button className={hlaeMode ? "on" : ""} onClick={() => setCapture("hlae")}>{t("rec.hlae.mode")}</button>
        </span>
        <span className="seg">
          {[30, 60].map((v) => <button key={v} className={fps === v ? "on" : ""} onClick={() => setFps(v)}>{t("clip.fps", { n: v })}</button>)}
        </span>
      </div>
      <label className="small"><input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} /> {t("rec.clean")}</label>
      <div className="row small">
        <label><input type="checkbox" checked={cut} onChange={(e) => setCut(e.target.checked)} /> {t("rec.cut")}</label>
        <input type="number" min={1} max={60} value={gap} disabled={!cut} style={{ width: 56 }} onChange={(e) => setGap(Number(e.target.value))} /> {t("common.s")}
      </div>
      {cut && <div className="muted small">{t(source === "kills" ? "rec.cutKills" : "rec.cutChecked")}</div>}
      {hlaeMode && (
        <div className="link-setup small">
          <div>{t("rec.hlae.about")}</div>
          {status && !status.hlae && (
            <div className="row">
              <button disabled={installing} onClick={installHlae}>{installing ? t("rec.hlae.installing") : t("rec.hlae.install")}</button>
              <span className="muted">{t("rec.hlae.source")}</span>
            </div>
          )}
        </div>
      )}
      <div className="row">
        {busy ? (
          <>
            <div className="progress grow">
              <div className="progress-bar" style={{ width: `${st && st.n ? ((st.i - 1 + (st.phase === "finish" ? 1 : 0.5)) / st.n) * 100 : 0}%` }} />
              <span>{t("rec.progress", { i: st?.i || 1, n: st?.n ?? 0, phase: td(`rec.phase.${st?.phase ?? "connect"}`, "") })}</span>
            </div>
            <button onClick={() => api.recorderCancel().then(() => api.recorder()).then(setStatus)}>{t("common.cancel")}</button>
          </>
        ) : (
          <button className="primary" disabled={preparing || !status?.ffmpeg || (hlaeMode ? !status.hlae : !status.connected) || (source === "checked" ? !checked.length : !player)} onClick={start}>
            {preparing ? t("rec.cutting") : t("rec.start")}
          </button>
        )}
      </div>
      {st?.status === "done" && st.match_id === match.id && <div className="small ok-text">{t("rec.done", { n: st.files.length })}</div>}
      {st?.status === "error" && st.match_id === match.id && <div className="small error">{t("rec.error", { error: cs2Error(st.error ?? "") })}</div>}
      {error && <div className="small error">{error}</div>}
      {!hlaeMode && <div className="muted small">{t("rec.hint")}</div>}
    </div>
  );
}

/** Clips recorded from CS2 for one match: watch, download, delete. */
export function Recordings({ match, refresh }: { match: MatchOverview; refresh: number }) {
  const [items, setItems] = useState<Recording[] | null>(null);
  useEffect(() => {
    api.recordings(match.id).then(setItems).catch(() => setItems([]));
  }, [match.id, refresh]);
  if (!items) return null;
  const remove = (r: Recording) => {
    if (!window.confirm(t("rec.deleteConfirm", { name: r.file }))) return;
    api.deleteRecording(match.id, r.file).then(() => setItems((cur) => cur?.filter((x) => x.file !== r.file) ?? null)).catch((e: Error) => window.alert(e.message));
  };
  return (
    <div className="recordings">
      <h3>{t("rec.gallery")} <span className="muted small">{items.length}</span></h3>
      {!items.length && <div className="muted small">{t("rec.noClips")}</div>}
      <div className="rec-grid">
        {[...items].reverse().map((r) => (
          <div key={r.file} className="rec-item">
            <video src={recordingUrl(match.id, r.file)} controls preload="metadata" />
            <div className="rec-meta">
              <b title={r.file}>{r.title}</b>
              <span className="muted small">R{r.round} · {t("common.sec", { n: r.seconds })} · {t("common.mb", { n: (r.size / 2 ** 20).toFixed(1) })}</span>
            </div>
            <div className="row small">
              <a className="badge ok" href={recordingUrl(match.id, r.file, true)} download={r.file}>{t("rec.download")}</a>
              <button className="link small" onClick={() => remove(r)}>{t("common.deleteLower")}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
