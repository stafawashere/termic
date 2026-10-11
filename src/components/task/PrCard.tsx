// PR/MR card pinned to the top of the Git tab (Conductor-style "checks"
// surface, scoped to what termic can know cheaply): live state pill, CI
// rollup, review decision, open-in-browser. When there's no PR yet it's
// the "Create pull request" entry point; when the forge CLI is missing or
// signed out it tells the user EXACTLY what to install / run - never an
// empty box with no explanation.
//
// Refresh model: a fetch on mount / task switch, then a 60s tick
// while mounted (the PR store rate-limits to 30s minimum, so remounts
// don't hammer the forge). GitPanel additionally forces a refresh right
// after a successful push.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation, Trans } from "react-i18next";
import {
  GitPullRequest, GitPullRequestDraft, GitPullRequestClosed, GitMerge,
  CircleCheck, CircleX, ExternalLink, RefreshCw, Plus, Bell, BellOff,
} from "lucide-react";
import type { MemberPrLookup, PrStatus, Task } from "@/lib/types";
import { azurePatLoginCmd, forgeCli, forgeInstallCmd, forgeLoginCmd, forgeName, prRef } from "@/lib/forge";
import { openPath } from "@/lib/ipc";
import { usePr, watchTickNow } from "@/store/pr";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { useAlignedSpin } from "@/hooks/useAlignedSpin";

const POLL_MS = 60_000;
/** CLI re-probe cadence while the card is blocked on a missing / signed-out
 *  CLI. ~7 subprocesses a pop (version + auth per forge CLI, plus az's
 *  Python startup), so this is minutes, not seconds. */
const PROBE_MS = 5 * 60_000;

// State pill: icon + label + color, GitHub's palette (open green, draft
// gray, merged purple, closed red). The PR tokens are tuned per theme the
// way the sidebar's PR glyph uses them, since PR state colours are a
// cross-tool convention users already know, not theme accents. Labels are
// i18n keys (pr subtree), resolved at render.
const STATE: Record<PrStatus["state"], { labelKey: string; color: string; Icon: typeof GitPullRequest }> = {
  open:   { labelKey: "pr.stateOpen",   color: "var(--color-pr-open)", Icon: GitPullRequest },
  draft:  { labelKey: "pr.stateDraft",  color: "var(--color-fg-faint)", Icon: GitPullRequestDraft },
  merged: { labelKey: "pr.stateMerged", color: "var(--color-pr-merged)", Icon: GitMerge },
  closed: { labelKey: "pr.stateClosed", color: "var(--color-err)", Icon: GitPullRequestClosed },
};

function ChecksChip({ checks }: { checks: PrStatus["checks"] }) {
  const { t } = useTranslation("panels");
  if (checks === "none") return null;
  // "pending" gets ui/Spinner, not a rotated CircleCheck-shaped icon - see
  // its own doc comment for why a rotated stroked-arc SVG wobbles at this
  // size (the same reason the refresh button's spinner does).
  if (checks === "pending") {
    return (
      <Tip content={t("pr.checksRunning")} side="bottom">
        <span className="rp-git-pr-signal" style={{ color: "var(--color-warn)" }}>
          {/* Measured against the row's actual pixel centers (bell/refresh/
              link icons and text with a descender all land on the same row
              - see CircleX below), not eyeballed: -translate-y-px pulls the
              icon up onto that line. */}
          <Spinner size={14} className="-translate-y-px" />
          CI
        </span>
      </Tip>
    );
  }
  const map = {
    passing: { Icon: CircleCheck, color: "var(--color-pr-open)", label: t("pr.checksPassing") },
    failing: { Icon: CircleX, color: "var(--color-err)", label: t("pr.checksFailing") },
  } as const;
  const { Icon, color, label } = map[checks];
  return (
    <Tip content={label} side="bottom">
      <span className="rp-git-pr-signal" style={{ color }}>
        {/* Measured pixel centers (see the pending-state Spinner above):
            this icon renders ~2px low relative to the row's actual
            baseline. -translate-y-px corrects it. */}
        <Icon className="h-3.5 w-3.5 -translate-y-px" />
        CI
      </span>
    </Tip>
  );
}

