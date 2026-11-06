import { useEffect, useState } from "react";
import { api, radarUrl, type MatchOverview, type ScoutTeam, type TacticsResult, type TimelineRound } from "../api";
import { go } from "../App";
import { DataTable } from "../components/DataTable";
import { ReplayView } from "../components/Replay";
import { MapsView } from "../components/MapsView";
import { ClipView } from "../components/ClipView";
import { LineupsView } from "../components/LineupsView";
import { HighlightsView } from "../components/HighlightsView";
import { InsightCards } from "../components/InsightCards";
import { sideColor, sideShort } from "../radar";
import { t, td, type Key } from "../i18n";

// A match is for going through one game; what spans games lives on the scout page.
const TABS: [string, Key][] = [
  ["overview", "tab.overview"],
  ["replay", "tab.replay"],
  ["maps", "tab.maps"],
  ["highlights", "tab.highlights"],
  ["clip", "tab.clip"],
];
const MORE_TABS: [string, Key][] = [
  ["players", "tab.players"],
  ["tactics", "tab.tactics"],
  ["lineups", "tab.lineups"],
];

/** How a round ended, in words. */
export const reasonLabel = (reason: string) => td(`reason.${reason}`, reason);
const REASON_ICON: Record<string, string> = { target_bombed: "💥", bomb_defused: "✂", target_saved: "⏱" };

const scoreClass = (mine: number, other: number) => (mine > other ? "win" : mine < other ? "lose" : "");

export function MatchPage({ id, tab, round, at }: { id: string; tab: string; round?: number; at?: number }) {
  const [match, setMatch] = useState<MatchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMatch(null);
    api.match(id).then(setMatch).catch((e: Error) => setError(e.message));
  }, [id]);
  const [known, setKnown] = useState<ScoutTeam[]>([]);
  useEffect(() => {
    api.teams().then((d) => setKnown(d.teams)).catch(() => {});
  }, []);

  if (error) return <div className="page error">{error}</div>;
  if (!match) return <div className="page">{t("match.loading")}</div>;
  const teams = Object.entries(match.score);

  return (
    <div className="page">
      <div className="mhero" style={{ backgroundImage: `url(${radarUrl(match.map)})` }}>
        <div className="crumbs">
          <a href="#/">{t("nav.library")}</a>
          <span>/</span>
          <span className="match-map">{match.map.replace(/^de_/, "")}</span>
          <span className="pill">{t("match.rounds", { n: match.timeline.length })}</span>
        </div>
        <div className="mhero-main">
          {teams.length === 2 ? (
            <>
              <div className="mteam a"><TeamLink raw={teams[0][0]} map={match.map} known={known} /></div>
              <div className="mscore">
                <span className={scoreClass(teams[0][1], teams[1][1])}>{teams[0][1]}</span>
                <span className="vs">:</span>
                <span className={scoreClass(teams[1][1], teams[0][1])}>{teams[1][1]}</span>
              </div>
              <div className="mteam b"><TeamLink raw={teams[1][0]} map={match.map} known={known} /></div>
            </>
          ) : (
            <div className="mteam">{teams.map(([t, s]) => `${t} ${s}`).join(" · ")}</div>
          )}
        </div>
        <div className="mhero-note">{match.id}</div>
      </div>
      <div className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} href={`#/match/${encodeURIComponent(id)}/${key}`} className={tab === key ? "active" : ""}>
            {t(label)}
          </a>
        ))}
        <span className="tabs-more">
          {MORE_TABS.map(([key, label]) => (
            <a key={key} href={`#/match/${encodeURIComponent(id)}/${key}`} className={tab === key ? "active" : ""}>
              {t(label)}
            </a>
          ))}
        </span>
      </div>
      {tab === "overview" && <Overview match={match} />}
      {tab === "players" && (
        <DataTable
          rows={match.players}
          columns={["name", "team", "kills", "deaths", "assists", "adr", "kast", "headshot_kills", "opening_kills", "opening_deaths",
            "traded_deaths", "clutches_won", "clutches_played", "utility_damage", "flashes_thrown", "enemies_flashed",
            "multikill_3k", "multikill_4k", "multikill_5k"].filter((c) => match.players[0] && c in match.players[0])}
        />
      )}
      {tab === "tactics" && <Tactics id={id} />}
      {tab === "replay" && <ReplayView match={match} round={round ?? match.timeline[0]?.round ?? 1} at={at} />}
      {tab === "maps" && <MapsView match={match} />}
      {tab === "lineups" && <LineupsView initial={match} />}
      {tab === "clip" && <ClipView initial={match} />}
      {tab === "highlights" && <HighlightsView match={match} round={round} at={at} />}
    </div>
  );
}

/** A team's name in a demo, leading to its dossier on this map; the dossier may know it under an alias. */
function TeamLink({ raw, map, known }: { raw: string; map: string; known: ScoutTeam[] }) {
  const name = known.find((team) => team.raw.includes(raw))?.name;
  if (!name) return <>{raw}</>;
  return <a href={`#/scout/${encodeURIComponent(name)}/${encodeURIComponent(map)}`} title={t("match.openScout", { team: name })}>{raw}</a>;
}

