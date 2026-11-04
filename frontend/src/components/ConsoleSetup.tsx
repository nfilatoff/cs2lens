// One-time setup of the link with CS2: the player enters a key bind in the game console; the
// app sees it in the game's saved keys (see cs2lens/app/cs2.py). Nothing is pressed in the game here.
import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";

export function ConsoleSetup({ bindCommand, running, onLinked }: { bindCommand: string; running: boolean; onLinked: () => void }) {
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setError(null);
    try {
      await api.cs2ConsoleTest();
      onLinked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="link-setup small">
      <b>{t("cs2.link.title")}</b>
      <div className="muted">{t("cs2.link.intro")}</div>
      <div className="row">
        <code className="console">{bindCommand}</code>
        <button className="link small" onClick={() => navigator.clipboard.writeText(bindCommand).then(() => setCopied(true)).catch(() => {})}>
          {copied ? t("cs2.link.copied") : t("cs2.link.copy")}
        </button>
      </div>
      <div className="muted">{t("cs2.link.step2")}</div>
      <div className="row">
        <button disabled={testing || !running} onClick={test}>{testing ? t("cs2.link.testing") : t("cs2.link.test")}</button>
        {!running && <span className="muted">{t("cs2.link.notRunning")}</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
