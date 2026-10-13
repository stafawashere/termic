# UI

## Conventions

- Colors are `@theme` CSS vars in `index.css`. Accent terracotta `#d97757`, dark surfaces `#0a0a0a`-`#181818`. Never hard-code hex outside `@theme`.
- Ink on a solid **status/accent fill** must come from that fill's own `-fg` token, never `text-white`. On a `--color-accent` fill (count badges, filled CTAs, review-comment buttons, editor search checkmark, toggle knobs on an accent track) use `--color-accent-fg`; on a `--color-ok` fill (the AgentsSection toggle tracks) use `--color-ok-fg`. Do not reuse one for the other: a theme may pair a light accent with a dark ok. The accent is not guaranteed dark (cobalt sky 1.9:1, matrix green 2.5:1, rosepine rose 1.7:1 against white), so light-accent themes override the token to a dark ink. `--color-accent-deep` stays dark in every theme, so white text on it is fine, which is why the `:hover` states that drop to accent-deep flip back to white.
- `CliIcon cli={...}` + `CLI_BRAND_COLOR[cli]` for claude/gemini/codex (orange/blue/green).
- Tooltips default `delay: 0`. Override per-call.
- `cn()` from `@/lib/utils` for class composition.
- **Dialog mode switches ride the TITLE line** (`titleAction` on `AppDialog`, spread `dialogTitleAction` onto the control). "Import a worktree", "From a GitHub issue" (named per-forge: GitLab issue, Azure DevOps work item), "Blank task instead" and "New worktree instead" change what KIND of thing the dialog is making, which is chrome, not a field, and as form rows they cost a `gap-4` row each on every open of a dialog most of whose opens have nothing to do with them. The title line is mostly empty, so they are free there. Two rules for anything you put in that slot: it is inside the window drag region, so it must carry the `data-tauri-drag-region="false"` + `WebkitAppRegion: "no-drag"` opt-out that `dialogTitleAction` provides (without it the control is not clickable at all), and the labels stay SHORT because worktree mode can show two switches at once. The row wraps rather than truncating, so the pathological case degrades to the row it used to cost instead of clipping.
- **Focus indicator: one rule, `src/index.css`, `@layer base`.** A single `:where(a[href], button, summary, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])):focus-visible` gives every control a 2px `--color-accent-soft` outline at `outline-offset: -2px`. The negative offset draws it INSIDE the border box, so a control sitting flush against a container edge cannot have it clipped (the sandbox picker's first card, which its dialog autofocuses, was the case that forced this). `:where()` makes it zero-specificity, so any component overrides it just by saying so. Do NOT add a per-component `focus-visible:ring-*`: `src/lib/focusRing.test.ts` fails if one appears. Text fields opt out with `outline-none` and signal focus with a border instead, as do Radix menu items (`data-highlighted`) and dialog containers (Radix focuses the content on open).
- **A resize divider is a 9px grab strip, not the line it paints** (`components/ui/ResizeHandle.tsx`). The element IS the strip: 3px on the panel's side, the border pixel, 5px on the neighbour's, with `anchor` saying which edge of the parent it straddles. The painted 1px line is a child, so what lights up under the cursor and what takes the press are the same region. Do NOT go back to a thin element with a wider hit-area child hanging out of it: hit testing respects an ancestor's clip, and the sidebar's `overflow-hidden` reduced that arrangement to one grabbable pixel (measured, `tabs-layout.e2e.ts` "gives both dividers a grab strip"). For the same reason the sidebar's handle is a SIBLING of its `<aside>`, not a child. The suite's `mouseDrag` dispatches straight at the handle element and so cannot see any of this; the grab strip is measured with `elementFromPoint`.
- All `<input>` and `<textarea>` get `spellCheck={false}` + `autoCorrect="off"` + `autoCapitalize="off"` + `autoComplete="off"`. Developer tool — paths and commands are never English words.

## Settings layout

Left rail + one content pane (`components/settings/Settings.tsx`). Three bands, hairline-separated, then the per-project list:

1. **Opened by choice** (General, Appearance, Agents & Terminals)
2. **Set once** (Tasks, Notifications, Prompts, Shortcuts, Profiles, Sync)
3. **The perimeter**, what the app is allowed to do (Sandbox, Termic CLI)
4. `PROJECTS`, the only band with a label, because it is a dynamic list needing an empty state

The bands are what the app looks like and runs, then how it behaves while you work, then what it is allowed to do. Sandbox sits low because of the last one, not because it matters least. General leads by convention rather than by that rule: it is app-level and set-once, but every settings UI opens on General and fighting that expectation costs more than the inconsistency does.

Appearance carries its own sub-tabs (Terminal, Editor, Interface & Sidebar) on the strip Settings → Projects uses. Terminal leads.

A per-project page carries four of those sub-tabs: Scripts & run (Members & scripts on a multi-repo project), Sandbox, Code navigation and More. Code navigation is named by `codeIntelName()`, so it reads Code intelligence once type checking is on, exactly like the panel it opens. It earned a tab rather than sitting under Scripts & run, where it started: it shares nothing with the setup/run/archive scripts that tab exists for, it is the size of a page on its own (arming, languages, the server picker, per-language settings), and it is machine-local `projects.json` while that tab's storage strip is switching between personal and the committed `.termic.yaml`. Its live preview is a real `AuxTerminal`, so it is click-armed: a settings visit must never fork a shell on its own, and the pty dies when the tab unmounts.

Each page owns one domain, and a setting belongs to the page whose domain it changes, not the page that happened to be open when it was written. General is app-level only (repos directory, personal file-tree excludes, remote images in the markdown preview); it is deliberately short. A new setting that needs a fifth thing on General is a sign the domain wants its own rail item.

Sections share `Controls.tsx`: `Toggle`, `ListField`, `Block` (hairline + spacing), `SectionTitle`, and `useBackendSettings()`. Use the hook rather than calling `settingsLoad`/`settingsSave` directly: it caches the whole `Settings` object and merges patches into it, so one page saving one field cannot wipe another page's. Prefs (`store/prefs`) persist on change; backend `Settings` fields either persist on change through `patch()` or use an explicit Save button when the field is a multi-line list.

Deep links (`openSettings(tab, repoId, highlight)`) hard-code a tab name, so moving a setting between pages means updating its callers. Live ones: the markdown-preview banner (`general` + `load-remote-images`), the command palette's settings list, and the shortcuts help dialog.

### The Linux desktop-entry row is absent, not disabled

Settings, General grows a "Desktop entry" block ONLY when `$APPIMAGE` is set
and points at a file that still exists. On macOS, on Windows, on a `.deb` and
in a dev build the block does not render at all.

Absent rather than greyed out because the thing it offers cannot be
half-done: it writes into the user's own `~/.local/share`, and a row offering
that on a build where `Exec=` would point at nothing is how somebody ends up
with a broken launcher entry. `settings.e2e.ts` pins the absence, and checks
the backend agrees rather than the row merely failing to render.

The button is "Create"/"Remove", never a toggle, because the state is read
from the filesystem every time the page opens. A toggle implies we own the
value; we do not, since the user can delete the file and Gear Lever or
AppImageLauncher can write one.

Two places ask, and they do not overlap. The welcome wizard carries it as an
unticked checkbox on its last step, for a user who is new. The standalone
prompt (`src/lib/desktopEntryPrompt.ts`) covers everyone who is not, and
stands down while `settings.welcomed` is false, because both are modal and
the wizard blocks Escape: without that, a brand new Linux user met a second
dialog stacked on one they could not dismiss.

Either way the question is asked ONCE ever, and the fact that it was asked is
recorded BEFORE the answer: quitting mid-dialog, or a failed write, must not
turn it into something that greets you at every launch. Settings owns it
after that.

The wizard's checkbox is TICKED by default; the standalone prompt still needs
a real click. The difference is deliberate: the prompt interrupts someone
mid-use, while the wizard is a setup flow they opened on purpose, with the
box, its label and what it does all on screen before Finish. Unticked, almost
nobody noticed it. It is never hidden or implied, and Settings → General
reverses it.

### Settings text runs the full width of the pane

**Never put `max-w-prose`, `max-w-md` or any other width cap on body text in a
settings page.** The content pane already sets the measure; a second cap inside
it wraps a paragraph at roughly half the pane's width and leaves an obvious
empty column to its right. Grep says it plainly: no settings section uses a
width utility on text, and every one that ever did was a regression.

It keeps happening because `max-w-prose` is genuinely good advice for a
full-bleed page and is the reflex when writing a description paragraph. It is
wrong HERE, because the pane is not full-bleed: it has already been narrowed
once. The two constraints multiply.

The same goes for `mx-auto max-w-*` on an empty state. Center the BOX, not the
sentence inside it.

If a paragraph genuinely reads too wide, the answer is the pane's own measure
in `Settings.tsx`, once, for every page: not a cap on one paragraph, which
makes that page disagree with the twelve beside it.

### Experimental features

A feature is Experimental when it is off by default **because we are not yet confident in it**, with a stated way out. Off for safety (remote images), off for taste (copy on select), and off as policy (sandbox permission bypass) are none of them experimental: those defaults are permanent, and labelling them experimental makes the label meaningless.

It shows as a badge, on the rail item and next to the page title, not as a separate Labs page. The badge is dropped when the feature graduates: it survived a release with no bug reports against it and has e2e coverage. Graduating drops the badge and gets a changelog line; it does not move the page, because a settings page that moves twice is worse than one labelled honestly. A dedicated Experimental page only earns its place when several features qualify at once, which today they do not (the residents are Sync and the Docker sandbox). Graduated so far: the CLI in 0.26.0, dropping the badge and flipping `cli_enabled` to default ON in the same change, since a badge that says "still settling" alongside a setting we ship enabled reads as a contradiction; and Profiles, whose badge came off the rail item and the page title together while the feature stays dormant until a profile is created.

## Settings > Sync (config sync, phase 1)

`components/settings/SyncSection.tsx`, loaded with `React.lazy` from `Settings.tsx` so the prefs registry and `lib/configSync.ts` stay off the app-start path. Experimental badge: nothing happens until a repo is connected, and Disconnect is the way out. The design is [ideas/config-sync.md](ideas/config-sync.md); the commands are in [ipc.md](ipc.md) "Config sync". Only the first profile to connect on a machine chooses a folder; after that every sync creates a profile for each repo folder nobody here follows and uploads each unlinked profile, so the picker appears for exactly two cases and says which (`data-why` on its first line): a profile that shares its name with a repo folder (never matched on a guess, the folder is preselected), or one that was disconnected. "Profiles not on this machine" lists repo profiles deleted here, each with Create here.

The page has three states, top to bottom:

1. **No repo on this machine**: a URL field and Connect. An EMPTY repo binds this profile to a new folder and pushes at once, since there is nothing to apply here. A URL that is not `https://`, `http://`, `ssh://`, `git://`, `file://` or `user@host:path` is refused before anything is cloned (Rust decides, see [ipc.md](ipc.md) "Config sync"), and `sync-action-error` names the forms it takes, in either language.
2. **A repo, this profile not bound**: one radio per folder already in the repo that no other profile on this machine follows (by profile name, its `profiles/<sync-id>` beside it; `sync_bind` refuses a taken one too, or two profiles would overwrite each other's folder) plus "Start a new one for this profile". Preview runs `sync_preview`, a dry run that writes nothing, and lists every change the first connect would make here. Lines that change a YOLO or sandbox default (`SAFETY_PROJECT` / `SAFETY_PREFS` in `config_sync.rs`) sort first and are highlighted in `--color-warn`. Nothing applies until "Apply and connect"; Cancel applies nothing.
3. **Bound**: repo and folder (one grid, so both values share a left edge in either language), Sync now, the last sync time, the last error, and the last run's report. The report names only what the sections below it do not: projects waiting for a folder are one count ("2 projects wait for a folder"), since that section lists them and nothing was applied, and a YOLO or sandbox change is counted as applied but carries no line of its own, since the notices panel and the toast already show it. A safety line always names the change ("Start new tasks in YOLO changed from Default to On"): "YOLO, Default to On" read as if the setting were called that.

Below that, only when there is something to answer: **Sync changed these settings** (what a pull applied that must not pass silently, persisted in `sync-state.json` until Got it, and announced once per set as a sticky toast with Review: a YOLO or sandbox default, or a custom agent deleted on another machine. That removal is applied and announced, not asked, because it deletes no files, unlike `project_remove`, which archives tasks and deletes worktrees; the line says tasks here that use the agent can no longer start it), **Changed on both machines** (one row per conflicting file, "Keep this machine's" / "Take the other one"; once every file has a choice the sync carries on. A conflict is per FILE: git merges by line and keys are sorted, so two machines changing adjacent fields of one project, `default_sandbox` and `default_sandbox_mode` say, conflict although the fields differ. Field-level resolution from the three versions is future work), **Waiting for a folder** (Locate opens a folder picker, Skip moves the row to **Skipped on this machine** with Show again), and **Removed on another machine** (Remove here asks with the same counts as Settings > project > Remove, because `project_remove` archives tasks and deletes worktrees; Keep republishes the project). **Stays on this machine** is always shown: agent env and Docker env never sync, nor do paths, port ranges, logins and tokens.

The launch pull runs from `App.tsx` after `loadAll`, through a dynamic import of `lib/configSync.ts`: one `sync_status` read when sync is not set up, nothing else. A run's prefs come back as keys to write; only keys whose stored value differs are written, then `reloadPrefsFromStorage`, the prompt library and the folder colors each publish only what moved (`selectorFanout.test.ts` pins the no-op case). Other windows hear `termic://sync-changed` (reload projects and themes) and `termic://sync-prefs-written` (reload prefs).

Test ids: `sync-url`, `sync-connect`, `sync-folder-option-<id|new>`, `sync-preview`, `sync-preview-panel`, `sync-preview-list`, `sync-apply`, `sync-preview-cancel`, `sync-now`, `sync-last`, `sync-error`, `sync-result`, `sync-change-safety`, `sync-notices`, `sync-notices-dismiss`, `sync-conflict-<i>`, `sync-waiting-<id>`, `sync-locate-<id>`, `sync-skip-<id>`, `sync-skipped-<id>`, `sync-unskip-<id>`, `sync-removal-<id>`, `sync-remove-<id>`, `sync-keep-<id>`, `sync-never`, `sync-disconnect`, `sync-action-error`. Spec: `e2e/specs/sync.e2e.ts`.

## The new-task launcher's CLI order

The project `+` menu (`sidebar/ProjectActionsMenuItems.tsx`) and the New Task
dialog's Default CLI pills list the same thing: every offered agent, then
Terminal. Both hoist **this project's** default CLI to the front
(`defaultCliFirst` in `lib/agents.ts`, unit-tested), and the menu marks that
row `default`.

Two orders are in play and they answer different questions. Settings → Agents
& Terminals is a global preference ("which agents do I care about, in what
order"), and dragging its pills reorders that list for the whole app. Which
agent a given repo starts with is a per-project answer stored as
`Project.default_cli`, and in a launcher that one wins: the first row is the
one people click without reading, so it has to be the pick they configured,
wherever that agent happens to sit in the registry. Terminal takes part like
any other row (a repo defaulting to a plain shell gets it hoisted too), rather
than being pinned to the tail.

Rows carry `data-launcher-cli="<id>"` so tests can assert the order by id
instead of by display name.

## The project row's task filter

The project header's hover carries a filter icon, left of ⋯
(`sidebar/ProjectTaskFilter.tsx`, GH #324). It opens a bar
on its OWN line under the header, full width: a text input and a bell.
Inline in the header, the input left a long project name almost no room.
The bell keeps only tasks with a notification and shows how many there
are. Both AND, per project, in
`useUI.taskFilters`, never persisted. The matching is a pure function of
store state (`lib/taskFilter.ts`, unit-tested) evaluated at render, so a
CLI rename or a notification arriving moves a row with no extra wiring.

- **Text matches the task name and each terminal tab's STABLE title**
  (the user's rename, else the default), never `liveTitle`. Agents
  rewrite their OSC title every second, and matching on it made rows
  flap in and out of the list. A task whose tabs are not loaded falls
  back to `persisted_tabs`, titled the way a restore would title them.
- **"Notification" is the tray's classification**, via the shared
  `aggregateTabsState` (`lib/cliAgentState.ts`): waiting or done, with
  working outranking both. The per-project counts therefore add up to
  the tray numeral; a second definition would make the two disagree.
- **The active task is always listed.** Opening a task clears its
  notification, so under the bell the row just clicked would vanish
  from under the cursor. It drops out once another task is selected.
  "No matching tasks" appears only when the list is empty: printed
  under the kept active row, it read as a contradiction.
- **Turning a filter on expands the project once**, through the normal
  collapse state: a filter whose results sit behind a chevron reads as
  "nothing matched". Once, not for as long as it is on: forcing it open
  at render made the chevron dead while a filter was up.
- **The header holds one filter icon while the bar is open**, lit while
  any filter (text or bell) is on; hover does not reveal it. It sits next to
  the bar it belongs to: the input, then the bell
  with its count. An active filter keeps its bar and pins the header's
  controls; an empty, abandoned bar folds away. A filter whose results sit behind a chevron reads as
  "nothing matched", and the stored collapse is left untouched so
  clearing the filter folds it back.
- Escape in the input and its clear button both empty it. The feature
  is absent in compact mode.

## One glyph per meaning

The sidebar grew one feature at a time and each brought its own mark, until
it said some things twice and swapped what a slot meant on hover. The rules
it keeps now (the "Lens" concept of the sidebar rethink):

- **The agent's own title glyph never repeats the icon beside it.**
  `formatTerminalTitle` always strips claude's `✳` (the brand icon says
  "claude"), and strips its spinner frame whenever Termic draws its own
  working badge (the `workingIndicator` pref), whatever the tab's state.
  A frame is one leading symbol that is not a letter, a number or ASCII
  punctuation, followed by a space, because claude has shipped Braille,
  circle (`◐◑◒◓`) and star (`✢✶✻✽`) frames. Matching only Braille left
  `◑` beside the spinner badge; matching any symbol without the space ate
  a title's own `「`, `¿` or `“`. A title that is only glyphs keeps them. It
  takes the RESOLVED icon id, so a cloned agent (`claude-dpf`) is treated
  as the claude it draws as. With the pref off the spinner stays: it is then
  the only working signal.
- **A task row's trailing marks, in order:** the PR (right-aligned, with
  its number, `#367`), the mode (sandbox, docker, or a dangerous YOLO;
  absent when there is none), then ONE fixed slot, always rightmost so it
  lines up down the tree: work state at rest (the badge while collapsed),
  the task menu on hover. Mode has its own slot, so the menu never hides
  it. For one release the menu had a slot of its own too, reserved and
  empty at rest, and every row ended 22px short of the sidebar's edge for a
  button that only exists under the pointer. Do not give a hover-only
  control a reserved column. The state layer sits OVER the trigger and is
  `pointer-events-none`: without that it takes every click meant for the
  three dots while invisible, which shipped once.
- **Location glyphs are a choice.** The tree draws a link for the main
  checkout and a branch for a worktree by default, in the branch chip at
  the row's right end (it fades out under the pointer, and takes the menu
  button's room when that slot is free); nothing sits after the name; the `taskLocationIcon`
  pref (Settings > Appearance > Sidebar, and a submenu in the Projects
  list options) narrows that to main checkout only, worktree only, or
  none, since whichever one you mostly use is noise. Other surfaces (board
  cards, the dashboard, the breadcrumb) always show both.
- **The PR mark is a choice too.** A task row with a PR draws its number
  (`#367`) by default, in the state's colour; the `taskPrBadge` pref
  (Settings > Appearance > Sidebar, and a submenu in the Projects list
  options) switches that to the glyph alone, glyph and number, or nothing.
  Every one of them keeps the state colour and the link.
- **An approved PR is ticked.** An OPEN PR whose review verdict is
  "approved" draws a small `--color-ok` check LEFT of its number (so the
  numbers keep one right edge down the tree), whatever the mark's own
  colour, so approved with a failing build is amber and
  ticked. Merged and closed PRs do not: the verdict no longer says
  anything. The verdict is `PrStatus.review`, which all three forges
  already report; GitHub's falls back to the reviews themselves when
  `reviewDecision` is empty.
- **The mark remembers its last status across launches.** The live lookup
  dies with the app and the background pass rebuilds it one subprocess at
  a time, so `usePr.snapshots` (localStorage `prSnapshots`) keeps each
  task's last state, checks and review, and `TaskPrBadge` wears it until
  this session's first poll lands. It feeds the mark ONLY. Board columns,
  status buckets and the merged-PR lifecycle keep reading the live
  `byTask`, because a remembered "open" there would turn a merge that
  happened while the app was closed into a transition seen live. Under "number", a PR whose number is not
  known yet keeps its glyph, since dropping both would drop the link. The
  status section and the dashboard never drew the number.
- **Names are drawn as typed.** Project names are no longer capitalised,
  and a folder group's name is shown in sentence case
  (`groupDisplayName`, `lib/projectGroups.ts`) although it is stored in
  caps. What sets a project apart from its tasks is the folder glyph and
  the filled background an open project keeps.
- **The project header's hover shows a tray:** the filter, ⋯ and `+` in
  one bordered box (`.sidebar-tray`). ⋯ opens the project's own
  right-click menu at the button, which is where Settings lives now; the
  filter (#324) keeps its own icon, pinned while it filters. A task row's
  menu button is the same tray holding one button.
- **One nesting style:** a 1px guide line. A project folder's is neutral (or
  its accent, tinted); a task group's is its colour. Different colour, same
  weight, same meaning: these belong together.
- **The nav is one segmented control,** a recessed well of icons with the
  current view raised, each with its name as a tooltip and as
  screen-reader text. It sits centred in the toolbar, and runs down the
  icon rail. Four full-width rows took the top of the sidebar before
  anything about your work showed. The toolbar held an agent activity
  readout beside it until the title bar's session strip took that job
  (docs/ui.md "Title bar contents"); neither the toolbar nor the rail draws
  one now.

## The refined tree (GH #90)

The sidebar's look, from the 2026-10 redesign. Every colour is a
`--sidebar-*` token defined for every theme (docs/themes.md), and the
accent is the theme's, never a literal.

- **Geometry.** One grid: `treeIndent(depth) = 6 + 18 * depth`. Each
  project wrapper sets `--sb-task-pad` (its tasks) and `--sb-member-pad`
  (a task group's members); session rows sit 18px further in, subagent
  rows 18px per level after that. Guides are 1px lines 4px right of the
  parent's indent, with a 9px elbow into each child. Rows are
  `--sidebar-row-h` (28px) for projects, sessions and subagents and
  `--sidebar-task-row-h` (30px) for tasks.
- **Selected** is `.sidebar-selected`: a horizontal accent gradient and a
  2px inset accent bar. It is the same on a task, a session, a subagent and
  a rail tile.
- **Counts are keycaps** (`.sidebar-badge`): 16px tall, a 4px radius and
  the tray's hairline, not pills.
- **Work state on a session is worded:** a dashed spinner and "running"
  in `--sidebar-running`, or "done" in `--sidebar-settled`. Subagent rows
  use the same words.
- **Menus** opt in with `.sidebar-menu`, which restyles the shared menu
  primitives (34px items, labelled sections, checked rows) for the sidebar
  only.
- **The bottom bar** is the sidebar half of the footer strip (see "The
  footer strip" below).
- **The icon rail** stacks the views in the same well. Every row is a 32px
  tile (`.sidebar-rail-tile`) with a corner dot for what its full row would
  draw.
- **Keyboard focus** is one inset ring, `--sidebar-focus-ring`, on every
  button and `role=button` row in the panel. Inputs keep their accent
  border (`.sidebar-inline-input`) and menu items their highlight.
- **Accent presets** (group folders, task groups, profiles) paint with
  `--color-swatch-*`, the palette at 57% chroma. The raw `--color-palette-*`
  still drives state marks and links.

## The shared ui-* family

The rest of the app wears the refined tree's materials through a small
set of classes in `src/index.css`, so a new surface composes them rather
than restating colours:

- **Surfaces.** `.ui-panel` (the right panel), `.ui-well` (a recessed
  tray for segments), `.ui-card` (a raised sheet on a page; add
  `data-interactive="true"` for a hover), `.ui-column` (a Kanban column,
  a well), `.ui-board-card`, `.ui-sheet` (dialogs, popovers, tooltips),
  `.ui-palette` (the translucent command, prompt and syntax palettes),
  `.ui-popover` (find bars), `.ui-view-bar` (a main view's top bar).
- **Controls.** `.ui-seg` with `data-active` inside a `.ui-well`,
  `.ui-raised` (`data-size="sm"`, `data-tone="accent|danger"`),
  `.ui-icon-btn` (`data-size="sm"`), `.ui-field` (a sunk field wrapper
  with a leading glyph and optional `.ui-keycap`), `.ui-input` and
  `.ui-sunk-input`, `.ui-btn-primary` and `.ui-btn-secondary` (what the
  shared `Button` variants map to).
- **Lists.** `.ui-row` (28px, radius 6, `data-selected="true"` for the
  accent gradient and left bar), `.ui-row-name`, `.ui-row-meta`,
  `.ui-guide`, `.ui-chevron`, `.ui-status-letter`, `.ui-tray` (hover
  actions), `.ui-section-head`, `.ui-eyebrow`, `.ui-count`, `.ui-notif`
  (a corner notification badge), `.ui-scroll`.

The shared primitives (`Button`, `Input`, `Checkbox`, `AppDialog`,
`Popover`, `Tooltip`, the dropdown and context menus, the toaster) are
built on these, so most dialogs follow without edits. The sidebar and the
title bar keep their own `.sidebar-*` and `.titlebar-*` classes; the
family reuses their tokens, not their selectors.

Not restyled here: the split-pane header (`PaneHeader`), which mirrors the
main tab strip and moves with it.

## The footer strip

Two footers read as one strip across the bottom of the window: the
sidebar's (`SidebarFooter`, `sidebar-footer`) and the task's (`FooterBar`
in `TerminalPane.tsx`, `task-footer`). Both are `--footer-h` (46px) with a
1px `--footer-border` top hairline and a white top highlight, and the
sidebar's right border runs through as the divider. `--bottom-bar-h` stays
36px for the bars that are not part of the strip: the split terminal's tab
strip and the right panel's footer. Tokens: docs/themes.md "Footer tokens".
Glyphs are the design's own paths, in `src/components/footer/footerIcons.tsx`.

Both are built from the sidebar's wells (`.footer-well`, `--sidebar-well-*`):
3px padding, 8px radius, 2px gap.

**The sidebar half.** One well holds theme (`footer-theme`), bug
(`footer-bug`), mail (`footer-whats-new`), keyboard (`footer-shortcuts`) and
activity (`open-activity`); settings (`footer-settings`) sits in its own
well at the far edge. Each is a 32x26 `.footer-icon-btn` with a 16px,
1.8-stroke glyph in `--sidebar-footer-icon`, hovering to
`--sidebar-seg-hover`. The theme glyph is a moon, or in light a sun in
`--footer-sun`. The icon rail keeps a vertical stack of the same buttons
(`.sidebar-footer-btn`, 22px glyphs).

The bug button opens a prefilled GitHub issue. The mail button opens the
Changelog (What's New) dialog and marks the running version seen through
`dismissWhatsNew`. While `isWhatsNewUnread(currentVersion,
lastSeenVersion)` holds, a 6px `--color-accent` dot with a glow and a ring
in the well's colour sits at the glyph's top-right
(`footer-whats-new-dot`). The watermark is the update store's
`updateLastSeenVersion`, so the dot stays gone across a reload and comes
back only when a newer version runs. A fresh install adopts its version
silently and shows no dot. `dismissWhatsNew` writes nothing when the
version is already seen. The unread flag is a primitive boolean selected
inside the footer, a memo component, so a version change re-renders the
bar and not the sidebar. The contact mailto (`src/lib/contact.ts`, which
also copies the address, #103) lives in the Changelog dialog's title line
as `changelog-contact`.

**The task half.** Left, one well with two 26px segments (`.footer-seg`):
Queue messages (`queue-button`) and Terminal (`footer-terminal`). A
segment is raised (`data-active`, the sidebar's chip gradient, weight 600)
while it is in use: Queue while it holds messages or its popover is open,
with its glyph in `--color-accent` and the count in a 16px pill
(`queue-count`, hidden at 0); Terminal while the bottom split is open and
expanded. Terminal runs `toggleBottomTerminal`, the same action as ⌘J. The
Queue control stays in this bar while the split is open; the split strip no
longer carries a second copy, so a task has exactly one. Labels drop below
680px of bar width (a container query), counts never do.

Right, the usage readouts ("The usage readout" below), the "N blocked"
count when the cage has denied something, and the sandbox chip
(`footer-sandbox`) pinned rightmost: 30px, 8px radius, a 1px
`--footer-chip-border`, shield glyph, "Sandbox" and a keycap naming the
state (`.footer-tag`: OFF, ON, FS, LOG, DOCKER). An enforcing cage tints
border, wash and keycap with `--color-ok`, monitoring with `--color-warn`.
A click opens the sandbox dialog, the same action as the title bar's
sandbox segment, so the two never disagree. `data-sandbox-mode` names the
mode for specs.

**Window in the background:** `initWindowFocus` mirrors `windowFocused`
onto `data-window-inactive` on the root, and `.footer-ink` (text and
glyphs) fades to 55% under it; wells and chips do not. An attribute rather
than a subscription per bar, so a focus change costs no React render.

## The sidebar's filter bar

The top of the sidebar, under the nav and above STATUS and PROJECTS,
carries the Kanban board's filter bar: the same component
(`BoardFilterBar` with `variant="sidebar"`), the same query language
(`lib/boardFilter.ts`), and the same funnel menu, built by the same code
(`hooks/useTaskQuery.tsx`, which the board calls too). Two bars that look
alike but were built twice drift apart, so there is one of each piece.

- **It scopes both sections.** STATUS (when it is on) and PROJECTS are two
  groupings of the same tasks, so a query hides a task from both or from
  neither. It sits above both, outside their scroller, for the same reason:
  a control under PROJECTS that also filtered STATUS above it read
  backwards, and it scrolled away with the tree. The status chips under it,
  drawn while STATUS is off, write into the same query (see "The sidebar's
  status chips").
- **The sidebar's own query** (`useUI.sidebarQuery`), not the board's.
  The two answer different questions (where am I working, what stage is
  everything at), and the board is often open next to the sidebar.
  Session-only, like the board's.
- **Structure does change here**, unlike the board. A project with no
  matching task hides (one line at the bottom counts them); a narrow
  column full of empty headers is noise. A project named by `project:`
  stays, so an empty one can be found to start a task in. The inactive
  fold is not drawn while filtering. STATUS buckets hide when emptied,
  as they already do.
- **The open task stays listed** in the tree, the #324 rule. STATUS does
  not keep it: the section is a copy and the tree already shows it.
- **Matching projects, folders and task groups render open while
  filtering,** without writing the stored fold. Every fold in the tree goes
  through one call, `setTreeFold` in `src/lib/treeFold.ts`: while the query filters it
  writes a throwaway map in the ui store (`sidebarQueryFolds`), which is
  what the tree draws then, and otherwise the stored fold. Any edit to the
  query drops the throwaway folds, and clearing it puts every stored fold
  back. Chevrons, Expand/Collapse all, the `+` menu, the palette's rename
  and the drops that open their target all go through it. Task rows have no
  throwaway fold, so Expand/Collapse all leaves them alone while filtering.
  A write that went around it either
  rewrote the layout from inside a filter or folded something the tree was
  not drawing.
- **Differences from the board's bar:** the count sits on its own line
  under the input, the menu opens to the right over the main area (it is a
  portal, so it keeps the board's width), there is no Archived chip (the
  sidebar lists no archived tasks), and neither `/` nor ⌘F focuses it.
  Focus is almost always in a terminal, where ⌘F is find, and while the
  board is up both bars are mounted and `/` is the board's.
- **The command palette is its way in:** "Filter sidebar tasks" leaves
  the icon rail if needed and focuses the bar (a pending flag in the ui
  store the bar consumes, so a remount never steals focus), and "Clear
  sidebar filter" shows only while a query is set.
- **It sits nearer what it filters:** more space above the bar (from the
  nav) than below it (to the chips, STATUS or PROJECTS header).
- **It takes over from the per-project filters (#324).** While a query is
  set, every project filter is kept but not applied: its bar is hidden
  (no extra lines while you search) and its header icon stays pinned with
  a slash through it, inert, with "Paused while the sidebar filter is on"
  as its tooltip. Bar and icon come back as they were when the query
  clears. An open bar with nothing in it just closes. Two scopes
  ANDed made a project filter silently hide what the global query was
  looking for.
- **Absent on the icon rail;** a query typed in the full sidebar filters
  nothing there.
- **Cost with no query is nil:** every subscription `useTaskQuery` adds
  goes through `taskQueryNeeds` and selects a constant until the query or
  the open menu reads it, columns are only computed for `status:` or the
  menu, and free text reuses the tab facts the body already holds.
  `selectorFanout.test.ts` pins the gate. A menu left open when ⌘B folds
  the bar away counts as closed.

## Run state in the sidebar

A run tab's controls live in its tab pill (restart + a red Stop while the PTY
is up, a Play once it exits, `TabBar.tsx`). The sidebar's child row for that
tab carries the Stop half as well: a live run is otherwise invisible from any
other task, and the only way to end it is to go back into the task that owns
it.

Both read the same thing, `tab.ptyId`, which TerminalPane clears on process
exit: red Stop while the run is up, quiet Play once it is not.

A COLLAPSED task header carries those same controls itself, inline right after
the name and the terminal count. Collapsing hides the child row that would
otherwise offer them, which is exactly when a run is hardest to notice and to
stop, so `RunTabControl` renders in whichever of the two places is on screen
(never both, so its testids stay unique). Three constraints shape it:

- **Inline, not in the trailing slot.** That column is the status badge and the
  kebab; a third icon there reads as one of them.
- **One button per run tab, capped at `COLLAPSED_RUN_BUTTON_CAP` (3).** A task
  can hold several runs at once (a multi-repo task runs one per member, custom
  run commands add their own, and a setup tab is a third kind), so a single
  button cannot stand for "the" run. Past the cap the header shows none and the
  task expands to reach them, which is what the tab strip makes it do anyway.
- **An instant `Tip`, not a native `title`.** On a collapsed row the button is
  the only thing naming the process it kills, and a tooltip that arrives a
  second later is no use to a cursor already on its way to the click. It holds
  the tab's name alone: a verb in front reads "Run Run" on the tab that is
  actually called Run, and the icon already says stop from start.

Play has a wrinkle Stop does not. The restart travels as a
`termic-run-tab-restart` window event, and the only listener is the tab's
`RunPane`, which exists solely under a mounted `TaskView` — so the row brings
the task up and fronts the run tab first. Whether it then fires the event
depends on what mounting already did: an already-mounted task needs it (its
pane is sitting on a finished run, and only the remount respawns), a task that
was NOT mounted spawns the run as `RunPane` mounts and firing as well would
kill that spawn to redo it, and the exception is a tab restored `idle`, whose
pane shows a play placeholder and waits for exactly this event. The dispatch is
deferred by a `setTimeout`, not a `requestAnimationFrame`: a just-mounted
listener has to be attached first, and rAF is frozen on an occluded window (see
[gotchas.md](gotchas.md)).

## Subagent rows in the sidebar

Each subagent a claude tab starts gets a row under that tab's row
(`SubagentRows.tsx`, logic in `subagentTree.ts`). The rows come from
`useSubagents` (`store/subagents.ts`), which the `SubagentStart` /
`SubagentStop` hooks feed and the transcript files on disk complete: a stop
says nothing about how the agent ended, so the row reads `unknown` until
`subagent_list` finds a final answer (`done`) or an error (`failed`). A
claude process exiting with agents still running marks them `interrupted`;
`expired` is a transcript that is gone. Each of the six states draws its own
badge, and none of them touches the parent tab's work badge or bell.

- **One flat keyed list, nested by indent.** An agent sits under the row of
  its `parentAgentId` when that agent has a row, otherwise under the tab, and
  the indent stops growing at depth 3 (`MAX_SUBAGENT_INDENT_DEPTH`) while
  deeper agents keep their rows. Flat because a parent named by a late
  `.meta.json` then MOVES the row (the same DOM node, so no frame without it)
  instead of remounting a subtree.
- **Two subscriptions.** The list selects a structure key (which agents,
  under which parent) and each row selects its own record, so an agent
  finishing re-renders that row alone. Pinned in `selectorFanout.test.ts`
  ("subagent rows").
- **Workflow agents sit under a run row.** A run is one row
  (`WorkflowRunRow.tsx`) at a plain agent's indent, with its name, a
  `running/total` count and a running, failed or done badge, all read from
  one counts string so it never selects an agent record. The badge is
  running while any agent in the run runs, failed once none runs and one
  failed, done otherwise. It starts collapsed whatever the auto-collapse
  setting; opened it lists a phase row per phase and the agents with no
  phase, each one step deeper. Clicking a run or phase row folds it and
  opens nothing. A workflow agent row opens its transcript like any other,
  with its `workflowRunId` on the tab so the view reads under
  `subagents/workflows/<run>/`. A child whose parent is a workflow agent
  sits under the tab.
- **Every row leads with an icon for its kind.** One 14px lucide icon
  (`RowIcon` in `subagentRowParts.tsx`) sits right of the fold chevron: a
  run draws `Workflow`, a phase a thinner `Layers`, and an agent the icon
  `subagentAgentIconName` (`subagentRowIcon.ts`) picks from its type:
  Explore `Search`, Plan `ListTodo`, claude-code-guide `BookOpen`, and
  `Bot` for general-purpose, workflow and custom agents. The icon is
  `--color-fg-faint` with a 1.75 stroke (1.5 for a phase), so the tab row's
  orange brand mark stays the heavier mark and the state badge on the right
  stays the only colour. It is `aria-hidden` and static, so it selects
  nothing. A row with no chevron keeps a 16px spacer in its place, which is
  what keeps icons and labels in one column per depth; the e2e specs
  measure that, and that every kind is the tab row's height.
- **Folding is in memory only.** A row with children has a chevron that folds
  its subtree (`useSubagentFold`); collapsing the task hides every subagent
  row with it, and nothing about subagents is written to localStorage.
- **The header predicate is `childRowCarriesSelection`.** An active tab of
  type `"subagent"` whose `subagentAgentId` has a row in this task carries the
  selection like a terminal child does, so the header drops its highlight and
  that row draws `--color-sel`. The task row asks through
  `useSubagentHasRow`, which applies the type filter and retention, so a
  filtered-out agent leaves the highlight on the header. When the agent is
  folded away inside a run or a phase, that run or phase row draws it.
- **A row names the agent by its `.meta.json` description**, falling back
  to the agent type, with `type: description` as its tooltip. Clicking it
  calls `setActiveTask` and only then `openSubagentPreview`, because
  activating a task brings back the tab it last had in front, which would
  cover a transcript opened first (see gotchas.md "A sidebar row click
  restores the previous tab after it activates the task").
- **Rows are rebuilt from disk, never persisted.** `lib/subagentRebuild.ts`
  scans a tab's `<sessionId>/subagents/` (the newest
  `SUBAGENT_HISTORY_CAP` = 50 transcripts by mtime) on three triggers: app
  launch, for every non-archived task's persisted claude tab that names a
  session, opened or not; a claude tab spawning with `--resume <id>`; and
  `setTabSessionId` after claude's SessionStart reports a new session (the old
  session's rows go first). A scanned transcript ending on an answer is
  `done`, on an error `failed`, and with no end entry `interrupted` when the
  tab has no `ptyId` or `unknown` when it has one. Only a `SubagentStart` hook
  makes a row `running`. `mergeScanned` lets a hook-reported record keep its
  state (the `unknown` a stop leaves is the one thing a final outcome may
  upgrade), so an agent seen by both sources is one row, and it bails on a
  scan that changes nothing. A result is dropped if the tab's session moved,
  the tab closed, or its claude stopped while the scan was in flight. The
  launch pass waits for `requestIdleCallback` after `loadAll`, runs two scans
  at a time, and nothing in hydration awaits it (pinned in
  `subagentRebuild.test.ts`).

### Claude subagent settings

Settings > Tasks ends with a "Claude subagents" block
(`SubagentSettingsBlock.tsx`). It lives in Tasks, not Agents: Agents edits
per-agent cards stored in `settings.json`, while these are prefs, and a
subagent is something a claude task does. Every control applies live.

- **Master toggle (`subagentsEnabled`).** Off does no work at all. The
  pref drives a plain flag (`lib/subagentGate.ts`, kept in step by
  `lib/subagentSettingsWatch.ts`) that the hook sink in `TerminalPane.tsx`,
  `receiveSubagentEvent`, `rebuildSubagentsForTab` / `runLaunchRebuild` and
  `openTranscriptSession` check before any IPC. Turning it off clears
  `useSubagents` and releases every open view's watch while the view keeps
  what it read; turning it on rescans every claude tab that names a session,
  the same pass a launch runs. Pinned in `store/subagentSettings.test.ts`.
- **Type filters (`subagentTypeFilter`).** `lib/subagentKind.ts` classes an
  agent type as built-in, custom, fork or workflow. Forks are unmeasured:
  only an agent type spelled `fork` counts as one. A run whose agents the
  filter hides draws no run row.
- **Retention (`subagentRetention`).** How long a `done`, `failed` or
  `interrupted` row stays. `running`, `unknown` and `expired` rows never go.
  `SubagentRows` schedules one timer per tab, only while an ended row is
  waiting to expire (`nextRetentionExpiry`). The window starts at the later
  of the row's end and the last time its transcript tab was on screen
  (`src/store/subagentSeen.ts`), and the row whose transcript is on screen
  never goes, so "10 seconds after last viewed" removes a finished agent
  ten seconds after the user stops looking at it.
- **Auto-collapse (`subagentAutoCollapse`).** Sets whether a claude tab's
  subagent group starts folded; the chevron on the tab row
  (`SubagentGroupToggle`) folds it by hand, and that wins until the tab's
  session changes.
- **Scope.** The four row settings are profile-scoped (`scoped()` keys); the
  view options below are global.
- **View options.** `subagentViewVerbose`, `subagentViewShowThinking`,
  `subagentViewShowToolInputs`, `subagentViewShowToolOutputs`,
  `subagentViewTruncateLines` (0 never cuts) and `subagentViewAutoScroll`
  are the DEFAULTS for every transcript view: verbose on, thinking on,
  inputs off, outputs off, cut at 100 lines, follow on. A view's bottom
  bar overrides them for that agent only (see below). Either redraws an
  open view from the entries it already holds, never by reading the file
  again.

### The subagent transcript view

Clicking a subagent row opens a read-only, live view of that agent's
transcript in the task's preview slot (`openSubagentPreview` in
`store/subagentPreview.ts`, which calls `openPreviewTab` with a `"subagent"`
target keyed by agent id). A second row recycles the slot; double-clicking the
pill pins it like any preview tab. The `SubagentTab` carries the parent tab
id, session id and agent id, never a path, and is never persisted: only
terminal tabs are durable.

- **No terminal, but it reads as one.** `SubagentPane.tsx` is a lazy React
  list drawn the way Claude Code 2.1.296 draws its own transcript, so
  flipping from the claude tab to a subagent tab looks like the same
  screen. It mounts no xterm and creates no WebGL context. It takes the
  font, weight 400 and line height 1.0 from exactly what TerminalPane
  hands xterm (the constants live in `lib/terminalCell.ts`), and the
  background from the active terminal theme. Its CSS letter spacing is
  NOT the pref: xterm floors the glyph advance to device pixels and adds
  the pref in device pixels, so the pane sets `cell - glyph advance`,
  which makes every glyph advance exactly one `--cell` (kerning and
  ligatures off). Passing the pref through made words visibly wider than
  the same words in the claude tab; the e2e spec measures a ten-glyph run.
- **A cell grid, measured like xterm.** `useTerminalCell` measures a run of
  `W` in the terminal font and `cellFromGlyph` rounds it to device pixels
  the way xterm's WebGL renderer sizes a cell (width floored, height
  ceiled, plus letter spacing). The pane sets `--cell` and `--row`, and
  every indent is `calc(var(--cell) * N)` and every vertical gap a whole
  `--row`: one blank row between blocks, the text of a bullet two cells
  in, a tool result's hook two cells in with its text from cell five. The
  e2e spec checks the font against the live terminal's, the two-cell
  offset, and the one-row gap.
- **Claude's palette, not termic's.** Colours are claude's theme roles as
  `--cc-*` properties on the pane root (`lib/claudePalette.ts`, see
  docs/themes.md "The subagent view paints with claude's palette"). The
  theme is the claude config's own `theme` key, read by
  `subagent_claude_theme` once per session and again on window focus
  (`store/claudeTheme.ts`). `--cc-dim` is the theme's `inactive`
  colour, because claude's Ink maps `dimColor` to that role rather than
  to terminal faint.
- **Tool runs collapse to one line.** `groupToolRuns`
  (`lib/subagentTranscript.ts`) folds each run of tool calls and thinking
  into one group row, and `countGroup` plus `groupSummaryParts`
  (`lib/subagentCliView.ts`) write it the way claude does, a dim line two
  cells in: "Thought for 2s, read 2 files, ran 1 shell command", numbers
  bold, an edit's `+A -R` in the diff word colours, Bash counted as shell
  commands last, and no expand hint, as in claude's own subagent view. A
  call whose result carries a file diff (`popsOut`, from the line's
  `toolUseResult.bashEditDiff`) is drawn in full between two groups. The
  group still running is not dim, takes the blinking tool bullet and the
  "-ing" forms with an ellipsis. Clicking the line unfolds that group, and
  ctrl+o while the pane has focus flips every group and opens every
  folded output, as claude's verbose toggle does. Unfolded, a thought
  shows at once under a dim italic U+2234, the thought itself dim
  markdown (not italic) as claude draws it in verbose, so "Thought for" is written
  only on the summary line. The phrases stay English in every locale,
  like the tool labels.
- **A tool result draws under its call.** In an unfolded group
  `pairToolCalls` matches results to calls by `toolUseId`, so the result is
  not a row of its own. The call's bullet blinks dim while pending, 600ms
  on and 600ms off (a CSS `steps()` animation, steady in the text colour
  under reduced motion), then turns success or error. The result hangs
  from claude's connector, two spaces, U+23BF, a space and a no-break
  space, so its text starts at cell 5 in the text colour, and a fold
  reads "... +N lines". Each note the host found on the result (another
  command ran in the repository, a skipped or unavailable file diff,
  "Allowed by auto mode classifier") hangs from its own dim connector
  below. A long argument wraps under the "(" that opens it, because the
  name and the arguments are separate flex children. A result whose call is
  on a page not loaded yet joins the group alone. `lib/subagentCliView.ts`
  heads a call the way Claude prints it (`Read(path)`, `Update(path)`,
  `Search(pattern: "x")`, `Update Todos`, `server - tool (MCP)`, paths
  inside the worktree relative) and summarises the result: lines read,
  files found, an Edit's line diff, the TodoWrite checklist (U+2714,
  U+25FC, U+25FB), an error, or the first three output lines. A diff row
  is the line number right-aligned in one more cell than the widest
  number, a space, the sign and the code, on claude's diff colour across
  the row; a removed and added pair with at most 40% of its characters
  changed gets the changed middle on the word colour (`wordSpans`).
- **Text and prompts.** Assistant text is claude's bullet (U+23FA on
  macOS, U+25CF elsewhere, `MESSAGE_BULLET`) in the text colour with the
  text two cells in, through the markdown subset in
  `lib/subagentMarkdown.ts` as React elements, following claude's own
  renderer: bold, italic, strikethrough, inline code and language-less
  fences in the permission colour, links and bare URLs as their text in
  the terminal's bright blue (plain blue on a light theme, `--cc-link`),
  backslash escapes dropped, H1 bold italic underlined and every heading
  followed by exactly one blank row, quotes as a dim U+258E bar per level
  with italic text in the text colour, ordered lists numbered from their
  first item and counted on (letters one level down, roman numerals two
  down), a nested list one cell past its parent's marker, and tables drawn
  in box characters with a rule after every row (`renderTable`). A fence
  with a language is plain text: claude highlights it with its native
  highlighter, which the view does not reproduce. There is no
  HTML path, and a unit test renders `<script>` and raw tags and checks
  they come out escaped. The prompt the agent was given is a U+276F
  pointer on claude's `userMessageBackground` across the row, drawn whole
  up to 10,000 characters and past that as its first and last 2,500 with
  a subtle rule naming what was hidden (`foldPrompt`). Meta user lines are
  dropped by the host and `<system-reminder>` blocks inside a prompt are
  stripped here, so a prompt of nothing but reminders is not drawn.
- **Laid on the terminal's grid.** The pane takes xterm's own padding
  (8px 6px 8px 10px) and draws every row `floor((width - 16 - 8) / cell)`
  cells wide, so a prompt's background and the right-aligned footer stats
  end on the same column claude's would in the tab next door.
- **Banner and footer.** At the top, claude's welcome banner: the 2.1.296
  mascot (three rows of quadrant blocks, drawn as boxes on a half-cell
  grid so the rows meet the way xterm's own block glyphs do), then
  "Claude Code" bold with the transcript's version dim, the model's
  display name (`modelDisplayName`, "Opus 5.5") and agent type, and the
  description, phase and read-only, followed by the two blank rows claude
  leaves before the first block.
  Under the scroller, while the agent runs, claude's spinner row in the
  claude colour: six frames played out and back on claude's 2s cosine
  (the stops are `cosineFrameStops`, and a unit test keeps index.css in
  step with it), the in-progress todo's activeForm or "Working..." with a
  three-cell shimmer stepping right to left one cell per 200ms, or a 2s
  pulse while a tool runs, and the dim "(elapsed, tokens)" suffix once
  there are tokens or 16s have passed. With no new entry for 10s, and no
  tool running, the glyph and message ramp to claude's stall red by 20s
  in eighths and the shimmer parks. All of it is CSS: the stall delay is
  measured from when the animation was first applied, so a new entry
  moves it without restarting anything, and a `display: none` pane runs
  none of it. Reduced motion shows a still U+25CF and no shimmer. Then a
  blank row and claude's agent list, two cells in on both sides: a dim
  "U+25CB main" row, and the viewed agent's row in bold with a green
  U+25CF, the agent type, two spaces and its description (else the call in
  flight) on the left, elapsed time and output tokens on the right, where
  only the seconds tick, from a 1 s interval that exists only while the
  agent runs and the pane is on screen (an IntersectionObserver turns it
  off for a hidden pane). Once stopped the dot stays green, or turns red
  or dim, and the left reads "Done (N tool uses)", "Failed" or
  "Interrupted". Counts and tokens come from the entries the view holds,
  so before every earlier page is loaded they cover the newest part only;
  times come from the transcript's own timestamps when entry 0 is held,
  else from the record.
- **Bottom bar.** In the place of claude's mode line ("auto mode on
  (shift+tab to cycle)"), between the spinner row and the agent list with
  a blank row on each side, one dim line two cells in, never wrapped,
  holds the view's settings as clickable toggles (`subagentView/BottomBar.tsx`):
  verbose (ctrl+o flips it too), thinking, tool inputs, tool outputs, the
  output cap (stepping 20, 40, 100, off through `nextTruncateLines`) and
  follow. An "on" value is in claude's suggestion colour. A toggle changes
  that agent's view only: `src/lib/subagentViewConfig.ts` keeps just the
  fields the bar changed, per `sessionId/agentId`, in the local
  `subagentViewConfigs` key (the 200 most recently changed views), and
  lays them over the Settings defaults, so a default changed later still
  reaches every toggle a view never touched.
- **Windowed by hand.** Only rows near the viewport are mounted, measured in
  a layout effect so a corrected height lands before paint. Row keys are
  entry indices in the whole transcript, so a page loaded above keeps every
  mounted row where it was.
- **Paged and tailed.** The view opens the host tail first and then reads
  the last 500 entries, so the page always reaches at least as far as the
  first live batch, and merges batches by their `start` index. "Load
  earlier" is a dim line just above the scroller; it prepends the page
  above and holds the entry being read in place, and goes once entry 0 is
  loaded. It sits outside the scroller on purpose: inside it, the line
  vanishing as entry 0 arrives moved the anchored entry by about 7px in
  the e2e anchor case, and outside it the case holds within 2px.
- **Follows only at the bottom.** `shouldFollowTail` in
  `lib/subagentTranscript.ts` decides; scrolling up pauses following and
  shows "Jump to latest".
- **Untrusted text.** Entries render as React text, ANSI is stripped again on
  this side, redacted thinking shows a placeholder, a `compact_boundary` line
  is a divider row, and an entry kind the view does not know is a collapsed
  generic row.
- **Ends cleanly.** A transcript this view read that is then gone shows
  "Transcript expired" and stops tailing. One it never found is `missing`:
  "Transcript not available yet" while the agent runs, looked for again
  every 2s (`MISSING_RETRY_MS`) without flashing back to loading, and "No
  transcript" once it has stopped. Both are dim. Archiving the task releases every view's watch and closes its
  subagent tabs (`installSubagentPreviewArchiveWatch`).

## Task groups in the sidebar

When an agent inside task A creates task B (`termic new`, or MCP `task_new`)
in A's own project, both land in one group led by A. In ANOTHER project B
joins no group and is only linked (see "Spawn links" below). The agent can name and colour the group itself: `termic group --name
... --color ...` (MCP `task_group`); the `new` reply prints the group it
joined and `TERMIC_CLI_HELP` teaches the verb, so an agent finds it
without being told. The CLI reads
`$TERMIC_TASK_ID` itself, so an agent gets grouping without being told
about it; `--no-group` opts out. MCP gets the same id from the
`X-Termic-Task` header the installed headers helper sends from the
agent's environment, so its `task_new` groups the same way (an explicit
`parentTask` overrides it). A worker that orchestrates in turn adds to
the ROOT group: groups are flat on purpose, since a tree in a 260px
sidebar is unreadable and "these belong to one job" is the question.

Drawing (`src/lib/taskGroups.ts`, `TaskGroupBlock.tsx`): a group is one
contiguous block at its FIRST member's position, a caption row in the
group's accent (name, member count) above a 1px rail of the same colour,
the same weight as a project folder's guide line.
The caption copies a task row's box model, so its icon sits in the loose
rows' chevron column and its label in their name column; the rail is the
members wrapper's left border, under the icon's centre, and members sit
18px in, the step a project folder gives its members. All four are
asserted by measurement in the e2e spec, since "a few px off" is exactly
what a screenshot cannot settle. The rename input inherits the caption's
font and has no padding or border (its outline is outside the box), so
entering rename moves no text.
A group exists while any live task carries it, one member included, the
same rule as a project folder. A group lives in ONE project: Rust refuses
a join across projects, and a group an older build left spanning two draws
its lone member in a project as a plain row (`crossProjectStrays`), since
two groups of one, both captioned with the lead's name, said nothing about
how the tasks relate. The label is the group's own name or,
unnamed, the lead's live name, so renaming the orchestrator renames the
group until someone names it. Founding colours skip red first (`blue`,
`teal`, ... `red` last): a red caption on a fresh group reads as an error.

Editing: right-click the caption for the swatch row, Rename group and
Ungroup tasks (the project-folder menu body, `GroupActionsMenuItems`).
A task row's menu has Move to group, the project row's submenu for tasks:
the project's groups (a check on the current one), New group (a group of
just this task, whose caption opens its rename straight away) and Remove
from group. Its group list is read from the store while the menu is open,
not subscribed, so no row re-renders for a menu nobody has open. Dragging a row INTO a block
joins it and OUT leaves it: during the drag the row wears whichever
block the cursor is inside (header included), so the block grows and
shrinks under it before anything is written, and the drop applies the
change to the store in the same update the drag state clears in, so the
row does not snap back to its old group for the IPC round-trip. No drag
gesture creates a group (dropping on a row already means reorder); New
group does.

A click anywhere on the caption COLLAPSES / expands the group (it hovers like
a task row), and a double-click renames. A double-click arrives as click(1),
click(2), dblclick: the second click is ignored and the dblclick undoes the
first one's toggle, so a rename leaves the group as it was, at the cost of a
brief collapse flash during the gesture. The alternative, delaying every
single click by the double-click window, makes every expand feel slow. The
chevron in the icon slot is a button for the keyboard and shows the STORED
collapse state, including while a filter is overriding it (see below); a
drop after a block drag swallows its trailing click. Collapsed, the caption
shows one of each mark any member's row would draw, in a fixed order
(attention, done, partial, working, delegated), beside the member count:
never just the most urgent, since "two finished and one needs you" is the
point, and the count is what says tasks are tucked away rather than gone. Each member contributes exactly its row's own mark (`taskWorkBadge`
plus the partial override), via `groupBadgeKinds`, so the caption cannot
claim what the hidden rows would not. `setActiveTask` expands the group of
the task it activates (every "go to task" route: click, cmd+1..9, the
next-waiting jump, a notification), and a collapsed group still renders
the ACTIVE task's row, which covers the routes that only preview a place
(`previewPlace`, the ctrl+tab walk) without writing anything. A project's task FILTER
shows its matches even inside a collapsed group, and a group with no match is
not drawn; the chevron keeps showing the stored state meanwhile, so a click
while filtering visibly collapses instead of storing a collapse nobody sees
(which then snapped the group shut when the filter cleared). Joining a
collapsed group by drag or Move to group opens it, so the task you placed
stays in view. The icon rail ignores collapse: it has no caption to expand
from. State is `collapsedTaskGroups` in localStorage, keyed by group id,
pruned in `loadAll`.

Dragging the CAPTION moves the whole block within its project, the task
twin of the project-folder drag: it hit-tests only top-level items (loose
rows and other blocks), moves the members through the store as one run,
and writes the display order through `task_reorder` on drop.

## What a folded header shows

Four containers fold task rows away: a task group in the tree and in the
status section, a project, and a project folder. Folded, all four carry the
same marks for the rows they hide: one of each that a member's row would
draw, in the fixed order above (`groupBadgeKinds`, drawn by `WorkMarkList` in
[src/components/sidebar/RollupMarks.tsx](../src/components/sidebar/RollupMarks.tsx)).
Open, they carry none, because the rows show their own.

A project's marks sit after its name, NOT in the action cluster on the right:
the filter toggle and the cog there keep their space while invisible, which
would strand the marks some 50px from the edge. A folder's sit after its name
too, before its count. The folder used to carry ONE dot (attention, else
done), which said nothing about an agent still working inside it, and a
collapsed project in the full sidebar carried nothing at all. The marks take
the work prefs the way the rows do, so `attentionIndicator` off hides the bell
here as well (the old folder dot ignored it).

The icon rail keeps its corner dot on the project monogram and the folder
chevron: there is no room there for a row of marks.

Rendering: a folded project or folder mounts `RollupMarks` and only while
folded, so an open header costs no selector run. It subscribes through one
joined string (`selectRollupMarks`), so it re-renders when the SET of marks
changes, never on a live title or an output stamp, and a second agent starting
a turn where one already works moves nothing. Its member ids arrive joined
too, so the Sidebar body re-rendering passes its memo. The badges carry
`rollup-work-badge`, not `work-badge`: a folded header sits above the rows in
document order, and a bare `work-badge` query must keep finding a row's.
`selectorFanout.test.ts` pins all of it.

## Spawn links

Every task an agent creates carries `spawned_by`, its DIRECT parent's id,
grouped or not (`src/lib/spawnLinks.ts`, `SpawnLinks.tsx`). Two things
draw it:

- A ↳ mark after the child's name, titled "Started by <parent> (<project>)";
  a click goes to the parent. On the sidebar, only where the group rail does
  not already say it: a child in another project, or one dragged out of its
  parent's group. The dashboard draws no rail, so there EVERY spawned child
  is marked, same-group ones included (`spawnMarkParent`'s `suppressInGroup`).
- Lines, ONLY while a row is hovered: an elbow from the hovered task to its
  parent and to each task it spawned, one level each way, down a faint 1px
  trunk 12px in (the accent, at the very edge, read as a loud border). Always-on lines between rows that sit far apart, across
  other projects, would tangle the list. Only between rows the grouping does
  not already link (another project, another group, or none): inside one
  group block the rail says it, so the mark and the line both stay off. The overlay keeps its own hover
  state and reads the task list only when the hovered row changes, so
  hovering re-renders nothing else; it skips a drag and the icon rail, and a
  row that is not in the DOM (collapsed project, filtered out) gets no line.
## Kanban view (over tasks)

Its nav entry is on by default and Settings -> Appearance -> Sidebar's "Kanban
board" switch hides it (`showBoard` in prefs, stored only once changed). The
entry is the only way into the board, so hiding it is the whole switch; turning
it off while the board is showing goes to the Dashboard.

The third nav view (GH #318), an overlay like History: `view.page === "board"`
in `src/store/app.ts`, mounted by `MainArea`'s overlay chain, unmounted when
left, so idle cost is zero by construction. One global board across projects,
laid out as a standard kanban: six full-height fixed-width columns (Not
started, Needs attention, Working, In review, Settled, Archived), each with
its own surface
one step above the page background, a header (semantic dot + title + count
badge) and an independently scrolling card stack. Columns have a 280px floor
and GROW to share the pane (`COLUMN_SIZE`: `flex-[1_0_280px]`, capped at
520px), in a row that is `w-max min-w-full`, LEFT aligned: a narrow window
scrolls, a wide one is filled edge to edge. Never `justify-center` +
overflow, which clips the left columns permanently. It centered with
`mx-auto` until empty columns started hiding, at which point two columns
floated mid-window with a screenful of nothing beside them; fixed 280px
columns after that left the same slab of nothing on the right instead. The
Inactive rail stays a fixed 200px, and the filter bar above spans the full
width so the toolbar and the columns share both edges.

**An EMPTY state column is not rendered**, because columns of nothing push the
ones with cards off screen (reported with a screenshot of exactly that). The
hidden ones gather in an **Inactive** column at the right, one ordinary row
each, name and a zero.

A column is on the board when it **has cards OR is pinned**, and the two
controls that set the pin are a pair:

- a row in **Inactive** pins that column, so it is always shown, empty or not;
- the **X** in a pinned column's header unpins it, so it goes back to hiding
  when it empties.

The X appears only on a column that is pinned AND empty (`boardColumnCanHide`).
Never on a column holding cards: hiding one would put those cards out of sight,
which is the single thing this board must not do. An unpinned empty column
cannot be on screen to carry a button in the first place.

The pin is a **setting** (`prefs.boardPinnedColumns`, localStorage, parsed by
`parseBoardPinnedColumns`), not view state. It was `useState` in `BoardView`
first, which meant it died with the unmount: pin a column, leave Kanban, come
back, and it was hidden again. That was reported as the columns disappearing
"quite random", which is what an invisible lifetime looks like from outside.
The parser drops unknown ids (a hand-edited value, a column from a future
build) and returns board order, so a pin can never reorder the board.

That column is not a legend: each row carries the same `data-board-cell` +
`data-column` a real column does, so a card dropped on a row runs the identical
command through the identical handler. It has to, because Settled and In review
ARE drop targets (clear work state, open the PR dialog) and are emptiest exactly
when you want to drop into them, so hiding a column must never take its command
with it. Archived is never hidden, being both muscle memory and the destructive
drop.

Two shapes were tried and rejected before this one, both caught by looking at
it. Revealing every column while dragging reflows the board under the hand
holding the card, and the drop target does not exist until the drag has already
begun (the existing cross-column e2e case could not find it). A thin rail of
vertical labels at the edge fits more but reads as a rendering glitch.

Tasks whose project is missing from the store are skipped entirely. The
sidebar renders tasks by walking PROJECTS, so such a task is invisible there,
while the board enumerates tasks and was the only surface that showed it, with
the group header falling back to printing the raw project UUID at the user.

Swimlanes by agent (`task.cli`) are dividers INSIDE a column, sticky while
the column scrolls, shown only when more than one agent has live tasks; a
task whose project left the profile keeps no lane alive either, since lanes
count visible cards. Project sub-headers are ALWAYS on (GH #318 feedback: on
a one-project board nothing else names the project, and the header is how a
card from another project reads at a glance when one appears). The Archived
column is agent-agnostic, read-only apart from being the drop-to-archive
target, and links to History in its footer.

### A card's third row: what it produced, and where the PR is

Two rows carry identity (agent, name, branch, age, cage). The third answers
the two questions you would otherwise open the task for, and renders only when
it has an answer, so a new task keeps the two-row card it had.

**PR chip** (`data-testid="board-card-pr"`). The number, the state glyph and
the checks, all one link, opened with `openPath`. The board has width a
sidebar row does not, so this is the full chip rather than the sidebar's bare
glyph: `#42 - checks failing` says whether a task is reviewable without
opening anything. Colour comes from `prBadgeAppearance`, the same tested rule
the sidebar uses, so the board cannot drift into a second palette.

The chip stops the click from reaching the card. The card is itself a button,
and a link that also navigates somewhere else is a trap.

**Churn** (`data-testid="board-card-churn"`): `+N -M - k files`, right
aligned, `--color-ok` / `--color-err`, the same tokens the compare view uses.
A zero side is omitted rather than printed, because "+0 -0 0 files" on every
untouched task is noise.

The numbers come from `task_diff_stat`, a lean sibling of `task_diff` (see
[ipc.md](ipc.md)) behind `src/store/diffStat.ts`. That store is NOT a poller.
A PR changes because someone elsewhere clicked something, so it has to be
polled to be discovered; a diff changes because an agent on this machine wrote
a file, and measuring costs two git processes per repo. So it is demand
driven with a 20s floor and a per-flush cap: the board measures what it is
about to draw, a card nobody is looking at is never measured, and a board
nobody has open costs nothing. It lives outside `useApp` for the reason
`pr.ts` does, since writing a number into the app store on a timer would
re-run every mounted task's selectors.

**The columns are derived, never stored** (`src/lib/taskBoardState.ts`, the
third consumer of `taskWorkState.ts` after the sidebar and the dashboard):
archived overrides everything, then attention, then working, then a persisted
open/draft PR identity (main checkouts excluded, same gate as the pr poller),
then Not started for a task with no work evidence this session (no terminal
tab has a classified `workState` or a `lastInputAt`: the state machine skips
the idle write on a fresh spawn, so untouched stays distinguishable from a
finished turn, whose tab holds `done` or an explicit `idle` write), and
everything else is Settled. A merged/closed PR falls through past review.
Not started is session-scoped by design, the same honesty as the done badge:
nothing here survives a restart, and persisting a "has worked" flag would be
a stored status. There is no `status` field on Task and there must not be
one: the terminal is the ground truth, and a stored status a card could
carry would drift from the PTY with no reconciliation path.

Rendering discipline: the whole board's column assignment is `useTaskQuery`'s
column map (the board passes `alwaysColumns`), built over per-task status
facts (`createStatusFactsSelector`) that keep their identity through output
stamps and live titles, and handed back unchanged unless a card moved; each
card subscribes to its own `selectTaskTabs` slice for its badge.
`selectorFanout.test.ts` pins the facts' counts.

Drags mean something or they do not happen. Hand-rolled pointer events, the
sidebar's pattern; no dnd-kit. Four drags are wired: reorder within a
same-project group inside one cell (`task_reorder`, whose Rust contract is
same-project ids), drop on the Archived column (shared `confirmAndArchive`,
so the confirm dialog, delete-branch checkbox, open-PR warning and spinner
come with it), drop on Settled (`clearTaskWorkState`, the focus-clear write
on every terminal tab) and drop on In review (CreatePrDialog, the same entry
the command palette uses). Every other drop snaps back with no write, and so
does a wired one that would be a no-op: nothing to clear, or a main
checkout. The matrix lives in `boardDropCommand()` in
[src/lib/taskBoardState.ts](../src/lib/taskBoardState.ts). Restore stays in
History; the Archived column links there.

The Archived column renders a CAPPED slice, not the whole archive: the most
recent entries first (the same `archived_at ?? created` sort History uses),
limited by Settings -> Tasks' "Kanban archived column limit" — the factory
default 25, unlimited, or a custom number taken as-is (no bounds; anything
below one renders an empty column). The cap bounds the DOM only: the column
badge always shows the full count, and History still lists everything.
`recentArchived()` in
[src/lib/taskBoardState.ts](../src/lib/taskBoardState.ts) is the one sort +
cap; the badge reads the uncapped filter.

### Filtering

A filter bar above the columns takes a GitHub Projects style query, parsed
and matched in [src/lib/boardFilter.ts](../src/lib/boardFilter.ts):

```
login bug                    free text: every word must match
project:acme agent:claude    qualifiers AND together
agent:claude,codex           comma ORs inside one qualifier
-status:settled              a leading - excludes
project:"my repo"            quotes keep spaces
```

Free text matches the task name and branch, plus whatever the sidebar's
per-project filter matches (`taskMatchesText`: stable tab titles and tab
property values), so anything the sidebar filter finds, the board finds
too; the board additionally matches the branch.
Qualifiers: `project:` (alias `repo:`, exact name, also a multi-repo
member's directory), `group:` (the project's sidebar folder, normalized by
`groupOf` like the sidebar), `agent:` (id or
display name), `status:` (alias `column:`, the column ids), `branch:` and
`base:` (substring), `pr:` (open, draft, merged, closed, none; behind the
review column's `hasPrIdentity` gate, so a main checkout is always none, and
an unpolled identity reads open, like the review column, except on an
archived task, which is never polled and reads unknown, matching no `pr:`
value), `checks:` (passing, failing, pending, none), `is:` (main,
worktree, yolo, docker, sandboxed, multi, archived), `has:` / `no:` (pr,
changes). An unmeasured diff, or a value `has:`/`no:` does not know, matches
neither. An unknown `key:` matches as free text and the bar says so, once per
key; text whose "value" starts with `/` or `\` (`https://...`, `C:\...`) is
not reported. A negation still being typed (`-`, `-ag` on the way to
`-agent:`, `-re` on the way to `-repo:`) filters nothing until a colon or a
trailing space settles it, and a menu or header click drops it rather than
pushing it mid-query, where it would become a real exclusion. `project:` is
name-based, so two projects with the same name are one chip in the menu.

Rules that are not obvious from the code:

- **The query never decides the board's structure.** Column visibility
  (and the pinned column's X) reads the UNFILTERED counts, and lanes come
  from the unfiltered live tasks, so typing never folds a column into
  Inactive or drops a lane divider mid-keystroke. A column the query emptied
  stays put and reads 0, and a lane divider survives its own `agent:`
  filter, so clicking it again takes the filter back out. A keystroke that
  matches the same cards keeps the same arrays (`useSameItems`), so the
  memoized columns do not re-render for it.
- **Archived filters before the cap**, so a search can surface an old
  archived task the cap would otherwise hide. The bar's "N of M" and the
  menu's chip counts count every matching archived task, cap or not, the
  same number the Archived badge shows, so with a large archive they can
  exceed the cards on screen.
- **The text lives in the ui store** (`boardQuery`), not BoardView state,
  for the reason the pin became a pref: the board unmounts when left. It is
  NOT persisted, because a forgotten filter hiding cards on launch is the
  board hiding cards.
- **Subscriptions widen only while the query reads them.** Free text holds
  `createBoardFilterFactsSelector` (titles and property values only, so
  streaming and work-state flips do not move it); with no free text the
  board selects a constant. `checks:` folds check state into the PR trigger
  key and `has:changes` adds a diffStat key, each only while used.
  `has:changes` also asks the diffStat store for every live task, since a
  card filtered out from the start never mounts to ask for itself. It asks
  on a 2s tick (`CHANGES_POLL_MS`) while the clause or the menu is up,
  because `requestMany` measures at most `MAX_PER_FLUSH` stale tasks per call:
  one call on mount left everything past the first six unmeasured, and a
  hidden task that gained changes later stayed stale. Fresh tasks make the
  tick a no-op. An open filter menu holds both, because it counts those
  facets too.
- **Reorder still works while filtered.** The drag group is the rendered
  cards, and `mergeReorderedGroup` keeps hidden siblings in their relative
  order, the same as cards in other lanes and columns already are. That
  means a hidden same-project sibling is persisted after the dragged group,
  which the user does not see happen; it is the existing contract for
  off-screen cards, applied to filtered ones.
- **Clicking a lane divider or a project sub-header** toggles `agent:` /
  `project:` in the query TEXT, so the bar stays the one source of truth and
  shows the syntax it just used.

**The funnel icon opens the filter menu** (`BoardFilterMenu` in
`BoardFilterBar.tsx`), a popover listing every facet as chips: status
(column dots), project, project group, agent (brand icons), pull request,
checks and task flags. A chip cycles off -> include -> exclude -> off
(`cycleBoardClause`) by editing the query TEXT, merging into an existing
token of the same key and sign (`project:a,b`), so the menu writes queries
rather than holding a second filter state, and the bar shows the syntax
each click produced. Each chip's count is the current query with that
chip included (`setBoardClause`, the same edit the click makes) run through
`boardTaskMatches`, so an off chip reads exactly what clicking it leaves.
The sections are built only while the menu is open (BoardView holds the
open state), so a closed menu costs the board nothing per render. An
excluded chip shows the same "with this included" number, not what its next
click (back to off) leaves. Closing the menu hands focus back to the input,
unless the close came from clicking another control (the sidebar filter),
which keeps the focus that click gave it.

Keys: `/` (when nothing editable has focus) or ⌘F focuses the bar; Esc
peels one layer per press (completions, then the text, then focus), and
ArrowDown reopens the completions Esc closed. Enter or Tab accepts.
**The sidebar's field wraps while focused** and grows down over the chips:
a query of more than a clause or two does not fit the sidebar, and a clipped
query cannot be read or edited. It is out of flow, so nothing under it
moves, and it is one clipped line again on blur. It is a textarea that never
holds a newline (Enter is swallowed, a pasted one becomes a space). The
board's bar is wide enough and stays one line.
A click in the field does NOT list the keys: that was tried (every
canonical key on click) and removed, because eleven rows dropping over the
sidebar on every click cost more than they taught, and the funnel beside the
field already offers the same filters. An IME
composition owns those keys until it commits. Autocomplete completes the
token at the end of the input: qualifier keys (aliases included) for a bare
word, values for `key:`, ranked by the palettes' `fuzzyMatch`. A key or a
value typed in full stays in the list, first, so Enter keeps what was typed
instead of picking a longer neighbour.

## The sidebar's status section

A STATUS section above PROJECTS, in the same scroller, that lists the tasks
needing you or in flight, grouped by the Kanban board's columns. It is the
board's attention half, compressed and always on screen: the board answers
"what stage is everything at", but it is a main-area overlay, and opening it
deselects the open task (`setView` sets `activeTaskId: null`), so it is never
on screen while you work (#298).

**Off by default** (`prefs.showStatusSection`): with two tasks it is clutter,
with twenty it is the point. Two switches write the one pref: a check row in
the Project list options menu next to "Collapse inactive projects", and
Settings > Appearance > Interface & Sidebar > Sidebar. The STATUS header and
PROJECTS header are highlighted section bars with semantic icons, and STATUS
carries an item count (PROJECTS does not: the list is right there). Clicking
the STATUS header collapses and expands its section in place
(using Plus/Minus fold indicators rather than chevrons, which avoids arrow
clutter). The PROJECTS header is a plain label and does NOT fold: it is the
tree itself, not a copy of it, and folding it left a sidebar with nothing in
it. A clean divider line separates Status from Projects. Each
bucket folds too, and those folds are a pref (`statusBucketCollapsed`,
a scoped localStorage key, with a setter that bails on an unchanged value).

**It is a copy, and the tree does not change.** Every task keeps its one home
in the project tree; the section lists a subset again. Copying rather than
moving is what keeps spatial memory intact (Gajos et al., AVI 2006, on split
interfaces; Linear's Favorites above Your Teams is the same shape). It copies
the ACTIONABLE subset only: a full second tree of every task is the case that
research found adds a second place to look, and the full grouping already
lives on the board.

### Buckets are board columns

Every task's bucket is `boardColumnFromFacts` in
[src/lib/taskBoardState.ts](../src/lib/taskBoardState.ts), the same
precedence the board uses (`taskBoardColumn` delegates to it). Nothing is
stored, and there is no sidebar-only rule: if a bucket looks wrong, the fix
goes in `taskBoardState.ts` and the board moves with it. The layout
(`statusBuckets` in [src/lib/sidebarStatus.ts](../src/lib/sidebarStatus.ts))
is the board's columns without Archived, attention first:

| Bucket | Default | Why |
| --- | --- | --- |
| Needs attention | listed | the reason the section exists |
| Working | listed | what is in flight |
| In review | listed | a PR is waiting on someone |
| Settled | count only | the largest bucket, and the least urgent |
| Not started | count only | session-scoped: after a relaunch every unopened task is here |

An empty bucket is hidden; the header stays even when every bucket is, so the
section cannot silently vanish. The labels are `chrome:board.col*`, so a
bucket and its column cannot be called two different things. The work prefs
gate it as they gate the board: `attentionIndicator` off empties Needs
attention, `workingIndicator` off empties Working.

Each bucket header carries a mark before its label, the glyph its rows draw
(bell, the spinner's ring, the PR glyph, the done dot, the dormant moon), in
the colour the status chips give the same bucket: `STATUS_MARK_COLOR`
([src/lib/sidebarStatus.ts](../src/lib/sidebarStatus.ts)), one map that the
chips' icons read too, so the two cannot drift. It is the board's column
colours except where the chips settled otherwise: In review in the text colour
(see "The sidebar's status chips" below) and Working in the faint the rows'
spinners use. The count sits on a tint of the same colour, with the digit left
`fg-dim`: amber or blue digits on the light theme's cream were too faint to
read. Two rules: the Working ring is drawn `still` (a header that spins
forever says what every row under it already says, on every frame), and the
mark is `aria-hidden`, since the label names the bucket. Before this, all five
headers were the same grey text and Working read exactly like Settled.

### Rows

A lighter row than the tree's: chevron, label, project name in the faint
colour, the tree's `(n)` from two terminals up, PR chip, work badge. No drag,
no rename, no run controls, no menu. Clicking it is `setActiveTask`, which
reveals the task in the tree (expands its project, folder and group) the way
every other way of opening a task does. The active task is marked in both
places (`data-active` here).

It expands the tree's way: one child row per main-pane terminal tab, each with
its own agent, title and badge, and a click on a child opens that tab. The
task's row carries no agent glyph of its own. It used to show the one from
`task.cli`, the agent the task was created with, so a task running claude and
codex read as claude alone; the board solves the same problem with extra
icons on the card, the tree with child rows, and the section follows the
tree. Expanded rows are their own pref (`statusTaskExpanded`, pruned of dead
ids on write), NOT the tree's task collapse, so opening a row here never
opens the tree's. Expanded, the children carry the badges and the selection,
as in the tree.

Opening a task does not answer it. A row under Needs attention stays there,
open task or not, until you answer in that terminal or the agent's turn ends
(docs/agent-states.md "A question is not answered by looking at it"); then it
moves to whatever bucket its other evidence gives it. The board reads the same
field, so it agrees; the section has no rule of its own.

Rows run newest activity first (`src/lib/recencyOrder.ts`), ties in TREE
order: `visualProjectOrder`, then each project's rows as the tree lays them
out (`layoutTaskList`, so a task group is one block, keyed by its newest
member). Activity is `activityAt` in the app store, written only when a turn
ends (the `working` to not-working edge), never by PTY output. Opening a task
or sending it a prompt is held in `pendingActivityAt` and folded in at the
next turn end, so every reorder lands at a turn end and nothing moves under
the user. A row also moves when its bucket changes. Keyboard task navigation
(`useShortcuts.ts`) walks the same order. A
task with no stamp orders by its creation time. The tree orders the same
way, except that a task the user dragged (`order` set) keeps its manual slot
ahead of the rest; a drag first pins the drawn order (`freezeDisplayOrder`)
so its indices match what is on screen. Subagent rows list the newest start first, a workflow run
counting as one block at its newest agent. The section walks projects rather
than tasks, so a task whose project left the profile is skipped exactly as
the tree skips it. The per-project task filter (#324) does not apply here; the
sidebar's filter bar does (see "The sidebar's filter bar").

**Task groups** draw the way the tree draws them: a caption in the group's
colour (with the project name, which its members then drop) and the members
behind a rail of the same colour. A group stays ONE unit, in the bucket of its
most urgent member, in bucket order, so a settled lead sits under Needs
attention while one of its workers asks something; every member keeps its own
badge, so the row that put the group there says so. This is a layout rule over
the board's buckets, not a state: each task's own bucket is still
`boardColumnFromFacts`. A bucket's count is task rows, members included. The
caption folds the tree's way (chevron, member count, the members' marks on
the caption while folded, the active task's row kept in view), from its own
pref (`statusGroupCollapsed`), so folding it never folds the tree's. It does
not rename or open a menu. It is its own component, not the tree's
TaskGroupBlock, because that one carries the tree's drag, rename and menu,
and its `data-task-group-id` is what the task drag hit-tests: a second one per
group would be a second drop target. This one carries `data-status-group-id`.
A legacy cross-project group draws as plain rows, as in the tree.

`TaskRow` is not reused: its rename and auto-expand effects would run twice
per task, and every auto-expand would be a second whole-state write.

**Identity.** A status row carries `data-status-task-id` and NONE of
`data-sidebar-task-id`, `data-sidebar-task-project-id` or
`data-sidebar-task-row`. The task drag's hit tests, `SpawnLinksOverlay` and
the e2e helpers all assume one `[data-sidebar-task-id]` per task. Its badges
render under their own testids (`status-work-badge`, `status-pr-badge`), so a
bare `task-pr-badge` query still returns the tree's, first in the document.

**Keyboard.** ⌥↑/↓ and ⌘[ / ⌘] keep walking the tree's project order; the
section adds no stops to them. The rows themselves take focus and Enter.

**The icon rail does not carry it.** The hover-reveal overlay is a full
sidebar and shows it there.

### Rendering

The section's facts are a record of their own (`useStatusTabFacts` in
[src/store/sidebarTabs.ts](../src/store/sidebarTabs.ts)): three raw booleans
per task (`attention`, `working`, `untouched`), cached per task the way the
body's facts are. Not more fields on `SidebarTaskFacts`: every idle -> working
flip of every agent would then re-render the whole Sidebar body, section on
or off. Not derived per row from `useRowTabs`: `untouched` reads
`lastInputAt`, which the row selector holds back on purpose. The PR snapshot
is read non-reactively, with a `usePr` re-render trigger like `BoardView`'s.
A collapsed row selects values only (its badge, its tab count, whether a
child holds the selection), so a working agent's once-a-second title rewrite
re-renders no status row. Only an EXPANDED row's children hold the tabs
(`useRowTabs`, timestamps held back), since they draw the titles. `selectorFanout.test.ts` pins all of it.

### Not built

Batches ACROSS projects (a spawn tree via `spawned_by`, drawn as one unit in
the bucket of its most urgent member: the task-group rule one level up), a
count on the compact rail, and drops
as commands (`boardDropCommand` is reusable once there is a vertical hit
test). A finished turn you have not looked at is NOT Needs attention: it is the
Done chip in the sidebar and the blue dot in the title-bar pill, which
counts the two separately (bell for blocked, dot for finished unread) and
is amber only while something is blocked. The board still files it under
Settled. Still open:
whether `taskBoardColumn` should grow a Merged column so "finished and can
go" has an answer on both surfaces.


## The sidebar's workspace view

A third `sidebarView` beside the tree and STATUS (`"workspace"` in
`parseSidebarView`, so a stored unknown value still lands on the tree). The
header's layers button (`sidebar-workspace-view`) swaps it with the tree; the
swap arrows keep swapping tree and STATUS, and leave the workspace view for
STATUS. Not on the icon rail, like STATUS.

A workspace is a named, saved set of project ids with one active. It is a
view filter, not project data: the view draws the ordinary project tree
filtered to the active set, in the tree's own project order, and the STATUS
section is not drawn above it (it would list tasks the filter hides). Nothing
about a project or task is written.

State is `src/store/workspaces.ts`, in scoped localStorage (`workspaces`, the
list, and `activeWorkspace`, the id), no Rust. A stored active id that names
no workspace boots as none. A project the user removes from the app leaves
every set, and only that: `ipc.projectRemove` calls `forgetProject` once the
backend call succeeds. A project list that merely lacks an id (a partial or
failed load) prunes nothing, because a lost set costs the user the filter they
built. An id whose project is gone by another route stays in the set and is
never drawn, since the tree lists existing projects only.
Deleting the active workspace activates the first one left.

`WorkspaceSection` is only the picker: chips (`workspace-chip`, one
`data-active`), the manage button, and the empty states (`workspace-empty-none`
with no workspaces, `workspace-empty-unselected`, `workspace-empty-projects`
for an active set with no projects). The manager
(`WorkspaceManagerDialog`, `React.lazy`, mounted on first open) creates,
renames and deletes workspaces (delete asks inline, in place of the button) and ticks projects in and out of the selected
one.

## The sidebar's status chips

Under the filter bar, a row of chips counts the tasks in action and, after
a thin rule, where each of them is: working, needing you, in review, settled
(`sidebar/StatusChips.tsx`).
A chip toggles its status clause in the sidebar's query, so clicking one
narrows the tree to those tasks and the bar shows the clause it wrote: the
board's lane-click idea, applied to the sidebar.

They are drawn only while the STATUS section (above) is off, which is the
default. The section lists the same buckets with their tasks, so with it on
the chips would say the same thing twice; turning it on swaps the chips for
it, and nothing else about the filter bar changes. For most people the
section's real job, saying that something needs you without scrolling, is
the count, and the list is one click away in the tree.

- **A chip IS a board column.** Every task's column is
  `boardColumnFromFacts` ([src/lib/taskBoardState.ts](../src/lib/taskBoardState.ts)),
  the board's own precedence, through `useTaskQuery`'s column map, and
  `status:` matches on the same map. If one looks wrong, the fix goes in
  `taskBoardState.ts` and the board moves with it.
- **A count is under the rest of the query:** the tasks in that column the
  bar lets through with its `status:` clauses dropped (`dropBoardClauses`),
  so it is what clicking the chip leaves in the tree, plus the open task the
  tree always keeps, and turning one chip on does not zero the others.
- **Counted per task.** The section placed a whole task group in its most
  urgent member's bucket, and a filter cannot reproduce that, so a count
  and its click would have disagreed.
- **A chip is its glyph and its count,** on one line at any sidebar width.
  Its name is in the tooltip and the accessible label: with the words the
  row wrapped to two lines in a narrow sidebar.
- **The row holds the chips and nothing else.** The filter's "N of M
  tasks" count used to sit at its far end. With the chips it has now that did not fit
  a default-width sidebar: the row scrolled, and the count covered the last
  chip, which was the one just clicked. The count is at the foot of the
  tree (`sidebar-filter-count`), above the note about hidden projects.
- **In review is the PR glyph in the text colour,** not green. The column
  means "has an open or draft PR, agent idle", and green on a row's PR
  badge is a PR state, so a green chip read as "checks passed". An eye was
  tried and dropped: the PR glyph is what the board's review column uses.
- **A total and its parts.** Tasks in action (`action`) comes first, then a
  1px rule (`status-chips-rule`), then the four board columns a started task
  can be in: Working (`working`), Needs you (`attention`), In review
  (`review`) and Settled (`settled`). A task is in exactly one column, so
  the four always add up to the first, and the spec asserts that sum. Not
  started (backlog) is the rest of the list; it stays in the query language
  and the filter menu.
- **Tasks in action is the total:** it counts all non-backlog tasks and
  toggles `-status:backlog` into the query. Clicking it clears granular
  status clauses, so every started task shows at once. Clicking a column
  chip while it is on replaces `-status:backlog` with that status.
- **Settled wears a check mark** in the settled colour
  (`STATUS_MARK_COLOR.settled`, `var(--color-info)`) and writes
  `status:settled`.
- **There is no Done chip, on purpose.** Done (the blue dot: a turn finished
  and nobody has looked) is not a column, it cuts across them: such a task
  is in Settled, or In review with a PR. The row had one through 1.14.4,
  when it had no Settled and no total, and the overlap did not show. With
  all three, one finished task read 1 on Tasks in action, 1 on Done and 1 on
  Settled. Taking Settled out instead left 1, 0, 0, 0, 0, a total with no
  part saying where the task was. The row keeps the set that partitions.
  `status:done` is still an overlay the matcher answers from the `done` fact
  (`BoardMatchCtx.done`, `BoardTaskFacts.done`), typed or from the bar's
  menu, and the title bar's waiting pill (`lib/waitingAgents.ts`) is where
  unread work is counted. The board's filter menu does not list it either.
- **Every chip is always drawn.** An empty one is disabled
  (`aria-disabled`, faint, glyph uncoloured, spinner held still, click does
  nothing) rather than hidden. Hidden, the row appeared with the first
  working agent and went with the last, and the project tree jumped a row
  each time. "Empty" means its unfiltered column, so typing in the bar never
  disables a chip (under a query a live one can read 0), and a chip whose
  clause is in the query stays live: it is how that clause comes back out.
  `aria-disabled` and not `disabled`, because a disabled button swallows the
  hover and the tooltip is the only place a chip's name is written.
- **The work prefs gate it as they gate the board:** `attentionIndicator`
  off empties Needs you, `workingIndicator` off empties Working.
- **Rendering:** its own memoized component calling `useTaskQuery` with
  `alwaysColumns`, whose columns come from a facts record of three booleans
  per task (`createStatusFactsSelector`), never `tabs`, with the PR snapshot
  read non-reactively behind a small `usePr` trigger. An output stamp or a
  live title re-renders nothing, and a count moving does not re-render the
  Sidebar body. `selectorFanout.test.ts` pins it.
- Not on the icon rail.

## What a task is called (name vs branch)

A task's label is decided in ONE place, `taskLabel()` in
[src/lib/taskLabel.ts](../src/lib/taskLabel.ts). By default it is the title
typed at creation. With `useBranchAsTaskName` on (Settings -> Tasks, off by
default, GH #260) a WORKTREE task is labelled by its branch instead, in the
sidebar row, the breadcrumb, the command palette, the archive and sandbox
dialogs, the Dashboard, the race board and the desktop notification title. New
surfaces that name a task go through the same helper: a place that reads
`task.name` directly is a place that disagrees with the sidebar.

Three rules the helper encodes, all load-bearing:

- **Only a worktree task is relabelled.** A plain-folder task has no branch
  (`""`), a detached checkout records the literal `"HEAD"`, and a main-checkout
  task is excluded even though `task_open_repo` does record a branch for it:
  that branch is the shared checkout's HEAD, so it reads `main` in every
  project and moves under the task whenever anyone runs `git checkout` there. A
  worktree's branch was cut FOR that task, which is the issue's whole premise.
  All three fall back to the typed name, which is also the guard against
  rendering an empty row.
- **The typed name is never overwritten.** It stays on the record, it is what
  rename edits, and it stays reachable in the row tooltip. The pref is a
  display choice, not a migration.
- **The branch is the one frozen on the worktree task's record**, the same
  value the breadcrumb has always shown. Checking out a different branch in the
  worktree does not rewrite it (`task_git_checkout` writes git, not the
  record), so a task whose HEAD has moved still shows the branch it was cut
  on. Resolving live HEAD instead would mean a git call per sidebar row on
  every render, which is not a trade this app makes.

**A branch label draws its leading path faint.** A sidebar of branches mostly
starts with the same word (`feature/`), so the rows differ only after it.
`taskLabelParts` splits the label at its last slash, and `TaskLabelText`
(shared by the tree's rows and the status section's) draws the prefix in
`fg-faint` and the leaf at full strength. Only a label that IS the task's
identifying branch is split, whether the pref put it there or the typed name
already equals it: a typed name with a slash in it is prose. Squeezed, the
prefix takes all of the shortfall and shrinks to nothing before the leaf
loses a character, since the leaf is what tells two rows apart: the leaf is
`shrink-0` capped at `max-w-full`. Weighting the shrink instead
(`shrink-[1000]` on the prefix) still hands the leaf a sliver, and a leaf
0.02px short paints its ellipsis; integer `scrollWidth`/`clientWidth` call
that whole, so the spec measures the text with a Range. The status
section's rows draw the leaf ALONE (`leafOnly`), with the whole branch in the
tooltip: they also carry the project name, and a prefix squeezed there came
out a different length on every row (`fea…`, `featu…`). The tree right below
still shows it. Other surfaces (breadcrumb, palette, dashboard) still draw the
label whole.

Where the label already sat next to the branch, it collapses rather than
repeats it: the breadcrumb's `<name> on <branch>` and the Dashboard row's
identical shape both drop the "on" clause when the label IS the branch. That
is the same collapse `task.name === task.branch` has always triggered for a
task the user never renamed.

`task.name` is still the right field for anything that is data rather than a
label: `TERMIC_WORKSPACE_NAME` and the agent env slugs, PTY log filenames, and
the agent briefing all keep the typed name whatever the pref says.

## Task type on a plain-folder project

"Worktree" needs branches, so a project pointing at a plain folder can only
run in its main checkout. That is a **single-repo** rule, and the three
surfaces that enforce it (the New Task dialog's Task type toggle, the sidebar
`+` menu, and `parseDeepLink`) all draw the line at
`non_git && type !== "multi"`.

A multi-repo project is different: the members are the git repos, and the host
is only where the shared `CLAUDE.md` / `.claude` live. `task_create_multi`
already handles a plain-folder host by creating the wrapper directory itself
and symlinking those shared files in, then worktreeing each git member under
it exactly as it would under a git host. Clamping such a project to the main
checkout takes its whole per-member list away, which is what happened when the
dialog started gating the member rows on the task type. What a plain-folder
host really loses is the HOST-level "Branch from" pin (there are no host
branches to pin); the members keep their own, in the dialog's member list.

A task does not have to mount every member. Each row carries an include
checkbox (default: all in); unchecked members are left out of the composition
entirely, in worktree mode and in the main-checkout checklist alike
(`task_create_multi`'s `members` arg and `task_open_repo`'s `members` arg are
the same filter). Named subsets are saved per project in localStorage
(`newTaskMemberSets`, `memberModes.ts`) — the chips under the Members header
apply one in a click and the dashed "Save set…" button stores the current
checkboxes. A member removed from the project stays in the set but is ignored
at apply time, so a re-added member rejoins it. "Duplicate worktree" on a
task re-seeds the dialog with that task's member subset (plus its branch),
not the all-in default; a task frozen before subsets existed duplicates the
way it always did.

An existing multi-repo task is editable too — the task menu's "Edit task…"
(multi-repo tasks only; a single-repo task has only its name, which Rename
covers) opens a dialog that mirrors New Task field-for-field, so "what did I
create" and "what can I change" are the same picture. Frozen fields render
disabled rather than hidden (Task type, Branch name, Host branch from, each
existing member's mode segmented control and branch — remove + re-add is how
you change a member's mode); editable ones write through their existing
commands: name → `task_rename`, Default CLI → `task_set_cli`, YOLO →
`task_set_yolo`, and the member checklist → `task_update_members` (current
members checked — uncheck = remove, gated by a destructive confirm for
worktree members since it deletes the worktree; project members not in the
task unchecked — check = add, with the same Main-checkout/Worktree toggle and
branch/base fields the New Task dialog shows; on a live main-checkout task
additions always link). Sandbox and Resume-args-override are the SAME fields
as New Task — the real `SandboxPicker` (with the per-mode config pane to the
right, same two-column layout New Task uses) and the inline override field —
saved through the same commands their dedicated dialogs use (`task_set_sandbox`
with `kill_live = false`, `task_set_docker` behind its mounted-agents confirm,
`task_set_resume_override`). The restart affordance those dialogs have becomes
a "Restart agents" toast action after a seatbelt change on a mounted task.
Saved-set chips and Set-all bulk buttons are
deliberately absent here — a one-click preset on existing members would be a
one-click mass worktree deletion. One Save applies the delta and refreshes.

## Starting a task from an issue (GH #21/#22)

One flow, two doors, and the SAME `NewTaskDialog` behind both:

- **Command palette → "New task from an issue…"** → the shared project picker
  (`openProjectPicker("issue")`; the placeholder tells you which question you
  are answering) → `openNewTask(projectId, { issueMode: true })`.
- **Inside the dialog**, the "From a <forge> issue" switch on the title
  line ("work item" on Azure DevOps — provider name and noun both come
  from `src/lib/forge.ts`), which is the same `enterIssues()` the seed
  triggers.

It is deliberately not a dialog of its own. "Which project" is the first
question either way, and everything after the issue is picked (task type,
branch, CLI, sandbox) is the ordinary New Task form. A second dialog would have
had to grow all of it back.

The palette row is NOT gated on any project being on a forge: no project is
chosen at that point, and resolving every project's remote to decide whether to
draw a row would be a `git remote get-url` per project. A repo that turns out
not to be on a forge gets told so, by name, in the issue column
(`unsupported-remote` / `no-remote` / `cli-missing` / `cli-unauthed` each carry
their own copy) rather than being shown an empty list, which would read as "no
open issues" and mean something else entirely.

### The issue picker is a COLUMN, not a field

It sits beside the form as a second pane, the same treatment the PR picker and
the sandbox config get.

It was inline above the form first. That put a 220px scrolling list inside a
dialog you were already scrolling, and hid the effect of a pick below the fold.

### The PR picker opens on you, and the repo's list is one click away

"From a PR" opens on **For you**: your own open PRs and, under them, the
open PRs waiting on your review (`gh pr list --search review-requested:@me`,
so a request to a team you are on counts, as on GitHub's own Review
requests tab). Both lists are about you, so they stay short on a busy repo.

**All open** is the repo's open PRs, newest first, one page of 50. It is a
chip, not the default, because on a repo with 1,300 open PRs the newest 50
are rarely the one you came for, while on a small team repo they are
exactly it. Three things keep it cheap for the first case:

- It is fetched on the click, never on entry. Nobody who stays on For you
  pays for it.
- It is capped. A full page says so under the list ("Showing the newest
  50") and points at the number box, which is the path for anything older.
- It is the forge's own default order (`gh pr list` with no filter, GitLab
  `order_by=created_at`, Azure the CLI's own order, not verified).
  `--search sort:updated-desc` was measured on a 1,300-PR repo and does not
  come back in updated order, so "most active first" is not on offer.

The chips draw only for an `ok` lookup of your own list: a forge that
cannot be reached is already explained there, and All open would fail the
same way. The column starts back on For you every time it is entered, and
a slow All open answer is dropped by a sequence number if you clicked back.

On GitLab every list is one REST call through `glab api`
(`merge_requests?scope=created_by_me`, `scope=reviews_for_me` for the MRs
where you are a reviewer, and `scope=all` for All open), and a pasted
number is `merge_requests/<iid>`.
The REST API rather than `glab mr list` because the CLI's JSON has moved
between versions, the same reason the issue list uses it. A server that
does not accept a `scope` value answers 400; for `reviews_for_me` that
reads as an empty review list, so the section hides instead of erroring
under your own MRs.

The review list is a second `project_forge_prs` call (`scope: "review"`) fired
beside the first, never before it. It renders BELOW your own PRs, because it
lands on its own clock and a list that arrives late must not push down a row
you are about to click. It draws only for an `ok` status with rows: a forge
that cannot be reached is already explained by the first list, and saying it
twice is noise. Azure's reviewer filter wants an identity id rather than
`@me`, so it answers an empty list and the section stays hidden there.

Picking a PR from any list is the same pick: fetch the head, then check
it out. Firing a review at it is the prompt library's Review entry, by hand.

The issue column has the matching half as chips over the list: **All**
and **Assigned to you** across GitHub, GitLab (`scope=assigned_to_me`),
and Azure DevOps (`[System.AssignedTo] = @me`), plus **Mentions you** on
GitHub (`--search mentions:@me`, a search qualifier because `gh issue
list` has no mention flag). Chips, not extra lists: the repo's list is
long, so a list appended under it would sit below the fold, and a chip
only changes the list when you click it. Each click refetches with a
sequence number so a slow answer for a scope you already left cannot
overwrite the one you picked. The column starts back on All every time it
is entered.

### The new-task dialog has TWO columns and TWO widths

Left is the form. Right is whatever context the chosen source needs (the issue
list, or the PR picker) with the sandbox config stacked **under** it. Nothing
gets a third column.

The dialog's width depends on exactly one thing: whether that right column
exists. `max-w-xl` without it, `max-w-[72rem]` with it.

Both rules are there because the obvious composition is wrong. Each pane used
to own a column and carry its own `ml-8 border-l pl-6`, and the width was a
six-way ternary over (issue AND sandbox), (issue OR sandbox) x (multi, import,
checkout). So the dialog jumped between four visible widths as you clicked
through the sources, and when the PR picker arrived it was not in the matrix at
all, which is how a FOURTH column appeared. A per-pane column does not scale:
every new source is another multiplication. A single stacked right column is
the same layout whatever is in it.

One fixed width for both cases is not the answer either. The plain form is one
narrow column, and at 72rem it sprawls across an empty dialog.

### A pick fills the form; it does not send anything

Picking an issue writes **Name**, **Branch** and **Initial prompt**, all three
still editable, and Create is still the only thing that acts.

The prompt is the part that changed: there used to be a second seeder in the
dialog (`seedIssue`) that composed `buildIssuePrompt(issue)` and typed it at the
agent after create, so the first message an issue task ever sent was one the
user never saw. It now lands in the Initial prompt box that already existed for
deep links (GH #192), which makes the box the preview, and lets you add the
sentence of steering an issue nearly always needs. There is exactly ONE seeder
in the dialog now (`seedFirstMessage`), which matters beyond tidiness: two of
them poll the same default tab and write to the same PTY, and `sendMessageToPty`
writes text then a CR shortly after, so two interleave into one line followed by
two Enters.

`buildIssuePrompt(issue, maxChars?)` takes a budget because the box caps what it
will send (`MAX_PROMPT_CHARS`). What gives is the issue BODY, never the tail:
the instructions are the ask, and the body is context the agent can re-read in
full with the forge's own view command already in the prompt (`gh issue
view --comments` / `glab issue view --comments` / `az boards work-item
show`, picked by provider in `issuePrompt.ts`).

The prompt's instruction half is `builtin:work-issue` from the prompt library,
read live, so editing it there changes every future issue task
(`src/lib/issuePrompt.ts`).

A plain shell or registry terminal has no prompt box, so the composed prompt has
nowhere to go: the column says so at the point the issue was chosen rather than
letting Create drop it silently.

## Checking out an existing branch

For reviewing or continuing someone else's branch in its own folder, beside
whatever the main checkout is doing. The "Existing branch" switch on the New
Task title line (worktree mode, single-repo git projects, the same gate as
"Import a worktree") and `termic new --checkout <branch>` both send
`task_create` with `checkout_existing: true`, and Rust's
`checkout_existing_branch` (lib.rs) decides what that means:

- a **local** branch is used as it is, even when the remote one has moved on:
  it may hold your own commits, and a checkout must not move it;
- otherwise the branch is looked up on the remote, taking `origin/alice/fix`
  or a bare `alice/fix` (the default remote). It is **fetched** first when
  "fetch before create" is on, so a branch pushed since your last fetch works,
  then gets a local branch **tracking** it, which is what `git checkout` DWIMs
  to and what makes push and pull on it reach their branch;
- an unknown name is an **error**. It never falls through to the new-branch
  path, which is the whole reason the mode exists: typing a remote-only branch
  into the ordinary "Branch name" field makes `rev-parse --verify` miss it and
  cuts a fresh branch of that name from main, so an agent reviews main under
  the colleague's branch name and nothing says so.

"Branch from" becomes "Compare against" in this mode: nothing is cut from it,
so it only sets `Task.base_branch`, the ref the diff pane compares against. A
typed one has to resolve, like `--base` on the new-branch path, or the diff
would quietly fall back to HEAD.

The picker lists `project_branch_context` (local git, no network): local
branches, then remote ones whose name is not already local, capped at
`BRANCH_CHOICES_MAX` rows (`src/lib/existingBranch.ts`). The typed text is the
value and the rows only fill it in, so a branch nobody has fetched yet is still
one keystroke away, and the field says it will be fetched. Name may stay
blank: it defaults to the branch minus its remote, shown as the placeholder.

**Restore remembers it was a checkout.** The task records
`checkout_existing`, and `ensure_restore_branch` reads it when archive deleted
the local branch (Settings > Tasks > "Delete the branch when archiving", off
by default): a checkout's branch comes back from the remote, fetched and
tracked like the first time, while a task's own branch is still cut from its
base. Without the flag, restoring such a task used to give a fresh branch off
main under the colleague's name. If the remote no longer has the branch
either, restore fails with an error instead of doing that.

## Title bar contents, and what moved out of it

The "Focus title" design (2026-10): the refined tree's material on a 50px
bar, three columns in a grid (`.titlebar`, `minmax(0,1fr) auto
minmax(0,1fr)`). It is a grid and not three `flex:1` columns because the
traffic-light reservation is padding inside the left column, and flex
columns with unequal padding come out unequal: the title sat 34px off the
window's centre until the switch.

- **Left**, after the traffic lights (84px, unless full-screen): the
  sidebar toggle and the profiles button as 28px icon buttons
  (`.titlebar-icon-btn`), then the waiting-agents pill and the build
  badge (DEV / E2E / BETA, or the update button). The design
  labels its second button "Agents" but draws the profiles glyph; termic
  has no Agents view, so it is the profiles button, the dot and name once
  profiles exist.
- **Centre**: the task title (`FocusTitle`), agent glyph, task, project,
  branch, the link glyph on a main checkout, a chevron. The whole pill opens
  the task finder, the same dialog as its shortcut, rather than a second
  switcher, and the finder sits 6px under the bar. A label that IS the
  branch drops the branch segment, so the branch shows once.
- **Right**: the session strip, then two recessed wells
  (`.titlebar-action-well`). Do holds the Run
  split (one raised chip, two buttons: run or stop, and the run menu) and
  Prompts; Manage holds the terminal panel toggle (raised while the bottom
  terminal is open), Send to main, sandbox (raised while any sandbox is on),
  archive and the open-with split. Then the command palette and the
  right-panel toggle. Every segment is icon-only with its label in the
  tooltip and its `aria-label`.

**The session strip** (`SessionStrip`, `lib/sessionStrip.ts`) speaks for the
open task only: the newest running agent tab. With no agent running it is
not rendered at all, even if one is blocked on you, and the right cluster
closes up.
It has two modes (`data-mode`): `minimal`, a pill holding only the trace,
and `expanded`, everything below. The pointer entering a hit zone 6px/10px
past the well, or focus landing inside it, expands it; leaving collapses it
after 220ms. Each hidden group is a grid track eased from 0fr to 1fr, so the
width animates without measuring content.
It draws a trace, tab name, state word, elapsed clock
and a stop button past a groove (it kills that tab's PTY after a confirm). A
`+N` chip switches to another running agent. Its data is what the tab
already carries; there is no live tool-call channel, so the tool slot only
appears for a permission request, whose hook body names the tool
(agent-hooks.md). Two rules keep it cheap: the pick is ONE string
subscription (`sessionStripKey`), so output stamps and live titles re-render
nothing, and the clock ticks in local state, mounted only while the window is
visible.

The bar carries the current profile's accent as a wash from the left edge,
fading out by the first third (`profileWashCss`, docs/profiles.md), as a
custom property under the bar's own gradient (`--titlebar-wash`). The chip
sits inside that wash, so the colour and the name are one signal rather than
two. The wash is the bar's only tint: wells and chips are the neutral
material, and only the build badge is coloured, as status.

Window in the background (`windowFocused` false): text and glyphs marked
`.titlebar-ink` drop to 55% opacity, wells and chips do not, and the trace
keeps running.

**The theme picker is NOT here.** It lives in the sidebar footer, first in the
row, and moved there when the profile chip took the space. It is a set-once
preference; the title bar is the strip you drive agents from. Anything proposed
for this bar has to earn its width against the title, which is the thing
people actually read.

### The folder button is a picker, not one action

`OpenWithButton` replaced a fixed "Open in Finder". Left half launches the app
picked last, a 21px chevron half opens the menu of everything detected (the
pair is 48px, the cap `task.e2e.ts` holds it to). Finder is
first in the list and the default, so the old behaviour is one click away and
nothing that worked stopped working. It earns the extra width because a git
worktree is rarely something you want in a file manager: the tools you want on
one are an editor or a terminal.

Three things about it are load-bearing:

**The app list is fetched on first menu open, never during render.** Detection
is a Rust call that stats `/Applications` (and on Linux walks the login shell's
PATH, which blocks), and this component repaints whenever the active task
changes. A render-path fetch is performance.md bear trap 5 here.

**Which means the button cannot know whether the remembered app still
exists, so it does not try.** It renders from the preference alone, and
`open_with_app` rejecting is what triggers the recovery: toast, then revert the
pick to the file manager. That is also the only correct answer for an app
deleted while the menu was open, so it is not a second-best fallback.

**The preference stores the label and kind, not just the key**
(`openWithApp` in localStorage, decoded once at store init by
`parseOpenWithPick`). That is what lets the button paint its icon and tooltip
with zero IPC. Decoding in a selector instead would mint a fresh object per
store notification and re-render the bar on unrelated prefs writes.

Icons are per GROUP, not per app (the design's open-folder glyph for the file
manager, `Code2` / `SquareTerminal` for the others):
lucide has no Cursor or Warp glyph, and eight brand SVGs is a bigger change
than the feature. The label carries the identity, the tooltip spells it out.

Deliberately NOT extended to the file context menus (`CopyPathItems`,
`TerminalPathMenu`). Those act on a FILE and already have "Open in default
app"; this acts on the task root. `ContextMenuItem` also drops `data-*`
attributes, so its rows cannot carry a test id.

## Session bar

The "Session bar" design (2026-10): the tab strip above the terminal, in
the title bar's material (`TabBar`, `.sessionbar` in `index.css`). Every
split pane's own strip (`PaneHeader`) is the same bar with a close-pane
button on the end, and the bottom shell strip reuses the same `TabPill`.

- **Shell**: 44px, a two-stop gradient with the title bar's grain baked
  into a background layer (`--sessionbar-grain`, no pseudo-element and no
  z-index games). `SESSION_BAR_PX` in `TabBar.tsx` is the same 44: split
  panes place their content that far below each pane's top, so the two
  move together.
- **Order**: the tab well, the + (opens the new-tab menu, as ⌘T does), a
  spacer, then the pane-tools well: broadcast, split down, split right.
  Broadcast is a toggle in the sense the UI can honour: it reads as on
  (raised chip, accent icon, `aria-pressed`) while that task's broadcast
  dialog is open, and a click while on closes it. The split buttons turn
  accent once the task has a split.
- **Tabs** size to their content, 96 to 200px, and shrink toward 96
  (ellipsising) before the well scrolls. Vertical wheel turns into
  horizontal scroll (`scrollSideways`); a trackpad swipe is left alone.
  Pinned tabs keep a fixed width (200, 180 in pane strips) so a live title
  cannot reflow the strip, and sit before a rule outside the scroller.
- **Active**: the raised chip, bold ink, the agent glyph at full brand
  colour with a soft glow. An idle tab's glyph is its brand colour mixed
  40% into `--sessionbar-glyph-dim`, so every agent keeps its own hue.
  The accent underline is drawn only on the active tab of the FOCUSED
  pane, so across a split one tab reads as current.
- **Name**: centred on the whole tab, with the glyph and the trailing slot
  at its edges. The glyph sits in a 30px box so both sides are 40px; a tab
  with run controls or a queue marker is off centre by their width.
- **Trailing slot**: one 24x20 cell holding two stacked layers, the state
  indicator and the close button (a plain red-tinted ×, no pill). Only the
  tab's right end (a 40px hit area) swaps them, so hovering the name never
  hides the state and the name's tooltip stays reachable. Indicators in priority order: failed
  (warning), attention (bell), partial (green ring), done (green dot),
  working (the ECG trace, `TabTrace`), delegated (background ring), then
  the unseen pad ring and the dirty dot. A pinned tab has a neutral unpin
  button in the close layer, shown at rest when no indicator outranks it.
- **The trace** animates only while a tab is working: its component
  mounts only then, the pulse is paused (`animation-play-state`, not
  unmounted) while the window is hidden (`useDocumentVisible`), and
  reduced motion leaves a static trace. `data-mark` sits on the pulse, so
  the e2e suite reads the mark and its 1.4s duration off one element. The
  e2e window is hidden, so a pulse that unmounted when hidden read as no
  animation at all there.

Window in the background: labels, indicators and icons drop to 55%
opacity; wells and chips do not. Tokens are `--sessionbar-*` for the bar
itself (Dark+ values in their own `@theme` block, derived from `--color-*`
for the other dark themes and custom themes, and for light); wells, chips,
hover ink and the settled green reuse the sidebar and title bar families.
`src/lib/sessionBarTokens.test.ts` checks every theme redeclares them.

## Window chrome / drag

macOS overlay title bar, hidden title, 84px reserved left for traffic lights. Their inset (`traffic_y` in `build_profile_window`) is 27.5, which centres them on the 50px bar: checked by eye on a Darwin 27 Mac, not yet on one before Tahoe (the old 38.5px bar used 21 on Tahoe and 16 before it). `TERMIC_TRAFFIC_Y` overrides it for tuning. Windows and Linux have no native frame at all (`decorations(false)` in `build_profile_window`): the same bar drags the window through `startDragging()`, a double click maximizes (read off the mousedown's click count), and `WindowControls` draws minimize, maximize / restore and close at its right end, in each platform's own look (Windows' caption glyphs and red Close; GNOME's small round buttons on Linux). Linux dropped GTK's title bar because it spent ~58px on the word "Termic" above a bar that already says where you are. The window still resizes from its edges (tao hit-tests the outer 5px of an undecorated window), and `WindowResizeEdges` lays transparent strips over that same 5px purely for the resize CURSOR, which tao sets on the toplevel window and which never shows over the webview. On Linux the window has no shadow, and the title-bar context menu (Move, Always on Top) is gone with the bar; the compositor's own Super+drag still moves it. The Activity window keeps its native title bar everywhere. Three drag mechanisms (each fails differently):

1. `data-tauri-drag-region` — primary (Tauri 2 JS handler)
2. `WebkitAppRegion: "drag"` — backup (native AppKit hint)
3. `onMouseDown → startDragging()` — escape hatch (imperative)

Opt-out with both `data-tauri-drag-region="false"` and `WebkitAppRegion: "no-drag"`. mousedown handler skips `button, input, [data-no-drag]`. `startDragging()` silently fails without `core:window:allow-start-dragging` in capabilities. No `user-select: none` on drag region — put it on inner text spans.

## Activity window (per-agent CPU / memory)

A SECOND window (label `procmon`, its own Vite entry `activity.html`), opened from the pulse icon in the sidebar footer or the palette's "Activity monitor". Not a modal, and that is the whole design: the numbers only mean something while you drive the agent that moves them, which a modal over the app makes impossible. Rows are grouped project → task → tab, with Termic's own processes in their own group at the bottom.

Every column header sorts (`activityGroups.ts`), default CPU descending, and a group sorts by the aggregate of whichever column is active. Two rules there are not obvious and both exist because the table was unreadable without them:

- **The CPU sort key is a short average, while the displayed number stays instantaneous.** Ordering on the instant makes near-equal rows trade places every tick, which is precisely when several agents are busy and you need to read the table.
- **The tie-break must be TOTAL** (name, then row key). Two idle claude tabs in one task tie on every column, and a comparator that returns 0 leaves them in snapshot order, i.e. Rust's `HashMap` iteration order — rows visibly reshuffling while nothing happens.

There is no expand affordance. PID is its own (sortable) column, and the per-child process breakdown a tree can have lives in the row's tooltip: for a one-process row, which is most rows, expanding only repeated the Process and PID columns.

Three things to know before touching it:

- **It has no capabilities.** `capabilities/default.json` is scoped `"windows": ["main"]`, so this window gets no core-plugin permissions: no `data-tauri-drag-region` (it keeps a NATIVE title bar, which is what you grab), no `startDragging`, no window-close from JS. App-defined `#[tauri::command]`s are outside the ACL and work fine, which is all the monitor needs. Anything plugin-backed you add here needs a second capability entry first.
- **Its own entry point, not a branch inside `main.tsx`.** `activity.html` → `src/activity.tsx` → `ActivityWindow.tsx`, which keeps xterm, the WebGL addon and CodeMirror out of the monitor's webview entirely (14 KB entry chunk + the shared React chunk, versus the app's 2.3 MB). A window whose job is reporting memory should not be the second-biggest consumer of it.
- **Snapshots never touch a Zustand store.** They live in local state in `ActivityWindow`. A 1 Hz write into `app.ts` would copy its ~233 keys and re-run every mounted task's selectors, i.e. the monitor would become the regression (docs/performance.md bear trap 8).
- **It remembers WHERE it was, never how big.** `procmon` is in the window-state plugin's `skip_initial_state` and `procmon_open_window` restores `StateFlags::POSITION` alone, so the monitor opens at its built 880x620 every time. The plugin puts saved bounds back verbatim and does not honour `min_inner_size`: a saved 880x620 came back as 440x310 LOGICAL on a 2x display, under this window's own 560x320 minimum, and at 440 the row grid's first column collapses so the process name renders at ZERO width. The title is in the DOM and invisible, every row reads as bare numbers, and `activity.e2e.ts` "names the agent row after the tab" is what catches it. Main and profile windows share the same plugin behaviour but survive it, because their halved size still clears their 900x600 minimum and `lib.rs` clamps them up anyway; this window had no clamp and a minimum it could fall under. Do not "restore the size too" without giving that first column a floor.

Theme comes from importing `@/store/prefs` (the module applies the persisted palette's CSS vars at load, and localStorage is shared across windows of the same origin). Zustand state does NOT cross webviews, so a theme change in the main window reaches this one when it next opens.

**Row names come from the main window, on request** (`lib/activityTitleBridge.ts`). A tab's displayed title is `customTitle ? title : (liveTitle || title)`, and `liveTitle` (the agent's OSC title) lives only in the main window's JS memory, never on disk — so Activity emits `activity://request-titles` and the main window answers with a `tabId -> title` map. Three details are load-bearing:

- **The request rides the sample tick, not `loadMeta`'s every-tenth.** The project/task lists are disk reads and genuinely slow-moving; a title is the one piece of metadata here that changes while you watch it, because an agent rewrites its tab title as it works. On the every-tenth cadence an occluded window lagged 50 s behind, which is also how the e2e case for it flaked.
- **A reply identical to the last one is dropped before it reaches React** (`sameTitles`). Nearly every reply is unchanged, and passing a fresh object identity through once a second would re-run `groupRows` for nothing — the cross-window twin of [performance.md](performance.md) bear trap 8.
- **A bridged title applies even to a tab absent from `persisted_tabs`.** The task list is re-read from disk on the slow cadence, so a just-opened task's tabs can still be missing from it while the main window is already showing their titles. Gating the overlay on the persisted array made such a row read "Agent · bash" until the next re-read.

`emit`/`listen` are the core `event` plugin, so — unlike a plain `#[tauri::command]` — they ARE capability-gated per window (`capabilities/procmon.json`). A dropped permission fails silently, with titles quietly reverting to the "Tab N · claude" fallback, which is why both sides log a broken bridge through `log_line`.

## Top-bar tooltips that name a shortcut

`CommandPaletteButton.tsx` sits after the two action wells in `UnifiedBar.tsx`, before the right-panel toggle, and renders with or without a task (the palette's global commands do not need one). The palette button is a bare 28px icon (a window with a ">" prompt) matching its neighbours: the shortcut lives in the tooltip only, built from the LIVE `command-palette` binding via `bindingGlyphs` rather than a hard-coded "⇧⌘P", so a rebind retitles it. An earlier version printed the glyphs on the button face as a bordered chip, which read as a foreign element in a row of bare icons.

Prompts (⌥⌘P, the searchable palette over the same list), the terminal panel (⌘J), the task title (⌘O) and the right-panel toggle (⌥⌘B) get the same treatment through the local `tipWithKey(text, id)` helper in `UnifiedBar.tsx`, which appends the live glyphs or nothing. Wrap the tooltip OUTSIDE a `DropdownTrigger asChild` (`<Tip><DropdownTrigger asChild><Button/></DropdownTrigger></Tip>`), and give that menu `onCloseAutoFocus={e => e.preventDefault()}` or the focus snapping back to the trigger re-fires the tooltip and leaves it stuck open.

The palette button toggles on `pointerdown`, not `click`, and that is load-bearing: the palette is a non-modal Radix dialog whose dismissable layer closes it on document pointerdown, so a click handler reading `commandPaletteOpen` always sees `false` and reopens what the user just dismissed. `onClick` remains as the keyboard path (Enter / Space fire no pointer event) and no-ops when pointerdown already handled the press.

## Dropping a path into a terminal

Two gestures, one landing point (`lib/terminalDrop.ts`): every terminal host registers itself with `registerTerminalDropTarget`, and a drop types the escaped path into that PTY through `ipc.ptyWrite` — indistinguishable from typing it.

- **From Finder** — Tauri's native `onDragDropEvent` (the DOM `drop` never fires, and WKWebView would not expose the real path anyway). Absolute paths, physical-pixel drop point. A drop on a **sandboxed** agent asks first: stage into TMPDIR, or allow the file/folder (needs an agent restart).
- **From the file tree** (GH #136) — a pointer drag (`startPathDrag`), same as the tab strip: **never HTML5 DnD**, which is unreliable in WKWebView and gets intercepted by Tauri's file-drop. Inserts the path relative to the task root (falls back to absolute for another task's terminal); no sandbox prompt, since the worktree is already granted.

Both share the hit test and the `.termic-drop-target` highlight, so they agree on where a drop lands.

## Right-click in a terminal

Every xterm (agent tabs, shell tabs, the scratch shell) has a context menu:
Copy, Paste, Select all (`TerminalContextMenu.tsx`, wrapping the xterm host
element). Copy is disabled until the terminal has a selection, read when the
menu opens. A paste goes through `term.paste`, so it is bracketed exactly
like a keyboard paste. The clipboard goes through the Rust clipboard plugin
(`clipboard-manager:allow-read-text` / `allow-write-text`), not
`navigator.clipboard`, for the reason `lib/clipboard.ts` gives: a Radix
menu's onSelect carries no user gesture in WKWebView.

## Find in terminal

⌘F (Ctrl+Shift+F elsewhere) opens `TerminalFindBar` over any terminal: agent and shell tabs, and the footer shell. Every match gets a wash of the accent the moment the query changes; the current one gets a stronger wash and an accent outline (and xterm's selection colour, since the addon selects it), with a "3 of 12" count. Reopening on a kept query highlights again straight away.

- The highlights are xterm decorations, which only take `#RRGGBB`. `lib/terminalFind.ts` resolves `--color-accent` and blends it into the terminal's background, so no hex lives outside the theme.
- While a decorated query is live the addon re-searches 200ms after new output. Closing the bar clears the decorations, which also stops that, so a streaming agent does not keep paying for a search nobody is looking at.
- Past 1000 matches the addon stops decorating and the count reads "1000+ matches".

## Touch ID for sudo offer

While a host terminal (agent tab with the sandbox off, shell tab, footer shell) sits at a sudo password prompt, `SudoTouchIdBanner` shows an in-flow strip above it: "Would you like to enable Touch ID for sudo?" with **Run in new tab**, **Copy command**, **Don't ask again** and a dismiss X. Modelled on iTerm2 3.7, including the transparency: nothing is elevated behind the user's back.

- **Run in new tab** opens a plain shell tab titled "Touch ID for sudo" and types the script path at its first prompt (`TerminalTab.sudoTouchIdInstall`, cleared to `""` once sent). The script prints its own source, then asks sudo for the password. A shell, not a custom-command tab, so the output stays after the script exits and nothing re-runs it on relaunch. That tab never shows the offer itself.
- **Copy command** copies `sudo '<path>'`.
- **Don't ask again** turns off `offerTouchIdForSudo`, re-exposed as "Offer Touch ID for sudo" in Settings, General (macOS only).
- Every button also dismisses it for the current prompt. Rust only raises it again on the next sudo run, and withdraws it as soon as sudo is no longer the foreground job.

Rust decides when it shows (see [ipc.md](ipc.md)); the frontend only listens and renders.

## Confirms for recoverable actions

`ConfirmDialog` (`askConfirm`) renders an optional second checkbox when the
request passes `dontAskAgain: true`. It reads **"Show this every time" and
starts ticked**: unticking is the deliberate act, and the box then matches the
Settings toggle it writes rather than inverting it. The result still comes back
as `dontAskAgain` (true = the user opted out), so callers persist on
`confirmed && dontAskAgain` and never on dismissal alone: the dialog reports
the checkbox state at dismissal, so a backed-out action would otherwise disable
every future confirmation.

Two flows use it, both writing a Settings › Tasks toggle:
`confirmBeforeArchiveTask` (`src/lib/archiveTask.ts`) and
`confirmBeforeCloseAgentTab` (`src/lib/closeTab.ts`). When the confirm is off,
the action still reports itself with a toast that names the way back (History
for an archive, the `+` menu's Resume submenu for a closed tab), because the
dialog was the only other feedback that anything happened.

Copy follows what is actually recoverable, and only a genuinely one-way action
gets `destructive: true` (the red button). An archive keeps the task in History
and the branch in git; a secondary tab comes back from Resume. A **pane** tab
is never snapshotted into `closedTabs`, so that one is one-way and says so. Red
buttons everywhere teach people to ignore red buttons.

The main agent tab has TWO answers, and the dialog picks between them rather
than always claiming the first:

- **This close empties the task's main strip.** The task sleeps, and waking it
  restores the tab from `persisted_tabs` with its session. "The session resumes
  when you reopen the task" is literally true, and no `closedTabs` entry is
  taken (it would be a duplicate way back).
- **Another main tab is still open** (a shell, a Run tab, a diff). The task
  never sleeps, so nothing ever wakes it, and `ensureDefaultTab` bails on any
  task that owns main tabs. The durable record stays on disk, perfect and
  unreachable. So this close DOES take a `closedTabs` entry, keyed to the tab's
  own id and carrying `is_default`, and the copy points at the Resume list like
  a secondary tab's does. Resuming reuses that id, which re-attaches to the
  existing durable record instead of adding a second one aimed at the same
  session.

The split matters most in a main checkout, where there is no cwd resume to
paper over a lost session id: a replacement agent from `+` there comes back
with nothing at all. See docs/gotchas.md, "A durable tab is only restored by a
WAKE".

A **scratchpad** (GH #244) gets its own three-outcome prompt instead
(`ScratchCloseDialog`, Save… / Discard / Cancel, dismissal = Cancel), because
it has never been written anywhere the user chose and there is no file to go
back to. That prompt runs **once per pad, including inside a bulk close**
("Close others", "Close to the right"): folding several pads into the one
counting confirm would mean a single click deciding the fate of several notes.
Cancel there spares that pad and lets the rest of the set close, the only
reading that survives the fact that the tabs before it are already gone.
`confirmBulkClose` therefore counts dirty FILES and live agents only, and a set
of nothing but pads skips it entirely rather than stacking two dialogs on one
decision.

A pad an AGENT creates or writes (`termic scratchpad`, MCP `scratchpad_*`)
while it is not on screen in a focused window gets `ScratchTab.unseen`: a
hollow ring in the done colour on its tab, in place of the grey dirty dot a
pad always carries (a pad is dirty for its whole life, so that dot says
nothing). Showing the tab clears it, by click or by `useSeenWhenWatched` when
you come back to a window where it is already in front. It is its own field,
not `unread`, because `unread` is agent news: the OS notifier and the
sidebar's work badges read it, and a pad edit must reach neither. The user's
own typing goes through the editor, never through `padHandler`, so it never
marks. A pad with no open tab has nowhere to show the mark.

## Close vs Quit (windowless mode)

Standard macOS app semantics, added as a prerequisite for the CLI's windowless daemon mode:

- **Close** (red button; ⌘W is "close active tab", not the window) → routed by the `close_action` setting. `CloseRequested` is ALWAYS prevented first, then Rust decides:
  - unset / `"ask"` (default) → emits `termic://close-requested`; `CloseDialog` asks **Keep in Menu Bar** / **Quit Termic**, with "Don't ask again" writing the choice back to `close_action`.
  - `"menubar"` → straight to windowless, agents keep running.
  - `"quit"` → teardown.

  Anything unrecognised falls back to **ask**, never to quit (`close_action_from`, unit-tested): a corrupt or hand-edited settings file must not be able to start killing agents.

  Settings › General exposes all three as a select. It has to include "Ask me each time", because ticking "Don't ask again" in the prompt is otherwise a one-way door.

  `CloseDialog` is deliberately NOT built on `ConfirmDialog`, which folds dismissal into cancel — whichever action sat on cancel would also fire on Escape. It has three outcomes instead, and **dismissal cancels the close entirely** (window stays as it was), so Esc can neither quit nor be the only route to quitting.
- **Quit** (⌘Q or the menu-bar item) → the only teardown path: `RunEvent::Exit` → `cleanup_children` SIGKILLs every PTY and script group. It **asks first when quitting would interrupt work**, the way a terminal asks before closing a window with a job running.

  The bar is "you are about to lose work", not "something is running". No live AGENT pty, no prompt, which is the common case of a window full of finished tasks. Live but idle agents get no prompt either: quitting an idle agent loses a process that was doing nothing. A **working** agent, or a **queued message** that would die unsent, gets one. `quit_warning` in `lib.rs` is that rule as a pure function, and the cases that matter are the ones where it stays quiet.

  "Is it busy" comes from the work-state snapshot the WEBVIEW pushes (the same cache the CLI's `wait` reads). When that is missing or stale, the prompt still fires and says it cannot tell: there are processes about to be SIGKILLed and no evidence they are idle, and "I cannot tell" must not resolve silently in favour of destroying the work.

  The alert is NATIVE, not a webview dialog, because the menu-bar Quit happens in windowless mode where there is no window to render one in. It is the only Rust-side `tauri_plugin_dialog` caller, so its copy is English like every other Rust-side message.

  All three user-initiated quits funnel through `confirm_quit_or_exit`: ⌘Q arrives as `ExitRequested` with no code, while the menu-bar Quit and the close prompt's Quit call `app.exit(0)` and so arrive WITH one, indistinguishable from the exit the confirm itself requests. One entry point is what stops the check applying to only one of the three.
- **Dock icon** click on a windowless app reopens it (`RunEvent::Reopen`). Unhandled before, but moot then: closing the window quit the app outright, so there was nothing to reopen.

This is a deliberate behavior CHANGE, not a bug fix. Previously closing the last window quit Termic and killed every running agent (tao destroys the window → Tauri fires `ExitRequested` → unprevented → exit). The teardown comment in `lib.rs` claimed the app survived a last-window close; that was wrong, verified empirically.
- **Menu-bar item** opens a menu on click (either button): **Show Termic** / separator / **Quit Termic**. No bare left-click "show" shortcut — that would leave Quit reachable only by right-click, which is undiscoverable for the one action that stops your agents. The separator keeps Quit off the muscle-memory path. It has no setting, deliberately. Its presence IS the signal "Termic is running without a window": shown when the window goes away, hidden on restore. A preference would only control whether it also sits there during a normal windowed session, which adds chrome and says nothing. `enter_windowless` refuses to drop the dock icon (`Accessory`) unless the item actually came up, so the app always has a way back.
- `termic`'s auto-launch passes `--headless`, which boots straight into windowless: no window, no dock icon. An instance that has never shown a window stays `ActivationPolicy::Accessory`; once the user has seen one, the dock icon persists for the process lifetime (Mail/Messages behavior).

The webview stays ALIVE while windowless — it owns PTY lifetime and every work-state signal, so tearing it down would kill the agents. It is not suspended (WebKit only clamps timers to 1 Hz). What windowless mode DOES have to do is collapse the task panes to zero geometry, or xterm keeps drawing for an invisible window: see docs/performance.md bear trap 2b and `src/lib/windowlessMode.ts`.

## Right-panel tabs (All files / Git)

**Git** is one tab with three sub-tabs, because they are three questions about
one repo rather than three places:

- **Commit** — what you can stage right now (Fork-style staging, the only one
  of the three you ACT in: stage, discard, commit, push).
- **Compare** — what this branch adds up to next to another ref (issue #208):
  one list of every path that differs between a chosen ref and the working
  tree, committed and uncommitted alike, because an agent that split a feature
  over six commits leaves nothing in the staging view to read. Its own bar
  (`<base> → <branch>`) WRAPS to a second row rather than truncating: two long
  names is the normal case, and on one row flexbox splits the deficit in
  proportion to length, which crushed the shorter ref to a single character.
- **History** — the commit graph (issue #199), full height.

### Two readings of one changed file

A row in Commit or Compare opens the file's DIFF on a plain click, and the
file ITSELF three ways: a button on the row (left of the eye), the row's
context menu ("Open file"), or an ⌥-click. Both readings select the row, so
switching between them never loses your place in the list.

The row button is not redundant with the other two. A context item and a
modifier are both invisible at rest, so the feature did not exist for anyone
who did not already know it was there: the first person to use it went
looking for an icon beside the eye and found nothing. Order on the row is
open, then viewed, then stage: navigate, judge, act. It carries the same
quiet-until-hover treatment the eye has, so the resting row is no busier.

The diff is the right default and stays it: this panel exists to show what
changed. But it is the wrong reader often enough to need an escape hatch. A
file added in one commit renders as an unbroken wall of `+`, which is the
worst possible way to read a spec somebody just wrote, and a markdown file in
a diff loses its rendered preview entirely. Opening the file goes through the
same `openPreviewTab` the file tree uses, so a file opened from a change row
and the same file opened from the tree are ONE tab, and a markdown file
arrives in whatever view you last read one in (`markdownDefaultView`).

Both surfaces hide it on a DELETION, following the eye: there is no
working-tree file to open, and an editor on a path that is gone is not a
reading of anything. That is the ONLY condition. A repo_root member's files
open like any other group's, because `task_file_read` resolves a
`<dir_name>/…` path inside that member's own checkout even when the checkout
sits outside the wrapper subtree. `DiffPane`'s own "Open" button is the third way in, for
when you are already looking at the diff.

Order of the chrome above them, outermost first: repo pills (multi-repo tasks),
then the branch bar, then the sub-tabs. Which repo you are looking at is what
the branch and all three sub-tabs are ABOUT, so it cannot sit inside them.

One box serves all three, on the branch row. The chip is not "one short
control" the way that row was first written: branch names are routinely long
enough to fill it, and since the box is a flex-basis-0 item it absorbed none of
the shrink and collapsed to its own padding. The box holds a 30% floor and the
chip a matching cap, so a name truncates instead of taking the row. In Commit and Compare it filters the file list. In History it is a
MESSAGE SEARCH run by git (`--grep`, literal and case-insensitive, subject and
body) over the whole scope rather than over the rows on screen: "does this
branch have a commit about X" is a question about the history, and answering it
from the loaded page would make it a question about how far you had scrolled.
Debounced at 250ms, so it is one `git log` per pause. It narrows whatever scope
is active rather than replacing it, so a search under All searches every ref.

The sub-tab row keeps only what belongs to the active view: the view-mode menu
for Commit and Compare, the ref picker for History.

History's picker has two independent axes. WHICH refs to walk (Auto = the
checked-out branch, All = every ref, or any number of named ones) and HOW MUCH
of the topology: **First parent only** collapses a merged side branch into the
merge commit that brought it in. Without it, picking one branch still draws a
lane per merged branch, because those commits genuinely are its ancestors,
which reads as "why am I seeing other branches when I picked main".

The graph used to be a collapsible section at the foot of the staging view,
sharing the body by a draggable ratio. It is the one view here that wants
vertical space and was getting whatever two file lists left over, so it became
a sub-tab and the collapse flag, the ratio, the divider and their localStorage
keys went with it.

## Pinned folders in the file tree

When the task's project has pinned folders, the All files tree opens with a
collapsible "Pinned" section over the root listing — a GitPanel-section band
(tinted header: chevron, label, count) whose rows sit enclosed above a closing
border and gap, so they never read as the first tree entries — one plain tree
row per pin showing the task-relative path. A row click is a REVEAL, not a navigation: the ancestors
expand, the view scrolls to the folder and the row ring-highlights for a
moment, exactly the reveal an editor breadcrumb asks for — one mechanism, two
callers. The section folds to its header row (`pinnedSectionCollapsed`,
machine-level like every collapse flag) and renders nothing at all when the
project has no pins. Marking has two entries, both on folder rows only: the
context menu's "Pin folder" / "Unpin folder", and a pin glyph at the row's
right edge that appears on hover (stays faintly visible on a pinned row, where
it is the passive indicator). Clicking the glyph toggles the pin without
expanding the folder; every handler on it stops propagation, `pointerdown`
included, or the row's drag-to-type eats the click before it happens.

Pins are PROJECT state, not task state (`src/store/pinnedFolders.ts`, one
localStorage key, profile-scoped like every project-id-keyed record): tasks
are worktrees of one project, and the task-relative path of the folder you
care about is stable across them, so a pin made in any task serves all of
them. Renaming a folder remaps its pin (and every pin beneath it) in place;
deleting one KEEPS the pin on purpose, because the common delete is a build
output dir that comes straight back, and a pinned row for a missing folder
reveal-no-ops quietly, the same as revealing a deleted file from a breadcrumb.
Pins die only with their project, in the same `loadAll` housekeeping pass that
prunes fileViewed by task liveness.

## Right-panel footer (Setup / Run / Terminal)

Three tabs. Setup + Run stream via `useScriptRuns`. Terminal is opt-in: click `+` → `useApp.enableFooterTerm(wsId)` → AuxTerminal mounts. RunToolbar: Open (expands `project.preview_url` with `$TERMIC_PORT`/`$CONDUCTOR_PORT`/`$PORT`/`$TERMIC_WORKSPACE_NAME` + any frozen extra named port, GH #196) + Run/Stop (SIGTERMs process group). Default: tab=Run, expanded.

`task_archive` sweeps `RUNNING_SCRIPTS` and SIGTERMs each before teardown.

## Markdown preview

**GitHub's typography, the theme's colours.** `.markdown-body` in `index.css`
ports Primer's markdown stylesheet: 16px block spacing, GitHub's heading
scale, 85% monospace code with a 6px radius, zebra table rows, and a 980px
measure centered in the pane. The one deliberate departure is the base size,
system font at 14px/1.5 instead of GitHub's 16px, which read as too large
next to the app's 13-14px chrome. Headings and code are `em`, so they follow.
Colours map onto theme tokens (links use `--color-palette-blue`), so the
document sits on the app surface under every theme. The old Inter 14px/1.65
across the full pane width read as heavy on a wide window.

**Selectable, and copies as clean rich text.** The host carries
`data-selectable` (the chrome is `user-select: none`). ⌘C is handled by
`lib/markdownCopy.ts`, not WebKit: WebKit inlines every computed style, so a
paste into a light surface arrived as near-white text in Inter. The handler
writes `text/html` with the document's structure only (links, emphasis,
lists, tables, headings, code), re-wrapping a partial selection in its
list / table / `<pre><code>` so bullets and code blocks survive, and drops
what a paste target cannot resolve: relative links become their text, local
`data:` images are left out. `text/plain` is the selection's text.

**External files preview too.** An absolute-path `.md` (the read-only
external tab from a ⌘-click) gets the same source / split / preview shell.
`MarkdownCtx.external` switches link resolution to the file's own directory
(`resolveExternalHref`): a target inside the task opens as an ordinary tab,
anything else as another external tab. Relative images are not loaded, see
docs/sandbox.md "Known gap".

**Every block knows its source lines.** markdown-it's `src_lines` core rule
stamps `data-src-line` / `data-src-end` (1-based, inclusive, trailing blank
lines trimmed) on each rendered block; a fence carries them on its `<pre>`.
Raw HTML in a document passes through with whatever `data-src-*` it wrote,
and those values decide which lines a comment quotes to the agent, so ours
carry a per-load nonce and `claimDocument()` unwraps ours and drops the
rest. It runs on everything that enters the preview, the render and each
mermaid SVG (mermaid sanitizes its labels itself and keeps `data-*`). Two
features read them:

- **Split-view scroll sync** (`useScrollSync` in `components/task/markdownScrollSync.ts`).
  Either pane drives the other: the blocks give (line, y) anchors and
  positions between them are interpolated, so a tall image or long paragraph
  scrolls smoothly. Anchors are cached until a re-render or a ResizeObserver
  hit (late images, mermaid). The echo of a programmatic `scrollTop` write is
  recognised by the value it lands on, not a time window (a busy frame
  delivers it late), which is what stops the two panes feeding each other. A
  pane with no box never drives. The pane that was already on screen leads
  when split opens, and the first sync waits for the ResizeObserver's initial
  delivery so the editor's `attachHiddenScrollRestore` cannot undo it. A
  rebuild re-aligns to the editor.
- **Comments on rendered text** (`usePreviewComments` in
  `previewComments.ts`). Selecting in the preview raises a "＋ Comment" pill;
  the comment lands in the same `reviewComments` store as an editor comment.
  The quote is ALWAYS the selection: it is what the user pointed at, and
  quoting the whole block (the old fallback whenever the selection was not
  verbatim source) turned "this phrase" into "this paragraph". The line range
  starts as the innermost stamped block at each end of the selection and is
  narrowed by `narrowSelection()` to the lines the selection spans in the
  source, matched with every whitespace run elastic (most markdown is
  hard-wrapped, and the rendering joins those lines with a space). When the
  selection is not in the source as typed (inline markdown, an entity), the
  locator stays the block's lines. In the preview the quoted text itself is
  wrapped in `<mark class="tc-md-quote">` (a `<mark>`, not the CSS Custom
  Highlight API, see docs/gotchas.md), the open composer's included; only
  when that text cannot be found in the rendering (an editor comment quoting
  `**markdown**`) are the blocks marked instead. Because it is the same comment, it
  shows beside its source in the editor too, and the editor's anchors keep it
  on its code through edits. The composer and card are the editor's own
  (`commentBoxes.ts`, framework-free DOM, styled by `.tc-comment-*` in
  index.css), placed in slot divs that `placeSlots()` keeps after the
  top-level block holding the innermost blocks the range touches (those are
  what the quote is searched in, and the fallback marks, so a comment on one
  list item marks that item, and
  markdown inside an unstamped `<div align="center">` still counts). It moves
  only slots that are out of place: moving a node detaches it, and a detached
  composer textarea loses focus (the innerHTML rebuild detaches them all, so
  `rebuild()` puts the caret back). Slots and commented blocks are marked
  with `data-tc-slot` (`SLOT_ATTR`) / `data-tc-commented`, which the
  sanitizer and `claimDocument()` strip from documents (with any `tc-*`
  class, so a README cannot draw a fake card either); find, ⌘C
  and `unmarkFind`'s normalize all leave the cards out. Task files only
  (`commentFile`); whole-file comments have no block and stay in the editor.

**Word wrap** (`prefs.editorWordWrap`, off by default) lives in Settings >
Appearance and the palette's "Toggle word wrap". No toolbar control, by
choice. It is its own compartment in `EditorPane`, reconfigured in place.

**Indent guides** (`prefs.editorIndentGuides`, on by default) and **minimap** (`prefs.editorMinimap`, off by default) are toggles in Settings > Appearance and the palette's "Toggle indent guides" and "Toggle minimap". Each is its own compartment in `EditorPane`, reconfigured in place. Guide colors are `--color-indent-guide` and `--color-indent-guide-active` in `index.css` `@theme`, mixed from `--color-fg` so every theme follows. The minimap renders to a canvas and is loaded on first use; see [performance.md](performance.md) bear trap 15.

**Editor keymap** (`prefs.editorKeymap`, `"default"` | `"zed"`) is a select in
Settings > Appearance and the palette's "Toggle Zed keymap". The Zed preset is
its own `Prec.high` compartment in `EditorPane`; see
[shortcuts.md](shortcuts.md#zed-preset-prefseditorkeymap).

## HTML preview

`.html` / `.htm` files, in the task or external, get the same source /
split / preview shell (`HtmlPane.tsx`), opening on the preview
(`prefs.htmlDefaultView`, its own pref like SVG's, since a report is
something you open to read). The page renders in a sandboxed iframe on
`--color-html-canvas`, white in every theme: a document that sets no
background expects a browser's page, and its default black text on the
app's dark surface is unreadable. Security and the measurements behind it
are in docs/sandbox.md, "HTML preview: the iframe is the boundary".

What a v1 deliberately does not do, and why:

- **No JavaScript.** A Chart.js or D3 chart drawn at runtime renders blank;
  inline SVG renders. Allowing scripts is not a flag flip (sandbox.md).
- **Links do nothing** except in-page `#anchors`. Leaving the frame is
  blocked by the sandbox and `frame-src 'none'`. Relative images and
  stylesheets do not load.
- **Shortcuts stop while the frame has focus.** termic's shortcuts are
  `keydown` listeners on the main window, and key events inside a
  cross-origin frame never reach it. Opening a file never puts focus there (the
  iframe has no `tabindex`, so `SourcePreviewShell` focuses the wrapper);
  clicking into the page to select text does, until you click back out.
  Wheel scrolling does not.
- **⌘F does not search the page**: the app cannot read an opaque frame.
- **Scroll resets on every change.** A new srcdoc is a new document, and
  the parent cannot read the frame's position to restore it. In split view
  that is every debounced edit; in preview it is an agent's rewrite. A
  hidden tab keeps its place (`display:none` does not unload a frame).
- **Over 2 MB or not UTF-8**, the editor cannot load the file, so the
  preview has nothing to render and says so after 1.5s.

## Live reload, merge and autosave

An open file follows the disk. `EditorPane` registers a watch (`editor_watch_file`, see [ipc.md](ipc.md)) on mount and drops it on unmount or path change, and re-reads on each `editor-file-changed`. The window-focus and `fsRevision` reloads stay as a fallback and go through the same function (`syncFromDisk`).

What happens to the text depends on the buffer:

- **Clean buffer:** disk replaces it as one minimal change (`lib/editor/externalReload.ts`), so the selection maps through and the scroll position stays. The change carries the `ExternalReload` annotation, so the dirty dot does not flip.
- **Dirty buffer:** three way merge (`lib/editor/threeWayMerge.ts`, line based diff3). The base is the text the editor last loaded or saved, ours is the buffer, theirs is the disk. Hunks only one side touched merge in silently and the tab stays dirty. A hunk both sides changed differently leaves the buffer alone and shows the conflict banner with Keep mine, Take disk and Compare (a read only `MergeView` of disk against buffer, `ConflictCompare.tsx`). Keep mine and Take disk both make the disk text the new base. A further write while the banner is open is merged against the same base again, so the banner resolves itself if the conflict goes away.
- **Disk equals the buffer, the base, or the text this editor is writing right now:** nothing happens.
- **File deleted or renamed away:** the buffer stays, a note says so, and saving recreates the file. **File became binary or over the read cap:** same note with the load error's wording, buffer kept.

Only the newest read applies (a ticket from `createReadTicket`), so a burst of agent writes costs one apply.

**Autosave** is the `editorAutosave` pref, off by default, in Settings, Appearance, Editor and as "Toggle autosave" in the command palette. When on, a dirty buffer is saved 1000 ms after the last edit, on editor blur, and when the tab closes, through the same `saveDoc` as Mod-s (so `gitRevision` bumps and blame refreshes). It never runs while the conflict banner is up, while the deleted or unviewable note is up, or for scratch, external and read only tabs. Autosave saves are silent (no toast). Saving by hand during a conflict is Keep mine by another route.

**With reindent on open** (`editorReindentToThree`): a reindented buffer is dirty from the start, and with autosave on it is written one second later. That write is ignored when its watcher echo arrives (it equals the in-flight text, then the merge base), and the resulting file is never reloaded, so it is not reindented twice. A real external write is reindented after it is applied, whether it replaced a clean buffer or merged into a dirty one.

Save writes `state.sliceDoc()`, not `doc.toString()`, so a pure CRLF file stays CRLF on disk.

## Editor path bar (breadcrumb + syntax)

The bar under the tab strip, for `edit` and `diff` tabs with a path (`EditorBreadcrumb` in `components/task/TaskView.tsx`). Each path segment is a click target: a folder reveals/expands that folder in the tree, the filename reveals the file, and every segment right-clicks to a copy menu. On the right: copy path, open the containing folder in Finder, locate in the tree.

Editor tabs also get a **language button** there, showing what the buffer is highlighted as and opening the "Set syntax" picker (`SyntaxPalette`, also reachable as the command palette's `set-syntax` row). Sublime and VS Code put this bottom-right; termic has no status bar, and inventing one to hold a single control would cost the terminal pane an edge, so it goes on the bar that already exists. Diff tabs deliberately do NOT get it: there is no editable buffer there, so a diff's syntax always follows its path.

A **scratchpad** (GH #244) renders its own variant of this bar: no trail, no copy / Finder / locate buttons (it has no path to point at), a line saying it is not in the project yet, and the language button — which matters more here than anywhere else, since with no extension the content sniffer is the only thing that CAN name the buffer. Its manual pick is PERSISTED, in the scratch index, unlike an edit tab's session-only one (point 1 below): there is no filename to re-derive it from after a relaunch. `SyntaxPalette` writes it at the moment of the pick, not the pane from an effect: picking Markdown swaps panes and remounts the editor in the same commit, so a pane-side effect would only ever see the new value as its initial seed.

Picking **Markdown** on a pad also earns it the source / preview / split shell a `.md` file gets (`MarkdownPane`, routed on `effectiveLanguageId(tab) === MARKDOWN` rather than on a path, since a pad has no extension). That works because the shell's preview is fed by the EDITOR BUFFER, not by disk, so an unsaved pad has something to render. Relative links and images resolve from the task root (a pad has no directory of its own), and there is no `file.md#heading` reveal to consume. Switching between the two panes remounts CodeMirror once; the pad's unmount flush writes the buffer on the way out, so nothing is lost.

### Which language, and where that is decided

The set of languages is **CodeMirror's published registry** (`@codemirror/language-data`, ~150 of them), so opening a `.php`, `.lua` or `.zig` file highlights with no edit here. **Adding a language is not a thing you do.** A language id IS the registry's `name` ("TypeScript", "Properties files", "TSX"), which is also its label.

Precedence, in `lib/languages.ts`:

1. **A manual pick** (`EditTab.syntax`) — session-only, exactly like Sublime's. It survives tab switches, not a relaunch, and is cleared when a preview tab slot recycles onto a different file (otherwise the next file to land in that slot inherits the override). A **scratchpad's** pick is the exception and persists (above).
2. **The automatic answer** (`syntaxAuto`), written by the editor pane: the language the PATH resolves to, or, when the path matches nothing, a guess from the **content** (`lib/detectSyntax.ts` — only markers close to unambiguous: a shebang, an `<?xml`, text that actually `JSON.parse`s; a wrong guess is worse than no guess, so anything vaguer stays Plain Text).

`effectiveLanguageId` therefore has only two levels, not three, and **does not look at the path**. It cannot: resolving a path needs the registry, and the registry may not be reachable from the main chunk (below). The pane owns resolution and writes its answer back to the tab, so the breadcrumb and the picker read one settled value instead of re-deriving it. A tab the pane has not answered for yet reads as Plain Text for a frame.

### The bundle rule

`lib/languageExts.ts` is the gateway to every grammar, and it is imported ONLY by the lazily loaded editor and diff panes. `lib/languages.ts` stays free of CodeMirror. **`lib/mainChunkGuard.test.ts` pins this** by walking the static import graph from `main.tsx`: a stray `import` of `@codemirror/language-data` from anything reachable at app start would move ~800K of grammars onto the launch path. `SyntaxPalette` is mounted from `App.tsx`, so it `import()`s the list when it opens rather than at module load.

The rule covers the GRAMMAR packages too, not just the registry index, and that is the half that bites. A single `import { javascript } from "@codemirror/lang-javascript"` in the settings theme preview pinned that package into the main chunk, and the namespace object the registry's own `import()` then received came back with **no `javascript` export at all** (`e.javascript is not a function`): every `.ts` and `.js` file in the app silently fell through to the content sniffer and highlighted as whatever that guessed. Nothing reachable at app start may name a grammar package, however small the use looks; fetch it with `await import("@/lib/languageExts")` instead. A failed grammar load now also `console.warn`s rather than resolving quietly to "no grammar".

Measured: the main chunk went 2361K → 2214K (the old catalog is gone, and so is the pinned JS grammar), `languageExts` is a 21K chunk fetched on the first editor or diff open, and `dist/` grows ~876K spread over ~119 extra chunks that are only fetched for a language actually opened.

### Async loads, and the race

A grammar is now a **chunk fetch**, so nothing about setting a language is synchronous. Both panes resolve it alongside the file read (`Promise.all`) rather than after it, so highlighting is there on first paint. Switching syntax still reconfigures the language **compartment** in place — no `EditorView` rebuild, so the cursor, undo history and scroll position survive.

Four things race to set one editor's language: the initial load, a path change on a recycled preview tab, the sniffer answering as a pad fills, and a manual pick. Whichever STARTED last must win no matter which chunk arrives first, so every apply goes through `lib/langSwitch.ts` (`claim()` returns a predicate that is false once anything else has claimed). An `alive` flag is not enough — it only knows about unmount.

### What termic still owns

Six grammars, because the registry cannot serve them, and a short **overlay** of filename rules, because it does not match the way we need:

- **Custom grammars**: `Makefile` (hand-written, `lib/makeMode.ts` — `legacy-modes` has ~150 CodeMirror 5 modes and Makefile is not among them; the rule that makes it a Makefile rather than a config file is that a leading TAB opens a recipe, where the line is shell instead of make, and a trailing backslash keeps that state across lines), `ProtoBuf` (`lib/protoMode.ts`; the registry's mode predates proto3, and ours takes the same NAME so it replaces rather than shadows it), `Elixir` (absent upstream), `Svelte` (`@replit/codemirror-lang-svelte`), `Astro` (`lib/astroMode.ts`, below) and `HCL` (`lib/hclMode.ts`, below).
- **Overlay rules** (`OVERLAY_RULES`), each reusing the registry entry's own loader: `Dockerfile.dev` (upstream's pattern is anchored `/^Dockerfile$/`), `justfile`, `.env.production`, `.zsh`/`.fish`, `.conf`, `.rake`, `.pyi`, `.mdx`, and the template formats with no grammar anywhere (`.ejs`, `.mustache`, `.twig`, `.njk`) which get tag highlighting from HTML.

**Frameworks.** React and Vue need nothing from us: the registry's JSX / TSX entries cover React, and its Vue entry loads `@codemirror/lang-vue`, a real single-file-component grammar. Svelte and Astro were on the HTML overlay until they read the tags and left every line of actual code grey, which on an `.astro` file means its entire frontmatter block.

`lib/astroMode.ts` exists because no CodeMirror grammar for Astro exists anywhere. An `.astro` file is a TypeScript block fenced by `---` followed by an HTML-with-expressions template, so it is the HTML parser with the frontmatter region **overlaid** by the TypeScript one (`parseMixed`). Three things about it are load-bearing:

- The overlay hangs off the leading **`Text` node**, not the document. A mount on the top node is silently dropped.
- It is **clipped to that node**, because a `<` in the frontmatter (a generic, a comparison) ends the Text node there and the HTML parser reads what follows as a tag. The block keeps its colouring up to that point instead of losing all of it.
- The closing fence must be a line that is exactly `---`, and an **unterminated** block highlights nothing. Both matter mid-edit: a half-typed fence that counted would flash the rest of the file a different colour on every keystroke.

Template `{expressions}` are attribute values and text, not JavaScript. That is the same trade every HTML-hosted format makes, and it is where a real Astro grammar would start.

Two upstream behaviours to know about. `LanguageDescription.matchFilename` compares the **raw** extension, so `README.MD` matches nothing — `matchLanguage` in `lib/languageExts.ts` does its own two-pass match with the extension lower-cased, and must not be swapped back. And the registry splits JSX/TSX out of JavaScript/TypeScript, so a `.tsx` file's button reads "TSX". `.gradle.kts` is Kotlin, not Groovy, which upstream already gets right.

**HCL.** The registry has no HCL entry. `CUSTOM` lazy-loads
`codemirror-lang-hcl` for `.tf`, `.tfvars` (including `.auto.tfvars`) and
`.hcl`, shared by the editor and diff viewer. The syntax picker calls it HCL
and also matches Terraform; `.tf.json` and `.tfvars.json` stay on JSON.
`lib/hclMode.ts` preserves the semantic tags and adds keyword/string
fallbacks for block types, labels and boolean/null literals, which Atom One
otherwise leaves uncoloured. Highlighting does not format files or start a
language server.

## Code intelligence (language servers, GH #174)

**The name follows the switch.** With type checking off (the default) the
feature is go-to-definition, find-usages, an outline and hover types, so every
user-visible surface calls it **Code navigation**; turn type checking on and
the same surfaces read **Code intelligence**, because then it is more than
navigation. One function decides (`lib/lsp/featureName.ts`), used by the
Settings heading, the chip, both consent prompts, the per-project section and
the editor's nav hint. Naming it "intelligence" while the checker is off sent
readers looking for a half of the feature they had not switched on.

**One download path, for both surfaces that offer it.** `confirmAndInstall`
(`lib/lsp/installFlow.ts`) discloses the size and the memory figure, fetches,
and reports a failure; the caller arms only when it returns true. It exists
because there were two copies and one was wrong: Search Everywhere's offer row
had an Install button that ARMED the checkout without downloading anything, so
nothing could start, the dialog waited for symbols that were never coming, and
the editor chip went on offering the same download. The confirm key is per
SERVER (`code-intel-install:<server>`), so "don't ask again" means the process
rather than the button that happened to be pressed.

**One click, from the editor.** The chip on the path bar (`CodeIntelChip`) is the whole entry point: open a file in a language something can serve and it says "Code intelligence" (or "Install ty 0.0.73" when nothing is on the machine). An earlier design gated this behind a Settings toggle that defaulted off, and the honest verdict on that was that nobody would ever find it. The Settings toggle survives as an OFF switch, default on, for people who never want the button.

Offering costs one IPC call per editor open and nothing else. Nothing is imported until a checkout is armed: `mainChunkGuard.test.ts` forbids `@codemirror/lsp-client` and `lib/lsp/host` from the app-start graph, and the `--version` probe that catches a broken `rust-analyzer` shim is cached by path in Rust, so the offer never spawns a process twice.

**The cost is disclosed once, not every time.** A language server holds its index (300 MB for TypeScript, ~3 GB for rust-analyzer, up to 7 GB for gopls on a big repo) and never releases it while it runs, and three of them also write into the checkout (clangd's `.cache/clangd`, ruby-lsp's `.ruby-lsp`), which is unusual enough that nobody should meet it by surprise. So the first arm shows what it costs, with a "don't show this again" checkbox; someone who has read it and turns navigation on in every repo does not read it again. Same pattern, and the same persist-only-if-confirmed rule, as archiving a task.

**A repo is usually several languages, and each is its own decision.** The chip reads the buffer's own language (`effectiveLanguageId` → `lspServerFor`), so a Django checkout offers Python on `models.py` and TypeScript on `static/app.js`, and arming one does NOT arm the other: the disclosure quotes a per-language number, and agreeing to ty's ~250 MB must not also start a second process. Grants are therefore keyed `(checkout, server)`, and several servers can run for one checkout, each with its own reap and its own Activity row. A project can narrow the set on that same sub-tab, under Auto start (`Project.code_intel_languages`, undefined = all). That list answers ONE question, "what starts here without being asked", and `autoStartsLanguage()` is read by the auto-start planner alone. It used to gate the editor chip, Search Everywhere and the nav hint as well, which made it answer a second question nobody had asked it: unticking Go to stop four servers starting by themselves also removed the one-click button for Go, along with the cost disclosure that button carries. Everything termic can serve is offered on request; the list decides what runs without one. This is what every editor with optional language servers does (Sublime's LSP package, Zed, Helix, Neovim); Fleet's single workspace-wide Smart Mode is the outlier.

**The grant is per (checkout, server)** and deliberately NOT sticky: refcounted against the tasks on that checkout, and it lapses when the last of them is closed or archived (`store/codeNav.ts`, pruned in `app.loadAll` beside the race and mark-as-viewed prunes). Worktrees disappear with their task, but the main checkout is permanent, and a grant made once for a five-minute code read would otherwise resurrect a multi-gigabyte server months later.

A project can standing-instruct arming in its own Code navigation sub-tab (Settings → the project), as three choices rather than a boolean (`Project.code_intel_auto`): off, main checkout only (bounded — one server per language, ever, shared by every task on it) or main checkout and worktrees (unbounded — one server per worktree). Machine-local in `projects.json`, never `.termic.yaml`: that file is committed, and whether to spend this machine's memory is not a colleague's decision.

**The languages live inside Auto start, and only appear once something starts.** They were a flat block ABOVE the radios, so the page asked which languages to narrow before anything had said what was being narrowed, and it read as a list of what the project supports. With Off selected there is nothing to narrow (each task asks, one chip click at a time) so the list is hidden, and switching to Off clears a stored one rather than leaving state behind that no visible control explains. Switching auto start ON with nothing decided yet runs detection over the checkout's file list (`projectLanguages`) and ticks what the repo turned out to be written in: every box ticked on a Python repo is an instruction to start four servers, and nobody means it.

**One list of servable languages** (`SERVABLE_LANGUAGES` in `lib/lsp/serverNames.ts`), pinned by a test against the set termic can actually serve. The per-project checkboxes used to enumerate four of the seven, so the first untick materialised a list of the remaining three UI ids and silently dropped C++, Swift and Ruby with it.

**The unit is the checkout, and that is a correctness rule, not a tuning knob.** Tasks that share a checkout share one server; two worktrees of one repo must not, because they hold different content behind the same module paths and a shared server would resolve an import into the wrong copy. `checkoutRoot()` is the one place that answers which is which.

**Turning it off stops the server now.** The idle grace (3 minutes, 1.5s in the e2e build) exists so closing a tab and opening another does not pay for a re-index. An explicit click on the chip is a different act: the commonest reason to toggle it is that the environment changed underneath the server (a package installed, a branch switched), and handing back the cached client would be the same process with the same stale view of the project. `stopClient` skips the grace, unless a sibling task on that checkout still holds the grant.

**Status, because a silent server looks like a broken one.** A cold rust-analyzer indexes a crate graph for minutes, and until it finishes hover and go-to-definition return nothing. The chip is the indicator, and it is ONE control: the compass becomes a pulsing dot while the server is starting or reading the repo, and the label holds still at "Code intelligence" throughout. The detail goes in the tooltip ("Loading crate graph 42%: answers are incomplete until this finishes", or why the server stopped), which is where someone wondering why a hover did nothing will look. A label that changed on every percentage would reflow the path bar under the reader, and the dot stops pulsing for BOTH settled states: ready, and failed, since a dot still pulsing on a dead server promises an answer that is not coming. That is why the client advertises `window.workDoneProgress` (the plan said not to until there was somewhere to show it, since a server whose `window/workDoneProgress/create` goes unanswered blocks; the Rust host answers it) and why `$/progress` is handled in `lib/lsp/host.ts`. The Activity window carries the other half: every live server as a row with its CPU, memory and a stop button, filed under no task because it belongs to the checkout.

The gap worth knowing about: the chip lives on the editor path bar, so while you are looking at a terminal tab nothing on screen says a server is running. Activity is where to look for that.

**Python environments are named, not inferred.** The host answers `workspace/configuration` per section: `python` gets `pythonPath` (pyright and basedpyright find their interpreter THERE and ignore `VIRTUAL_ENV`), `ty` gets `environment.python`, and every other section gets `null`, which is what the rest expect. Without this, a project whose packages live in `.venv` gets analysed against some other Python and fills with errors about imports that are installed. Termic also warns when a checkout has Django but no `django-stubs`: Django adds `Model.objects` at runtime, so a checker is right to call it missing, and the fix is a package rather than a setting (measured: ty reports that error without the stubs and zero diagnostics with them).

**A usages row says which file, but only when it has to.** Row labels come
from `usageLabels()` (`lib/lsp/usageLabels.ts`), which is PyCharm's rule: a
basename that appears once is shown bare, and only a clash pays for a path,
elided in the middle when long (`projects/…/views.py`). What it replaced named
every row by whatever was left after stripping the directory all rows share,
which collapsed to the bare basename exactly when it mattered: nine usages
spread over a Django repo's three `views.py` read as nine usages in one file.
Two files that would still elide to the same label get their full relative
paths instead, since an ambiguous label is the whole problem being solved. The
footer keeps the selected row's absolute path.

**The usages list resizes from its bottom-right corner, and the size sticks.**
That is the corner that moves nothing: the tooltip is anchored by its top-left,
so the header and arrow stay on the symbol. The drag is clamped to 320x120 and
to the window edge, and the result is kept in `localStorage.usagesPopupSize`.
A reopened popup takes the remembered WIDTH as fixed and the HEIGHT as a cap,
so three usages do not sit in a box sized for forty. The file column is a share
of the row (40%) rather than a fixed 26ch, so widening the popup is what
un-ellipsizes the labels. Every row's `title` is its absolute `path:line`, and
the footer's is the full path, for whatever still does not fit.

Locations are **deduplicated on (uri, line, character) before anything counts
them**: a server reporting one reference from both the open document and its
index is normal, and the popup listed each twice, so four usages read as eight
with the same line numbers repeated.

**⌘-click does what IntelliJ's does**, which is two things depending on where you are: on a usage it jumps to the definition, and **on the definition it lists the usages** (`lib/lsp/modClick.ts`). That second half is the one people miss when they leave JetBrains, and it costs one comparison: ask for the definition, and when the answer is the place you clicked, ask for references instead. It is a mousedown handler rather than a click one, so the editor never starts a text selection first. While the modifier is held the editor shows a pointer, reusing the same `termic-mod-held` class as the terminal's link affordance, scoped to `.cm-lsp-navigable` so an editor with no server keeps a text caret.

Keys come from the client's own keymaps, mounted only while a checkout is armed: **F12** jumps to definition, **Shift-F12** finds references (the client ships the panel it renders into). They are CodeMirror bindings, not entries in termic's rebindable shortcut system (docs/shortcuts.md), because they exist only inside an editor that has a server attached.

What the editor gets: completion, hover types, signature help, diagnostics (feeding the `lintGutter()` EditorPane has had mounted with no source since the day it was written) and go-to-definition. Definitions OUTSIDE the checkout open in a read-only external tab (`type: "external"`), because every other tab path is task-relative and `safe_task_path` rejects anything escaping the worktree. ⌘-clicking into `site-packages` also hops from a stub to the source it describes (`lib/lsp/declarationSource.ts`): landing in a `.pyi` full of `...` is the correct answer to "what is the type" and the wrong answer to "show me this code".

**Where a server comes from, and how it stays current.** Resolution order is the checkout's own toolchain (`node_modules/.bin`, `.venv/bin`), then the user's real login-shell PATH, then termic's own downloads. Nothing is ever put on the user's PATH: a downloaded server lives under `<data dir>/servers/<language>/<version>/` and deleting termic deletes it.

Versions are **not pinned to the termic release**. `lsp_install` resolves the latest release of a hardcoded upstream repo (microsoft/typescript, astral-sh/ty, rust-lang/rust-analyzer) and verifies the bytes against the SHA-256 that release's API record advertises, with the compiled-in version as a tested floor and an offline fallback. A hard pin ages in a way the user pays for, and re-pinning four servers across four platforms by hand is a chore that quietly stops happening. Be honest about what the digest buys: integrity (a truncated download, a corrupted CDN copy, a renamed asset are all refused), not provenance, since the bytes and the digest come from the same place. What this build decides is the PLACE.

Upgrading is in Settings, Appearance, Editor, under the Code intelligence toggle: it checks **on demand only** (a background version check is a network call the user did not ask for, in an app that otherwise talks to nothing but termic.dev), installs **alongside** rather than swapping (a binary replaced under a live session would answer from a different index mid-read, and the running process holds the old one anyway), and keeps the version it replaced so a bad upgrade is undone by deleting a directory. The new build is used the next time a server spawns.

Two things the servers themselves get wrong, both of which fail silently and are therefore pinned by tests. **Diagnostics are half push and half pull**: TypeScript 7 never pushes (0 pushed, 1 pulled on a one-line type error), while ty stops pushing the moment a client claims pull support (0 with the claim, 2 without). So the Rust host strips the CodeMirror client's `textDocument.diagnostic` claim from `initialize`, and `lib/lsp/pullDiagnostics.ts` polls any server that advertises a provider. And **`rust-analyzer` on PATH is usually rustup's shim**, which prints "unavailable for the active toolchain" and exits; resolution asks `rustup which` first and runs every candidate's `--version` before believing in it.

**Completion is the one that hid its own absence.** `basicSetup` ships a local word scraper, so the popup is never empty even with no server attached: it can offer an identifier because that word is on screen, and can never offer a member on it. `serverCompletion()` was missing from the extension list for a while and nothing looked broken. The e2e fixture therefore answers with a label that appears nowhere in the file, which a word scraper cannot invent.

`lib/lsp/workspace.ts` replaces the client's `DefaultWorkspace`, which THROWS on a second view of one file — a state termic reaches without trying, since several tasks can render editors on the same path. It holds a list of views per file, tells the server only about the first open and the last close, replays the last diagnostics into a view that attaches late, and fans pushed diagnostics out to every view rather than the first.

## Indentation, detected per file

The editor hard-coded two spaces for every buffer, which is wrong for most of what an agent writes: Python is four, Go and Makefiles are tabs, and a Makefile's tabs are the format rather than a preference. `lib/detectIndent.ts` reads it off the file, VS Code's default behaviour (`editor.detectIndentation`) and the only one that needs no configuration to be right.

It votes on the DIFFERENCE between consecutive indented lines rather than the smallest indent seen: a file full of 8-column aligned continuation lines still steps by 2, and the step is what survives that. Ties go to the smaller size (a 4-space file also steps by 8 wherever it nests twice), a single observation is not enough evidence to override the fallback, and only the first 64 KB is read, since this runs on the path that opens a file. It lives in its own compartment, so an external reload re-detects without rebuilding the view.

Not done: `.editorconfig`, which is the explicit signal and should win over the guess when a project has one.

## Inline review comments (two surfaces)

(A third, the rendered markdown preview, shares the store and the
composer/card in `commentBoxes.ts`, but not this extension: see "Markdown
preview" above.)

`reviewCommentsExtension(taskId, file, surface)` is one component with two loudness settings, because the same gesture means different things in the two places it runs.

- **Diff pane** (default `{ selection: "pill", hoverGutter: true }`) — reviewing IS the job, so a selection raises a labelled "＋ Comment on lines 12-40" pill and every line offers a hover button.
- **Code editor** (`{ selection: "gutter", hoverGutter: false }`) — you are reading and typing, so both of those read as a second cursor. One dim gutter icon, on the selection's first line, only while a selection stands. ⇧⌘L is the keyboard route (see [shortcuts.md](shortcuts.md)).

The composer has two exits, because a remark on code is sometimes the whole thought and sometimes one of five:

- **Send** (accent CTA, also ↵) ships THIS one immediately and never touches the queue. The comment body is optional there: the selected code alone is a legitimate message.
- **Add to pending** queues it. Queued remarks from the editor and the diff share one list (both key by `file`), and the pending-comments bar sends the batch as ONE message.

Both routes go through `sendCommentsToAgent` (`lib/sendComments.ts`) — one delivery path, so target resolution, the `lastInputAt` stamp that re-arms work-done detection, the focus handover and the toast cannot drift between the two entry points. Editing an already-queued comment offers Update only: it is in the queue, and the bar is where a queue gets sent. Every message carries the fenced code, not just a location line.

The editor's gutter column collapses to zero width while there is nothing to put in it (no selection, no comments for the file). A gutter costs its width on every line forever, and an editor is read far more than it is commented on — 20px of permanent horizontal room made files, markdown especially, start scrolling sideways sooner than they used to. The diff keeps a fixed column: it shows a button on every hover, so a width appearing and disappearing under the mouse would be worse than the space.

While an editor is open, each queued comment keeps the actual selection it was made on as document offsets, mapped through every edit (`lib/commentAnchors.ts`) and written back to the store debounced. Type three lines above a queued comment and its stored range follows the code instead of pointing at whatever now occupies the old line number. The association pair is deliberate: `from` maps with +1 and `to` with -1, so the range does not swallow text typed at its edges. Note the anchor tracks the BUFFER; comment on unsaved edits and the agent, which reads disk, sees something different.

## Inline git blame (cursor line only)

`inlineBlameExtension(taskId, path, { onOpenCommit, onShowInHistory })` annotates the line the cursor is on with `subject, Author (age)` in dimmed text, 50px after the code. VS Code's `git.blame.editorDecoration`, and the format is VS Code's default template with `commitAge` supplying the age so the editor and the History panel describe the same commit the same way.

**The annotation itself is inert.** It sits inside the line being edited, where a click target competes with placing the cursor, so it is hover-only. Resting on it for `CARD_DELAY_MS` (500ms) opens a hover card: long enough that crossing the annotation on the way somewhere else does not throw a card over the next line, short enough that resting on it feels answered.

The card carries author, relative age AND absolute date (the first answers "is this recent", the second "which release"), the short sha, co-authors, the subject in full, and the message prose. Its header holds the two actions:

- **Open diff** — this file as that commit changed it, in the `commit:<sha>` diff tab the History panel already uses.
- **Show in History** — `revealCommitInHistory(taskId, sha)` on the UI store. RightPanel opens the Git tab (and un-hides the panel), GitPanel switches to the Graph, HistoryPanel selects, expands and scrolls to the sha. Three consumers of one request, because the editor has no handle on any of them.

  Two things about that request are load-bearing:

  - **It is CONSUMED.** `clearCommitReveal()` once honoured, plus an `at` timestamp each consumer records so it acts on a request once. Left standing it is a standing order: RightPanel's effect depends on the active task, so it re-fires on every task switch and re-pins the panel to the Git tab. That is not theoretical, it cost most of a debugging session and broke two unrelated e2e specs.
  - **A commit that is not loaded is JUMPED to, not paged to.** `task_git_commit_offset` asks git how far back the sha is (`rev-list --count <sha>..HEAD`) and the panel fetches the single page around it, replacing the window rather than appending (the rows above belong to a different part of the history, and stitching them would draw a graph with a hole in it). Paging forward until the sha appears works on a young repo and is hopeless on a monorepo, where a two-year-old commit is tens of thousands of rows down. A sha that is not reachable from HEAD says so in a toast and drops the request.

The card is a CodeMirror tooltip (`showTooltip`), so CodeMirror owns positioning, flipping and clipping. Two things had to be told about the geometry, and both were visible bugs first:

- **`tooltips({ tooltipSpace })` in EditorPane**, constraining every tooltip to the editor pane's own rect. CodeMirror's default is the whole document viewport, so a card anchored at the end of a long line ran under the right panel and one near the top ran under the tab bar. Mounted in EditorPane rather than in this extension because the review-comment tooltip wants it too.
- **A `min-width` on the card**, not just a max. The annotation sits at the end of a line, so there is often only a sliver of room to its right; with no minimum the card shrink-to-fit into that sliver, wrapped its header into a column and drew its buttons over the author line. Given a width it cannot fit, CodeMirror shifts it left instead, which is the wanted behaviour. It has to survive the pointer travelling into it or its buttons are decoration, hence `CARD_CLOSE_MS` (220ms) of grace on leaving the annotation, cancelled when the pointer arrives in the card. Any edit closes it: the card describes a line that is moving under it.

The message body is NOT part of the blame payload. A file's blame can name 169 distinct commits and the reader looks at one, so `task_git_commit_meta` fetches the body when a card opens, cached per sha. The header renders immediately from the blame data and the prose fills in when git answers, rather than the card waiting on a fork before showing anything.

There is deliberately **no blame column**. Annotating every line is a layout cost, not a cosmetic choice; the reasoning and the CodeMirror rule behind it are bear trap 10 in [performance.md](performance.md).

The pref is `inlineBlame`, OFF by default (matching VS Code's own default and the opt-in shape `loadRemoteImages` set), in Settings → Appearance → Editor, and in the command palette as "Toggle inline git blame" with its current state as the row suffix. It is mounted through its own `Compartment`, so toggling reconfigures in place: cursor, undo history and scroll position all survive, and with it off the extension is never constructed, so nothing is fetched and no state field exists.

Two honesty rules, because a confidently wrong author is worse than none:

- **A line the user edited loses its attribution** and reads "Not committed yet". Mapping alone does not achieve that: `MapMode.TrackBefore` drops a line joined onto the one above, but the survivor keeps its own mark, so the merged line would be credited to whoever owned the first half. Every line an edit touched is filtered out of the snapshot as well.
- **A dirty buffer is never re-blamed.** Blame reads the file on DISK, so its line numbers would not match the screen. The save and external-reload paths drop the cache entry and dispatch `refreshBlame`, which is when a re-fetch happens.

A git tick is deliberately NOT a re-fetch. `gitRevision` bumps on every stage and unstage, not just on commits, so it dispatches `markBlameStale`: the annotation on screen stays put and the refetch rides the reader's next cursor move. Re-blaming per tick forks git once per open editor to redraw one line that usually did not change, and it measurably slowed the e2e suite when it was written that way.

## Git change gutter

`gitChangeGutterExtension(taskId, path)` marks lines added, modified or deleted against HEAD in a narrow gutter beside the line numbers: a bar for added, a bar for modified, a small triangle between lines for deleted, colored from `--ui-git-added`, `--ui-git-modified` and `--ui-git-deleted` in the `@theme` block of `index.css`. The diff is `task_git_line_changes` on the live buffer, requested on mount, 300ms after the last edit, and when the task's `gitRevision` changes.

A result is applied only when the buffer is still the exact document that was sent. Otherwise it is dropped and a new request is scheduled, and a newer request supersedes an older one, so a slow answer can never paint markers on the wrong lines. Markers are mapped through edits in between.

The pref is `editorGitGutter`, ON by default, in Settings → Appearance → Editor and in the command palette as "Toggle Git Gutter". It has its own `Compartment` in `EditorPane`, reconfigured in place, so cursor, undo history and scroll position survive. Scratch and external tabs never get it. Cost notes are in bear trap 10 of [performance.md](performance.md).

## Reindent to 3 spaces on open

`editorReindentToThree` (OFF by default; Settings → Appearance → Editor and the palette's "Toggle reindent to 3 spaces on open") makes `EditorPane` reindent an `edit` tab's buffer to 3 spaces right after the view is created, in the same task as creation so no 2-space frame paints. Nothing is written: it is one ordinary transaction, so it marks the tab dirty, `Mod-z` takes it back in one step, and the file changes only on save. It is deliberately NOT annotated `ExternalReload`, which would hide the dirty dot.

`src/lib/editor/reindent.ts` decides. Allowed languages are TS/JS/JSX/TSX, JSON, CSS/SCSS/LESS, HTML, Rust, C/C++, Java, Kotlin, Swift, PHP and Lua. It skips everything else (Python, YAML, Makefile, Go, Markdown), mixed tab and space files, files with no clear width, files already at 3, files over 1 MB, and any parse that does not finish inside 80ms. Only leading whitespace is edited, and lines that begin inside a string, template literal, raw string, heredoc, block comment or HTML `pre`/`textarea` are left alone, found from the lezer tree. Kotlin, Swift and Lua use CodeMirror 5 stream grammars whose tokens never cross a line, so they get a small scanner instead.

`reindentedFromRef` holds the disk text the buffer was reindented from. The focus reload compares disk to the buffer, which now always differs, so while disk still equals that text the "changed on disk" banner stays down. Saving clears it. A live reload that changes disk re-applies the reindent if the pref is on and the new text is not already 3-space.

## The dashboard

The home screen: hero, three action cards, a Recent row, and the project list.
Rendered by `MainArea` as an OVERLAY whenever no task is active and the view is
not History, with every visited task still mounted underneath so its PTYs
survive. That is why it can afford live signals at all: it is not on screen
while you are driving an agent.

**It shows the same structure the sidebar does.** Project groups render as
folders here too, through the same `projectSections()` in
`src/lib/projectGroups.ts` and, critically, the same `collapsedGroups` map.
Collapsing a folder in either view collapses it in both, because one folder in
two states is a bug the user would read as a rendering fault.

**Section first, then sort.** The dashboard floats projects with live tasks to
the top and the sidebar does not (it folds inactive ones into a trailing
section instead). Applying that sort to the flat project list before sectioning
splits a folder: a group is anchored at its FIRST member's index, so moving
members moves the folder and reorders it internally. `sortSectionsActiveFirst`
sorts whole sections, which keeps a folder intact and its members in the order
every other surface shows them. The worked counter-example is in that
function's comment.

**Rename and drag stay in the sidebar.** Both are inline edits on a row the
sidebar owns; a second way to do them here would be two sources of truth for
one gesture. The dashboard's folder right-click menu is the shared
`GroupActionsMenuItems` WITHOUT its `onRename`.

**Live signals are read-only.** The work badge and the PR chip are the sidebar's
own components (`TaskWorkBadge`, `TaskPrBadge`), fed by the same
`src/lib/taskWorkState.ts` predicates and the same precedence
(attention > done > working). The PR chip renders what the poller already
resolved and never starts a lookup, so listing every task costs nothing.

**Task rows are flat, and the spawned-by mark fills in for the rail.** The
sidebar's task-group rail, collapse and drag stay there; a dashboard card
lists its tasks as plain rows. Since nothing on this surface says who started
whom, every spawned child carries the ↳ mark, including the same-group
children the sidebar suppresses (`suppressInGroup={false}` in
`Dashboard.tsx`). A row with more than one main terminal tab also carries the
sidebar's `(n)` count.

### `work-badge` is no longer a unique testid

The sidebar is always mounted and the dashboard sits on top of it, so a task
with a live agent renders the badge TWICE. A bare
`[data-testid="work-badge"]` query returns the sidebar's, in document order.
Every assertion must scope: `dashboardBadge()` goes through
`[data-dashboard-task-id]`, `sidebarBadge()` through `[data-sidebar-task-row]`.
The sidebar's status section is a third surface, and it does NOT add a copy:
its badges render as `status-work-badge` and `status-pr-badge`, scoped through
`[data-status-task-id]`.

### Recent is a way back in, not a second History

`recentTasks` in `useApp`: task ids, newest first, capped at
`RECENT_TASKS_CAP`, localStorage-backed and written inside the `set()` that
`setActiveTask` was already doing (a separate write would copy the whole state
again for a list nobody renders while a task is open). Archived and deleted ids
are pruned in `loadAll` alongside the group maps, so the row never offers a
dead link. It is hidden entirely when empty, so a fresh install sees the page
it always saw.

It is localStorage and not a `last_opened_at` on the `Task` record for the same
reason folder colours are: it is a per-machine UI convenience, and a disk write
on every task click would be the wrong trade.

## The usage readout: one meter per window, named in words

The task footer's usage chip (GH #277) is a recessed well (`.footer-usage`):
the agent's brand glyph with a soft glow, then one reading per window. The
lead window gets a 64x4 meter and its figure in words, `42% of 5h limit`;
any reading beside it (the week next to the session, the context) is
compact, a 24px meter and `95% wk`, so a chip carrying everything stays
near 290px and two agents still fit one bar. It has been four designs, and
the reasons are worth keeping because they are not about this chip.

One bar, showing whichever window was closest to its limit, sat hard against
the 5h number and displayed the OTHER one. Two pill bars fixed that and left
four marks for two facts. The third design drew each window's gauge as the
fill BEHIND its own figure, which nothing could misread but which cost the
text contrast exactly when it mattered (amber on amber measured 3.3:1). The
footer design brought the bar back, and what makes it safe this time is the
label: every meter is followed by the window it measures, spelled out, so no
bar on the row can be read against the other window's number.

The meter's fill is `--color-accent` (a gradient from a darker mix of it),
`--color-warn` at the warn level and `--color-err` at critical, where the
label takes the same hue; at `normal` the label is `--sidebar-ink`. A stale
reading halves the fill's opacity. The width eases over 300ms and nothing
else animates. Colour comes from `data-level` in `index.css`, never from
`transition-colors`, which never repaints a themed colour in WKWebView
(docs/gotchas.md). An agent that can report and has not shows a dashed
track and "Usage unknown".

The context window (`NN% ctx`) is a third reading of the same kind, LEADING
the chip because it is this conversation's number rather than the account's.
It uses its own thresholds (80 / 90, `contextLevel`), later than the plan's,
because a filling context is a session's normal life and only the approach to
compaction is news. Each readout can be switched off per agent in Settings >
Agents (`agentFooterHidden` in prefs, stored as opt-outs); hiding usage also
stops the pull transports asking, so a hidden number spawns nothing.

**A chip is fully shown or not shown at all, and the bar says when it hid
one.** The original rule was a single hide-below-780px on a secondary agent's
chip, a width measured for the two-agent case. A task runs as many agents as it
has tabs, so with five the chips wanted ~870px on their own, the rule never
fired, and the group ran off the end of the bar and under the right panel.

`footerChipMode` (its own module, so the order is unit-testable without a
window) gives the k-th secondary chip a container-query breakpoint at the width
where it stops fitting, so the bar sheds from the tail. The agent whose tab is
on screen never gets one and is therefore never hidden, at any width. There is
deliberately no abbreviated middle state: a chip missing its plan figures reads
identically to an agent that has none, which is the footer lying by omission,
and half a readout in a bar meant to be taken at a glance is worth less than a
clear signal that something is missing. `moreMarkerClass` supplies that signal,
a `···` shown by the inverse breakpoint so it appears exactly while at least
one chip is gone.

**The marker carries no COUNT, and that is a deliberate trade.** An accurate
"+4 more" means knowing how many chips fit, which means measuring the strip in
JS, and this bar has no ResizeObserver on purpose: it sits under a streaming
terminal and the `@container` collapse exists so a window drag costs no React
render. CSS can hide the overflow but cannot produce the number, so the marker
says "there are more" and stops there. If that number is ever worth a
ResizeObserver, scope it to the chip strip and set state only when the fitting
count changes, never per pixel.

The chips also sit in their own `min-w-0 overflow-hidden` box inside the right
group, so width is shed from the left and the sandbox chip stays pinned as
the rightmost item whatever happens.

The footer classes live in `@layer components` in `index.css`. Unlayered,
`.footer-usage`'s `display: flex` beat the chip's container-query `hidden`
utility (layered CSS always loses to unlayered), so no chip ever hid and
two chips ran past a 600px bar.

## Scheduled queue messages (GH #300)

The queue popover's "Send after" row (Next turn / Tomorrow / In 3 days / In a
week / a date) turns a message into a scheduled one. The promise, stated under
the picker and never stronger: **sent the next time this chat is open and idle
on or after the date.** Nothing fires on its own. There is no daemon and no
Rust timer; with the app closed, `open -a Termic && "$TERMIC_CLI" send <task>
--resume -p "..."` under launchd is the headless route.

- **Dates are local midnight.** A preset or a picked date resolves to the start
  of that day, so "in a week" made at 14:05 still sends when the chat is opened
  at 09:00 that day. A date input is parsed as local, not UTC
  (`localDateValue`), which would be a day early west of Greenwich.
- **The drain** (`sendNextQueued` in TerminalPane, rules in
  `lib/scheduledQueue.ts`'s `pickQueueItem`): a due scheduled item sends
  whether or not the queue is active; a future one is skipped so ordinary items
  behind it still drain; future items do not keep the loop "running" and
  suppress the "Message queue finished" toast. A respawn pauses ordinary items
  and leaves scheduled ones alone, because a reopened chat is exactly when they
  exist.
- **A scheduled send waits for readiness**, like `seedPromptWhenReady`: it can
  be the first thing typed into a session resumed seconds ago, and claude's
  startup dialogs eat keystrokes (its trust picker answers `No, exit` on the
  submit). `blocked`, `lost`, a PTY swap, a turn the user started during the
  wait, or a missing echo all KEEP the item for the next try. It is removed and
  the file rewritten only after the write lands. More than an hour late toasts
  "Scheduled message sent (due N days ago)"; the prompt text is never changed.
- **Two kicks.** The PTY coming up (`tabPtyLive` in the queueKick effect's
  deps) covers reopening a chat. For a chat already open when the date passes,
  `lib/scheduledTicker.ts` walks mounted tabs once a minute and bumps
  `queueKick` only on a live, idle tab with a due item; a pass with nothing due
  writes nothing to the store. Not per-tab `setTimeout`s: past ~24.8 days the
  delay overflows, and timers do not track sleep.
- **Closing** a secondary or pane agent tab that holds scheduled messages asks
  "Delete scheduled messages?" even with the close confirm turned off, because
  the Resume list does not bring them back. The main strip tab stays durable
  when closed, so it does not ask.

Must be checked by hand whenever the readiness path changes: a resumed claude
session that shows an update or trust dialog at startup. No suite catches a
prompt typed into a splash screen.

## Scheduled tasks (GH #300)

Recurring agent runs: a daily dashboard check, a morning triage. The one-shot
half of #300 is the queue's "Send after" above; this is the recurring half.

**A schedule is a parent task.** `Task.schedule` lives on the parent's record
(see data-model.md), so it rides the task file: profile-scoped, paused while
the parent is archived, back on restore. The parent leads the sidebar group
its runs join, collapsed when the schedule founds it, and is created
UNMOUNTED: its agent starts when someone opens it, so a schedule costs
nothing between runs. Its own agent tab is where the user talks about the runs.

**Each run is a new task**: the project's main checkout, never a worktree
(no branch, no disk, no setup script, and a plain folder has no worktree
mode), named for its slot (`grafana-check 2026-09-28 09:00`, de-duplicated
with `(2)`), created with what `runSpecFromParent` derives and mounted but
never activated. Its prompt gets one appended instruction naming the exact
report file to write (`lib/schedules/runSpec.ts reportInstruction`). The
prompt goes in through `lib/agentDelivery.ts`, the same delivery `termic new`
uses, so the readiness rules are one implementation.

**The clock** (`lib/schedules/runner.ts`) is one JS interval on the
`initPrStatusPoller` model, next to the queue-message ticker: started by
`initSchedules` after `loadAll`, one pass at once and then every minute. A
pass with nothing due reads the task list and writes NOTHING (a count test
in `runner.test.ts` injects the regression). The decision is
`decidePass` (`lib/schedules/slots.ts`), pure and driven by an explicit `now`:

- **Grace window, 15 minutes.** A slot first seen within it fires; later, it
  is missed. No timer runs while the Mac sleeps, so a Mac that wakes at 09:03
  still gets its 09:00 run.
- **Missed stays missed**, recorded as one streak entry ("Missed 3 runs"),
  never rung. "Run once at launch if a run was missed" fires one run however
  many slots passed.
- **Overlap is skipped**: a slot due while the previous run is still in
  flight (working, or waiting on input) is recorded as skipped. The overlap
  lock is an in-memory map of in-flight runs, so after a relaunch nothing is
  in flight.
- **`last_slot` only moves forward**, and a slot is recorded BEFORE its run
  is created, so a crash costs one run instead of running it twice. A second,
  per-session guard (`actedSlot`) covers a stale `last_slot` after a lost
  load-modify-save. Creating, re-enabling or re-timing a schedule starts
  `last_slot` at the latest slot already passed.
- **Refused at fire time, not only in the dialog**: a parent switched to
  Docker, an agent with no done signal, a deleted prompt-library entry. Each
  records `failed` and creates nothing. A Docker parent's runs never fall back
  to the host.

**When a run ends** (`lib/schedules/watcher.ts`): one subscription that
costs a `Map.size` check per store write while no run is in flight. It
records what a run has been through on every write but DECIDES in a
microtask, because one agent event can be several writes: `goAttention`
sets `done` and only then marks the attention (gotchas.md). Done: `fired` if
the report file exists, else `no_report`, and the run is stopped unless it is
on screen. Attention: `needs_input`, the run stays live and keeps the
overlap lock. A PTY exit without a done: `failed`. Idle after working ends
the run at once only while it is on screen (a done the user acknowledged by
watching). Off screen it proves nothing at first, since a title-driven agent
goes idle 5s before its done, so the run stays in flight; idle that long after
working (`IDLE_SETTLE_MS`, 2 minutes, checked on the runner's minute tick)
settles it by the report without stopping it. That is what frees a run the
20-minute ceiling gave up on. After each run, runs past `keep_runs` are
archived with `skip_scripts` and report retention is applied.

**One notification per run**, through the same OS path and Settings switch
as every other: "Report ready", "Finished without a report", "Needs your
input", or why it failed, titled with the schedule's name.
`useAttentionNotifier` mutes the generic banners of a run's tabs while it is
in flight, so a run never rings twice. The unread mark still appears.

**Opening a finished run** puts its report in front of the user, once per run
per session: a Markdown report as a rendered tab (`mdView: "preview"`) in
front of the agent tab, and only after the agent tab exists (a tab opened
first would stop `ensureDefaultTab` restoring the agent); an HTML report in
the browser configured for previews, never in the webview, which sits outside
the sandbox. The Scheduled view's link opens either one on request.

**Surfaces.** A **Scheduled** entry in the primary nav (fourth, after
Kanban; Settings -> Appearance -> Sidebar's "Scheduled" picks Off, With
schedules or Always, `scheduledNav` in prefs, Always by default, and "With
schedules" counts a paused schedule because the view is where it is switched
back on) opens `views/Scheduled.tsx`: each schedule's agent, name, project,
cadence, next run, last outcome (a fired run reads as its report's title,
linked), an enabled switch, Run now, edit, delete, and its history. Delete
asks, with "Also archive related tasks and delete reports" unticked
(leaving the parent and its runs as ordinary tasks by default; ticked,
it archives the parent and its runs with skip_scripts and deletes the
reports). Renaming a schedule renames its parent too while the
parent still carries the schedule's old name, so the sidebar group (which
shows its lead's name) agrees; a parent with a name of its own keeps it.
`ScheduleDialog.tsx` creates one with a new parent
(project, name, agent and model, prompt or library entry, cadence, the
Seatbelt sandbox and YOLO seeded the way New Task seeds them, catch-up,
runs to keep, report retention) or from a task's "Schedule..." menu item,
where the agent settings are the task's and are not asked for. A Docker
default seeds no sandbox at all and Create waits for a choice. The dialog
takes New Task's two widths (`max-w-xl`, or `max-w-[72rem]` with a right
column): picking a Seatbelt mode for a new parent opens the cage's allowed
paths and hosts beside the form, seeded from the app-wide and project lists
and editable for this schedule, exactly as New Task does. Size it with
`max-w-*`, never `w-*`: AppDialog's own `max-w-md` caps a bare width, which is
how the dialog shipped 448px wide while asking for 560. "Schedule..."
is disabled on a Docker task with the reason written on the item, and is
offered only for agents with work-done detection. The dialog and the view
both state the ceiling in one line: runs happen only while Termic is running
(a window, or the menu bar), and with profiles only while that profile's
window is open, because closing a non-root profile window destroys its
webview. With desktop notifications off, the dialog says so and links to
the switch.

## Settled detection / notifications

TerminalPane samples `term.buffer.active` every 3s, FNV-1a hashes the visible viewport, marks tab "settled" after 2 identical consecutive samples. Resets on user input. `markAttention(wsId, tabId, reason)` never marks the active tab in the active task. `useAttentionNotifier` suppresses OS notifications for every tab in the focused task. Desktop notifications off by default. Clicking a banner only brings the window forward: it never changes the active task or tab (the old focus-edge router jumped on any refocus within 15s of a notification, including a plain cmd-Tab). The unread dot is what points at the tab; the user does the switching.

## The work badge, and the fourth thing it can say

The full state list, including what each one draws and whether it rings,
is [agent-states.md](agent-states.md). This section is the rendering
rationale.

Three states and a qualifier, not four states. `workState` stays `idle` /
`working` / `done`; `delegatedWork` on the tab says what the agent handed off
and has not finished, and it changes what two of the three MEAN:

- `working` + delegated: the model loop has STOPPED and the agent is waiting
  on its own subagent. The turn is running but nothing is being computed, so
  the spinner is replaced outright by `BackgroundRing`: a dashed ring
  turning once every 8 seconds. A 1s spinner claims a model is running and reads as
  a hang long before the two-hour monitoring agent it will eventually be
  sitting on. Alive, not busy.
- `working` + delegated `partial`: some of that work reported back and the
  rest runs on. An outlined blue dot, the done colour without the fill,
  because it is the same event as a done except that it is not over. It
  outranks done in the chain and rings nothing.
- `done`/`idle` + delegated: the turn ended and left a shell running. The
  badge is the ordinary blue bullet and the tooltip names the leftovers. An
  idle tab is the correct rendering here, and it is what the user was owed and
  not getting: before this, that turn's done was swallowed for the rest of the
  session (docs/agent-hooks.md "Delegated work").

Why not a fourth `workState`: `taskWorkState`, `waitingAgents`,
`cliAgentState` (whose `work_state` is a PUBLISHED CLI contract, and where
`waiting` already means attention), the sidebar, the tab bar and the dashboard
would all have to learn a member none of them has an opinion about. Only the
renderers, the notifier and the queue gate care.

There is a FOURTH rendering, and it is the one that makes the others worth
having: `idle` + delegated, the same dashed ring. A done on the tab you are looking
at is acknowledged straight to idle (`isUserWatching`), and idle draws no
badge at all, so without this the decoration is invisible in the common case
and a task with two subagents running looks exactly like an inert one. It is
last in every precedence chain: failed > attention > partial > done >
working > delegated > dirty, and `taskWorkBadge`'s rungs in the same order. Gated on
`settledHighlight`, not on `workingIndicator`: it is not a spinner and claims
nothing is being computed.

Both marks are SVG rings with a 2px stroke, and that is a DPI fix rather than
a style. The spinner used to be a CSS `border-radius` ring at `border-[1.5px]`,
which is exactly 3 device pixels at 2x and a HALF pixel at 1x: crisp on a
retina display, thin and smeared on anything else. 2px is whole-pixel at both.
The spinner also gained a faint full track under its arc, because hiding a
quarter of a ring by making one border transparent reads as a ring with a bite
out of it, where a track plus a brighter arc reads as one object with a
highlight going round it. `data-mark` says which mark is drawn, since the two
are no longer distinguishable by their CSS.

In the session bar the working mark is the ECG trace rather than the spinner,
and done and partial are green (`--sidebar-settled`) to match the sidebar;
see "Session bar".

Surfaces: the tab strip (`TabBar`), the expanded sidebar row's per-tab badge,
and the COLLAPSED sidebar row plus the dashboard through `taskWorkBadge`. The
collapsed row matters most: the tab strip only helps inside the task you are
already in, and a dev server left running is something you go looking for from
outside. All of them carry `data-delegated="<label>"` next to
`data-work-state`. A separate
attribute rather than a fifth state value, because it accompanies two of them
and a spec needs to tell those apart. Opacity rather than a colour swap, for
the reason in this file already: `transition-colors` never repaints a themed
colour in WKWebView.

## Settings: where a feature's row belongs

Agent hooks sits under **Agents & Terminals**, not Notifications, and the route
there is worth recording because the first answer was wrong.

The case for Notifications was real: the four settings there (desktop
notifications, completion sound, the done indicator, the in-progress spinner)
are all downstream of work-state detection, and hooks is where that detection
comes from. True, and beside the point. Notifications is where you choose
whether to be TOLD; hooks is how termic KNOWS, it writes into the agent's own
config, and it changes how that agent behaves.

The tell was the cross-reference. Placing it under Notifications required a
signpost on the Agents page pointing at it, which is usually evidence a thing
is in the wrong place: nobody looking for "how does termic know what claude is
doing" opens Notifications. The pointer now runs the other way, from the four
indicators to the thing that decides them, which is the direction that needs
explaining.

**Hooks and the terminal patterns are one setting, "Agent state", on each
agent's card.** They were two: the hooks table above the tabs, and a "Work-done
detection" group at the bottom of every card (a switch over four regex fields),
written before hooks existed. Hooks replace that detection at runtime (once
installed and proven on a pty nothing else may end a turn, agent-hooks.md
"Hooks own the turn"), and nothing on the page said so: a card with hooks
installed still showed four fields that looked live.

The section now leads with its SOURCE (`AgentHookSource.tsx`,
`hookSourceState`), and everything under it follows from that line:

| source | the card says | patterns |
| --- | --- | --- |
| `hooks` | reported by the agent, hooks replace terminal detection; Remove | folded, labelled "fallback, not in use" |
| `available` | guessed from the terminal, hooks recommended; Install, in amber | open, "in use" |
| `blocked` | the agent's own `disableAllHooks` stops them | open, "in use" |
| `terminal` | no hooks exist for this agent (cursor, a custom CLI, most agents on Windows) | open, "in use", and no warning colour: it has done nothing wrong |
| `absent` | the CLI is not on PATH | open |

Rules that came out of building it:

- **The switch is `work_done` and means "track this agent at all".** It gates
  the hook-reported state too (`workDoneCapable` is the single gate, and the
  queue and scheduled runs read it), so it sits above both sources rather than
  being one of them. Off, the source row and the patterns are not rendered.
- **A fallback is folded, not removed.** The patterns still apply before a
  tab's first hook arrives and when a hook cannot deliver (Docker transport),
  and the disclosure says exactly that when opened.
- **Antigravity gets a footnote.** It has no hook for a permission prompt, so
  "needs you" still comes off the screen; "hooks replace the terminal" would be
  false for it without the note.
- **The output-matching switch is not drawn until a pattern exists.** Disabled,
  it rendered as a grey dot with no track.
- **One colour for switches.** These two were `--color-ok` green among accent
  switches, which read as a different kind of control.

What is left above the tabs (`AgentHooksBlock.tsx`) is the fleet control: the
"Install hooks for every agent" switch, the coverage count, and, while any
wirable agent is still guessed at, a line naming them. That line is the
recommendation: amber when some agents are wired and others are not, ordinary
dim on an untouched install. Its names, and the rows behind the chevron, are
links that select the agent's tab and scroll to its Agent state section; they
carry no install button, so there is one place per agent to act. Both read
installed and supported from the store (`agentHooksInstalled`,
`agentHooksSupported`), the same read a live tab uses, so the block, the cards
and the terminals cannot disagree. The link out of Notifications does not gate
on which agents are supported; the cards are the authority on that.

## The multibuffer tab

Find in files (and its Open as Multibuffer button, or Alt-Enter) turns the
current matches into one `multibuffer` tab: each file gets a header (name and
path, click opens the file at that excerpt) followed by an editable excerpt of
the lines around each hit, three lines of context either side, with adjacent
hits merged.

- **It is its own tab type, not an `edit` tab.** There is no single `path`, so
  inline blame, review comments and the breadcrumb all stay off it. It is never
  persisted: the excerpts live in memory and a relaunch starts without it.
- **One CodeMirror view per excerpt, built lazily.** `MultibufferPane` leaves
  a placeholder sized from the line count and creates the view when an
  IntersectionObserver reports it within 600px of the viewport, so a
  500-match result does not build 500 views. Views are never torn down on
  scroll back, so undo history survives.
- **Line numbers are the real ones.** `lineNumbers` is given a `formatNumber`
  that adds the excerpt's start line, and the gutter compartment is
  reconfigured after a save because a write can change how many lines an
  earlier excerpt in the same file has.
- **Saving writes the whole file, once.** Mod-s re-reads each edited file,
  asks `saveTargets` (`src/lib/multibuffer.ts`) what to write, and sends it
  through `taskFileWrite`. A file whose excerpt no longer matches what is on
  disk is a conflict: it gets a toast and is not written. The dirty dot clears
  only when every write succeeded, so a conflict leaves the tab dirty and
  Mod-s retries what is left. A successful write rebases that file's excerpts
  (new start and end lines, new base text) and bumps `gitRevision`.
- **Closing a dirty multibuffer asks**, with the same prompt as a dirty editor
  tab (`lib/closeTab.ts`).
