# Claude subagents in the sidebar

**Status: idea, not approved.** No GitHub issue exists and none gets
opened until the maintainer approves it. This file is a description of
the feature as decided so far, plus the measurements it rests on. It is
not a build order.

When a claude task spawns subagents (the Agent tool, custom agents,
forks, and agents run by the Workflow tool), termic would add a sub-item
under that task's sidebar row for each one. Clicking a sub-item opens a
read-only tab that renders the subagent's transcript live, styled like
the Claude CLI. A subagent runs inside the parent claude process and has
no session or PTY of its own, so there is nothing to attach to. Steering
stays in the parent claude, and the view only reads.

Detection is hybrid. SubagentStart and SubagentStop hooks create and
close rows quickly over the existing OSC 777 transport, and the
transcript files on disk supply the content and catch what hooks miss.
Both sources are keyed on the tab's `sessionId`, never on the newest file
in a directory, because main-checkout tasks share their cwd with the
user's own claude sessions (see the comment above the transcript lookup
in `src-tauri/src/cli_server.rs`).

## Measured hook payloads

Measured against claude 2.1.296 on 2026-10-10. The field names below are
transcribed from live payloads, and no payload is pasted.

**SubagentStart** carries `session_id`, `transcript_path`, `cwd`,
`prompt_id`, `agent_id`, `agent_type` and `hook_event_name`. It carries
no path to the agent's own transcript. `transcript_path` is the parent
session's transcript.

