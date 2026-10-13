# Keep agents running

In upstream Termic, quitting the app stops every agent, and the next launch
starts each one again, usually by resuming its conversation. With **Keep
agents running** on, Termic+ starts agents in a small background process
instead. Quitting, updating or a crash leaves them running, and the next
launch reconnects each tab to its agent with the output it printed while the
app was closed.

The setting is off until you turn it on.

## Turn it on

1. Open Settings > Tasks.
2. Turn on **Keep agents running when Termic quits**.
3. Start a new agent tab. Only agents started after you turn the setting on
   run in the background process.

## Try it

1. With the setting on, start a `claude` tab in a task and give it a job that
   takes a few minutes.
2. Quit Termic+ with `Cmd+Q` while it works.
3. Wait a minute or two, then open Termic+ again and go to the same task.
4. The tab shows what the agent printed while the app was closed, then
   continues live. The agent was never restarted, so there is no resume and
   the conversation is exactly where it was.

If the agent finished and exited while Termic+ was closed, the tab starts a
fresh agent the usual way.

## Which tabs it covers

Only agent tabs in tasks that are neither sandboxed nor in Docker. Shell tabs,
the bottom terminal, setup, run and archive scripts, and any agent in a
sandboxed or Docker task still stop when the app quits, exactly as upstream.

## Things to know

- Only the last 4 MiB of each agent's output is replayed on reconnect.
- The background process exits on its own 30 seconds after its last agent
  exits, as long as no app is connected to it. While any agent is alive it
  stays up, even with Termic+ closed for days.
- Turning the setting off does not stop agents already in the background
  process. Close their tabs first, or quit them from inside the agent, before
  you turn it off. Otherwise a new tab starts a second agent beside the old
  one.
- After an update, agents already running keep running on the old build until
  they exit.
- If the app loses its connection to the background process, the tabs show
  the agents as exited even though they are still running. Opening such a tab
  again starts a second agent. Quitting and relaunching the app should
  reconnect the tabs to the agents still running.
- Only your own user can connect.
- The background process is not supported on Windows or in the Linux
  AppImage yet, so leave the setting off there.
