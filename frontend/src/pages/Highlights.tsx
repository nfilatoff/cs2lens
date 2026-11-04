import { useEffect, useState } from "react";
import { api, type LibraryMatch, type MatchOverview } from "../api";
import { go } from "../App";
import { HighlightsView } from "../components/HighlightsView";
import { mapPretty } from "../components/MatchPicker";
import { t } from "../i18n";

/** Highlights of any match of the library: the most recent one unless the route names one. */
export function HighlightsPage({ id }: { id?: string }) {
  const [library, setLibrary] = useState<LibraryMatch[] | null>(null);
  const [match, setMatch] = useState<MatchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.library()
      .then((l) => setLibrary(l.matches.filter((m) => !m.error).sort((a, b) => b.modified - a.modified)))
      .catch((e: Error) => setError(e.message));
  }, []);
  const current = id ?? library?.[0]?.id;
  useEffect(() => {
    if (!current) return;
    setMatch(null);
    api.match(current).then(setMatch).catch((e: Error) => setError(e.message));
  }, [current]);

  return (
    <div className="page">
      <div className="pagehead"><h1>{t("highlights.title")}</h1><div className="sub">{t("highlights.sub")}</div></div>
      {library && !library.length && <div className="muted">{t("hl.noMatches")}</div>}
      {library && library.length > 0 && (
        <div className="lib-filters">
          <span className="muted small">{t("hl.match")}</span>
          <select value={current} onChange={(e) => go("highlights", e.target.value)}>
            {library.map((m) => (
              <option key={m.id} value={m.id}>
                {mapPretty(m.map || "?")} · {Object.entries(m.score ?? {}).map(([tm, s]) => `${tm} ${s}`).join(" : ") || m.id}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {match && match.id === current && <HighlightsView key={match.id} match={match} />}
    </div>
  );
}
