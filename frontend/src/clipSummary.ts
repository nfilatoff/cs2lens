// Facts about a clip, computed from the replay data and the map's callouts: a one-line
// caption drawn under the radar and a text file that goes into the archive with the clip,
// with everything needed to describe what the player or team does in these rounds.
import type { MapMeta, Replay, ReplayPlayer, Side } from "./api";
import { sideShort } from "./radar";
import { fmtClock, playerState, weaponName } from "./replayDraw";
import { hasZones, zoneAt } from "./zones";
import { t, td } from "./i18n";

export const ROUND_TIME = 115;
const SPAWN_GROUPS = new Set(["t_spawn", "ct_spawn"]);
const NADE_MIN_SHARE = 0.2; // a grenade spot makes the caption when it is in at least 20% of the rounds
const TABLE_STEP = 5; // seconds between rows of the position table

export const buyLabel = (buy: string | null | undefined) => (buy ? td(`buy.${buy}`, buy) : "?");
const nadeName = (type: string) => td(`nade.${type}`, type);

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

export const clockOf = (sec: number) => (sec < 0 ? t("clock.freeze", { t: fmtClock(-sec) }) : fmtClock(ROUND_TIME - sec));
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
      const sec = secOf(tr, k.tick);
      if (k.attacker && tr.ids.has(k.attacker)) {
        const az = zoneName(k.ax, k.ay, k.az);
        fragZones.set(az, (fragZones.get(az) ?? 0) + 1);
        frags.push(t("sum.frag", {
          label: tr.label, clock: clockOf(sec), attacker: k.attacker_name, az, victim: k.victim_name, vz: zoneName(k.vx, k.vy, k.vz),
          weapon: weaponName(k.weapon), hs: k.headshot ? t("sum.hs") : "", trade: k.trade ? t("sum.trade") : "",
        }));
      }
      if (tr.ids.has(k.victim)) {
        deaths.push(t("sum.death", {
          label: tr.label, clock: clockOf(sec), victim: k.victim_name, zone: zoneName(k.vx, k.vy, k.vz),
          attacker: k.attacker_name ?? t("sum.world"), weapon: weaponName(k.weapon), traded: k.traded ? t("sum.traded") : "",
        }));
      }
    }
    const names = new Set(tr.players.map((p) => p.name));
    for (const b of tr.r.bomb) {
      if (b.event === "finish_plant" && b.player && names.has(b.player) && inWindow(tr, b.tick)) {
        plants.push(t("sum.plant", { label: tr.label, clock: clockOf(secOf(tr, b.tick)), player: b.player, site: b.site ?? "?" }));
      }
    }
  }

  // caption: the most consistent position and the regular grenades
  let caption: string | null = null;
  const parts: string[] = [];
  if (zones && best) parts.push(t("sum.capPos", { zone: best.zone, clock: clockOf(best.t), n: best.n, N }));
  if (zones) {
    const regular = nades.filter((g) => g.zone !== "?" && g.rounds.size >= Math.max(2, NADE_MIN_SHARE * N)).slice(0, 3);
    const phrase = regular.map((g) => t("sum.capNade", { nade: nadeName(g.type), zone: g.zone, clock: clockOf(median(g.times)), n: g.rounds.size, N })).join(", ");
    if (phrase) parts.push(phrase[0].toUpperCase() + phrase.slice(1));
  }
  if (parts.length) caption = parts.join(". ") + ".";

  // the text file
  const L: string[] = [];
  const who = info.kind === "player" ? t("sum.player", { name: info.name, team: info.team }) : t("sum.team", { name: info.name });
  L.push(t("sum.header", { name: info.name, sides: sides.join("+"), map: info.map }));
  L.push(who);
  L.push(t("sum.mapLine", { map: info.map, sides: sides.join("+"), buy: info.buy ? buyLabel(info.buy) : t("sum.anyBuy") }));
  L.push(t("sum.opponents", { list: opponents.join(", ") || "?" }));
  L.push(t("sum.matches", { n: info.matches.length }));
  for (const m of info.matches) L.push(`  M${m.no}  ${m.id}${m.opponent ? t("sum.matchVs", { opp: m.opponent }) : ""}`);
  L.push(t("sum.roundsLine", {
    n: N, layout: info.layout === "overlay" ? t("sum.layoutOverlay") : t("sum.layoutSeq"), from: info.from, to: Math.round(tEnd),
    c1: clockOf(info.from), c2: clockOf(tEnd),
  }));
  const won = tracks.filter((tr) => tr.won).length;
  L.push(t("sum.result", { w: won, l: N - won }));
  L.push("");
  L.push(t("sum.caption", { noZones: zones ? "" : t("sum.noZones") }));
  L.push(caption ?? "—");
  L.push("");
  L.push(t("sum.positions", { unit: info.kind === "player" ? t("sum.unitRounds") : t("sum.unitPlayerRounds") }));
  for (const row of table) {
    const top = row.zones.slice(0, 4).map(([zn, n]) => `${zn} ${n}`).join(", ");
    L.push(`  ${clockOf(row.t).padStart(5)}  ${t("sum.alive", { a: row.alive, t: row.total })}  ${top}`);
  }
  L.push("");
  L.push(t("sum.nades"));
  if (!nades.length) L.push(`  ${t("sum.none")}`);
  for (const g of nades) {
    L.push(`  ${nadeName(g.type)} · ${g.zone} · ~${clockOf(median(g.times))} · ${t("sum.of", { n: g.rounds.size, N })}${info.kind === "team" ? ` · ${[...g.who].join(", ")}` : ""}`);
  }
  L.push("");
  const topFrag = [...fragZones].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([zn, n]) => `${zn} ${n}`).join(", ");
  L.push(t("sum.frags", { n: frags.length, top: topFrag ? t("sum.fragTop", { list: topFrag }) : "" }));
  frags.forEach((f) => L.push(`  ${f}`));
  L.push(t("sum.deaths", { n: deaths.length }));
  deaths.forEach((d) => L.push(`  ${d}`));
  if (plants.length) {
    L.push(t("sum.plants", { n: plants.length }));
    plants.forEach((p) => L.push(`  ${p}`));
  }
  L.push("");
  L.push(t("sum.byRound"));
  for (const tr of tracks) {
    const thrown = tr.r.grenades
      .filter((g) => g.thrower && tr.ids.has(g.thrower) && inWindow(tr, g.t[0]))
      .map((g) => `${nadeName(g.type)} ${zoneName(g.x[g.x.length - 1], g.y[g.y.length - 1], g.z[g.z.length - 1])} ${clockOf(secOf(tr, g.end))}`);
    const k = tr.r.kills.filter((x) => x.attacker && tr.ids.has(x.attacker) && inWindow(tr, x.tick)).length;
    const d = tr.r.kills.filter((x) => tr.ids.has(x.victim) && inWindow(tr, x.tick)).length;
    L.push(`  ${t("sum.roundLine", {
      label: tr.label, opp: tr.opponent ?? "?", side: sideShort(tr.side), buy: buyLabel(tr.buy), result: tr.won ? t("common.win") : t("common.loss"), k, d,
    })}`);
    if (thrown.length) L.push(`      ${t("sum.roundNades", { list: thrown.join("; ") })}`);
  }
  L.push("");
  L.push(t("sum.footer"));

  return { caption, mainZone: best?.zone ?? null, opponents, side: sides.join("+"), text: L.join("\n") };
}
