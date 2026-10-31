import { useEffect, useState } from "react";
import { LibraryPage } from "./pages/Library";
import { MatchPage } from "./pages/Match";
import { AggregatePage } from "./pages/Aggregate";
import { ClipView } from "./components/ClipView";
import { LineupsView } from "./components/LineupsView";

// Hash routes: #/ (library), #/match/<id>/<tab>[/<round>[/<seconds after freeze end>]], #/aggregate, #/clip, #/lineups
function useHash(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export const go = (...parts: (string | number)[]) => {
  window.location.hash = "#/" + parts.map((p) => encodeURIComponent(String(p))).join("/");
};

export function App() {
  const [page, ...rest] = useHash();
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          cs2lens
        </a>
        <nav>
          <a href="#/" className={!page ? "active" : ""}>
            Библиотека
          </a>
          <a href="#/aggregate" className={page === "aggregate" ? "active" : ""}>
            Несколько матчей
          </a>
          <a href="#/clip" className={page === "clip" ? "active" : ""}>
            Клипы
          </a>
          <a href="#/lineups" className={page === "lineups" ? "active" : ""}>
            Лайнапы
          </a>
        </nav>
      </header>
      <main>
        {page === "match" && rest[0] ? (
          <MatchPage id={rest[0]} tab={rest[1] ?? "overview"} round={rest[2] ? Number(rest[2]) : undefined} at={rest[3] ? Number(rest[3]) : undefined} />
        ) : page === "aggregate" ? (
          <AggregatePage />
        ) : page === "clip" ? (
          <div className="page">
            <ClipView />
          </div>
        ) : page === "lineups" ? (
          <div className="page">
            <LineupsView />
          </div>
        ) : (
          <LibraryPage />
        )}
      </main>
    </div>
  );
}
