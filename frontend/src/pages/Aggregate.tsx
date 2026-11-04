import { useEffect, useMemo, useState } from "react";
import { api, type LibraryMatch, type Tables } from "../api";
import { DataTable } from "../components/DataTable";
import { t, td } from "../i18n";

// in this order; titles are agg.s.<name> in the locales
const SECTIONS = [
  "matches", "summary", "summary_by_map", "by_side", "by_side_map", "opening", "trades", "bomb_t", "bomb_ct",
  "executes", "rotations", "setups", "win_reasons", "by_buy", "players",
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
      <div className="pagehead"><h1>{t("agg.title")}</h1><div className="sub">{t("agg.sub")}</div></div>
      <div className="grid2">
        <div>
          <h3>{t("agg.matches")}</h3>
          <div className="row small">
            <button className="link" onClick={() => setPicked(new Set(matches.map((m) => m.id)))}>{t("agg.selectAll")}</button>
            <button className="link" onClick={() => setPicked(new Set())}>{t("agg.clear")}</button>
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
          <h3>{t("agg.aliases")}</h3>
          <div className="muted small">{t("agg.aliasHint")}</div>
          <textarea rows={6} value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="team_dr1amwtf=Arena Pro Team" />
          {teams.length > 0 && (
            <div className="small muted">
              {t("agg.teamsIn")}{" "}
              {teams.map((t) => (
                <button key={t} className="link" onClick={() => setAliasText((a) => (a ? a + "\n" : "") + `${t}=`)}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <button disabled={!picked.size || busy} onClick={run}>
              {busy ? t("agg.computing") : t("agg.compute", { n: picked.size })}
            </button>
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div>
          {result.warnings.map((w) => <div key={w} className="warn">{w}</div>)}
          {SECTIONS.filter((k) => result.tables[k]).map((k) => (
            <DataTable key={k} title={td(`agg.s.${k}`, k)} rows={result.tables[k]} maxHeight={k === "players" || k === "setups" ? 420 : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
