// Frame-by-frame export of a clip to GIF (gifenc) or MP4 (WebCodecs + mp4-muxer).
// Rendering is deterministic: frame i shows clip time i / fps * speed, however long encoding takes.
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { strToU8, zipSync } from "fflate";

export type RenderFrame = (ctx: CanvasRenderingContext2D, time: number) => void;

export interface ExportJob {
  width: number;
  height: number;
  duration: number; // clip seconds
  speed: number; // clip seconds per video second
  fps: number;
  render: RenderFrame;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

function frames(job: ExportJob): number {
  return Math.max(1, Math.ceil((job.duration / job.speed) * job.fps));
}

function canvasFor(job: ExportJob): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = job.width;
  c.height = job.height;
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("отменено", "AbortError");
}

export async function exportGif(job: ExportJob): Promise<Blob> {
  const [, ctx] = canvasFor(job);
  const n = frames(job);
  const at = (i: number) => Math.min(job.duration, (i / job.fps) * job.speed);
  const pixels = () => ctx.getImageData(0, 0, job.width, job.height).data;

  // One palette for the whole clip, from a few frames spread over it: the radar dominates
  // every frame, and a shared palette avoids colour flicker between frames.
  const samples = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
  const sample = new Uint8ClampedArray(samples.length * job.width * job.height * 4);
  samples.forEach((f, k) => {
    job.render(ctx, at(f));
    sample.set(pixels(), k * job.width * job.height * 4);
  });
  const palette = quantize(sample, 256);

  const gif = GIFEncoder();
  const delay = Math.round(1000 / job.fps);
  for (let i = 0; i < n; i++) {
    checkAbort(job.signal);
    job.render(ctx, at(i));
    gif.writeFrame(applyPalette(pixels(), palette), job.width, job.height, i === 0 ? { palette, delay } : { delay });
    job.onProgress((i + 1) / n);
    if (i % 2 === 0) await yieldToUi();
  }
  gif.finish();
  return new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: "image/gif" });
}

const CODECS: { codec: string; mux: "avc" | "vp9" | "av1" }[] = [
  { codec: "avc1.640034", mux: "avc" }, // H.264 High 5.2
  { codec: "avc1.4d0034", mux: "avc" }, // H.264 Main 5.2
  { codec: "vp09.00.50.08", mux: "vp9" },
  { codec: "av01.0.12M.08", mux: "av1" },
];

export const canEncodeVideo = () => typeof VideoEncoder !== "undefined";

export async function exportMp4(job: ExportJob): Promise<Blob> {
  if (!canEncodeVideo()) throw new Error("браузер не поддерживает WebCodecs — выберите GIF или обновите браузер");
  const bitrate = Math.round(Math.min(12e6, Math.max(2e6, job.width * job.height * job.fps * 0.12)));
  // Software encoders first: they are fast enough for these frame sizes and never stall
  // the way a busy or broken GPU encoder can.
  let chosen: VideoEncoderConfig | null = null;
  let mux: (typeof CODECS)[number]["mux"] = "avc";
  search: for (const hardwareAcceleration of ["prefer-software", "no-preference"] as const) {
    for (const c of CODECS) {
      const config: VideoEncoderConfig = { codec: c.codec, width: job.width, height: job.height, bitrate, framerate: job.fps, hardwareAcceleration };
      if ((await VideoEncoder.isConfigSupported(config)).supported) {
        chosen = config;
        mux = c.mux;
        break search;
      }
    }
  }
  if (!chosen) throw new Error("ни один видеокодек (H.264, VP9, AV1) не поддерживает такой размер — уменьшите размер");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: mux, width: job.width, height: job.height, frameRate: job.fps },
    fastStart: "in-memory",
  });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(chosen);

  const [canvas, ctx] = canvasFor(job);
  const n = frames(job);
  const frameUs = 1e6 / job.fps;
  try {
    for (let i = 0; i < n; i++) {
      checkAbort(job.signal);
      if (failure) throw failure;
      job.render(ctx, Math.min(job.duration, (i / job.fps) * job.speed));
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: i % (job.fps * 2) === 0 });
      frame.close();
      job.onProgress((i + 1) / n);
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      if (i % 4 === 0) await yieldToUi();
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

/** A zip with the clip (stored as is: GIF and MP4 are compressed already) and its text description. */
export async function zipWith(mediaName: string, media: Blob, textName: string, text: string): Promise<Blob> {
  const zip = zipSync({
    [mediaName]: [new Uint8Array(await media.arrayBuffer()), { level: 0 }],
    [textName]: strToU8("﻿" + text.replace(/\n/g, "\r\n")), // BOM and CRLF: opens cleanly in Notepad
  });
  return new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
