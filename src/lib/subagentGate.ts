// Whether the Claude subagent feature is switched on (Settings > Tasks >
// Claude subagents), as the code that does the work reads it.
//
// A plain flag rather than a read of usePrefs, because the subagent store, the
// rebuild and the transcript sessions are imported where the prefs store
// cannot be (it touches the document as it loads). `subagentSettingsWatch.ts`
// keeps this in step with the pref.

let enabled = true;

export function subagentsEnabled(): boolean {
  return enabled;
}

export function setSubagentsEnabledGate(value: boolean): void {
  enabled = value;
}
