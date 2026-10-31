// Typed client for the FastAPI backend (cs2lens/app/server.py).

export type Row = Record<string, string | number | boolean | null>;
export type Tables = Record<string, Row[]>;
export type Side = "terrorist" | "counter-terrorist";

export interface LibraryMatch {
  id: string;
  map: string;
  has_replay: boolean;
  modified: number;
  busy: boolean;
  score?: Record<string, number>;
  rounds?: number;
  error?: string;
}

export interface LibraryDemo {
  path: string;
  name: string;
  size_mb: number;
  map: string | null;
  match_id: string;
  uploaded: boolean;
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
  kind: "extract" | "replay" | "unpack";
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
  shots: Row[];
  damages: Row[];
  blinds: Row[];
  plants: Row[];
}

export interface Movement {
  cell: number; // radar px per cell
  levels: [number, number, number][][]; // per level: [i, j, samples]
  samples: number;
  player_seconds: number;
}

export interface Throw {
  id: string;
  round_num: number;
  tick: number;
  sec: number;
  steamid: string;
  name: string;
  team: string | null;
  side: Side;
  type: string; // smoke | flashbang | he | molotov | decoy
  weapon: string;
  technique: string | null; // stand | walk | run | jump | run_jump
  speed: number | null;
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  land_x: number | null;
  land_y: number | null;
  land_z: number | null;
  flight_sec: number | null;
  throw_zone: string | null;
  land_zone: string | null;
}

export interface Throws {
  map: string;
  tick_rate: number;
  playdemo: string | null; // demo path for CS2's playdemo, when the demo is inside the game folder
  throws: Throw[];
}

export interface CS2Status {
  game_dir: string | null;
  cfg_dir: string | null;
  port: number;
  connected: boolean;
  loaded: string | null;
  state: { phase: "idle" | "launching" | "loading" | "done" | "error"; message: string; time: number };
}

export interface Lineup {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  weapon: string;
  label: string;
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
  inv: [number, number][] | null; // [tick, index into Replay.items] at every inventory change
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
  assister_name: string | null;
  hitgroup: string | null;
  trade: boolean;
  traded: boolean;
  dist: number | null; // world units
  attacker_hp: number | null;
  victim_weapon: string | null;
  given: [number, number]; // [hits, damage] killer -> victim this round
  taken: [number, number]; // [hits, damage] victim -> killer this round
  duel_start: number | null; // tick of the first hit between the two
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
  items: (string | null)[][]; // inventories: [primary, secondary, ...grenades]
  players: ReplayPlayer[];
  grenades: ReplayGrenade[];
  smokes: ReplayArea[];
  fires: ReplayArea[];
  blinds: { tick: number; attacker: string; victim: string; duration: number }[];
  kills: ReplayKill[];
  bomb: ReplayBombEvent[];
  // gun shots: shooter position and view yaw; hx/hy is the victim's position when the shot hit
  shots: { tick: number[]; player: string[]; x: number[]; y: number[]; yaw: number[]; hx: (number | null)[]; hy: (number | null)[] };
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
  upload: (file: File, onProgress?: (loaded: number) => void) =>
    new Promise<{ job: number | null; name: string }>((resolve, reject) => {
      // XHR rather than fetch: only XHR reports upload progress.
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
      xhr.onload = () => {
        let body: { detail?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as { job: number | null; name: string });
        else reject(new Error(`${xhr.status}: ${body.detail ?? xhr.statusText}`));
      };
      xhr.onerror = () => reject(new Error(`${file.name}: соединение прервано`));
      xhr.send(file);
    }),
  deleteMatch: (id: string, demo: boolean) =>
    request<{ deleted: string; demo: string | null }>(`${m(id)}?demo=${demo}`, { method: "DELETE" }),
  deleteDemo: (path: string) => request<{ deleted: string }>(`/api/demos?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  jobs: () => request<Job[]>("/api/jobs"),
  buildReplayData: (id: string) => request<{ job: number }>(`${m(id)}/replay-data`, { method: "POST" }),
  match: (id: string) => request<MatchOverview>(m(id)),
  tactics: (id: string) => request<TacticsResult>(`${m(id)}/tactics`),
  points: (id: string) => request<Points>(`${m(id)}/points`),
  movement: (id: string, f: { team: string; side: string; player: string; round_from: number; round_to: number; t_from: number; t_to: number }) =>
    request<Movement>(`${m(id)}/movement?${new URLSearchParams(Object.entries(f).map(([k, v]) => [k, String(v)]))}`),
  throws: (id: string) => request<Throws>(`${m(id)}/throws`),
  cs2: () => request<CS2Status>("/api/cs2"),
  cs2Settings: (game_dir: string | null, port: number | null) => request<CS2Status>("/api/cs2/settings", json({ game_dir, port })),
  cs2Open: (map: string, lineup: Lineup, reload = false) =>
    request<{ mode: "netcon" | "launch"; steam_url: string | null; cfg: string | null }>("/api/cs2/open", json({ map, lineup, reload })),
  cs2List: (map: string, name: string, lineups: Lineup[], install: boolean) =>
    request<{ text: string; file: string; exec: string; path: string | null }>("/api/cs2/list", json({ map, name, lineups, install })),
  cs2RunList: (map: string, name: string) =>
    request<{ mode: "netcon" | "launch"; steam_url: string | null }>("/api/cs2/run-list", json({ map, name })),
  cs2Demo: (match_id: string, tick: number, player: string) =>
    request<{ mode: "netcon" | "launch"; steam_url: string | null }>("/api/cs2/demo", json({ match_id, tick, player })),
  replay: (id: string, round: number) => request<Replay>(`${m(id)}/rounds/${round}/replay`),
  mapMeta: (map: string) => request<MapMeta>(`/api/maps/${map}`),
  aggregate: (ids: string[], aliases: Record<string, string>) =>
    request<{ tables: Tables; warnings: string[] }>("/api/aggregate", json({ ids, aliases })),
};

export const radarUrl = (name: string) => `/api/radar/${name}.png`;
