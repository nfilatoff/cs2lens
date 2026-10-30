import { useEffect, useState } from "react";
import { LibraryPage } from "./pages/Library";
import { MatchPage } from "./pages/Match";
import { AggregatePage } from "./pages/Aggregate";

// Hash routes: #/ (library), #/match/<id>/<tab>[/<round>[/<seconds after freeze end>]], #/aggregate
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
        </nav>
      </header>
      <main>
        {page === "match" && rest[0] ? (
          <MatchPage id={rest[0]} tab={rest[1] ?? "overview"} round={rest[2] ? Number(rest[2]) : undefined} at={rest[3] ? Number(rest[3]) : undefined} />
        ) : page === "aggregate" ? (
          <AggregatePage />
        ) : (
          <LibraryPage />
        )}
      </main>
    </div>
  );
}
