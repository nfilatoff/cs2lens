// Facts about a clip, computed from the replay data and the map's callouts: a one-line
// caption drawn under the radar and a text file that goes into the archive with the clip,
// with everything needed to describe what the player or team does in these rounds.
import type { MapMeta, Replay, ReplayPlayer, Side } from "./api";
import { sideShort } from "./radar";
import { fmtClock, playerState, weaponName } from "./replayDraw";
import { hasZones, zoneAt } from "./zones";

export const ROUND_TIME = 115;
const SPAWN_GROUPS = new Set(["t_spawn", "ct_spawn"]);
const NADE_MIN_SHARE = 0.2; // a grenade spot makes the caption when it is in at least 20% of the rounds
const TABLE_STEP = 5; // seconds between rows of the position table

export const BUY_LABELS: Record<string, string> = { full: "фулл-бай", force: "форс", eco: "эко", pistol: "пистолетки", semi: "полу-бай" };
const NADE_NAMES: Record<string, string> = {
  smoke: "смок", flashbang: "флешка", he: "HE", molotov: "молотов", incendiary: "молотов", decoy: "декой",
};

export interface Track {
  key: string; // `${matchId}#${round}`
  matchId: string;
  matchNo: number; // 1-based position of the match in the selection
  round: number;
  label: string; // "M1 R7"
  r: Replay;
  players: ReplayPlayer[]; // the subject's players in this round
  ids: Set<string>;
  team: string;
  side: Side | undefined;
  won: boolean;
  buy: string | null;
  opponent: string | null;
}

export interface ClipInfo {
  kind: "player" | "team";
  name: string; // player or team
  team: string; // the subject's team (the most frequent name for a player)
  map: string;
  from: number;
  to: number;
  layout: "overlay" | "sequence";
  buy: string | null; // buy filter, if any
  matches: { no: number; id: string; opponent: string | null }[];
}

export interface Summary {
  caption: string | null;
  mainZone: string | null;
  opponents: string[];
  side: string; // T, CT or T+CT
  text: string;
}

export const clockOf = (t: number) => (t < 0 ? `фризтайм ${fmtClock(-t)}` : fmtClock(ROUND_TIME - t));
const tickOf = (tr: Track, t: number) => tr.r.freeze_end_tick + t * tr.r.tick_rate;
const secOf = (tr: Track, tick: number) => (tick - tr.r.freeze_end_tick) / tr.r.tick_rate;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const uniq = <T,>(v: T[]) => [...new Set(v)];

