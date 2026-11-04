// Density heatmaps on a radar: weights accumulated on a GRID x GRID raster (4 radar px per
// cell), blurred with three box passes (close to a gaussian) and coloured with a palette.
import { RADAR_SIZE } from "./radar";

export const GRID = 256;
const CELL = RADAR_SIZE / GRID;

type Stop = [number, [number, number, number]];
// names are palette.<key> in the locales
export const PALETTES: Record<string, { stops: Stop[] }> = {
  inferno: { stops: [[0, [0, 0, 4]], [0.25, [87, 16, 110]], [0.5, [188, 55, 84]], [0.75, [249, 142, 9]], [1, [252, 255, 164]]] },
  viridis: { stops: [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]] },
  ice: { stops: [[0, [8, 16, 48]], [0.35, [30, 90, 200]], [0.7, [80, 200, 255]], [1, [240, 255, 255]]] },
  red: { stops: [[0, [60, 0, 0]], [0.5, [220, 30, 30]], [1, [255, 230, 120]]] },
};

function color(stops: Stop[], v: number): [number, number, number] {
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const f = (v - a) / (b - a);
      return [0, 1, 2].map((c) => ca[c] + (cb[c] - ca[c]) * f) as [number, number, number];
    }
  }
  return stops[stops.length - 1][1];
}

export const newGrid = () => new Float32Array(GRID * GRID);

/** Add a weight at a radar-pixel position. */
export function add(grid: Float32Array, px: number, py: number, w = 1) {
  const i = Math.floor(px / CELL), j = Math.floor(py / CELL);
  if (i >= 0 && j >= 0 && i < GRID && j < GRID) grid[j * GRID + i] += w;
}

function boxBlur(src: Float32Array, r: number): Float32Array {
  if (r < 1) return src;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pass = (a: Float32Array, b: Float32Array, horizontal: boolean) => {
    for (let line = 0; line < GRID; line++) {
      let sum = 0;
      const at = (k: number) => (horizontal ? a[line * GRID + k] : a[k * GRID + line]);
      for (let k = -r; k <= r; k++) if (k >= 0 && k < GRID) sum += at(k);
      for (let k = 0; k < GRID; k++) {
        const idx = horizontal ? line * GRID + k : k * GRID + line;
        b[idx] = sum / (2 * r + 1);
        const inc = k + r + 1, rem = k - r;
        if (inc < GRID) sum += at(inc);
        if (rem >= 0) sum -= at(rem);
      }
    }
  };
  let cur = src;
  for (let n = 0; n < 3; n++) {
    pass(cur, tmp, true);
    pass(tmp, out, false);
    cur = out.slice();
  }
  return cur;
}

export interface HeatOptions {
  radius: number; // blur radius in cells
  palette: string;
  opacity: number; // 0..1
  scale: "linear" | "log";
}

/** Draw a density grid over a radar panel of `size` px at (ox, 0). */
export function drawHeat(ctx: CanvasRenderingContext2D, grid: Float32Array, ox: number, size: number, o: HeatOptions) {
  const g = boxBlur(grid, Math.round(o.radius / 3));
  let max = 0;
  for (const v of g) if (v > max) max = v;
  if (max <= 0) return;
  const stops = PALETTES[o.palette]?.stops ?? PALETTES.inferno.stops;
  const img = new ImageData(GRID, GRID);
  const lmax = Math.log1p(max);
  for (let k = 0; k < g.length; k++) {
    const v = o.scale === "log" ? Math.log1p(g[k]) / lmax : Math.pow(g[k] / max, 0.7);
    if (v < 0.05) continue;
    const [r, gg, b] = color(stops, v);
    img.data[k * 4] = r;
    img.data[k * 4 + 1] = gg;
    img.data[k * 4 + 2] = b;
    img.data[k * 4 + 3] = 255 * o.opacity * Math.pow(Math.min(1, v * 1.25), 1.4); // rare places stay see-through
  }
  const off = document.createElement("canvas");
  off.width = off.height = GRID;
  off.getContext("2d")!.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, ox, 0, size, size);
  ctx.restore();
}
