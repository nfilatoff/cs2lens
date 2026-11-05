import { t } from "../i18n";

/** Fewer rounds than this: a conclusion is not worth much, and says so. */
export const LOW_SAMPLE = 5;

/** "on N rounds", marked when that is too few to trust. */
export function SampleBadge({ rounds }: { rounds: number }) {
  return (
    <>
      <span className="muted">{t("scout.onRounds", { n: rounds })}</span>
      {rounds < LOW_SAMPLE && <span className="sample-low">{t("scout.lowData")}</span>}
    </>
  );
}
