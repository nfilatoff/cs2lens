import { useEffect, useState } from "react";
import { api, type MatchOverview, type TacticsResult, type TimelineRound } from "../api";
import { go } from "../App";
import { DataTable } from "../components/DataTable";
import { ReplayView } from "../components/Replay";
import { MapsView } from "../components/MapsView";
import { ClipView } from "../components/ClipView";
import { sideColor, sideShort } from "../radar";

const TABS: [string, string][] = [
  ["overview", "Обзор"],
  ["players", "Игроки"],
  ["tactics", "Тактика"],
  ["replay", "2D-реплей"],
  ["maps", "Карты"],
  ["clip", "Клип (GIF/видео)"],
];

export const REASONS: Record<string, string> = {
  target_bombed: "взрыв бомбы",
  bomb_defused: "разминирование",
  ct_win: "все T убиты",
  terrorists_win: "все CT убиты",
  target_saved: "время вышло",
  terrorists_surrender: "сдача T",
  cts_surrender: "сдача CT",
};
const REASON_ICON: Record<string, string> = { target_bombed: "💥", bomb_defused: "✂", target_saved: "⏱" };

export function MatchPage({ id, tab, round, at }: { id: string; tab: string; round?: number; at?: number }) {
  const [match, setMatch] = useState<MatchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMatch(null);
    api.match(id).then(setMatch).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <div className="page error">{error}</div>;
  if (!match) return <div className="page">Загрузка матча…</div>;
  const teams = Object.entries(match.score);

  return (
    <div className="page">
      <div className="match-head">
        <div className="match-map">{match.map}</div>
        <div className="match-score">
          {teams.map(([t, s], i) => (
            <span key={t}>
              {i > 0 && <span className="muted"> : </span>}
              <span className="team-name">{t}</span> <b>{s}</b>
            </span>
          ))}
        </div>
        <div className="muted small">{match.id}</div>
      </div>
      <div className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} href={`#/match/${encodeURIComponent(id)}/${key}`} className={tab === key ? "active" : ""}>
            {label}
          </a>
        ))}
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
      {tab === "clip" && <ClipView match={match} />}
    </div>
  );
}

function RoundStrip({ match }: { match: MatchOverview }) {
  const teams = Object.keys(match.score);
  return (
    <div className="round-strip">
      {teams.map((team) => (
        <div key={team} className="strip-row">
          <div className="strip-team">{team}</div>
          {match.timeline.map((r: TimelineRound) => {
            const t = r.teams[team];
            const won = r.winner === team;
            return (
              <div
                key={r.round}
                className={`strip-cell ${won ? "won" : ""}`}
                style={won ? { background: sideColor(t?.side) } : { borderColor: sideColor(t?.side) }}
                title={`Раунд ${r.round}: ${t ? sideShort(t.side) : ""}, закуп ${t?.buy ?? "?"} (${t?.equip ?? "?"}$), убийств ${t?.kills ?? 0}` +
                  (won ? `, победа — ${REASONS[r.reason] ?? r.reason}` : "") +
                  (r.plant_site ? `, плант ${r.plant_site}` : "")}
                onClick={() => go("match", match.id, "replay", r.round)}
              >
                {won ? REASON_ICON[r.reason] ?? "" : ""}
              </div>
            );
          })}
        </div>
      ))}
      <div className="strip-row">
        <div className="strip-team muted small">раунд</div>
        {match.timeline.map((r) => (
          <div key={r.round} className="strip-num">
            {r.round}
          </div>
        ))}
      </div>
    </div>
  );
}

function Overview({ match }: { match: MatchOverview }) {
  const ts = match.team_stats;
  return (
    <div>
      <h3>Ход матча</h3>
      <div className="muted small">Клик по раунду открывает 2D-реплей. Цвет — сторона победителя.</div>
      <RoundStrip match={match} />
      <DataTable
        title="Раунды"
        maxHeight={360}
        rows={match.timeline.map((r) => {
          const row: Record<string, string | number | boolean | null> = {
            round_num: r.round,
            winner: r.winner,
            side: r.winner_side,
            reason: REASONS[r.reason] ?? r.reason,
            plant_site: r.plant_site,
            duration: r.duration,
          };
          for (const [team, t] of Object.entries(r.teams)) {
            row[`${team}: закуп`] = `${t.buy ?? ""} ${t.equip ?? ""}$`;
            row[`${team}: убийства`] = t.kills;
          }
          return row;
        })}
        onRowClick={(r) => go("match", match.id, "replay", Number(r.round_num))}
      />
      <DataTable title="Сводка" rows={ts.summary} />
      <div className="grid2">
        <DataTable title="По сторонам" rows={ts.by_side} />
        <DataTable title="Опенинги" rows={ts.opening} />
        <DataTable title="Трейды" rows={ts.trades} />
        <DataTable title="Как выигрывались раунды" rows={ts.win_reasons} />
        <DataTable title="T: планты" rows={ts.bomb_t} />
        <DataTable title="CT: ретейки и дефьюзы" rows={ts.bomb_ct} />
      </div>
      <DataTable title="Раунды по закупам (свой vs соперника)" rows={ts.by_buy} />
    </div>
  );
}

function Tactics({ id }: { id: string }) {
  const [t, setT] = useState<TacticsResult | null>(null);
  useEffect(() => {
    api.tactics(id).then(setT).catch((e: Error) => setT({ tables: null, error: e.message, warnings: [] }));
  }, [id]);
  if (!t) return <div>Считаю тактику…</div>;
  return (
    <div>
      {t.warnings.map((w) => (
        <div key={w} className="warn">
          {w}
        </div>
      ))}
      {t.error && <div className="error">Тактика не посчитана: {t.error}</div>}
      {t.tables && (
        <>
          <DataTable title="Экзекуты T по сайтам" rows={t.tables.executes} />
          <DataTable
            title="Раунды T: цель, темп, заход и пакет гранат"
            rows={t.tables.rounds_t}
            columns={["team", "round_num", "target_site", "exec_sec", "plant_sec", "tempo", "package", "entry", "package_zones", "won"]}
            onRowClick={(r) => go("match", id, "replay", Number(r.round_num))}
          />
          <DataTable
            title="Сетапы CT (сколько CT у A / B / в центре)"
            rows={t.tables.setups}
            columns={["team", "round_num", "setup", "plant_site", "buy", "won"]}
            maxHeight={400}
            onRowClick={(r) => go("match", id, "replay", Number(r.round_num))}
          />
          <DataTable title="Ротации CT по сайту планта" rows={t.tables.rotations} />
        </>
      )}
    </div>
  );
}
