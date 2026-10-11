// The task footer's sandbox chip: shield, "Sandbox", and a keycap naming the
// state (docs/ui.md "The footer strip"). A click opens the same sandbox dialog
// as the title bar's sandbox segment, so the two can never disagree.

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { DockerSandboxIcon, sandboxModeText } from "@/components/SandboxIcon";
import { FooterShieldGlyph, FooterShieldOffGlyph } from "@/components/footer/footerIcons";
import { useUI } from "@/store/ui";
import type { SandboxMode } from "@/lib/types";

type Tone = "ok" | "warn" | undefined;

const MODE_TONE: Record<SandboxMode, Tone> = {
  off: undefined,
  "enforce-fs": "ok",
  monitor: "warn",
  enforce: "ok",
};

const MODE_TAG: Record<SandboxMode, string> = {
  off: "footer.sandboxTagOff",
  "enforce-fs": "footer.sandboxTagFs",
  monitor: "footer.sandboxTagMonitor",
  enforce: "footer.sandboxTagOn",
};

function ModeGlyph({ mode }: { mode: SandboxMode }) {
  if (mode === "off") return <FooterShieldOffGlyph size={15} className="footer-ink shrink-0" />;

  const glyphColor = mode === "monitor" ? "text-[var(--color-warn)]" : "text-[var(--color-ok)]";
  const isFullCage = mode === "enforce";
  const hasCheck = mode !== "monitor";

  return <FooterShieldGlyph size={15} filled={isFullCage} check={hasCheck} className={`footer-ink shrink-0 ${glyphColor}`} />;
}

export function SandboxChip({ taskId, mode, docker, warning }: {
  taskId: string;
  mode: SandboxMode;
  docker: boolean;
  /** Why the cage is degraded, when it is. Wins over every other state. */
  warning: string | null;
}) {
  const { t } = useTranslation("task");
  const { t: tChrome } = useTranslation("chrome");

  const tone: Tone = warning ? "warn" : docker ? "ok" : MODE_TONE[mode];
  const modeName = sandboxModeText(mode, tChrome).shortLabel;
  const tip = warning
    ?? (docker ? t("footer.sandboxDockerTip")
      : mode === "off" ? t("footer.sandboxOffTip")
      : t("footer.sandboxOnTip", { mode: modeName }));

  const glyph = warning
    ? <AlertTriangle className="footer-ink h-[15px] w-[15px] shrink-0 text-[var(--color-warn)]" />
    : docker
      ? <DockerSandboxIcon className="footer-ink h-[15px] w-[15px] shrink-0" />
      : <ModeGlyph mode={mode} />;
  const tag = warning ? t("footer.sandboxTagDegraded")
    : docker ? t("footer.sandboxTagDocker")
    : t(MODE_TAG[mode]);

  return (
    <button
      type="button"
      data-testid="footer-sandbox"
      data-sandbox-mode={docker ? "docker" : mode}
      data-tone={tone}
      title={tip}
      aria-label={tip}
      onClick={() => useUI.getState().openSandbox(taskId)}
      className="footer-sandbox"
    >
      {glyph}
      <span className="footer-ink @max-[560px]:hidden">{t("footer.sandbox")}</span>
      <span className="footer-tag footer-ink">{tag}</span>
    </button>
  );
}