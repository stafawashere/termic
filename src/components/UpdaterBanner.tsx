// Compact self-update surface — a small terracotta pill in the unified
// bar, shown ONLY when the sidebar is collapsed. When the sidebar is
// expanded the richer UpdateCard (sidebar, above the footer) is the
// update surface instead; this pill is the collapsed-mode fallback so
// a pending update is never unreachable.
//
// All update state — the check() probe, changelog fetch, install +
// relaunch dance — lives in store/update.ts. This component is pure
// presentation.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { useUpdate } from "@/store/update";
import { automationArmed } from "@/lib/ipc";
import { betaInfo, isBetaBuild } from "@/lib/build";
import { ArrowDownToLine, RotateCw } from "lucide-react";

export function UpdaterBanner() {
  const { t } = useTranslation("chrome");
  const update = useUpdate(s => s.update);
  const installing = useUpdate(s => s.installing);
  const install = useUpdate(s => s.install);
  const dismissedVersion = useUpdate(s => s.dismissedVersion);
  const compact = useApp(s => s.compactSidebar);

  // Is this window driven by the e2e automation bridge? If so the DEV pill
  // becomes a red E2E pill so an automated run is never mistaken for a normal
  // dev window. Only probed in dev builds (the command is absent in release).
  const [isE2E, setIsE2E] = useState(false);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    automationArmed().then(setIsE2E).catch(() => {});
  }, []);

  // Dev builds can't surface a real update (no signed release to check
  // against). With no mock update injected, claim the slot with a DEV
  // marker so a `tauri dev` window is unmistakable. VITE_MOCK_UPDATE
  // populates `update`, in which case we fall through to the real pill.
  // Opt out of the marker with VITE_HIDE_DEV_PILL=1 (e.g. for screen
  // recordings / screenshots where the badge is just noise).
  const hideDevPill =
    import.meta.env.VITE_HIDE_DEV_PILL === "1" ||
    import.meta.env.VITE_HIDE_DEV_PILL === "true";
  // Injected by vite.config.ts from `git rev-parse --abbrev-ref HEAD` at
  // dev-server startup. One `tauri dev` window per worktree is otherwise
  // indistinguishable at a glance. Absent in release builds, where the
  // Beta pill already names what it was built from.
  const branch: string | undefined = import.meta.env.VITE_GIT_BRANCH;
  // A detached HEAD reports the literal "HEAD", which is worth showing: it
  // means the window is not on any branch, so it is probably not running
  // what you think it is.
  const branchLabel = branch ? (
    <span className="titlebar-badge-branch titlebar-trunc titlebar-mono">
      {branch}
    </span>
  ) : null;
  const branchTitle = branch ? t("updaterBanner.branchSuffix", { branch }) : "";
  if (import.meta.env.DEV && !update && !hideDevPill) {
    return isE2E ? (
      <span
        title={t("updaterBanner.e2eTitle", { branchSuffix: branchTitle })}
        data-tone="e2e"
        className="titlebar-badge titlebar-ink select-none"
      >
        E2E
        {branchLabel}
      </span>
    ) : (
      <span
        title={t("updaterBanner.devTitle", { branchSuffix: branchTitle })}
        data-tone="dev"
        className="titlebar-badge titlebar-ink select-none"
      >
        DEV
        {branchLabel}
      </span>
    );
  }

  // Beta: "Termic Beta.app", built from a branch by `make beta` and installed
  // next to the shipped app, sharing its data dir. It never self-updates
  // (store/update.ts skips the probe), so `update` is always null here and the
  // pill is permanent: the one thing telling this window apart from a shipped
  // one that is reading the very same tasks.
  if (isBetaBuild()) {
    const info = betaInfo();
    return (
      <span
        title={
          info
            ? t("updaterBanner.betaBuilt", { info })
            : t("updaterBanner.betaLocal")
        }
        data-tone="beta"
        className="titlebar-badge titlebar-ink select-none"
      >
        BETA
      </span>
    );
  }

  // Nothing pending, the user already dismissed this version, or the
  // sidebar is expanded (UpdateCard owns the surface there) → no pill.
  if (!update || update.version === dismissedVersion || !compact) return null;

  return (
    <button
      type="button"
      onClick={() => void install()}
      disabled={installing !== null}
      title={t("updaterBanner.updateTo", { version: update.version, current: update.currentVersion })}
      className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-[6px] bg-[var(--color-accent-deep)] px-[9px] text-[12px] font-medium text-white shadow-[var(--sidebar-chip-shadow)] transition-[filter] duration-[120ms] hover:brightness-110 disabled:opacity-70"
    >
      {installing === null && (
        <>
          <ArrowDownToLine className="h-3 w-3" />
          <span>{t("updaterBanner.downloadRestart")}</span>
        </>
      )}
      {installing === "downloading" && (
        <>
          <RotateCw className="h-3 w-3 animate-spin" />
          <span>{t("update.downloading")}</span>
        </>
      )}
      {installing === "installing" && (
        <>
          <RotateCw className="h-3 w-3 animate-spin" />
          <span>{t("update.restarting")}</span>
        </>
      )}
    </button>
  );
}
