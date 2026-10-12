# Agent task rows in the sidebar

**Status: idea, not approved.** No GitHub issue exists and none gets
opened until the maintainer approves a slice of this. Each feature below
is specced far enough to build, but being detailed is not being decided.

Scope is the agent side of the sidebar only: how an agent task row looks,
what its context menu can do, what it tells you without opening it, and
the store and IPC work underneath. Project rows, groups and the status
section are out of scope except where an agent feature touches them.

Related docs, read before building any slice:

- `docs/agent-states.md`, what each agent state is and what it draws
- `docs/ideas/agent-orchestration.md`, which already covers cross-harness
  handoff in depth (see B1, which defers to it)
- `docs/ideas/claude-subagents.md`, phase 1 shipped the subagent rows
  that C3 builds on
- `docs/performance.md` bear trap 8, which every setter here must obey

## What the row already has

Checked against `src/components/sidebar/Sidebar.tsx` on 2026-10-12. The
task row context menu holds: New (tab submenu), Spotlight, Sandbox or
Docker, YOLO, Rename, Edit command, Edit task, Resume override, Copy
branch, Copy briefing, Edit or Schedule task, Move to group, and archive.
A per-task broadcast already exists (`useUI.openBroadcast(taskId)`) but
is reachable only from the tab bar, the command palette and a shortcut,
not from the sidebar. `task_diff_stat` already exists in Rust and
`src/store/diffStat.ts` feeds it to the board view, not the sidebar. The
task filter (`src/lib/taskFilter.ts`) knows only free text and a bell
toggle.

## Shared groundwork

Most features below need the same three pieces. Build these first, in
one change, or every feature reinvents them.

### G1. Task decoration fields

New optional fields on `Task` in `src/lib/types.ts` and the Rust `Task`
struct, all absent by default so existing records need no migration:

```ts
/** Sidebar row accent, a GROUP_COLORS css value. Absent is untinted. */
accent?: string;
/** Pinned above groups and manual order in its project. */
pinned?: boolean;
/** Up to 3 characters drawn before the name, e.g. "FE". */
tag?: string;
```

One Rust command, `task_set_decoration(id, accent, pinned, tag)`, that
writes only the fields passed and returns the updated `Task`, following
`task_set_yolo`. It must be async if it touches disk on the IPC thread
(see "What NOT to do", synchronous IO-heavy commands). Accent values are
validated against the palette on the Rust side, so a hand-edited
`tasks.json` cannot inject an arbitrary CSS string into a `style`
attribute.

Docker: these fields are UI-only and never reach `docker::build_spec` or
the host env overlay, so the second realm is unaffected. Say so in the
PR so the reviewer does not have to check.

### G2. One decoration selector per row

The row reads accent, pin and tag through one selector that returns a
stable tuple, compared shallowly, keyed by task id. The store setter
bails when all three are unchanged, like its siblings. Add a case to
`src/store/selectorFanout.test.ts` asserting that writing an unchanged
decoration re-renders zero rows and writing one task's accent re-renders
exactly one row.

### G3. A context menu section for agent actions

The task menu is already long. New actions go into one "Agent" submenu
placed after New, so the top level grows by one line. Items that act on
a running PTY are disabled, not hidden, when the task has no live agent,
with the reason in the tooltip, so the menu does not reshuffle between
opens.

## A. How an agent row looks

### A1. Accent tint

**What.** A color swatch row in the task context menu, the same
Finder-tag row `GroupActionsMenuItems.tsx` uses for groups, with Default
leading. Picking a swatch sets `accent`.

**How it draws.** A 2px left bar in the accent color plus the accent at
low alpha behind the name on hover only. The name itself stays
`--color-fg` so contrast never depends on the chosen color. All colors
come from `GROUP_COLORS`, which resolve to `@theme` vars; no hex.

**Interaction with groups.** A task in a colored group keeps its own
accent bar; the group color stays on the group header. If both are set,
the task bar wins on the row.

**Edge cases.** Archived tasks keep the accent so a restore brings it
back. Spotlighted rows already draw a highlight; the accent bar sits
outside it and must not shift the row's text by a pixel when either
toggles (check with a computed `paddingLeft`, not a screenshot).

**Tests.** Unit: the setter bail (G2). e2e: set an accent, assert
`getComputedStyle(bar).backgroundColor` matches the resolved var, reload,
assert it persisted, reset to Default, assert the bar is gone. Snap each
state for the PR.

### A2. Agent identity glyph