**SubagentStop** carries the same fields plus `agent_transcript_path`,
`last_assistant_message`, `stop_hook_active`, `background_tasks`,
`permission_mode` and `effort`. It has no outcome or error field. A
subagent that failed and one that finished cleanly produce the same
SubagentStop shape, which is why done and failed are read from the
transcript (see ## States).

Both events fire for Agent-tool subagents and for agents run by the
Workflow tool. Workflow agents arrive with `agent_type` set to
`workflow-subagent`.

The live `agent_id` has no `agent-` prefix. It is the bare id, shaped
like `aXXXXXXXXXXXXXXXX`, while the file on disk is named
`agent-aXXXXXXXXXXXXXXXX.jsonl`. The upstream docs examples disagree with
each other on this, so the reader strips an optional leading `agent-`
anyway rather than trust either form.

**PreToolUse** on the `Agent` tool carries a `tool_use_id`, and that
value equals the `toolUseId` in the spawned agent's `.meta.json`
sidecar. That is the link from a parent tool call to the agent it
started. Tool calls made by a subagent already fire hooks in the parent
session, marked by `agent_id` and `agent_type` (`docs/agent-hooks.md`,
"Subagent tool calls fire hooks in the PARENT session").

None of these events is wired today. The claude hook table in
`src-tauri/src/agent_hooks.rs` registers SessionStart, UserPromptSubmit,
PreToolUse, PermissionRequest and Stop only.

## Transcript layout

Paths are relative to the projects dir of the config or account dir in
use (`~/.claude/projects` by default). `<slug>` is the task cwd with
every non-alphanumeric character replaced by `-`, as
`claude_project_dir_name` in `src-tauri/src/cli_server.rs` computes it.

```
<slug>/
  <sessionId>.jsonl                          parent transcript
  <sessionId>/
    subagents/agent-<id>.jsonl               one subagent's transcript
    subagents/agent-<id>.meta.json           its sidecar
    subagents/workflows/wf_<runid>/agent-<id>.jsonl
    subagents/workflows/wf_<runid>/agent-<id>.meta.json
    subagents/workflows/wf_<runid>/journal.jsonl
    workflows/wf_<runid>.json                run state and script
```

A workflow run's agents sit one level deeper than plain subagents, so a
watcher that only lists `subagents/*.jsonl` misses all of them. Some
`subagents/` dirs also hold an `agent-<id>.prefix.json`, which nothing
here needs.

The `.meta.json` keys seen so far are `agentType`, `description`,
`model`, `toolUseId`, `spawnDepth`, `parentAgentId`, `requestShape`,
`requestNonInteractive` and `workflowPhase`. Every one of them is
optional: older sidecars carry only `agentType` and `spawnDepth`, and
workflow agents have no `toolUseId` because the workflow, not claude,
spawned them. `parentAgentId` and `spawnDepth` give the nesting, and
`workflowPhase` names the phase a workflow agent belongs to.

None of these formats is documented upstream. The transcript JSONL, the
sidecar, the journal and the workflow state file can all change in any
claude release, so every reader parses them leniently: an unknown key is
ignored, a missing key is absent rather than an error, and a line that
does not parse is skipped without dropping the rest of the file.

## States

A subagent row is in one of six states.

- **running.** SubagentStart arrived, or a rebuild from disk found a
  transcript whose parent is still live and whose last entry is not an
  end.
- **done.** SubagentStop arrived and the transcript's last entry is an
  ordinary final assistant message.
- **failed.** SubagentStop arrived and the transcript's last entry is an
  error-shaped tool result or an API error.
- **interrupted.** The parent PTY exited while the agent was still
  running.
- **unknown.** A rebuild from disk found no end entry and cannot tell
  whether the agent is still going. If the parent PTY is not running,
  the row is interrupted instead.
- **expired.** The transcript file was deleted after the row existed.
  The row stays, but the view has nothing to show.

Hooks create and close rows. The transcript decides between done and
failed, because SubagentStop carries no outcome.

SubagentStop is not a done for the parent task. The parent's work state
still comes only from its own Stop, and subagent state never feeds task
attention, the bell, or any ring logic. Alerts for subagents are a
separate, opt-in phase (see ## Phases).

## Path trust

The hook payload is attacker-shaped input: it comes from whatever is
running in the PTY, including a container. So no path is ever read from
a hook payload, `transcript_path` and `agent_transcript_path` included.
Every path is derived on the host from three things termic already
holds: the project slug (`claude_project_dir_name` in
`src-tauri/src/cli_server.rs`), the config or account dir, and the tab's
`sessionId`.

`agent_id` must match a strict charset (ASCII letters, digits, `_` and
`-`, bounded length) after an optional leading `agent-` is stripped. An
id that fails the check drops the event.

Every read is canonicalised and must land under
`<slug>/<sessionId>/subagents/`. A symlink that resolves outside that
directory is refused, and so is any path that canonicalises elsewhere.

An event whose `session_id` differs from the tab's `sessionId` is
dropped. Nested `claude -p` runs write into the parent's tty
(`docs/agent-hooks.md`), so a session check is the only thing that keeps
their subagents off this tab.

Docker is a second realm (`docs/gotchas.md`, "Docker is a SECOND REALM").
The container writes transcripts into the mounted projects dir
(`/root/.claude/projects`), and the host reads the same files through
the host path. On macOS and Linux the container workdir equals the host
path, so the slug matches. On Windows the container sees a translated
path, the slug differs, and that translation is deferred.

## Phases

**Phase 1: subagent rows and the live view.**

- One row per subagent under its claude task, nested by spawn depth, up
  to claude's three levels, each level collapsible.
- Clicking a row opens a live, read-only transcript view in the preview
  slot (`openPreviewTab` in `src/store/app.ts`). The view renders
  assistant text, tool calls and results in the Claude TUI style.
- The view tails its file through a notify watcher that is refcounted
  per open view. Nothing watches a transcript nobody is looking at.
- Nothing is persisted. On relaunch, rows are rebuilt from disk, capped
  to the newest N.
- Rows follow the tab's current `sessionId`, so a `/clear` or resume
  moves the tab to the new session's subagents.
- Workflow agents are recorded but not rendered.
- A settings section: master toggle, per-type filters (built-in,
  custom, workflow, fork), retention and auto-collapse, and view
  options (thinking, tool inputs and outputs, truncation, auto-scroll).
- Host and Docker on macOS and Linux.

**Phase 2: workflow run nodes.** Each workflow run becomes one row,
collapsed by default, expanding to its phases and then its agents. Each
agent opens the same view as a plain subagent.

**Phase 3: alerts.** A running-subagent count on the parent row, and
finish and fail notifications wired into the attention notifier, off
unless the settings turn them on.

**Out of scope:** gemini and codex tasks. This is claude only.

Constraints every phase keeps:

- Subagent records live in their own zustand store and never on
  `TerminalTab`. A new tab field re-renders its sidebar row on every
  change, because the row comparator only skips the fields listed in
  `ROW_HIDDEN_TAB_FIELDS` (`src/store/sidebarTabs.ts`).
- Every setter bails on an unchanged value (`docs/performance.md` bear
  trap 8). Per-tab selectors return frozen empty constants.
- The header highlight (`activeTabIsTerminalChild` in
  `src/components/sidebar/Sidebar.tsx`) has to learn the new row type,
  or the task header and the subagent row both show selection.
- Rust emits go through `emit_to_window` to the owning window, not a
  broadcast. No `thread::sleep` poll loops (bear trap 9).
- Transcript text is untrusted. No raw HTML is rendered, ANSI escapes
  are stripped, and redacted thinking shows as a placeholder.
- A view opens on the last 500 entries, with a control to load earlier
  ones.
- Every fixture is synthetic, and e2e drives the feature through a new
  `scripts/fake-agent.sh` directive that writes a synthetic subagent
  transcript and the matching OSC bodies.

## Unmeasured

These are open. Nothing above depends on either answer.

- Whether a fork's JSONL holds a copy of the parent's history before
  the fork's own entries. The view renders from the tail either way, so
  this changes only how much scrollback a fork's view has.
- Whether the macOS host receives FSEvents for writes made inside a
  Docker container to the mounted projects dir. If it does not, the
  hook-triggered incremental read (SubagentStart, PreToolUse with an
  `agent_id`, SubagentStop) is the fallback that keeps a Docker view
  moving.