function ReviewChip({ review }: { review: PrStatus["review"] }) {
  const { t } = useTranslation("panels");
  if (review === "none") return null;
  const map = {
    approved: { color: "var(--color-pr-open)", label: t("pr.approved") },
    changes_requested: { color: "var(--color-err)", label: t("pr.changesRequested") },
    review_required: { color: "var(--color-warn)", label: t("pr.reviewRequired") },
  } as const;
  const { color, label } = map[review];
  // The one shrinkable item in the row (see the two-row comment below):
  // "Changes requested" is the widest label here, and at the panel's
  // 280px default width a fully-populated row would otherwise push the
  // action buttons off the card's right edge, clipped by the window
  // itself, where the button isn't even clickable. truncate keeps the
  // buttons on-screen; the full label stays reachable via title.
  return (
    <span title={label} className="min-w-0 truncate text-[11.5px] leading-none" style={{ color }}>{label}</span>
  );
}

export function PrCard({ task }: { task: Task }) {
  const { t } = useTranslation("panels");
  const entry = usePr(s => s.byTask[task.id]);
  const refresh = usePr(s => s.refresh);
  const refreshForges = usePr(s => s.refreshForges);
  const openCreatePr = useUI(s => s.openCreatePr);
  const isFocused = useApp(s => s.activeTaskId === task.id);
  const [manualSpin, setManualSpin] = useState(false);
  // See useAlignedSpin: a real refresh's duration is arbitrary (network
  // round-trip or, on the fixture path, near-instant), so tying the icon's
  // rotation directly to it cuts the CSS animation off mid-turn - this
  // rounds the visible window up to a whole rotation so it always lands
  // back at rest instead of snapping there from an arbitrary angle.
  const spinning = useAlignedSpin(manualSpin || !!entry?.loading);

  // Fetch whenever this task's Git tab GAINS focus (mount counts as gaining
  // it), plus a slow tick while mounted. A background task keeps ticking on
  // its own (see the module doc comment - that's what lets a merge auto-
  // archive a task nobody's looking at), but the moment you actually switch
  // to it, forced+immediate beats waiting out the rest of the 60s window.
  const wasFocused = useRef(false);
  useEffect(() => {
    if (isFocused && !wasFocused.current) refresh(task.id, true);
    wasFocused.current = isFocused;
  }, [isFocused, task.id, refresh]);
  useEffect(() => {
    const t = window.setInterval(() => refresh(task.id, true), POLL_MS);
    return () => window.clearInterval(t);
  }, [task.id, refresh]);

  const lookup = entry?.lookup ?? null;

  // Manual refresh: force + brief spinner for feedback. Re-probes the CLIs
  // first, because forge.rs caches binary resolution per name - without a
  // re-probe, a `brew install gh` done while termic is running would stay
  // invisible to this card no matter how often you hit refresh. Also kicks
  // the comment-watcher tick (normally on its own 60s loop, see
  // initCommentWatcher) - a manual "check now" should check everything
  // this card knows how to check, not just the status pill.
  const doRefresh = () => {
    setManualSpin(true);
    Promise.resolve(refreshForges())
      .then(() => refresh(task.id, true))
      .finally(() => {
        watchTickNow();
        setManualSpin(false);
      });
  };

  // Same reason, unattended: while the card sits on a "not installed" or
  // "signed out" hint, re-probe so installing the CLI or running
  // `auth login` in another window fixes the card on its own. Deliberately
  // MUCH slower than the status poll: a probe is a handful of
  // subprocesses (each CLI's version + auth check), and installing a CLI
  // is a rare,
  // deliberate act, not something worth spending a spawn a minute waiting
  // for. The refresh button covers anyone who does not want to wait.
  const status = entry?.lookup?.status;
  const blocked = status === "cli-missing" || status === "cli-unauthed";
  useEffect(() => {
    if (!blocked) return;
    void refreshForges();
    const t = window.setInterval(() => {
      void refreshForges().then(() => refresh(task.id, true));
    }, PROBE_MS);
    return () => window.clearInterval(t);
  }, [blocked, refreshForges, refresh, task.id]);

  // The card exists only for repos actually hosted on a forge we can talk
  // to. A local-only repo, or one pushing to Bitbucket / Gitea / a plain
  // SSH host, gets NOTHING: an "install gh" nag on a repo where gh could
  // never help is pure noise. (Self-hosted GitHub Enterprise and GitLab do
  // resolve, as long as the CLI is signed in to that host - forge.rs asks
  // the CLI which instances it knows rather than guessing from the
  // hostname.) Also silent while the first lookup is in flight, to avoid a
  // flash of the wrong state.
  if (!lookup) return null;
  if (lookup.status === "no-remote" || lookup.status === "unsupported-remote") return null;

  const providerLabel = forgeName(lookup.provider);
  const noun = lookup.provider === "gitlab" ? t("pr.mergeRequest") : t("pr.pullRequest");

  // ── hint states: the user must see WHY there's no PR data ──
  if (lookup.status !== "ok") {
    const cli = forgeCli(lookup.provider);
    const hint =
      lookup.status === "cli-missing" ? {
        // az is two installs (CLI + extension) - the suffix names the second
        // requirement so {{cli}} stays the bare binary.
        title: t("pr.cliMissingTitle", {
          provider: providerLabel, noun, cli,
          suffix: lookup.provider === "azure" ? t("common:azureCliSuffix") : "",
        }),
        body: <Trans ns="panels" i18nKey="pr.cliMissingBody" values={{ install: forgeInstallCmd(lookup.provider), auth: forgeLoginCmd(lookup.provider) }} components={{ code: <Code /> }} />,
      } : lookup.status === "cli-unauthed" ? {
        title: t("pr.signInTitle", { provider: providerLabel }),
        body: lookup.provider === "azure"
          ? <Trans ns="panels" i18nKey="pr.signInBodyAzure" values={{ command: forgeLoginCmd(lookup.provider), alt: azurePatLoginCmd }} components={{ code: <Code /> }} />
          : <Trans ns="panels" i18nKey="pr.signInBody" values={{ command: forgeLoginCmd(lookup.provider) }} components={{ code: <Code /> }} />,
      } : {
        title: t("pr.unreachable", { provider: providerLabel }),
        body: <span className="break-words">{lookup.message}</span>,
      };
    return (
      <Card tone="var(--color-warn)">
        <div className="flex items-start gap-2">
          <GitPullRequest className="mt-px h-4 w-4 shrink-0 text-[var(--color-warn)]" />
          <div className="min-w-0 flex-1">
            <div className="break-words text-[12.5px] font-semibold text-[var(--sidebar-ink-strong)]">{hint.title}</div>
            <div className="mt-1 break-words text-[12px] leading-snug text-[var(--sidebar-muted)]">{hint.body}</div>
          </div>
          <RefreshBtn spinning={spinning} onClick={doRefresh} />
        </div>
      </Card>
    );
  }

  // ── no PR yet: the create entry point ──
  if (!lookup.pr) {
    return (
      <Card>
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 shrink-0 -translate-y-px text-[var(--sidebar-icon)]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] leading-none text-[var(--sidebar-muted)]">
            {t("pr.noPrYet", { noun })}
          </span>
          <RefreshBtn spinning={spinning} onClick={doRefresh} />
          <button
            onClick={() => openCreatePr(task.id)}
            className="ui-raised shrink-0 gap-1"
            data-size="sm"
            data-tone="accent"
          >
            <Plus className="h-3.5 w-3.5" /> {t("create", { ns: "common" })}
          </button>
        </div>
      </Card>
    );
  }

  // ── the PR card proper ──
  const pr = lookup.pr;
  const { labelKey, color, Icon } = STATE[pr.state];
  const label = t(labelKey);
  const numberLabel = prRef(pr.provider, pr.number);
  // Two rows on purpose. The right panel is narrow, and one row of
  // [pill][title][CI][review][3 buttons] gave the title `flex-1 min-w-0`
  // against six unshrinkable siblings: it collapsed to zero width and the
  // PR title - the single most useful thing here - never rendered at all,
  // while "Changes requested" wrapped onto a second line anyway. Identity
  // (badge + signals + actions) shares the top row; the title gets the
  // whole second row to itself so it truncates against ONE sibling
  // (nothing) instead of six.
  return (
    <Card tone={color}>
      <div className="flex items-center gap-2">
        <Tip content={t("pr.stateTip", { state: label, provider: providerLabel })} side="bottom">
          {/* The one pill on the card: the state is what the card is about,
              and the spine and wash behind it already carry its colour. */}
          <span className="rp-git-pr-state">
            <Icon className="h-3 w-3" />
            {label}
          </span>
        </Tip>
        <ChecksChip checks={pr.checks} />
        <ReviewChip review={pr.review} />
        <span className="min-w-0 flex-1" />
        <span className="flex shrink-0 items-center">
        {(pr.state === "open" || pr.state === "draft") && <WatchBell task={task} />}
        <RefreshBtn spinning={spinning} onClick={doRefresh} />
        <Tip content={t("pr.openOn", { provider: providerLabel })} side="bottom">
          <button
            onClick={() => openPath(pr.url).catch(() => {})}
            className="ui-icon-btn"
            data-size="sm"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </Tip>
        </span>
      </div>
      <button
        onClick={() => openPath(pr.url).catch(() => {})}
        title={pr.title}
        data-testid="pr-title"
        className="rp-git-pr-title"
      >
        <span className="rp-git-pr-num">{numberLabel}</span>
        <span className="rp-git-pr-title-text min-w-0 flex-1 truncate">{pr.title}</span>
      </button>
    </Card>
  );
}

