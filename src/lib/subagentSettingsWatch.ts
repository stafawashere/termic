// The Settings master toggle for Claude subagents, applied live.
//
// Off: the gate closes first, so a hook report or a scan already in flight is
// dropped, then every record goes and every open transcript view lets go of
// its watch, keeping what it had read on screen. On: the gate opens and every
// claude tab is rebuilt from its transcripts on disk, the same scan a launch
// runs, so no row needs a restart to come back.

import { setSubagentsEnabledGate } from "@/lib/subagentGate";
import { runLaunchRebuild } from "@/lib/subagentRebuild";
import { usePrefs } from "@/store/prefs";
import { useSubagents } from "@/store/subagents";
import { releaseAllSubagentSessions } from "@/store/subagentPreview";

let installed: (() => void) | null = null;

export function installSubagentsEnabledWatch(): () => void {
  if (installed) return installed;

  setSubagentsEnabledGate(usePrefs.getState().subagentsEnabled);

  const unsub = usePrefs.subscribe((state, prev) => {
    if (state.subagentsEnabled === prev.subagentsEnabled) return;

    setSubagentsEnabledGate(state.subagentsEnabled);
    if (!state.subagentsEnabled) {
      useSubagents.getState().clear();
      releaseAllSubagentSessions();
      return;
    }
    void runLaunchRebuild();
  });

  installed = () => { unsub(); installed = null; };
  return installed;
}
