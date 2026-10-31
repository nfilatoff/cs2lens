// A map and the matches of that map to work on, shared by the clip builder and the lineups page.
import { useEffect, useState } from "react";
import { api, type LibraryMatch } from "../api";

export const mapPretty = (map: string) => {
  const m = map.replace(/^de_/, "");
  return m.charAt(0).toUpperCase() + m.slice(1);
};

export function MatchPicker({ map, setMap, ids, setIds, onError }: {
  map: string;
  setMap: (map: string) => void;
  ids: string[];
  setIds: (ids: string[]) => void;
  onError: (message: string) => void;
}) {
  const [library, setLibrary] = useState<LibraryMatch[]>([]);
  useEffect(() => {
    api.library().then((l) => {
      const ok = l.matches.filter((m) => !m.error);
      setLibrary(ok);
      if (!map && ok[0]?.map) setMap(ok[0].map);
    }).catch((e: Error) => onError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const maps = [...new Set(library.map((m) => m.map).filter(Boolean))].sort();
  const toggle = (id: string) => setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <>
      <select value={map} onChange={(e) => { setMap(e.target.value); setIds([]); }}>
        {maps.map((m) => <option key={m} value={m}>{mapPretty(m)}</option>)}
      </select>
      <div className="pick-list clip-matches">
        {library.filter((m) => m.map === map).map((m) => (
          <label key={m.id} className="pick">
            <input type="checkbox" checked={ids.includes(m.id)} onChange={() => toggle(m.id)} />
            {ids.includes(m.id) && <b> M{ids.indexOf(m.id) + 1} </b>}
            {m.id}
            <span className="muted small"> {Object.entries(m.score ?? {}).map(([t, s]) => `${t} ${s}`).join(" : ")}</span>
          </label>
        ))}
      </div>
    </>
  );
}