/** The card's material. `tone` is the colour of its spine and wash: the PR's
 *  state, or a warning while the forge CLI needs attention. */
function Card({ children, tone, testId = "pr-card" }: { children: ReactNode; tone?: string; testId?: string }) {
  const toneStyle = tone ? ({ "--rp-pr-tone": tone } as React.CSSProperties) : undefined;

  return (
    <div data-testid={testId} className="rp-git-pr" style={toneStyle}>
      {children}
    </div>
  );
}

/** Inline-code styling for Trans-interpolated tokens: react-i18next clones
 *  this element with the translated children, so the prop is optional here
 *  even though every real render has one. */
function Code({ children }: { children?: ReactNode }) {
  return (
    <code className="rp-git-pr-code">
      {children}
    </code>
  );
}

/** Comment-watcher opt-in bell. While on (and the task has a live
 *  agent) new PR comments are queued into the main agent to address.
 *  Project-level "always watch" shows as locked-on; the per-task
 *  bell persists across relaunches. */
function WatchBell({ task }: { task: Task }) {
  // Subscribe to the LIVE task record - the `task` prop identity can lag
  // the optimistic pr_watch flip.
  const watching = useApp(s => !!s.tasks.find(w => w.id === task.id)?.pr_watch);
  const always = useApp(s => !!s.projects.find(p => p.id === task.project_id)?.watch_pr_comments);
  const setWatch = usePr(s => s.setWatch);
  const { t } = useTranslation("panels");
  const active = watching || always;
  const tip = always
    ? t("pr.watchAlways")
    : active
    ? t("pr.watchOn")
    : t("pr.watchOff");
  const Icon = active ? Bell : BellOff;
  return (
    <Tip content={tip} side="bottom">
      <button
        onClick={() => { if (!always) void setWatch(task.id, !watching); }}
        data-size="sm"
        className={cn(
          "ui-icon-btn",
          active && "text-[var(--color-accent)]",
          always && "cursor-default",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    </Tip>
  );
}

function RefreshBtn({ spinning, onClick }: { spinning: boolean; onClick: () => void }) {
  const { t } = useTranslation("panels");
  return (
    <Tip content={t("pr.refreshStatus")} side="bottom">
      <button
        onClick={onClick}
        className="ui-icon-btn"
        data-size="sm"
      >
        {/* A rotating SVG icon (RefreshCw, Loader2, ...) wobbles/looks
            off-center at this size - see ui/Spinner's own doc comment for
            why (stroked-arc rasterization + rotation about a half-pixel
            box center). Its border-radius ring is symmetric by
            construction and pixel-snapped, so it's the one shape that
            actually spins in place. */}
        {spinning
          ? <Spinner size={12} />
          : <RefreshCw className="h-3 w-3" />}
      </button>
    </Tip>
  );
}

/** Per-member PR/MR rows for a multi-repo task. The task-level card above
 *  covers the host worktree (the task's own `path`; `composition` holds
 *  only NON-host members); these cover the members, each resolved by the
 *  branch checked out in its own repo. Rendered only for members that
 *  resolved to a forge-backed result (status "ok"): no-remote/unsupported
 *  rows are noise, and an error/cli-missing hint would read as "no PR" on
 *  a compact row - the board card applies the same rule. Renders nothing
 *  until a refresh landed, so a task whose members were never polled never
 *  flashes empty rows. A member with no PR keeps the bare name+branch
 *  row: on a multi-repo task "this repo has no PR yet" is the answer. */
export function MemberPrRows({ task }: { task: Task }) {
  const members = usePr(s => s.byTask[task.id]?.members);
  const refresh = usePr(s => s.refresh);
  const hasMembers = (task.composition?.length ?? 0) > 0;
  // PrCard owns the mount/tick polling while it's mounted. On a
  // main-checkout task it never mounts, so member rows tick for
  // themselves - refresh() polls only members for such a task. A
  // main checkout with NO members has no PR surface at all: skip
  // the interval rather than churn a fresh PrEntry every minute.
  useEffect(() => {
    if (!task.is_main_checkout || !hasMembers) return;
    void refresh(task.id);
    const t = window.setInterval(() => refresh(task.id, true), POLL_MS);
    return () => window.clearInterval(t);
  }, [task.id, task.is_main_checkout, hasMembers, refresh]);
  if (!members?.length) return null;
  const rows = members.filter(m => m.status === "ok");
  if (!rows.length) return null;
  return (
    <Card testId="member-pr-rows">
      {rows.map(m => <MemberPrRow key={m.dir_name} m={m} />)}
    </Card>
  );
}

function MemberPrRow({ m }: { m: MemberPrLookup }) {
  const { t } = useTranslation("panels");
  const pr = m.pr;
  const st = pr ? STATE[pr.state] : null;
  return (
    <div className="flex items-center gap-2 py-0.5" data-testid="member-pr-row">
      <span className="min-w-0 flex-1 truncate text-[12px] leading-none text-[var(--sidebar-ink)]">
        {m.dir_name}
        {m.branch ? <span className="font-mono text-[var(--sidebar-faint)]"> · {m.branch}</span> : null}
      </span>
      {pr && st ? (
        <>
          <Tip content={t("pr.stateTip", { state: t(st.labelKey), provider: forgeName(pr.provider) })} side="bottom">
            <span className="rp-git-pr-signal font-medium" style={{ color: st.color }}>
              <st.Icon className="h-3 w-3" />
              {prRef(pr.provider, pr.number)}
            </span>
          </Tip>
          <ChecksChip checks={pr.checks} />
          <Tip content={t("pr.openOn", { provider: forgeName(pr.provider) })} side="bottom">
            <button
              onClick={() => openPath(pr.url).catch(() => {})}
              className="ui-icon-btn h-5 w-5"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          </Tip>
        </>
      ) : null}
    </div>
  );
}
