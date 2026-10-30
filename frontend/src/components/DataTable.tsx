import { useMemo, useState } from "react";
import type { Row } from "../api";

// Column headers in Russian; unknown columns are shown as-is.
const LABELS: Record<string, string> = {
  team: "команда", side: "сторона", rounds: "раунды", wins: "победы", win_pct: "% побед", rounds_won: "выиграно",
  round_win_pct: "% раундов", kills: "убийства", deaths: "смерти", assists: "ассисты", kd: "K/D", adr: "ADR", kast: "KAST",
  hs_pct: "HS %", headshots: "хедшоты", buy: "закуп", opp_buy: "закуп соперника", avg_equip: "ср. экип.",
  avg_opp_equip: "ср. экип. соперника", reason_name: "причина", opening_kills: "первые убийства",
  opening_deaths: "первые смерти", opening_win_pct: "% опенингов", trade_kills: "трейд-убийства", trade_kill_pct: "% трейдов",
  traded_deaths: "отомщённые смерти", traded_death_pct: "% отомщённых", plants: "планты", plant_pct: "% плантов",
  avg_plant_sec: "ср. время планта, с", target_site: "сайт", plant_site: "сайт планта", round_num: "раунд",
  exec_sec: "старт экзекута, с", plant_sec: "плант, с", tempo: "темп", package: "пакет", won: "победа", entry: "заход",
  package_zones: "куда легли гранаты", setup: "сетап", plants_faced: "плантов против", retake_wins: "ретейков выиграно",
  retake_win_pct: "% ретейков", avg_rotators: "ср. ротирующих", avg_arrived: "ср. доехали", avg_before_plant: "ср. до планта",
  avg_rot_sec: "ср. время ротации, с", name: "игрок", matches: "матчи", map: "карта", rounds_played: "раунды",
  utility_damage: "урон гранатами", flashes_thrown: "флешек", enemies_flashed: "ослеплено врагов",
  clutches_won: "клатчи выиграны", clutches_played: "клатчи сыграны", avg_exec_start_sec: "ср. старт экзекута, с",
  smokes: "смоки", flashes: "флешки", mollies: "молотовы", hes: "HE", early: "ранние", mid: "средние", late: "поздние",
  score: "счёт", winner: "победитель", duration: "длительность, с", reason: "причина", teams: "команды", match: "матч", t_rounds: "раундов за T", ct_rounds: "раундов за CT",
};

const SIDES: Record<string, string> = { terrorist: "T", "counter-terrorist": "CT" };

function fmt(v: Row[string]): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1);
  return SIDES[v] ?? v;
}

interface Props {
  rows: Row[];
  columns?: string[];
  title?: string;
  maxHeight?: number;
  onRowClick?: (row: Row) => void;
}

export function DataTable({ rows, columns, title, maxHeight, onRowClick }: Props) {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]).filter((c) => !c.includes("steamid")) : []);
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const s = [...rows].sort((a, b) => {
      const x = a[sort.col], y = b[sort.col];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return x < y ? -1 : 1;
    });
    return sort.desc ? s.reverse() : s;
  }, [rows, sort]);

  return (
    <div className="table-block">
      {title && <h3>{title}</h3>}
      {rows.length === 0 ? (
        <div className="muted">нет данных</div>
      ) : (
        <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c}
                    title={c}
                    onClick={() => setSort((s) => ({ col: c, desc: s?.col === c ? !s.desc : true }))}
                  >
                    {LABELS[c] ?? c}
                    {sort?.col === c ? (sort.desc ? " ▾" : " ▴") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? "clickable" : ""}>
                  {cols.map((c) => (
                    <td key={c} className={typeof r[c] === "number" ? "num" : ""}>
                      {fmt(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
