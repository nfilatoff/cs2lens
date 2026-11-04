import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, radarUrl, type Job, type Library, type LibraryMatch } from "../api";
import { go } from "../App";
import { t } from "../i18n";

const ACCEPT = ".dem,.zip,.rar,.7z,.tar,.tgz,.gz,.bz2,.xz,.zst";
const ARCHIVE = /\.(zip|rar|7z|tar|tgz|gz|bz2|xz|zst)$/i;
const jobKind = (kind: Job["kind"]) => t(`job.${kind}`);

interface Upload {
  name: string;
  size: number;
  loaded: number;
  status: "queued" | "uploading" | "done" | "skipped" | "error";
  error?: string;
}

const mapLabel = (map: string | null | undefined) => (map ? map.replace(/^de_/, "") : "?");

export function LibraryPage() {
  const [lib, setLib] = useState<Library | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [mapFilter, setMapFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [search, setSearch] = useState("");
  const [hideExtracted, setHideExtracted] = useState(true);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LibraryMatch | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const queue = useRef<File[]>([]);
  const libRef = useRef<Library | null>(null);
  libRef.current = lib;

  const refresh = useCallback(() => {
    api.library().then(setLib).catch((e: Error) => setError(e.message));
    api.jobs().then(setJobs).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  // Poll while something is queued or running; refresh the library when a job finishes.
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!active) return;
    let running = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    const t = setInterval(async () => {
      const next = await api.jobs();
      setJobs(next);
      const now = next.filter((j) => j.status === "queued" || j.status === "running").length;
      if (now !== running) refresh(); // a job finished (or an unpack queued new ones)
      running = now;
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refresh]);

  const run = (p: Promise<unknown>) => p.then(refresh).catch((e: Error) => setError(e.message));
  const jobFor = (target: string) => jobs.find((j) => j.target === target && j.status !== "done");

  // ---- uploads: one file at a time, skipping demos that are already in the library ----
  const patch = (name: string, change: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.name === name ? { ...u, ...change } : u)));

  const pump = useCallback(
    async () => {
      if (uploading.current) return;
      uploading.current = true;
      let f: File | undefined;
      while ((f = queue.current.shift())) {
        const file = f;
        const known = libRef.current?.demos.find((d) => d.name === file.name && Math.abs(d.size_mb - file.size / 2 ** 20) < 0.05);
        if (known) {
          patch(file.name, { status: "skipped", loaded: file.size });
          if (!known.extracted && !known.job) await api.extract(known.path).catch(() => {});
          continue;
        }
        patch(file.name, { status: "uploading" });
        try {
          await api.upload(file, (loaded) => patch(file.name, { loaded }));
          patch(file.name, { status: "done", loaded: file.size });
        } catch (e) {
          patch(file.name, { status: "error", error: (e as Error).message });
        }
        refresh();
      }
      uploading.current = false;
      refresh();
    },
    [refresh],
  );

  const addFiles = (files: File[]) => {
    const ok = files.filter((f) => f.name.toLowerCase().endsWith(".dem") || ARCHIVE.test(f.name));
    const bad = files.filter((f) => !ok.includes(f));
    if (bad.length) setError(t("lib.skipped", { files: bad.map((f) => f.name).join(", ") }));
    if (!ok.length) return;
    setUploads((list) => [
      ...list.filter((u) => !ok.some((f) => f.name === u.name)),
      ...ok.map((f) => ({ name: f.name, size: f.size, loaded: 0, status: "queued" as const })),
    ]);
    queue.current.push(...ok);
    pump();
  };

  // ---- filters ----
  const maps = useMemo(() => {
    const s = new Set<string>();
    lib?.matches.forEach((m) => m.map && s.add(m.map));
    lib?.demos.forEach((d) => d.map && s.add(d.map));
    return [...s].sort();
  }, [lib]);
  const teams = useMemo(() => {
    const s = new Set<string>();
    lib?.matches.filter((m) => !mapFilter || m.map === mapFilter).forEach((m) => Object.keys(m.score ?? {}).forEach((t) => s.add(t)));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [lib, mapFilter]);
  const q = search.trim().toLowerCase();
  const matches = (lib?.matches ?? []).filter(
    (m) => (!mapFilter || m.map === mapFilter) && (!teamFilter || teamFilter in (m.score ?? {})) &&
      (!q || m.id.toLowerCase().includes(q) || Object.keys(m.score ?? {}).some((t) => t.toLowerCase().includes(q))),
  );
  const demos = (lib?.demos ?? []).filter(
    (d) => (!mapFilter || d.map === mapFilter) && (!hideExtracted || !d.extracted || jobFor(d.path)) && (!q || d.name.toLowerCase().includes(q)),
  );
  const runningJobs = jobs.filter((j) => j.status === "queued" || j.status === "running" || (j.status === "error" && j.kind === "unpack"));

  if (!lib) return <div className="page">{error ?? t("common.loading")}</div>;

  return (
    <div
      className="page"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {error && (
        <div className="error" onClick={() => setError(null)} title={t("common.hide")}>
          {error}
        </div>
      )}

      <div className="pagehead">
        <h1>{t("lib.title")}</h1>
        <div className="sub">{t("lib.sub")}</div>
      </div>

      <div className="lib-filters">
        <select value={mapFilter} onChange={(e) => setMapFilter(e.target.value)}>
          <option value="">{t("lib.allMaps")}</option>
          {maps.map((m) => <option key={m} value={m}>{mapLabel(m)}</option>)}
        </select>
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
          <option value="">{t("common.allTeams")}</option>
          {teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder={t("lib.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        {(mapFilter || teamFilter || search) && (
          <button className="link" onClick={() => { setMapFilter(""); setTeamFilter(""); setSearch(""); }}>{t("lib.reset")}</button>
        )}
      </div>

      <section>
        <h2>{t("lib.matches")} <span className="count">{matches.length}{matches.length !== lib.matches.length ? t("lib.ofTotal", { n: lib.matches.length }) : ""}</span></h2>
        <div className="muted small">{t("lib.outDir", { dir: lib.out })}</div>
        <div className="cards">
          {matches.map((m) => {
            const job = jobs.find((j) => j.match_id === m.id && j.kind === "replay" && j.status !== "done");
            const teamsOf = Object.entries(m.score ?? {});
            const top = Math.max(...teamsOf.map(([, s]) => s));
            return (
              <div key={m.id} className="card clickable" onClick={() => go("match", m.id, "overview")}>
                <button
                  className="card-del"
                  title={m.busy ? t("lib.busy") : t("common.delete")}
                  disabled={m.busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(m);
                  }}
                >
                  ✕
                </button>
                <div className="card-banner" style={m.map ? { backgroundImage: `url(${radarUrl(m.map)})` } : undefined}>
                  <div className="card-map">{mapLabel(m.map)}</div>
                </div>
                {teamsOf.length > 0 && (
                  <div className="card-score">
                    {teamsOf.map(([t, s]) => (
                      <div key={t} className={`card-team ${s === top && teamsOf.some(([, o]) => o < s) ? "win" : ""}`}>
                        <span>{t}</span>
                        <b>{s}</b>
                      </div>
                    ))}
                  </div>
                )}
                <div className="card-title" title={m.id}>{m.id}</div>
                {m.error && <div className="error small">{m.error}</div>}
                <div className="card-foot">
                  {m.has_replay ? (
                    <span className="badge ok">{t("lib.replayBadge")}</span>
                  ) : job ? (
                    <span className="badge">{job.stage || t("lib.queued")}</span>
                  ) : (
                    <button
                      className="small-btn"
                      title={t("lib.needDem")}
                      onClick={(e) => {
                        e.stopPropagation();
                        run(api.buildReplayData(m.id));
                      }}
                    >
                      {t("lib.replayData")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {matches.length === 0 && <div className="muted">{t("lib.noMatches")}</div>}
        </div>
      </section>

      <section>
        <h2>{t("lib.demos")} <span className="count">{demos.length}</span></h2>
        <div className="row">
          <input
            className="grow"
            placeholder={t("lib.folderPlaceholder")}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && folder && run(api.addFolder(folder).then(() => setFolder("")))}
          />
          <button disabled={!folder} onClick={() => run(api.addFolder(folder).then(() => setFolder("")))}>
            {t("lib.addFolder")}
          </button>
          <button onClick={() => fileInput.current?.click()}>{t("lib.upload")}</button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              addFiles(files);
            }}
          />
        </div>
        <div className={`dropzone ${dragOver ? "over" : ""}`}>
          {t("lib.drop")}
        </div>

        {uploads.length > 0 && (
          <div className="uploads">
            {uploads.map((u) => (
              <div key={u.name} className="row small">
                <span className="grow">{u.name}</span>
                {u.status === "error" ? (
                  <span className="error">{u.error}</span>
                ) : u.status === "skipped" ? (
                  <span className="muted">{t("lib.alreadyIn")}</span>
                ) : u.status === "done" ? (
                  <span className="ok-text">{t("lib.uploaded")}</span>
                ) : (
                  <div style={{ width: 280 }}>
                    <Progress value={u.size ? u.loaded / u.size : 0} label={u.status === "queued" ? t("lib.waiting") : t("lib.uploading", { done: (u.loaded / 2 ** 20).toFixed(0), total: (u.size / 2 ** 20).toFixed(0) })} />
                  </div>
                )}
              </div>
            ))}
            {uploads.every((u) => u.status !== "queued" && u.status !== "uploading") && (
              <button className="link small" onClick={() => setUploads([])}>{t("lib.clearList")}</button>
            )}
          </div>
        )}

        {runningJobs.length > 0 && (
          <div className="uploads">
            {runningJobs.map((j) => (
              <div key={j.id} className="row small">
                <span className="grow">{jobKind(j.kind)}: {j.target.split(/[\\/]/).pop()}</span>
                {j.status === "error" ? (
                  <span className="error">{j.error}</span>
                ) : (
                  <div style={{ width: 280 }}>
                    <Progress value={j.progress} label={j.status === "queued" ? t("lib.queued") : j.stage} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {lib.folders.length > 0 && (
          <ul className="folders">
            {lib.folders.map((f) => (
              <li key={f}>
                {f}{" "}
                <button className="link" onClick={() => run(api.removeFolder(f))}>
                  {t("lib.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="small">
          <input type="checkbox" checked={hideExtracted} onChange={(e) => setHideExtracted(e.target.checked)} /> {t("lib.hideParsed")}
        </label>
        <table className="demos">
          <tbody>
            {demos.map((d) => {
              const job = jobFor(d.path);
              return (
                <tr key={d.path}>
                  <td className="muted">{mapLabel(d.map)}</td>
                  <td title={d.path}>{d.name}{d.uploaded && <span className="muted small">{t("lib.uploadedTag")}</span>}</td>
                  <td className="num muted">{t("common.mb", { n: d.size_mb })}</td>
                  <td className="status">
                    {job ? (
                      job.status === "error" ? (
                        <span className="error small">{job.error}</span>
                      ) : (
                        <Progress value={job.progress} label={job.status === "queued" ? t("lib.queued") : job.stage} />
                      )
                    ) : d.extracted ? (
                      <a className="badge ok" href={`#/match/${encodeURIComponent(d.match_id)}/overview`}>{t("lib.parsed")}</a>
                    ) : (
                      <button className="small-btn" onClick={() => run(api.extract(d.path))}>
                        {t("lib.parse")}
                      </button>
                    )}
                  </td>
                  <td>
                    <button
                      className="link small"
                      disabled={!!job}
                      title={t("lib.deleteDemoTitle")}
                      onClick={() => window.confirm(t("lib.deleteDemoConfirm", { name: d.name, path: d.path })) && run(api.deleteDemo(d.path))}
                    >
                      {t("common.deleteLower")}
                    </button>
                  </td>
                </tr>
              );
            })}
            {demos.length === 0 && (
              <tr>
                <td className="muted">
                  {lib.demos.length ? t("lib.allParsed") : t("lib.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {confirmDelete && (
        <DeleteDialog
          match={confirmDelete}
          hasDemo={lib.demos.some((d) => d.match_id === confirmDelete.id)}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={(withDemo) => {
            const id = confirmDelete.id;
            setConfirmDelete(null);
            run(api.deleteMatch(id, withDemo));
          }}
        />
      )}
    </div>
  );
}

function DeleteDialog({ match, hasDemo, onCancel, onConfirm }: {
  match: LibraryMatch; hasDemo: boolean; onCancel: () => void; onConfirm: (withDemo: boolean) => void;
}) {
  const [withDemo, setWithDemo] = useState(false);
  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("del.title")}</h3>
        <p>
          <b>{match.id}</b> {t("del.body", { map: mapLabel(match.map) })}
        </p>
        {hasDemo ? (
          <label>
            <input type="checkbox" checked={withDemo} onChange={(e) => setWithDemo(e.target.checked)} /> {t("del.withDemo")}
          </label>
        ) : (
          <div className="muted small">{t("del.noDemo")}</div>
        )}
        <div className="row">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button className="danger" onClick={() => onConfirm(withDemo)}>{t("common.delete")}</button>
        </div>
      </div>
    </div>
  );
}

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress" title={label}>
      <div className="progress-bar" style={{ width: `${Math.round(value * 100)}%` }} />
      <span>
        {label} {Math.round(value * 100)}%
      </span>
    </div>
  );
}
