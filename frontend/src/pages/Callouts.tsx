import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { go } from "../App";
import { drawCallouts } from "../callouts";
import { mapPretty } from "../components/MatchPicker";
import { t, td } from "../i18n";
import { drawRadar, levelLabel, useMapAssets, type MapAssets } from "../radar";

// the order of the list: from the sites outwards
const GROUPS = ["A", "A_approach", "B", "B_approach", "mid", "t_spawn", "ct_spawn"];

function draw(canvas: HTMLCanvasElement, assets: MapAssets, size: number, highlight: string | null) {
  const { meta, images } = assets;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  meta.levels.forEach((_, li) => {
    drawRadar(ctx, images[li], li * size, size);
    drawCallouts(ctx, meta, li, li * size, size, { highlight });
    if (meta.levels.length > 1) {
      ctx.fillStyle = "#fff";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(levelLabel(meta, li), li * size + 10, 20);
    }
  });
}

/** Every map of the pool with its position names: to learn them, no demo needed. */
export function CalloutsPage({ map }: { map?: string }) {
  const [maps, setMaps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    api.maps().then(setMaps).catch((e: Error) => setError(e.message));
  }, []);
  const active = map ?? maps[0];
  const { assets, error: mapError } = useMapAssets(active);
  const ready = assets && assets.meta.map === active ? assets : null;
  const ref = useRef<HTMLCanvasElement>(null);
  const n = ready?.meta.levels.length ?? 1;
  const size = Math.min(n > 1 ? 640 : 860, Math.floor((window.innerWidth - (n > 1 ? 140 : 420)) / n));
  useEffect(() => {
    if (ref.current && ready) draw(ref.current, ready, size, highlight);
  }, [ready, size, highlight]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, Set<string>>();
    for (const z of ready?.meta.zones ?? []) {
      const g = z.group ?? "";
      if (!byGroup.has(g)) byGroup.set(g, new Set());
      byGroup.get(g)!.add(z.name);
    }
    return [...byGroup].sort((a, b) => GROUPS.indexOf(a[0]) - GROUPS.indexOf(b[0]));
  }, [ready]);
  const dpr = window.devicePixelRatio || 1;

  return (
    <div className="page">
      <div className="pagehead"><h1>{t("callouts.title")}</h1><div className="sub">{t("callouts.sub")}</div></div>
      {(error || mapError) && <div className="error">{error ?? mapError}</div>}
      <div className="filters">
        <span className="seg wrap">
          {maps.map((m) => <button key={m} className={m === active ? "on" : ""} onClick={() => go("callouts", m)}>{mapPretty(m)}</button>)}
        </span>
      </div>
      {!ready ? <div>{t("common.loading")}</div> : (
        <div className="callouts">
          <canvas ref={ref} width={size * n * dpr} height={size * dpr} style={{ width: size * n, height: size }} />
          <div className="callout-list">
            {groups.map(([g, names]) => (
              <div key={g}>
                <h3>{td(`callouts.group.${g}`, g)}</h3>
                <div className="zone-chips">
                  {[...names].sort().map((name) => (
                    <span key={name} className={name === highlight ? "on" : ""} onMouseEnter={() => setHighlight(name)} onMouseLeave={() => setHighlight(null)}>{name}</span>
                  ))}
                </div>
              </div>
            ))}
            <div className="muted small">{t("callouts.hint")}</div>
          </div>
        </div>
      )}
    </div>
  );
}
