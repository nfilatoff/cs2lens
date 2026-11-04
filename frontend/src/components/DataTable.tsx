import { useMemo, useState } from "react";
import type { Row } from "../api";
import { t, td } from "../i18n";

// Column headers come from the locales (col.<name>); unknown columns are shown as-is.

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
        <div className="muted">{t("table.noData")}</div>
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
                    {td(`col.${c}`, c)}
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
