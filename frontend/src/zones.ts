// Callout of a world position from the map config polygons, the same rules as cs2lens/maps:
// polygons of the point's level only, the smaller zone wins where zones overlap, and a
// point up to SNAP units outside every zone belongs to the nearest one.
import type { MapMeta } from "./api";
import { levelOf } from "./radar";

const SNAP = 64;

interface Zone {
  name: string;
  group: string | null;
  level: string;
  poly: [number, number][];
  area: number;
}

const prepared = new WeakMap<MapMeta, Zone[]>();

function zonesOf(meta: MapMeta): Zone[] {
  let z = prepared.get(meta);
  if (!z) {
    z = meta.zones
      .map((zone) => {
        let area = 0;
        zone.polygon.forEach(([x1, y1], i) => {
          const [x2, y2] = zone.polygon[(i + 1) % zone.polygon.length];
          area += x1 * y2 - x2 * y1;
        });
        return { name: zone.name, group: zone.group, level: zone.level, poly: zone.polygon, area: Math.abs(area) / 2 };
      })
      .sort((a, b) => a.area - b.area);
    prepared.set(meta, z);
  }
  return z;
}

function inside(poly: [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function edgeDistance(poly: [number, number][], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j], [x2, y2] = poly[i];
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}

export const hasZones = (meta: MapMeta) => meta.zones.length > 0;

/** The zone at a world position, or null when the map has no config or the point is off every zone. */
export function zoneAt(meta: MapMeta, x: number | null, y: number | null, z: number | null): { name: string; group: string | null } | null {
  if (x === null || y === null) return null;
  const level = meta.levels[levelOf(meta, z)]?.name;
  const zones = zonesOf(meta).filter((zone) => meta.levels.length === 1 || zone.level === level);
  for (const zone of zones) if (inside(zone.poly, x, y)) return zone;
  let near: Zone | null = null, best = SNAP;
  for (const zone of zones) {
    const d = edgeDistance(zone.poly, x, y);
    if (d <= best) {
      best = d;
      near = zone;
    }
  }
  return near;
}
