import { useEffect, useState } from "react";
import { api } from "./api";
import { LibraryPage } from "./pages/Library";
import { MatchPage } from "./pages/Match";
import { AggregatePage } from "./pages/Aggregate";
import { HighlightsPage } from "./pages/Highlights";
import { CalloutsPage } from "./pages/Callouts";
import { ScoutPage } from "./pages/Scout";
import { ClipView } from "./components/ClipView";
import { LineupsView } from "./components/LineupsView";
import { IconLibrary, IconLogo, IconMap, IconScout, IconStar, IconUs } from "./components/Icons";
import { LANGS, detectSystemLang, setLang, t, useLang, type Key, type Lang } from "./i18n";

// Hash routes: #/ (library), #/match/<id>/<tab>[/<round>[/<seconds after freeze end>]], #/aggregate, #/clip, #/lineups,
// #/highlights[/<id>], #/callouts[/<map>], #/scout[/<team>[/<map>[/<tab>]]][?last=&side=&buy=&rounds=]
function useHash(): string[] {
  const read = () => window.location.hash.split("?")[0].replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

/** The ?a=b part of the hash route. */
export const hashQuery = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");

export const go = (...parts: (string | number)[]) => {
  window.location.hash = "#/" + parts.map((p) => encodeURIComponent(String(p))).join("/");
};

export function App() {
  const [page, ...rest] = useHash();
  const lang = useLang();
  useEffect(() => detectSystemLang(() => api.system().then((s) => s.locale)), []);
  const [own, setOwn] = useState<string | null>(null);
  useEffect(() => {
    api.teams().then((d) => setOwn(d.own)).catch(() => {});
  }, []);
  const us = own ? `scout/${encodeURIComponent(own)}` : null;
  const nav: [string, Key, typeof IconLibrary][] = [
    ["", "nav.library", IconLibrary],
    ["scout", "nav.scout", IconScout],
    ...(us ? [[us, "nav.us", IconUs] as [string, Key, typeof IconLibrary]] : []),
    ["highlights", "nav.highlights", IconStar],
    ["callouts", "nav.callouts", IconMap],
  ];
  // the old pages stay reachable from the scout page: they live under it
  const active = page === "match" ? ""
    : page === "scout" && own && rest[0] === own ? us ?? ""
    : page === "aggregate" || page === "clip" || page === "lineups" ? "scout"
    : page ?? "";
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
              {t(label)}
            </a>
          ))}
        </nav>
        <LangSwitch lang={lang} />
      </aside>
      <div className="content">
        <header className="topbar">
          <a className="wordmark" href="#/">
            CS2<b>LENS</b>
            <small>{t("app.tagline")}</small>
          </a>
        </header>
        {/* Pages are remounted on a language change: canvases and memoized texts are drawn in the language */}
        <main key={lang}>
          {page === "match" && rest[0] ? (
            <MatchPage id={rest[0]} tab={rest[1] ?? "overview"} round={rest[2] ? Number(rest[2]) : undefined} at={rest[3] ? Number(rest[3]) : undefined} />
          ) : page === "callouts" ? (
            <CalloutsPage map={rest[0]} />
          ) : page === "scout" ? (
            <ScoutPage team={rest[0]} map={rest[1]} tab={rest[2] ?? "summary"} onOwn={setOwn} />
          ) : page === "aggregate" ? (
            <AggregatePage />
          ) : page === "clip" ? (
            <div className="page">
              <div className="pagehead"><h1>{t("clips.title")}</h1><div className="sub">{t("clips.sub")}</div></div>
              <ClipView />
            </div>
          ) : page === "lineups" ? (
            <div className="page">
              <div className="pagehead"><h1>{t("lineups.title")}</h1><div className="sub">{t("lineups.sub")}</div></div>
              <LineupsView />
            </div>
          ) : page === "highlights" ? (
            <HighlightsPage id={rest[0]} />
          ) : (
            <LibraryPage />
          )}
        </main>
      </div>
    </div>
  );
}

function LangSwitch({ lang }: { lang: Lang }) {
  return (
    <label className="lang" title={t("lang.label")}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
      </svg>
      <span>{lang.toUpperCase()}</span>
      {/* the native select is invisible on top of the label, so the narrow sidebar shows just the code */}
      <select value={lang} aria-label={t("lang.label")} onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGS.map(([code, name]) => <option key={code} value={code}>{code.toUpperCase()} · {name}</option>)}
      </select>
    </label>
  );
}