**What.** A 12px mark for the task's `cli` (claude, gemini, codex,
custom) at the row's left, replacing nothing, toggleable in the sidebar
list options next to "Task git icon".

**Why.** Projects that race agents on one problem currently show three
rows that differ only by name.

**How.** Glyphs live in `sidebarIcons.tsx` as monochrome SVG using
`currentColor`, so they theme for free. Custom commands get a generic
terminal glyph. No brand colors.

**Open question.** Whether the glyph follows `cli` or the agent actually
running in the focused tab, which can differ after a hand-off. Proposal:
follow `cli`, because the row describes the task, not a tab.

### A3. Pin to top

**What.** "Pin" and "Unpin" in the context menu. Pinned tasks sort first
in their project, above groups, in their own manual order.

**How.** Sorting happens where `order` is applied today; pinned tasks
form a first band and `order` still sorts within each band. Dragging a
pinned task below the band unpins it, dragging an unpinned task into it
pins it, so drag and the menu never disagree.

**Edge cases.** A pinned task inside a group: pinning lifts it out of
the group visually but does not clear `group`, so unpinning puts it back.
The collapsed "inactive" fold never swallows a pinned task.

**Tests.** e2e: pin, assert DOM order; drag out of the band, assert
`pinned` false; pin a grouped task, unpin, assert it is back in its
group.

### A4. Short text tag

**What.** "Set tag..." opens an inline input on the row, up to 3
characters, drawn as a small mono chip before the name. Empty input
clears it.

**Why not emoji.** Width is unpredictable across fonts and the repo's
own rules keep emoji out of the UI.

**Edge cases.** Tags participate in the sidebar text filter. Leading and
trailing whitespace is trimmed; anything past 3 graphemes is rejected in
the input, not truncated silently.

### A5. State-driven row decoration

**What.** Today the row draws a work badge (`taskWorkBadge`: attention,
done, working, delegated). This adds text treatment on top of it:

- waiting for input: name in medium weight
- done and unseen: a faint underline until the task is focused, cleared
  by the same path as `unread` (`setActiveTask`)
- idle for a long time: name in `--color-fg-muted`, threshold in
  Settings > Tasks, default 30 minutes, off by default

**Performance.** These derive from the aggregate state the badge already
computes. No new subscription, no timer per row. The idle dim uses one
shared minute ticker for the whole sidebar, not one per task.

**Risk.** Weight changes can reflow the row and truncate the name at a
different point. Use a font-variation or a fixed-width technique and
assert the name's `offsetWidth` does not change between states.

## B. Context menu actions

All of these live under the Agent submenu (G3).

### B1. Hand off to another agent

**What.** "Continue with..." lists the other installed agents. Picking
one opens a new tab in the same worktree running that agent, seeded with
the task's briefing (the text Copy briefing already builds).

**Scope.** The briefing seed only. The full session-transfer design
(converting one agent's transcript into another's) belongs to
`docs/ideas/agent-orchestration.md` "Cross-harness handoff" and is not
duplicated here. This slice is useful without it.

**Edge cases.** Sandbox and Docker settings are per task, so the new tab
inherits them; the confirmation line says so. If the target agent is
not installed, the item is disabled with the reason.

### B2. Fork task

**What.** "Fork task..." opens the New Task dialog prefilled with the
same project, agent, sandbox and YOLO settings, and the base set to this
task's current HEAD instead of `base_branch`. The new task gets
`spawned_by` set, so `SpawnLinks.tsx` draws the link.

**Edge cases.** Uncommitted changes in the source are not carried; the
dialog warns when the source worktree is dirty and offers to stop. Main
checkout tasks (`is_main_checkout`) fork from the checked-out branch.

### B3. Broadcast from the sidebar

**What.** "Send to agent..." calls the existing
`useUI.getState().openBroadcast(task.id)`. Nothing new under it; this
only exposes a shipped feature where people look for it.

### B4. Restart agent

