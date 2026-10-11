// The sidebar's bottom bar: theme, bug report, What's New, shortcuts and
// activity in one well, settings in its own at the far edge (docs/ui.md
// "The footer strip"). The icon rail keeps a vertical stack of the same
// buttons.
//
// Its own memo component so the What's New subscription re-renders this bar
// and nothing else in the sidebar (performance.md bear trap 5).

import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ThemePicker } from "@/components/ThemePicker";
import { Tip } from "@/components/ui/Tooltip";
import {
  FooterBugGlyph,
  FooterGearGlyph,
  FooterKeyboardGlyph,
  FooterMailGlyph,
  FooterPulseGlyph,
} from "@/components/footer/footerIcons";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { isWhatsNewUnread, useUpdate } from "@/store/update";
import { openIssue } from "@/lib/contact";
import { procmonOpenWindow } from "@/lib/ipc";
import { kbd } from "@/lib/platform";

function openWhatsNew() {
  useUI.getState().openChangelog();
  useUpdate.getState().dismissWhatsNew();
}

function openActivity() {
  void procmonOpenWindow().catch(() => {});
}

function FooterButton({ label, testId, compact, onClick, children }: {
  label: string;
  testId: string;
  compact: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tip content={label}>
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        className={compact ? "sidebar-footer-btn relative" : "footer-icon-btn"}
        onClick={onClick}
      >
        {children}
      </button>
    </Tip>
  );
}

export const SidebarFooter = memo(function SidebarFooter({ compact }: { compact: boolean }) {
  const { t } = useTranslation("sidebar");
  const openSettings = useApp(s => s.openSettings);
  const whatsNewUnread = useUpdate(s => isWhatsNewUnread(s.currentVersion, s.lastSeenVersion));

  const glyphSize = compact ? 22 : 16;
  const whatsNewTip = whatsNewUnread ? t("whatsNewUnreadTip") : t("whatsNewTip");
  const settingsTip = t("settingsTip", { combo: kbd("⌘,") });

  const supportButtons = (
    <>
      <ThemePicker compact={compact} />
      <FooterButton label={t("reportBug")} testId="footer-bug" compact={compact}
        onClick={() => openIssue(t("bugIssueTitle"), t("bugIssueBody"))}>
        <FooterBugGlyph size={glyphSize} className="footer-ink" />
      </FooterButton>
      <FooterButton label={whatsNewTip} testId="footer-whats-new" compact={compact} onClick={openWhatsNew}>
        <FooterMailGlyph size={glyphSize} className="footer-ink" />
        {whatsNewUnread && <span aria-hidden data-testid="footer-whats-new-dot" className="footer-unread-dot" />}
      </FooterButton>
      <FooterButton label={t("shortcuts")} testId="footer-shortcuts" compact={compact}
        onClick={() => useUI.getState().openShortcutsHelp()}>
        <FooterKeyboardGlyph size={glyphSize} className="footer-ink" />
      </FooterButton>
      {/* A separate window, not a dialog, so it keeps sampling while you
          drive the agent it is measuring. */}
      <FooterButton label={t("activityTip")} testId="open-activity" compact={compact} onClick={openActivity}>
        <FooterPulseGlyph size={glyphSize} className="footer-ink" />
      </FooterButton>
    </>
  );

  const settingsButton = (
    <FooterButton label={settingsTip} testId="footer-settings" compact={compact} onClick={() => openSettings()}>
      <FooterGearGlyph size={glyphSize} className="footer-ink" />
    </FooterButton>
  );

  if (compact) {
    return (
      <div
        data-testid="sidebar-footer"
        className="sidebar-footer flex shrink-0 flex-col items-center gap-[4px] border-t border-[var(--sidebar-divider)] p-2"
      >
        {supportButtons}
        {settingsButton}
      </div>
    );
  }

  return (
    <div data-testid="sidebar-footer" data-expanded="" className="sidebar-footer flex shrink-0 items-center">
      <div className="footer-well">{supportButtons}</div>
      <div className="flex-1" />
      <div className="footer-well">{settingsButton}</div>
    </div>
  );
});