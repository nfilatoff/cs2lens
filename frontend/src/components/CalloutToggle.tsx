import type { MapMeta } from "../api";
import { setCallouts, useCallouts } from "../callouts";
import { t } from "../i18n";

/** The switch of position names, shared by every radar; hidden on a map without a config. */
export function CalloutToggle({ meta }: { meta: MapMeta | undefined }) {
  const on = useCallouts();
  if (!meta?.zones.length) return null;
  return (
    <label className="small" title={t("callouts.toggleTitle")}>
      <input type="checkbox" checked={on} onChange={(e) => setCallouts(e.target.checked)} /> {t("maps.zones")}
    </label>
  );
}
