import type { RoundRef, Row, ScoutCard, Strat } from "../api";
import { t, td } from "../i18n";
import { SampleBadge } from "./SampleBadge";

export const buyLabel = (buy: unknown) => td(`buy.${buy}`, String(buy ?? "?"));
export const nadeLabel = (type: unknown) => td(`nades.${type}`, String(type));
export const tempoLabel = (tempo: unknown) => td(`scout.tempo.${tempo}`, String(tempo));
export const stratCore = (core: Strat["core"]) => core.map((c) => `${nadeLabel(c.type)} ${c.zone}`).join(", ");

/** Report rows with values in words instead of the data's codes. */
export const namedRows = (rows: Row[]): Row[] => rows.map((r) => {
  const out = { ...r };
  if (r.buy) out.buy = buyLabel(r.buy);
  if (r.opp_buy) out.opp_buy = buyLabel(r.opp_buy);
  if (r.pistol) out.pistol = td(`scout.pistol.${r.pistol}`, String(r.pistol));
  if (r.tempo) out.tempo = tempoLabel(r.tempo);
  if (r.type) out.type = nadeLabel(r.type);
  return out;
});

export const roundHref = (r: RoundRef) => `#/match/${encodeURIComponent(r.match)}/replay/${r.round}/${r.sec}`;

/** The words of a conclusion, in the current language. */
export function cardText(card: ScoutCard): string {
  const p = card.params;
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) params[k] = typeof v === "object" ? "" : v;
  if (p.tempo) params.tempo = tempoLabel(p.tempo);
  if (p.buy) params.buy = buyLabel(p.buy);
  if (p.type) params.type = nadeLabel(p.type);
  if (Array.isArray(p.core)) params.core = stratCore(p.core) || t("scout.noSmokes");
  return td(`scout.card.${card.key}`, card.key, params);
}

/** Links that open rounds in the replay. A round number alone can repeat across matches: the title tells the match. */
export function RoundLinks({ rounds }: { rounds: RoundRef[] }) {
  return (
    <>
      {rounds.map((r) => (
        <a key={`${r.match}:${r.round}`} className="round-link" href={roundHref(r)} title={t("scout.openRound", { round: r.round, match: r.match })}>
          {t("scout.roundShort", { n: r.round })}
        </a>
      ))}
    </>
  );
}

export function InsightCards({ cards, limit }: { cards: ScoutCard[]; limit?: number }) {
  if (!cards.length) return <div className="muted">{t("scout.noConclusions")}</div>;
  return (
    <div className="insights">
      {cards.slice(0, limit ?? cards.length).map((c) => (
        <div key={c.key} className={`insight ${c.low ? "low" : ""}`}>
          <div className="insight-label">{td(`scout.cardTitle.${c.key}`, c.key)}</div>
          <div className="insight-text">{cardText(c)}</div>
          <div className="insight-foot">
            <SampleBadge rounds={c.rounds} />
            <RoundLinks rounds={c.examples} />
          </div>
        </div>
      ))}
    </div>
  );
}
