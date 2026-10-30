// Typed client for the FastAPI backend (cs2lens/app/server.py).

export type Row = Record<string, string | number | boolean | null>;
export type Tables = Record<string, Row[]>;
export type Side = "terrorist" | "counter-terrorist";

export interface LibraryMatch {
  id: string;
  map: string;
  has_replay: boolean;
  modified: number;
  score?: Record<string, number>;
  rounds?: number;
  error?: string;
}

export interface LibraryDemo {
  path: string;
  name: string;
  size_mb: number;
  extracted: boolean;
  job: number | null;
}

export interface Library {
  out: string;
  folders: string[];
  matches: LibraryMatch[];
  demos: LibraryDemo[];
}

export interface Job {
  id: number;
  kind: "extract" | "replay";
  target: string;
  match_id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  stage: string;
  error: string | null;
}

export interface TimelineRound {
  round: number;
  winner_side: Side;
  winner: string | null;
  reason: string;
  plant_site: string | null;
  defused: boolean;
  duration: number;
  teams: Record<string, { side: Side; buy: string | null; equip: number | null; kills: number }>;
}

export interface MatchOverview {
  id: string;
  map: string;
  tick_rate: number;
  has_config: boolean;
  has_replay: boolean;
  header: Record<string, string | null>;
  score: Record<string, number>;
  timeline: TimelineRound[];
  team_stats: Tables;
  players: Row[];
}

export interface TacticsResult {
  tables: Tables | null;
  error: string | null;
  warnings: string[];
}

export interface Points {
  map: string;
  kills: Row[];
  utility: Row[];
  utility_error: string | null;
}

export interface Level {
  name: string;
  z_min: number;
  z_max: number;
  radar: string;
  has_image: boolean;
}

export interface MapMeta {
  map: string;
  pos_x: number;
  pos_y: number;
  scale: number;
  levels: Level[];
  config_source: string | null;
  sites: { site: string; level: string; polygon: [number, number][] }[];
  zones: { name: string; group: string | null; level: string; polygon: [number, number][] }[];
}

export interface ReplayPlayer {
  steamid: string;
  name: string;
  team: string | null;
  side: Side;
  x: (number | null)[];
  y: (number | null)[];
  z: (number | null)[];
  yaw: (number | null)[];
  hp: number[];
  armor: number[];
  helmet: number[] | null;
  kit: number[] | null;
  bomb: number[];
  weapon: number[];
  defusing: number[] | null;
  money: number | null;
}

export interface ReplayGrenade {
  type: string;
  thrower: string | null;
  side: Side | null;
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  end: number;
}

export interface ReplayArea {
  start: number;
  end: number;
  x: number;
  y: number;
  z: number;
}

export interface ReplayKill {
  tick: number;
  attacker: string | null;
  victim: string;
  assister: string | null;
  attacker_name: string | null;
  victim_name: string;
  attacker_side: Side | null;
  victim_side: Side;
  weapon: string;
  headshot: boolean;
  thrusmoke: boolean;
  noscope: boolean;
  wallbang: boolean;
  flashed: boolean;
  ax: number | null;
  ay: number | null;
  az: number | null;
  vx: number;
  vy: number;
  vz: number;
}

export interface ReplayBombEvent {
  tick: number;
  event: string;
  site: string | null;
  player: string | null;
  x: number;
  y: number;
  z: number;
}

export interface Replay {
  format: number;
  map: string;
  round: number;
  tick_rate: number;
  start_tick: number;
  freeze_end_tick: number;
  end_tick: number;
  last_tick: number;
  winner_side: Side;
  reason: string;
  step: number;
  low_res: boolean;
  ticks: number[];
  teams: Partial<Record<Side, string>>;
  weapons: string[];
  players: ReplayPlayer[];
  grenades: ReplayGrenade[];
  smokes: ReplayArea[];
  fires: ReplayArea[];
  blinds: { tick: number; attacker: string; victim: string; duration: number }[];
  kills: ReplayKill[];
  bomb: ReplayBombEvent[];
  shots: { tick: number[]; player: string[] };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const m = (id: string) => `/api/matches/${encodeURIComponent(id)}`;

export const api = {
  library: () => request<Library>("/api/library"),
  addFolder: (path: string) => request<{ folders: string[] }>("/api/library/folders", json({ path })),
  removeFolder: (path: string) =>
    request<{ folders: string[] }>(`/api/library/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  extract: (path: string) => request<{ job: number }>("/api/extract", json({ path })),
  upload: (file: File) =>
    request<{ job: number }>(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "PUT", body: file }),
  jobs: () => request<Job[]>("/api/jobs"),
  buildReplayData: (id: string) => request<{ job: number }>(`${m(id)}/replay-data`, { method: "POST" }),
  match: (id: string) => request<MatchOverview>(m(id)),
  tactics: (id: string) => request<TacticsResult>(`${m(id)}/tactics`),
  points: (id: string) => request<Points>(`${m(id)}/points`),
  replay: (id: string, round: number) => request<Replay>(`${m(id)}/rounds/${round}/replay`),
  mapMeta: (map: string) => request<MapMeta>(`/api/maps/${map}`),
  aggregate: (ids: string[], aliases: Record<string, string>) =>
    request<{ tables: Tables; warnings: string[] }>("/api/aggregate", json({ ids, aliases })),
};

export const radarUrl = (name: string) => `/api/radar/${name}.png`;
