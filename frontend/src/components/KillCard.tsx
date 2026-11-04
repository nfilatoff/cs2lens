// Duel details for one kill, shown when the pointer is over its death cross.
import type { Replay, ReplayKill } from "../api";
import { sideColor, sideShort } from "../radar";
import { ROUND_TIME, UNITS_PER_METER, fmtClock, weaponName } from "../replayDraw";
import { t, td } from "../i18n";

export function KillCard({ r, kill, x, y, maxX }: { r: Replay; kill: ReplayKill; x: number; y: number; maxX: number }) {
  const sec = (kill.tick - r.freeze_end_tick) / r.tick_rate;
  const tags = [
    kill.headshot && t("kc.headshot"),
    kill.wallbang && t("kc.wallbang"),
    kill.thrusmoke && t("kc.thrusmoke"),
    kill.noscope && t("kc.noscope"),
    kill.flashed && t("kc.flashed"),
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
        {sec >= 0 ? t("kc.clock", { clock: fmtClock(ROUND_TIME - sec), sec: Math.round(sec) }) : t("kc.freeze")}
        {kill.dist !== null && ` · ${t("kc.m", { n: (kill.dist / UNITS_PER_METER).toFixed(1) })}`}
      </div>
      {tags.length > 0 && <div className="kc-tags">{tags.map((t) => <span key={String(t)}>{t}</span>)}</div>}
      <table className="kc-table">
        <tbody>
          {kill.attacker && (
            <>
              <tr>
                <td>{sideShort(kill.attacker_side)} {kill.attacker_name}</td>
                <td className="num">{t("kc.dealt", { dmg: kill.given[1], hits: kill.given[0] })}</td>
              </tr>
              <tr>
                <td>{sideShort(kill.victim_side)} {kill.victim_name}</td>
                <td className="num">{t("kc.dealt", { dmg: kill.taken[1], hits: kill.taken[0] })}</td>
              </tr>
            </>
          )}
          {kill.attacker_hp !== null && (
            <tr><td>{t("kc.attackerHp")}</td><td className="num">{kill.attacker_hp}</td></tr>
          )}
          {kill.hitgroup && <tr><td>{t("kc.finalHit")}</td><td className="num">{td(`hit.${kill.hitgroup}`, kill.hitgroup)}</td></tr>}
          {kill.victim_weapon && <tr><td>{t("kc.victimWeapon")}</td><td className="num">{weaponName(kill.victim_weapon)}</td></tr>}
          {duelSec !== null && duelSec > 0 && <tr><td>{t("kc.duel")}</td><td className="num">{t("common.sec", { n: duelSec.toFixed(1) })}</td></tr>}
          {kill.assister_name && <tr><td>{t("kc.assist")}</td><td className="num">{kill.assister_name}</td></tr>}
        </tbody>
      </table>
      {(kill.trade || kill.traded) && (
        <div className="small">
          {kill.trade && <span className="kc-flag">{t("kc.trade")}</span>}
          {kill.traded && <span className="kc-flag">{t("kc.traded")}</span>}
        </div>
      )}
      <div className="muted small">{t("kc.clickHint")}</div>
    </div>
  );
}