**What.** Two items: "Restart agent" (respawn with resume, the same
lifecycle as the existing resume path) and "Restart fresh" (respawn with
no resume, behind a confirm because it drops the conversation from the
agent's point of view).

**Edge cases.** Applies to agent tabs only, never AuxTerminal or run
tabs. With several agent tabs the item becomes a submenu listing them.
A sandboxed task's restart must keep the sandbox; reuse the forced-
restart path the Sandbox dialog already uses rather than a new one.

### B5. Review this task

**What.** "Review changes" opens a new agent tab in the same worktree
with the review prompt from `src/lib` and the task's diff against base.

**Edge cases.** Disabled when `task_diff_stat` reports zero changes. The
reviewer runs with the task's sandbox. It never runs YOLO regardless of
the task flag, because a reviewer has no reason to write.

### B6. Compare with another task

**What.** "Compare with..." lists sibling tasks in the same project.
Picking one opens a diff view of task A's tree against task B's tree.

**How.** A new Rust command, async, running `git diff <a-head> <b-head>`
across the two worktrees (they share an object store as worktrees of one
repo). Renders in the existing DiffPane.

**Edge cases.** Multi-repo compositions compare member by member; a
member present in only one task is listed, not diffed.

### B7. Copy last agent message, export transcript

**What.** "Copy last response" copies the agent's last assistant message.
"Export transcript..." saves it as Markdown.

**Open question.** Only claude has a reliable on-disk transcript today
(the subagent work reads it). For gemini and codex this is either
scrollback scraping, which is lossy, or not offered. Proposal: claude
only in the first slice, disabled with a reason elsewhere.

### B8. Notify me when done

**What.** A one-shot toggle. When the task next reaches done or waiting,
it fires a system notification even if notifications are off for that
state globally, then clears itself.

**How.** A transient UI-store set of task ids checked by
`useAttentionNotifier`. Not persisted; a relaunch forgets it, which is
correct for a one-shot.

### B9. Run the same prompt on several agents

**What.** "Race this..." creates one new task per selected agent, each
with this task's original prompt, and puts them in a new task group
named after the source task.

**Edge cases.** Each spawned task gets its own port block and worktree;
creation runs through the existing pending-task path so failures show as
pending rows with errors, not as a silent partial set. Combined with B6
this is the "which agent did it better" loop.

## C. Information on the row

### C1. Hover card

**What.** Hovering a task row for 600ms shows a card: agent and model
(from `agent_args`), runtime of the current session, diff stat, last
state change and when, sandbox mode, and account override if set.

**Performance.** Nothing is fetched until the card opens; the diff stat
comes from `src/store/diffStat.ts` on demand. The card unmounts on
leave. No polling while open; it re-reads only when the task's state
changes.

**Open question.** Token or cost usage. `docs/ideas/usage-footer.md`
covers where usage comes from; the card shows it only once that exists.

### C2. Inline diff stat

**What.** `+12 -3` at the row's right edge, muted, toggleable in list
options, off by default.

**How.** Refreshed when the task settles (the settled detection in
`docs/ui.md`), never on PTY output. Uses the existing `task_diff_stat`.

**Risk.** One git call per task per settle. For a project with many
tasks finishing together, batch through the store's existing queue
rather than firing one IPC each.

### C3. Subagent count on collapsed rows

**What.** When a claude task row is collapsed and has live subagents, a
small count badge shows how many are running. Data already exists in
`src/store/subagents.ts`; this only reads it.

## D. Explorer-wide

### D1. Filter by agent and state

**What.** Extend `TaskFilter` with `agents: string[]` and
`states: ("waiting" | "working" | "done" | "idle")[]`, exposed as chips
in `ProjectTaskFilter.tsx`. The text box also accepts `agent:claude` and
`is:waiting` tokens that set the same fields.

**Rule.** Match on aggregate state only, never `liveTitle`, for the
reason `taskFilterFacts` already documents: rows would flap.

**Tests.** Unit tests in `taskFilter.test.ts` for each token, combined
filters, and unknown tokens falling back to text.

### D2. Jump to next waiting agent

**What.** A shortcut that focuses the next task whose aggregate state is
waiting, cycling in sidebar order, wrapping at the end, and a no-op with
a short toast when none is waiting.

**How.** Registered through the shortcut system in `docs/shortcuts.md`,
rebindable like the rest. Uses `taskHasNotification`'s classification so
it agrees with the tray count.

## Build order

1. G1, G2, G3 together, with the fan-out test.
2. A1 and A3, the most asked-for and the cheapest on top of G1.
3. B3, B4, B8, small and reusing shipped paths.
4. D1 and D2.
5. A2, A4, A5, C2, C3.
6. B1, B2, B5, B9, which create tabs or tasks and need careful e2e.
7. B6, B7, C1, which need new Rust or depend on other ideas.

Every slice carries its e2e spec in the same commit and, being UI,
screenshots in its PR description.

## Open questions for the maintainer

- Does accent belong on the task or on the agent tab? This doc puts it
  on the task.
- Is an Agent submenu acceptable, or should the top-level menu be
  reorganized instead?
- Should B9 exist in the sidebar at all, or only in the New Task dialog?
