import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Tracks macOS native full-screen state. In full-screen the traffic lights are
// hidden, so chrome that reserves space for them — the UnifiedBar's 84px left
// inset, the Settings modal's top inset — can reclaim it.
//
// macOS fires resize events *during* the full-screen zoom animation, before the
// window's style mask actually flips, so an early resize-triggered read returns
// a stale value. We re-read once more after a short settle delay to catch the
// final state.
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let timers: ReturnType<typeof setTimeout>[] = [];

    const read = () => { win.isFullscreen().then(setIsFullscreen).catch(() => {}); };
    const onResize = () => {
      read();
      timers.forEach(clearTimeout);
      // The exit animation can outlast 350ms, so a single settle read can
      // still see full-screen and leave the lights drawn over the controls.
      timers = [setTimeout(read, 350), setTimeout(read, 1000)];
    };

    read();
    win.onResized(onResize).then(u => { unlisten = u; });
    return () => { unlisten?.(); timers.forEach(clearTimeout); };
  }, []);

  return isFullscreen;
}
