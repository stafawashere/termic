// The claude `theme` setting per session, read once and again whenever the
// window regains focus (the user may have run /theme in the meantime).
// Never read on a PTY path: only a mounted subagent view asks for it.

import { useEffect, useSyncExternalStore } from "react";
import * as ipc from "@/lib/ipc";
import { asClaudeTheme, type ClaudeTheme } from "@/lib/claudePalette";

interface Source {
  taskId: string;
  sessionId: string;
}

const themes = new Map<string, ClaudeTheme>();
const sources = new Map<string, Source>();
const listeners = new Set<() => void>();
let focusWatchInstalled = false;

function keyOf(taskId: string, sessionId: string): string {
  return `${taskId}\u0000${sessionId}`;
}

async function refresh(key: string, source: Source): Promise<void> {
  let theme: ClaudeTheme;
  try {
    theme = asClaudeTheme(await ipc.subagentClaudeTheme(source.taskId, source.sessionId));
  } catch {
    theme = "dark";
  }

  if (themes.get(key) === theme) return;

  themes.set(key, theme);
  for (const listener of listeners) listener();
}

function installFocusWatch(): void {
  if (focusWatchInstalled) return;

  focusWatchInstalled = true;
  window.addEventListener("focus", () => {
    for (const [key, source] of sources) void refresh(key, source);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useClaudeTheme(taskId: string, sessionId: string): ClaudeTheme {
  const key = keyOf(taskId, sessionId);
  const theme = useSyncExternalStore(subscribe, () => themes.get(key) ?? "dark");

  useEffect(() => {
    installFocusWatch();
    if (sources.has(key)) return;

    const source = { taskId, sessionId };
    sources.set(key, source);
    void refresh(key, source);
  }, [key, taskId, sessionId]);

  return theme;
}
