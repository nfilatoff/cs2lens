// World <-> radar-pixel transform and radar image loading, shared by the replay and map views.
import { useEffect, useState } from "react";
import { api, radarUrl, type MapMeta } from "./api";

export const RADAR_SIZE = 1024;
export const CT_COLOR = "#5aa9ff";
export const T_COLOR = "#f2b134";
export const sideColor = (side: string | null | undefined) =>
  side === "counter-terrorist" ? CT_COLOR : side === "terrorist" ? T_COLOR : "#aaa";
export const sideShort = (side: string | null | undefined) =>
  side === "counter-terrorist" ? "CT" : side === "terrorist" ? "T" : "?";

export function worldToPx(meta: MapMeta, x: number, y: number): [number, number] {
  return [(x - meta.pos_x) / meta.scale, (meta.pos_y - y) / meta.scale];
}

/** Index of the level an altitude belongs to (0 = upper/default). */
export function levelOf(meta: MapMeta, z: number | null | undefined): number {
  if (z == null) return 0;
  for (let i = 0; i < meta.levels.length; i++) {
    const lv = meta.levels[i];
    if (z >= lv.z_min && z < lv.z_max) return i;
  }
  return 0;
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`cannot load ${url}`));
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

export interface MapAssets {
  meta: MapMeta;
  images: (HTMLImageElement | null)[]; // one per level
}

const metaCache = new Map<string, Promise<MapMeta>>();

/** Map metadata plus one radar image per level (null where the image is not cached locally). */
export function useMapAssets(map: string | undefined): { assets: MapAssets | null; error: string | null } {
  const [assets, setAssets] = useState<MapAssets | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!map) return;
    let alive = true;
    let p = metaCache.get(map);
    if (!p) {
      p = api.mapMeta(map);
      metaCache.set(map, p);
    }
    p.then(async (meta) => {
      const images = await Promise.all(
        meta.levels.map((lv) => (lv.has_image ? loadImage(radarUrl(lv.radar)).catch(() => null) : Promise.resolve(null))),
      );
      if (alive) setAssets({ meta, images });
    }).catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [map]);
  return { assets, error };
}

/** Panels to draw: one per level, or a single chosen level. */
export function panelLevels(meta: MapMeta, view: number | "all"): number[] {
  return view === "all" ? meta.levels.map((_, i) => i) : [view];
}

export function levelLabel(meta: MapMeta, i: number): string {
  if (meta.levels.length === 1) return "";
  return meta.levels[i].name === "lower" ? "нижний" : "верхний";
}

/** Draw the radar background of one panel into a square of `size` px at (ox, 0). */
export function drawRadar(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, ox: number, size: number) {
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(ox, 0, size, size);
  if (img) ctx.drawImage(img, ox, 0, size, size);
  else {
    ctx.fillStyle = "#666";
    ctx.font = "14px sans-serif";
    ctx.fillText("радар не найден в ~/.awpy", ox + 12, 24);
  }
}
