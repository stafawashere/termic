# Subagents

When `claude` hands work to a subagent (Explore, Plan, a custom agent, a fork
or a workflow run), upstream Termic shows nothing until the parent tab gets the
answer back. Termic+ gives each subagent its own row in the sidebar, nested
under the tab that started it, and a click on the row opens what that subagent
is doing as it happens.

This works for `claude` tabs only, in host and Docker tasks, on macOS and
Linux.

## Try it

1. Open a task and start a `claude` tab.
2. Ask for something that fans out, for example: "Use two Explore subagents,
   one to list the tests and one to list the docs."
3. Two rows appear under the tab in the sidebar. A row shows the subagent's
   kind and description and whether it is running, done, failed or was
   interrupted.
4. Click a row. Its transcript opens as a read-only tab, drawn in the colors
   of your `claude` theme, and it keeps updating while the subagent works.
5. Press `Ctrl+O` inside the transcript to switch between the one-line
   summary of each tool call and the full call with its output, the same key
   `claude` uses.

A workflow run shows as one folded row. Expand it to see the agents it
started. A tab's rows fold together once they have all finished if you set
that in the settings below, and you can fold or unfold them by hand.

Subagent rows never change the parent tab's state. A parent waiting on
subagents still reads as waiting on them, not finished, and a subagent
finishing does not ring the bell.

## Settings

Settings > Tasks > Claude subagents:

**Show Claude subagents** turns the whole feature on or off, and off means no
transcript is read or watched at all. **Kinds of subagent** picks which kinds
get rows (built-in agents, custom agents, forks and workflow agents). **Keep
finished rows** sets how long a row stays after it ends, from "Hide when
finished" to "Until the session changes", and **Collapse a tab's subagents**
chooses whether rows start folded.

**Transcript view** sets the defaults for new transcript tabs: verbose,
  thinking, tool inputs, tool outputs, how many lines of tool output to show
before cutting, and whether to follow new entries. The bar at the bottom of a
transcript overrides these for that one agent.

## What to expect

- Nothing about a subagent is saved by Termic+. After a relaunch, a resume or
  a session change, the rows are rebuilt from the transcripts `claude` keeps
  on disk.
- The transcript format belongs to `claude` and is not documented. If a new
  `claude` release changes it, a row can show as unknown or unreadable until
  Termic+ catches up.
- Docker tasks depend on the container's file sharing reporting changes. It
  was measured on Docker Desktop for macOS. On other setups the view may only
  refresh when `claude` reports a subagent starting or stopping.