export function summarize(tracks: Track[], meta: MapMeta, info: ClipInfo): Summary {
  const N = tracks.length;
  const zones = hasZones(meta);
  const zone = (x: number | null, y: number | null, z: number | null) => zoneAt(meta, x, y, z);
  const zoneName = (x: number | null, y: number | null, z: number | null) => zone(x, y, z)?.name ?? "?";
  const inWindow = (tr: Track, tick: number) => tick >= tickOf(tr, info.from) && tick <= Math.min(tr.r.last_tick, tickOf(tr, info.to));
  const longest = Math.max(0, ...tracks.map((tr) => secOf(tr, tr.r.last_tick)));
  const tEnd = Math.min(info.to, longest);
  const sides = uniq(tracks.map((tr) => sideShort(tr.side)));
  const opponents = uniq(tracks.map((tr) => tr.opponent).filter((o): o is string => !!o));

  // positions over time: which zone each subject player is in, among those alive
  const table: { t: number; alive: number; total: number; zones: [string, number][] }[] = [];
  let best: { t: number; zone: string; n: number } | null = null;
  for (let t = Math.max(0, Math.ceil(info.from)); t <= tEnd; t++) {
    const counts = new Map<string, number>();
    let alive = 0, total = 0;
    for (const tr of tracks) {
      for (const p of tr.players) {
        total++;
        const st = playerState(tr.r, p, Math.min(tickOf(tr, t), tr.r.last_tick));
        if (st.hp <= 0 || Number.isNaN(st.x) || tickOf(tr, t) > tr.r.last_tick) continue;
        alive++;
        const zn = zone(st.x, st.y, st.z);
        const key = zn?.name ?? "?";
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (info.kind === "player" && zn && !SPAWN_GROUPS.has(zn.group ?? "")) {
          const n = counts.get(key)!;
          if (!best || n > best.n) best = { t, zone: key, n };
        }
      }
    }
    if ((t - Math.max(0, Math.ceil(info.from))) % TABLE_STEP === 0) {
      table.push({ t, alive, total, zones: [...counts].sort((a, b) => b[1] - a[1]) });
    }
  }

  // grenades: type and landing zone, grouped over rounds
  const nadeGroups = new Map<string, { type: string; zone: string; times: number[]; rounds: Set<string>; who: Set<string> }>();
  for (const tr of tracks) {
    for (const g of tr.r.grenades) {
      if (!g.thrower || !tr.ids.has(g.thrower) || !inWindow(tr, g.t[0])) continue;
      const n = g.x.length - 1;
      const type = g.type === "incendiary" ? "molotov" : g.type;
      const zn = zoneName(g.x[n], g.y[n], g.z[n]);
      const key = `${type}|${zn}`;
      const grp = nadeGroups.get(key) ?? { type, zone: zn, times: [], rounds: new Set(), who: new Set() };
      grp.times.push(secOf(tr, g.end));
      grp.rounds.add(tr.key);
      grp.who.add(tr.players.find((p) => p.steamid === g.thrower)?.name ?? "?");
      nadeGroups.set(key, grp);
    }
  }
  const nades = [...nadeGroups.values()].sort((a, b) => b.rounds.size - a.rounds.size || median(a.times) - median(b.times));

  // kills, deaths and plants of the subject
  const frags: string[] = [], deaths: string[] = [], plants: string[] = [];
  const fragZones = new Map<string, number>();
  for (const tr of tracks) {
    for (const k of tr.r.kills) {
      if (!inWindow(tr, k.tick)) continue;
      const t = secOf(tr, k.tick);
      if (k.attacker && tr.ids.has(k.attacker)) {
        const az = zoneName(k.ax, k.ay, k.az);
        fragZones.set(az, (fragZones.get(az) ?? 0) + 1);
        frags.push(`${tr.label}  ${clockOf(t)}  ${k.attacker_name} (${az}) → ${k.victim_name} (${zoneName(k.vx, k.vy, k.vz)}), ${weaponName(k.weapon)}${k.headshot ? ", в голову" : ""}${k.trade ? ", размен" : ""}`);
      }
      if (tr.ids.has(k.victim)) {
        deaths.push(`${tr.label}  ${clockOf(t)}  ${k.victim_name} умер в ${zoneName(k.vx, k.vy, k.vz)} от ${k.attacker_name ?? "мира"} (${weaponName(k.weapon)})${k.traded ? ", разменян" : ""}`);
      }
    }
    const names = new Set(tr.players.map((p) => p.name));
    for (const b of tr.r.bomb) {
      if (b.event === "finish_plant" && b.player && names.has(b.player) && inWindow(tr, b.tick)) {
        plants.push(`${tr.label}  ${clockOf(secOf(tr, b.tick))}  ${b.player} — плант ${b.site ?? "?"}`);
      }
    }
  }

  // caption: the most consistent position and the regular grenades
  let caption: string | null = null;
  const parts: string[] = [];
  if (zones && best) parts.push(`${best.zone} на ${clockOf(best.t)} в ${best.n} из ${N}`);
  if (zones) {
    const regular = nades.filter((g) => g.zone !== "?" && g.rounds.size >= Math.max(2, NADE_MIN_SHARE * N)).slice(0, 3);
    const phrase = regular.map((g) => `${NADE_NAMES[g.type] ?? g.type} ${g.zone} ~${clockOf(median(g.times))} (${g.rounds.size} из ${N})`).join(", ");
    if (phrase) parts.push(phrase[0].toUpperCase() + phrase.slice(1));
  }
  if (parts.length) caption = parts.join(". ") + ".";

  // the text file
  const L: string[] = [];
  const who = info.kind === "player" ? `Игрок: ${info.name} (${info.team})` : `Команда: ${info.name}`;
  L.push(`Клип cs2lens — ${info.name} · ${sides.join("+")} · ${info.map}`);
  L.push(who);
  L.push(`Карта: ${info.map} · сторона: ${sides.join("+")} · закуп: ${info.buy ? BUY_LABELS[info.buy] ?? info.buy : "любой"}`);
  L.push(`Соперники: ${opponents.join(", ") || "?"}`);
  L.push(`Матчи (${info.matches.length}):`);
  for (const m of info.matches) L.push(`  M${m.no}  ${m.id}${m.opponent ? `  против ${m.opponent}` : ""}`);
  L.push(`Раундов: ${N} (${info.layout === "overlay" ? "наложены друг на друга" : "по очереди"}) · окно: ${info.from}…${Math.round(tEnd)} с после фризтайма (${clockOf(info.from)} → ${clockOf(tEnd)})`);
  const won = tracks.filter((tr) => tr.won).length;
  L.push(`Исход: ${won} побед, ${N - won} поражений`);
  L.push("");
  L.push(`Подпись (собрана кодом${zones ? "" : "; у карты нет конфига зон, поэтому без неё"}):`);
  L.push(caption ?? "—");
  L.push("");
  L.push(`Позиция по времени (зона: сколько ${info.kind === "player" ? "раундов" : "игроко-раундов"} из живых; часы раунда):`);
  for (const row of table) {
    const top = row.zones.slice(0, 4).map(([zn, n]) => `${zn} ${n}`).join(", ");
    L.push(`  ${clockOf(row.t).padStart(5)}  жив ${row.alive}/${row.total}  ${top}`);
  }
  L.push("");
  L.push("Гранаты (тип · куда легла · медиана времени · в скольких раундах · кто):");
  if (!nades.length) L.push("  нет");
  for (const g of nades) {
    L.push(`  ${NADE_NAMES[g.type] ?? g.type} · ${g.zone} · ~${clockOf(median(g.times))} · ${g.rounds.size} из ${N}${info.kind === "team" ? ` · ${[...g.who].join(", ")}` : ""}`);
  }
  L.push("");
  const topFrag = [...fragZones].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([zn, n]) => `${zn} ${n}`).join(", ");
  L.push(`Фраги: ${frags.length}${topFrag ? ` (откуда чаще: ${topFrag})` : ""}`);
  frags.forEach((f) => L.push(`  ${f}`));
  L.push(`Смерти: ${deaths.length}`);
  deaths.forEach((d) => L.push(`  ${d}`));
  if (plants.length) {
    L.push(`Закладки C4: ${plants.length}`);
    plants.forEach((p) => L.push(`  ${p}`));
  }
  L.push("");
  L.push("По раундам:");
  for (const tr of tracks) {
    const thrown = tr.r.grenades
      .filter((g) => g.thrower && tr.ids.has(g.thrower) && inWindow(tr, g.t[0]))
      .map((g) => `${NADE_NAMES[g.type] ?? g.type} ${zoneName(g.x[g.x.length - 1], g.y[g.y.length - 1], g.z[g.z.length - 1])} ${clockOf(secOf(tr, g.end))}`);
    const k = tr.r.kills.filter((x) => x.attacker && tr.ids.has(x.attacker) && inWindow(tr, x.tick)).length;
    const d = tr.r.kills.filter((x) => tr.ids.has(x.victim) && inWindow(tr, x.tick)).length;
    L.push(`  ${tr.label} против ${tr.opponent ?? "?"} · ${sideShort(tr.side)} · ${BUY_LABELS[tr.buy ?? ""] ?? tr.buy ?? "?"} · ${tr.won ? "победа" : "поражение"} · фраги ${k}, смерти ${d}`);
    if (thrown.length) L.push(`      гранаты: ${thrown.join("; ")}`);
  }
  L.push("");
  L.push("Время — часы раунда (1:55 = конец фризтайма). Зоны — callouts из конфига карты cs2lens.");

  return { caption, mainZone: best?.zone ?? null, opponents, side: sides.join("+"), text: L.join("\n") };
}
