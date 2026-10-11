// The session bar's glyphs, from the "Session Bar" design's SVG paths, in the
// sidebar's stroke language. currentColor throughout.

import { Glyph, type GlyphProps } from "@/components/sidebar/sidebarIcons";

const TRACE_PATH = "M1 12h8l4-9 6 18 5-12 4 6 3-3h20";

export function PlusGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M12 5v14M5 12h14" /></Glyph>;
}

export function CloseGlyph(props: GlyphProps) {
  return <Glyph strokeWidth={2.4} {...props}><path d="M6 6l12 12M18 6L6 18" /></Glyph>;
}

export function BroadcastGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M20 5v14L9 15H5a1 1 0 01-1-1v-4a1 1 0 011-1h4z" /><path d="M7.5 15l1.2 4.5h2.4L10.2 15.6" /></Glyph>;
}

export function SplitDownGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 12h16" /></Glyph>;
}

export function SplitRightGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M12 4v16" /></Glyph>;
}

/** The working agent's heart-monitor trace. The moving pulse is only drawn
 *  while `running`; the caller turns that off while the window is hidden. */
export function TabTrace({ running }: { running: boolean }) {
  return (
    <svg
      width={22}
      height={10}
      viewBox="0 0 52 24"
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
      data-testid="tab-trace"
      data-running={running || undefined}
      // The e2e suite reads the badge's mark and its animation off whichever
      // element carries data-mark, so it moves to the pulse while one runs.
      data-mark={running ? undefined : "trace"}
    >
      <path d={TRACE_PATH} opacity={0.22} className="sessionbar-trace-ghost" />
      {running && <path d={TRACE_PATH} strokeDasharray="12 36" className="sessionbar-trace-pulse" data-mark="trace" />}
    </svg>
  );
}
