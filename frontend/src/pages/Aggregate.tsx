import { useEffect, useMemo, useState } from "react";
import { api, type LibraryMatch, type Tables } from "../api";
import { DataTable } from "../components/DataTable";

const SECTIONS: [string, string][] = [
  ["matches", "Матчи"],
  ["summary", "Команды: всего"],
  ["summary_by_map", "Команды по картам"],
  ["by_side", "По сторонам"],
  ["by_side_map", "По картам и сторонам"],
  ["opening", "Опенинги"],
  ["trades", "Трейды"],
  ["bomb_t", "T: планты"],
  ["bomb_ct", "CT: ретейки и дефьюзы"],
  ["executes", "Экзекуты T по картам и сайтам"],
  ["rotations", "Ротации CT"],
  ["setups", "Сетапы CT"],
  ["win_reasons", "Как выигрывались раунды"],
  ["by_buy", "По закупам"],
  ["players", "Игроки (по ADR)"],
];

export function AggregatePage() {
  const [matches, setMatches] = useState<LibraryMatch[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [aliasText, setAliasText] = useState("");
  const [result, setResult] = useState<{ tables: Tables; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.library().then((l) => setMatches(l.matches)).catch((e: Error) => setError(e.message));
  }, []);

  const teams = useMemo(() => {
    const s = new Set<string>();
    matches.filter((m) => picked.has(m.id)).forEach((m) => Object.keys(m.score ?? {}).forEach((t) => s.add(t)));
    return [...s].sort();
  }, [matches, picked]);

  const aliases = useMemo(() => {
    const out: Record<string, string> = {};
    for (const line of aliasText.split("\n")) {
      const [old, ...rest] = line.split("=");
      if (old?.trim() && rest.join("=").trim()) out[old.trim()] = rest.join("=").trim();
    }
    return out;
  }, [aliasText]);

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = () => {
    setBusy(true);
    setError(null);
    api
      .aggregate([...picked], aliases)
      .then(setResult)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="page">
      <div className="pagehead"><h1>Несколько матчей</h1><div className="sub">Суммарная статистика команд и игроков по выбранным матчам</div></div>
      <div className="grid2">
        <div>
          <h3>Матчи</h3>
          <div className="row small">
            <button className="link" onClick={() => setPicked(new Set(matches.map((m) => m.id)))}>выбрать все</button>
            <button className="link" onClick={() => setPicked(new Set())}>снять</button>
          </div>
          <div className="pick-list">
            {matches.map((m) => (
              <label key={m.id} className="pick">
                <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
                <span className="muted">{m.map?.replace("de_", "")}</span> {m.id}
                <span className="muted small"> {Object.entries(m.score ?? {}).map(([t, s]) => `${t} ${s}`).join(" : ")}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3>Алиасы команд</h3>
          <div className="muted small">Одна строка — одна замена: СТАРОЕ=НОВОЕ. Так склеиваются разные названия одной команды.</div>
          <textarea rows={6} value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="team_dr1amwtf=Arena Pro Team" />
          {teams.length > 0 && (
            <div className="small muted">
              Команды в выбранных матчах:{" "}
              {teams.map((t) => (
                <button key={t} className="link" onClick={() => setAliasText((a) => (a ? a + "\n" : "") + `${t}=`)}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <button disabled={!picked.size || busy} onClick={run}>
              {busy ? "Считаю…" : `Посчитать (${picked.size})`}
            </button>
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div>
          {result.warnings.map((w) => <div key={w} className="warn">{w}</div>)}
          {SECTIONS.filter(([k]) => result.tables[k]).map(([k, title]) => (
            <DataTable key={k} title={title} rows={result.tables[k]} maxHeight={k === "players" || k === "setups" ? 420 : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
