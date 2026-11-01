// Duel details for one kill, shown when the pointer is over its death cross.
import type { Replay, ReplayKill } from "../api";
import { sideColor, sideShort } from "../radar";
import { UNITS_PER_METER, fmtClock, weaponName } from "../replayDraw";

const HITGROUPS: Record<string, string> = {
  head: "голова", chest: "грудь", stomach: "живот", left_arm: "левая рука", right_arm: "правая рука",
  left_leg: "левая нога", right_leg: "правая нога", neck: "шея", generic: "тело",
};
const ROUND_TIME = 115;

export function KillCard({ r, kill, x, y, maxX }: { r: Replay; kill: ReplayKill; x: number; y: number; maxX: number }) {
  const sec = (kill.tick - r.freeze_end_tick) / r.tick_rate;
  const tags = [
    kill.headshot && "в голову",
    kill.wallbang && "прострел",
    kill.thrusmoke && "через смок",
    kill.noscope && "без прицела",
    kill.flashed && "жертва ослеплена",
  ].filter(Boolean);
  const duelSec = kill.duel_start !== null ? (kill.tick - kill.duel_start) / r.tick_rate : null;
  const left = x > maxX - 300 ? x - 296 : x + 16;
  return (
    <div className="kill-card" style={{ left, top: Math.max(4, y - 20) }}>
      <div className="kc-head">
        <span style={{ color: sideColor(kill.attacker_side) }}>{kill.attacker_name ?? "World"}</span>
        <span className="kc-weapon">{weaponName(kill.weapon)}</span>
        <span style={{ color: sideColor(kill.victim_side) }}>{kill.victim_name}</span>
      </div>
      <div className="muted small">
        {sec >= 0 ? `${fmtClock(ROUND_TIME - sec)} на часах (${Math.round(sec)} с от начала)` : "фризтайм"}
        {kill.dist !== null && ` · ${(kill.dist / UNITS_PER_METER).toFixed(1)} м`}
      </div>
      {tags.length > 0 && <div className="kc-tags">{tags.map((t) => <span key={String(t)}>{t}</span>)}</div>}
      <table className="kc-table">
        <tbody>
          {kill.attacker && (
            <>
              <tr>
                <td>{sideShort(kill.attacker_side)} {kill.attacker_name}</td>
                <td className="num">нанёс {kill.given[1]} ({kill.given[0]} попад.)</td>
              </tr>
              <tr>
                <td>{sideShort(kill.victim_side)} {kill.victim_name}</td>
                <td className="num">нанёс {kill.taken[1]} ({kill.taken[0]} попад.)</td>
              </tr>
            </>
          )}
          {kill.attacker_hp !== null && (
            <tr><td>HP убийцы после</td><td className="num">{kill.attacker_hp}</td></tr>
          )}
          {kill.hitgroup && <tr><td>Добивающее попадание</td><td className="num">{HITGROUPS[kill.hitgroup] ?? kill.hitgroup}</td></tr>}
          {kill.victim_weapon && <tr><td>Оружие жертвы</td><td className="num">{weaponName(kill.victim_weapon)}</td></tr>}
          {duelSec !== null && duelSec > 0 && <tr><td>Дуэль длилась</td><td className="num">{duelSec.toFixed(1)} с</td></tr>}
          {kill.assister_name && <tr><td>Ассист</td><td className="num">{kill.assister_name}</td></tr>}
        </tbody>
      </table>
      {(kill.trade || kill.traded) && (
        <div className="small">
          {kill.trade && <span className="kc-flag">размен за тиммейта</span>}
          {kill.traded && <span className="kc-flag">жертву разменяли</span>}
        </div>
      )}
      <div className="muted small">клик — перемотать к дуэли</div>
    </div>
  );
}
