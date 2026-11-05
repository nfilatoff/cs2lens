import type { MapMeta } from "../api";
import { setCalloutMode, useCalloutMode, type CalloutMode } from "../callouts";
import { t, type Key } from "../i18n";

const MODES: [CalloutMode, Key][] = [["off", "callouts.off"], ["names", "callouts.names"], ["full", "callouts.full"]];

export function CalloutModeSwitch({ mode, onChange }: { mode: CalloutMode; onChange: (mode: CalloutMode) => void }) {
  return (
    <span className="callout-switch small" title={t("callouts.toggleTitle")}>
      {t("callouts.label")}
      <span className="seg">
        {MODES.map(([value, label]) => (
          <button key={value} className={mode === value ? "on" : ""} aria-pressed={mode === value} onClick={() => onChange(value)}>{t(label)}</button>
        ))}
      </span>
    </span>
  );
}

/** The mode shared by every radar; hidden on a map without a config. */
export function CalloutToggle({ meta }: { meta: MapMeta | undefined }) {
  const mode = useCalloutMode();
  if (!meta?.zones.length) return null;
  return <CalloutModeSwitch mode={mode} onChange={setCalloutMode} />;
}
