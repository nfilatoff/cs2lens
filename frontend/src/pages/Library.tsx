import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Job, type Library } from "../api";
import { go } from "../App";

export function LibraryPage() {
  const [lib, setLib] = useState<Library | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api.library().then(setLib).catch((e: Error) => setError(e.message));
    api.jobs().then(setJobs).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  // Poll while something is queued or running; refresh the library when a job finishes.
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const next = await api.jobs();
      setJobs(next);
      if (!next.some((j) => j.status === "queued" || j.status === "running")) refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [active, refresh]);

  const run = (p: Promise<unknown>) =>
    p.then(refresh).catch((e: Error) => setError(e.message));

  const jobFor = (target: string) => jobs.find((j) => j.target === target && j.status !== "done");

  if (!lib) return <div className="page">{error ?? "Загрузка…"}</div>;

  return (
    <div className="page">
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <section>
        <h2>Матчи ({lib.matches.length})</h2>
        <div className="muted small">Разобранные демки лежат в {lib.out}</div>
        <div className="cards">
          {lib.matches.map((m) => {
            const job = jobs.find((j) => j.match_id === m.id && j.kind === "replay" && j.status !== "done");
            const teams = Object.entries(m.score ?? {});
            return (
              <div key={m.id} className="card clickable" onClick={() => go("match", m.id, "overview")}>
                <div className="card-map">{m.map?.replace("de_", "")}</div>
                <div className="card-title">{m.id}</div>
                {teams.length > 0 && (
                  <div className="card-score">
                    {teams.map(([t, s], i) => (
                      <span key={t}>
                        {i > 0 && " : "}
                        <b>{s}</b> {t}
                      </span>
                    ))}
                  </div>
                )}
                {m.error && <div className="error small">{m.error}</div>}
                <div className="card-foot">
                  {m.has_replay ? (
                    <span className="badge ok">реплей</span>
                  ) : job ? (
                    <span className="badge">{job.stage || "в очереди"}</span>
                  ) : (
                    <button
                      className="small-btn"
                      title="Нужен исходный .dem в одной из папок библиотеки"
                      onClick={(e) => {
                        e.stopPropagation();
                        run(api.buildReplayData(m.id));
                      }}
                    >
                      данные для реплея
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2>Демки</h2>
        <div className="row">
          <input
            className="grow"
            placeholder="Папка с .dem, например D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && folder && run(api.addFolder(folder).then(() => setFolder("")))}
          />
          <button disabled={!folder} onClick={() => run(api.addFolder(folder).then(() => setFolder("")))}>
            Добавить папку
          </button>
          <button onClick={() => fileInput.current?.click()}>Загрузить .dem…</button>
          <input
            ref={fileInput}
            type="file"
            accept=".dem"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              files.forEach((f) => run(api.upload(f)));
            }}
          />
        </div>
        {lib.folders.length > 0 && (
          <ul className="folders">
            {lib.folders.map((f) => (
              <li key={f}>
                {f}{" "}
                <button className="link" onClick={() => run(api.removeFolder(f))}>
                  убрать
                </button>
              </li>
            ))}
          </ul>
        )}
        <table className="demos">
          <tbody>
            {lib.demos.map((d) => {
              const job = jobFor(d.path);
              return (
                <tr key={d.path}>
                  <td>{d.name}</td>
                  <td className="num muted">{d.size_mb} МБ</td>
                  <td className="status">
                    {job ? (
                      job.status === "error" ? (
                        <span className="error small">{job.error}</span>
                      ) : (
                        <Progress value={job.progress} label={job.status === "queued" ? "в очереди" : job.stage} />
                      )
                    ) : d.extracted ? (
                      <span className="badge ok">разобрана</span>
                    ) : (
                      <button className="small-btn" onClick={() => run(api.extract(d.path))}>
                        Разобрать
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {lib.demos.length === 0 && (
              <tr>
                <td className="muted">Добавьте папку с демками или загрузите файл.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
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
