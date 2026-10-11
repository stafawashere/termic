# Claude subagents in the sidebar

**Status: idea, not approved.** Phase 1 is built; phases 2 and 3 below
are not, and no GitHub issue exists for them. None gets opened until the
maintainer approves the rest. This file keeps the open design for those
phases plus the measurements the whole feature rests on.

## Shipped in phase 1

A claude task now shows one sidebar row per subagent under the tab that
spawned it, nested by spawn depth, badged running, done, failed,
interrupted, unknown or expired, and never touching the parent tab's work
state, attention or bell. Clicking a row opens a live, read-only,
Claude-styled transcript view in the task's preview slot. Rows come from
claude's `SubagentStart` / `SubagentStop` hooks (`SCHEMA_VERSION` 16) and
from the transcripts on disk, which also rebuild them after a relaunch, a
resume or a session change; nothing is persisted. A refcounted notify
watcher tails only the transcripts a view has open, and Settings > Tasks
has a "Claude subagents" block (master toggle, type filters, retention,
auto-collapse, view options). Host and Docker are covered on macOS and
Linux; workflow agents are recorded but get no row. Where each part is
documented: the hook bodies and their rejection rules in
[docs/agent-hooks.md](../agent-hooks.md) "Subagent reports", the rows, the
view and the settings in [docs/ui.md](../ui.md) "Subagent rows in the
sidebar", the separate store and the watcher's cost in
[docs/performance.md](../performance.md), the path, session and watch traps
in [docs/gotchas.md](../gotchas.md), and the commands and events in
[docs/ipc.md](../ipc.md).

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
transcript (docs/ui.md, "Subagent rows in the sidebar").

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

Phase 1 reads only `session_id`, `agent_id` and `agent_type` (see
docs/agent-hooks.md). Nothing uses the `tool_use_id` link yet, and
`workflowPhase` is read into the summary but drawn nowhere until phase 2.

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

## Open design: phases 2 and 3

**Phase 2: workflow run nodes.** Each workflow run becomes one row,
collapsed by default, expanding to its phases (`workflowPhase` in the
sidecar) and then its agents. Each agent opens the same view as a plain
subagent. Phase 1 already keeps workflow agents in the store
(`isWorkflow`) and leaves them off the row selector, the workflow type
filter in Settings is drawn disabled until this exists, and
`subagent_list` already lists `subagents/workflows/wf_<runid>/`. Not yet
decided: whether the run node reads `workflows/wf_<runid>.json` or the
run's `journal.jsonl` for its phase list, and what the node shows while
a run has started no agent yet.

**Phase 3: alerts.** A running-subagent count on the parent row, and
finish and fail notifications wired into the attention notifier, off
unless the settings turn them on. This is the one place subagent state
would reach attention, so it has to stay opt-in and must not change the
rule that a SubagentStop is never a done for the parent task.

**Out of scope:** gemini and codex tasks. This is claude only. Windows
Docker path translation is deferred: the container sees a translated
path there, so the slug differs from the host's.

Constraints phases 2 and 3 keep from phase 1:

- Subagent records stay in `useSubagents`, never on `TerminalTab`, and
  every setter bails on an unchanged value (docs/performance.md, "A store
  setter that writes an UNCHANGED value is an idle CPU leak").
- A new row type has to teach `childRowCarriesSelection`
  (`src/components/sidebar/subagentTree.ts`) about itself, or the task
  header and the row both draw the selection.
- Rust emits go through `emit_to_window` to the owning window, and nothing
  polls with `thread::sleep` (docs/performance.md, "PTY firehose").
- No path is read from a hook payload, and every read stays confined to
  the session's `subagents/` directory.
- Every fixture is synthetic and driven through `scripts/fake-agent.sh`.

## Docker and file events

Measured 2026-10-10 on macOS with Docker Desktop 4.89.0 (engine 29.7.2,
linuxkit kernel 7.0.12). The bind mount is VirtioFS: `mount` inside the
container reports `virtiofs2 on /root/.claude/projects type virtiofs`.

Method: a host directory bind-mounted at `/root/.claude/projects` with a
plain `-v host:container`, the way `docker::build_spec` mounts the
projects dir. On the host, a notify 8 `RecommendedWatcher` (FSEvents)
watched that directory non-recursively. Inside an `alpine:3` container,
three `echo >>` appends to an existing `agent-*.jsonl` one second apart,
then a new file, then an `rm`.

Result: yes. Every append reached the host as an event batch
(`Create(File)`, `Modify(Metadata(Extended))`, `Modify(Data(Content))`
for the file), within the same wall-clock second as the write (the
container's busybox `date` has one-second resolution, so the latency is
under a second and not measured more finely). The new file and the
`rm` arrived the same way, the `rm` as `Remove(File)`.

So Docker tasks open their watches live, the same as host tasks. FSEvents
reports every append as a `Create`, which is harmless because the tail
reads to EOF on any event rather than interpreting its kind. The hook
poke still ships: it is the final flush on SubagentStop, and it is what
keeps a view moving on a host whose watch could not be added.

Not measured: gRPC-FUSE and osxfs (Docker Desktop's older file-sharing
modes), OrbStack and colima. Linux bind mounts share the host kernel, so
inotify sees container writes there by construction, but that was not
run either.

## Unmeasured

This is open. Nothing above depends on the answer.

- Whether a fork's JSONL holds a copy of the parent's history before
  the fork's own entries. The view renders from the tail either way, so
  this changes only how much scrollback a fork's view has.
