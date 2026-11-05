// The dossier as a Markdown file: conclusions first, then the tables behind them.
import type { Row, ScoutQuery, ScoutReport } from "./api";
import { buyLabel, cardText, namedRows, stratCore, tempoLabel } from "./components/InsightCards";
import { t, td } from "./i18n";

const cell = (v: Row[string]) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "✓" : "✗") : String(v).replace(/\|/g, "\\|"));

function table(title: string, rows: Row[], columns: string[]): string {
  if (!rows.length) return "";
  const head = columns.map((c) => td(`col.${c}`, c));
  return [`## ${title}`, "", `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
    ...namedRows(rows).map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`), ""].join("\n");
}

const sideText = (side: string) => (side === "terrorist" ? "T" : side === "counter-terrorist" ? "CT" : t("common.bothSides"));

export function dossierMarkdown(report: ScoutReport, q: ScoutQuery): string {
  const s = report.sample;
  const out = [
    `# ${t("scout.exportTitle", { team: report.team, map: q.map.replace(/^de_/, "") })}`,
    "",
    t("scout.exportScope", { matches: s.matches, rounds: s.rounds, win: s.win_pct ?? 0, side: sideText(q.side), buy: q.buy ? buyLabel(q.buy) : t("scout.allRounds") }),
    "",
    `## ${t("scout.tab.summary")}`,
    "",
    ...report.cards.concat(report.more_cards).map((c) => `- **${td(`scout.cardTitle.${c.key}`, c.key)}:** ${cardText(c)} (${t("scout.onRounds", { n: c.rounds })}${c.low ? `, ${t("scout.lowData")}` : ""})`),
    "",
  ];
  if (report.playbook.strats.length) {
    out.push(`## ${t("scout.tab.playbook")}`, "");
    for (const st of report.playbook.strats) {
      const tempo = Object.entries(st.tempo).map(([k, n]) => `${tempoLabel(k)} ${n}`).join(", ");
      out.push(`- **${t("scout.stratTitle", { id: st.id, site: st.site })}** ${t("scout.stratLine", { n: st.rounds, share: st.share_pct, win: st.win_pct })}: ${stratCore(st.core) || t("scout.noSmokes")} (${tempo})`);
    }
    out.push("");
  }
  out.push(
    table(t("scout.executesByBuy"), report.executes_by_buy, ["buy", "target_site", "rounds", "share_pct", "win_pct", "plants", "avg_exec_sec", "avg_plant_sec"]),
    table(t("scout.afterPistol"), report.economy.after_pistol, ["pistol", "buy", "rounds", "share_pct", "win_pct", "avg_equip"]),
    table(t("scout.lossStreak"), report.economy.loss_streak, ["streak", "buy", "rounds", "share_pct", "win_pct", "avg_equip"]),
    table(t("scout.setups"), report.setups, ["setup", "rounds", "share_pct", "win_pct"]),
    table(t("scout.tab.nades"), report.nades.slice(0, 20), ["side", "type", "zone", "rounds", "per_round_pct", "median_sec"]),
    table(t("scout.tab.players"), report.players, ["name", "matches", "rounds", "kd", "adr", "kpr", "hs_pct", "opening_win_pct", "trade_kill_pct", "traded_death_pct", "nearest_mate", "top_weapons"]),
  );
  return out.filter((part) => part !== undefined).join("\n");
}

export function download(name: string, text: string, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
