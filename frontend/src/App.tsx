import { useEffect, useState } from "react";
import { LibraryPage } from "./pages/Library";
import { MatchPage } from "./pages/Match";
import { AggregatePage } from "./pages/Aggregate";
import { ClipView } from "./components/ClipView";
import { LineupsView } from "./components/LineupsView";
import { IconFilm, IconGrenade, IconLibrary, IconLogo, IconStats } from "./components/Icons";

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
  const nav: [string, string, typeof IconLibrary][] = [
    ["", "Библиотека", IconLibrary],
    ["aggregate", "Матчи", IconStats],
    ["clip", "Клипы", IconFilm],
    ["lineups", "Лайнапы", IconGrenade],
  ];
  const active = page === "match" ? "" : page ?? "";
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="logo" href="#/" title="cs2lens">
          <IconLogo />
        </a>
        <nav>
          {nav.map(([key, label, Icon]) => (
            <a key={key} href={`#/${key}`} className={`navitem ${active === key ? "active" : ""}`}>
              <Icon />
              {label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="content">
        <header className="topbar">
          <a className="wordmark" href="#/">
            CS2<b>LENS</b>
            <small>Анализатор демок</small>
          </a>
        </header>
        <main>
          {page === "match" && rest[0] ? (
            <MatchPage id={rest[0]} tab={rest[1] ?? "overview"} round={rest[2] ? Number(rest[2]) : undefined} at={rest[3] ? Number(rest[3]) : undefined} />
          ) : page === "aggregate" ? (
            <AggregatePage />
          ) : page === "clip" ? (
            <div className="page">
              <div className="pagehead"><h1>Клипы</h1><div className="sub">GIF и видео по игроку или команде из одной или нескольких демок</div></div>
              <ClipView />
            </div>
          ) : page === "lineups" ? (
            <div className="page">
              <div className="pagehead"><h1>Лайнапы</h1><div className="sub">Все броски гранат по картам с выгрузкой и запуском в CS2</div></div>
              <LineupsView />
            </div>
          ) : (
            <LibraryPage />
          )}
        </main>
      </div>
    </div>
  );
}