function RoundStrip({ match }: { match: MatchOverview }) {
  const teams = Object.keys(match.score);
  return (
    <div className="round-strip">
      {teams.map((team) => (
        <div key={team} className="strip-row">
          <div className="strip-team">{team}</div>
          {match.timeline.map((r: TimelineRound) => {
            const tm = r.teams[team];
            const won = r.winner === team;
            return (
              <div
                key={r.round}
                className={`strip-cell ${won ? "won" : ""}`}
                style={won ? { background: sideColor(tm?.side) } : { borderColor: sideColor(tm?.side) }}
                title={t("strip.title", { round: r.round, side: tm ? sideShort(tm.side) : "", buy: tm?.buy ?? "?", equip: tm?.equip ?? "?", kills: tm?.kills ?? 0 }) +
                  (won ? t("strip.won", { reason: reasonLabel(r.reason) }) : "") +
                  (r.plant_site ? t("strip.plant", { site: r.plant_site }) : "")}
                onClick={() => go("match", match.id, "replay", r.round)}
              >
                {won ? REASON_ICON[r.reason] ?? "" : ""}
              </div>
            );
          })}
        </div>
      ))}
      <div className="strip-row">
        <div className="strip-team muted small">{t("strip.round")}</div>
        {match.timeline.map((r) => (
          <div key={r.round} className="strip-num">
            {r.round}
          </div>
        ))}
      </div>
    </div>
  );
}

/** What each team did in this match, before any table. */
function MatchInsights({ id }: { id: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.insights>> | null>(null);
  useEffect(() => {
    let alive = true;
    api.insights(id).then((d) => alive && setData(d)).catch(() => alive && setData({}));
    return () => {
      alive = false;
    };
  }, [id]);
  if (!data) return <div className="muted">{t("common.loading")}</div>;
  return (
    <>
      {Object.entries(data).map(([team, ins]) => (
        <div key={team}>
          <h3>{team}</h3>
          <InsightCards cards={ins.cards} limit={4} />
        </div>
      ))}
    </>
  );
}

function Overview({ match }: { match: MatchOverview }) {
  const ts = match.team_stats;
  return (
    <div>
      <h2>{t("overview.flow")}</h2>
      <div className="muted small">{t("overview.hint")}</div>
      <RoundStrip match={match} />
      <h2>{t("overview.insights")}</h2>
      <MatchInsights id={match.id} />
      <details className="data-more">
      <summary>{t("scout.showData")}</summary>
      <DataTable
        title={t("overview.rounds")}
        maxHeight={360}
        rows={match.timeline.map((r) => {
          const row: Record<string, string | number | boolean | null> = {
            round_num: r.round,
            winner: r.winner,
            side: r.winner_side,
            reason: reasonLabel(r.reason),
            plant_site: r.plant_site,
            duration: r.duration,
          };
          for (const [team, tm] of Object.entries(r.teams)) {
            row[t("overview.colBuy", { team })] = `${tm.buy ?? ""} ${tm.equip ?? ""}$`;
            row[t("overview.colKills", { team })] = tm.kills;
          }
          return row;
        })}
        onRowClick={(r) => go("match", match.id, "replay", Number(r.round_num))}
      />
      <DataTable title={t("overview.summary")} rows={ts.summary} />
      <div className="grid2">
        <DataTable title={t("overview.bySide")} rows={ts.by_side} />
        <DataTable title={t("overview.opening")} rows={ts.opening} />
        <DataTable title={t("overview.trades")} rows={ts.trades} />
        <DataTable title={t("overview.winReasons")} rows={ts.win_reasons} />
        <DataTable title={t("overview.bombT")} rows={ts.bomb_t} />
        <DataTable title={t("overview.bombCt")} rows={ts.bomb_ct} />
      </div>
      <DataTable title={t("overview.byBuy")} rows={ts.by_buy} />
      </details>
    </div>
  );
}

function Tactics({ id }: { id: string }) {
  const [res, setRes] = useState<TacticsResult | null>(null);
  useEffect(() => {
    api.tactics(id).then(setRes).catch((e: Error) => setRes({ tables: null, error: e.message, warnings: [] }));
  }, [id]);
  if (!res) return <div>{t("tactics.loading")}</div>;
  return (
    <div>
      {res.warnings.map((w) => (
        <div key={w} className="warn">
          {w}
        </div>
      ))}
      {res.error && <div className="error">{t("tactics.failed", { error: res.error })}</div>}
      {res.tables && (
        <>
          <DataTable title={t("tactics.executes")} rows={res.tables.executes} />
          <DataTable title={t("agg.s.executes_by_buy")} rows={res.tables.executes_by_buy ?? []} />
          <DataTable
            title={t("tactics.roundsT")}
            rows={res.tables.rounds_t}
            columns={["team", "round_num", "target_site", "exec_sec", "plant_sec", "tempo", "package", "entry", "package_zones", "won"]}
            onRowClick={(r) => go("match", id, "replay", Number(r.round_num))}
          />
          <DataTable
            title={t("tactics.setups")}
            rows={res.tables.setups}
            columns={["team", "round_num", "setup", "plant_site", "buy", "won"]}
            maxHeight={400}
            onRowClick={(r) => go("match", id, "replay", Number(r.round_num))}
          />
          <DataTable title={t("tactics.rotations")} rows={res.tables.rotations} />
        </>
      )}
    </div>
  );
}
