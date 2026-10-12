# PTY daemon: agents that outlive the app

Agent PTYs move out of the app into `termic-ptyd`, a long-lived process
the app talks to over a socket. Quitting the app (a `make install`
rebuild, an update, a crash) no longer kills running agents. The next
launch reattaches to them, replays the scrollback and streams live, and
the agent never notices the gap.

## Today

Every PTY is a child of the app. `RunEvent::Exit` calls
`cleanup_children` (lib.rs:26126), which runs `docker::cleanup_all()`
and SIGKILLs every `child_pid` in the `PtyManager`. `TerminalPane.tsx`
always spawns on mount (around 2872); there is no attach path. On
relaunch the conversation comes back through `--resume <id>`, but any
in-flight turn is lost.

## What a live agent depends on

| Service | Fix |
|---|---|
| Sandbox CONNECT proxy (proxy.rs:221, owned by `SandboxBundle`, sandbox.rs:53). Its port is baked into the seatbelt profile and `HTTPS_PROXY` | Moves into the daemon with the bundle and its deny counters. The app reads counters through a `stats` RPC |
| Sandbox `log stream` watcher (sandbox.rs:699) | Stays in the app, restarted on attach. Path denies during the gap are lost |
| CLI socket `termic.sock` (cli_server.rs:218) | Stays in the app on its stable path. `termic-cli` retries connect for ~10 s instead of failing |
| MCP server (mcp_server.rs:2049) | Stays in the app, already prefers its previous port. Verify the agent's MCP client reconnects |
| Hook OSC (`TERMIC_PTY` slave path) | Unix: nothing, the writes hit the tty the daemon holds. Windows: `hook_pipe.rs` moves into the daemon |
| Docker container removal (lib.rs:4511, 4543, 26131) | Moves into the daemon's waiter. App quit skips containers whose PTY the daemon owns |
| Schedules, delivery queue | Stay in the app and resume after reattach |
| Run/setup scripts, LSP, grep, AuxTerminal | Out of scope. Keep kill-on-quit |

## Daemon

- Same binary, `termic --ptyd <global_dir>`, so no second signed sidecar.
- Socket at `global_dir()/ptyd.sock` (lib.rs:1012), so `termic` and
  `termic_dev` and every `TERMIC_DATA_DIR` get their own daemon. Windows:
  `\\.\pipe\termic-ptyd-<hash(global_dir)>`.
- Protocol: length-prefixed frames, JSON control, raw binary output
  frames (no JSON-escaped bytes at firehose rates). One multiplexed
  connection. Requests: `hello{proto, build}`, `spawn{SpawnSpec}`,
  `write`, `resize`, `kill`, `list`, `subscribe{id}` (ring snapshot then
  live), `unsubscribe`, `stats`. Events: `out{id, bytes}`,
  `exit{id, code}`. The app still builds argv, env and cwd; `SpawnSpec`
  carries the finished result plus sandbox config.
- Versioning: its own `PTYD_PROTO`, separate from termic-proto's
  `PROTOCOL_VERSION`. Messages are additive only. A newer app that
  cannot speak to an old daemon leaves it running until its PTYs exit
  and starts a second one on `ptyd-v<N>.sock`.
- Lifecycle: the app connects at startup and, on failure, spawns the
  daemon with `setsid` and detached stdio, then blocks on the socket.
  The daemon exits once it has had zero PTYs and zero clients for a
  grace period, armed as a single timer.
- Perf: the condvar flusher and 8 ms coalescing move into the daemon.
  With no subscriber it only appends to the ring, so a quiet PTY costs
  zero wakeups (bear trap 9). The app forwarder blocks on a socket read
  and calls `emit_to_window`.

## Frontend

On mount, before `decideResume`, ask the daemon whether the tab's PTY
is alive. If it is, attach: listen on `pty://id` and `pty-exit://id`,
call `pty_attach(id, windowLabel, cols, rows)`, write the ring snapshot
into xterm, resize, and send `pty_attached`. Do not stamp
`firstOutputAt` or arm the resume-failure tail. The replay re-emits OSC
titles and hook sequences, so a `replaying` flag suppresses attention
and notifications until the snapshot is written. The unmount kill
stays for an explicit tab close.

## Phases

1. Extract the PTY core behind a `Sink` trait, no behaviour change.
   Update the source guard at lib.rs:27240; unit test chunk-then-exit
   ordering.
2. Daemon binary and protocol. Cargo tests: framing round-trip;
   spawn, subscribe, ring, exit; disconnect, write, resubscribe gets
   ring plus live; idle PTY emits nothing; idle exit; handshake
   mismatch.
3. App uses the daemon behind a setting. `pty_*` commands become RPCs;
   `cleanup_children` skips daemon PTYs. Vitest the spawn/attach
   decision as a pure function next to `decideResume`.
4. Proxy, sandbox bundle and Docker cleanup move into the daemon.
   Cargo test that a sandboxed PTY's proxy survives a client
   disconnect.
5. Frontend attach and replay guard. Vitest that replay stamps no
   attention. E2E: a task runs a `date` loop, the app quits and
   relaunches on the same `TERMIC_DATA_DIR`, the pane shows output from
   both sides of the gap and the pid is unchanged.
6. Windows and Linux. `make install` kills by exe path
   (Makefile:349) and must spare the daemon, and NSIS cannot overwrite
   a running exe, so the daemon runs from a copy. An AppImage mount
   disappears on exit, so the daemon spawns from the extracted path.

## Open questions

- Output written during the gap past the 256 KiB ring is dropped.
  Grow the ring for daemon PTYs?
- Does the quit prompt offer "keep agents running" and "stop agents"?
- Does Touch ID sudo stay in the app?
- CLI attach sessions (cli_server.rs:325) need rerouting through
  `subscribe`.
- A SIGKILLed daemon orphans Docker containers until the next app
  start's `cleanup_all`.
