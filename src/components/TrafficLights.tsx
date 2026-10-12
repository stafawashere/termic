// The macOS window buttons, drawn by the app. The system's own are hidden
// (hide_native_traffic_lights in lib.rs) because they never follow the page
// zoom, so at any Cmd +/- level other than 100% they drifted off the bar's
// centre. These live in the bar, so they scale and centre with it.
//
// Green toggles full-screen, as it does in a native window. Renders nothing
// off macOS and in full-screen, where the system hides its own too.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Minus, Plus, X } from "lucide-react";
import { IS_MAC } from "@/lib/platform";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";

type Kind = "close" | "minimize" | "zoom";

const FILL: Record<Kind, string> = {
  close: "var(--color-traffic-close)",
  minimize: "var(--color-traffic-minimize)",
  zoom: "var(--color-traffic-zoom)",
};

export function TrafficLights() {
  const { t } = useTranslation("common");
  const isFullscreen = useIsFullscreen();

  const isHidden = !IS_MAC || isFullscreen;
  if (isHidden) return null;

  const win = getCurrentWindow();

  const button = (kind: Kind, label: string, Glyph: typeof X, onClick: () => void) => (
    <button
      type="button"
      data-no-drag
      data-testid={`traffic-${kind}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-3 w-3 items-center justify-center rounded-full text-[var(--color-traffic-ink)] outline-none"
      style={{ background: FILL[kind], boxShadow: "inset 0 0 0 0.5px rgba(0, 0, 0, 0.25)" }}
    >
      <Glyph size={8} strokeWidth={3} className="opacity-0 group-hover/traffic:opacity-100" aria-hidden />
    </button>
  );

  return (
    <div data-testid="traffic-lights" className="group/traffic mr-4 flex shrink-0 items-center gap-2">
      {button("close", t("close"), X, () => { win.close().catch(() => {}); })}
      {button("minimize", t("minimize"), Minus, () => { win.minimize().catch(() => {}); })}
      {button("zoom", t("fullscreen"), Plus, () => { win.setFullscreen(true).catch(() => {}); })}
    </div>
  );
}
