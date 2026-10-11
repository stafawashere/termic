// The refined tree's own glyphs, drawn from the design's SVG paths so the
// sidebar keeps one stroke language (24-unit box, 1.8 stroke, round caps).
// Everything paints in currentColor; the caller sets the colour.

import type { SVGProps } from "react";

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number; strokeWidth?: number };

function Glyph({ size = 16, strokeWidth = 1.8, children, ...rest }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

const FOLDER_PATH = "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z";

export function FolderGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d={FOLDER_PATH} /></Glyph>;
}

/** A group folder: stroke in the group colour, filled with it at 13%. */
export function TintedFolderGlyph({ color, ...props }: GlyphProps & { color: string }) {
  const fill = `color-mix(in srgb, ${color} 13%, transparent)`;

  return (
    <Glyph {...props} style={{ color, ...props.style }}>
      <path d={FOLDER_PATH} fill={fill} />
    </Glyph>
  );
}

export function DashedFolderGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d={FOLDER_PATH} strokeDasharray="2.5 2" /></Glyph>;
}

export function FolderPlusGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d={FOLDER_PATH} /><path d="M12 10v6M9 13h6" /></Glyph>;
}

export function HistoryGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M3 12a9 9 0 103-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></Glyph>;
}

export function KanbanGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></Glyph>;
}

export function ScheduleGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M21 7.5V6a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h3.5" />
      <path d="M16 2v4M8 2v4M3 10h5" />
      <circle cx="16" cy="16" r="6" />
      <path d="M16 14v2l1 1" />
    </Glyph>
  );
}

export function PulseGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M2 12h4l3-8 4 16 3-8h6" /></Glyph>;
}

export function SearchGlyph(props: GlyphProps) {
  return <Glyph strokeWidth={2} {...props}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Glyph>;
}

export function SwapGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M7 16V4M7 4L3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4" /></Glyph>;
}

export function ExpandAllGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M7 9l5-5 5 5M7 15l5 5 5-5" /></Glyph>;
}

export function CollapseAllGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M8 5l4 4 4-4M8 19l4-4 4 4" /></Glyph>;
}

export function ListOptionsGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M4 6h16M4 12h16M4 18h10" /><circle cx="18" cy="18" r="2" /></Glyph>;
}

/** `slashed`: struck through, the way lucide draws its own -off icons. */
export function FilterLinesGlyph({ slashed = false, ...props }: GlyphProps & { slashed?: boolean }) {
  return (
    <Glyph strokeWidth={2} {...props}>
      <path d="M4 6h16M7 12h10M10 18h4" />
      {slashed && <path d="m2 2 20 20" />}
    </Glyph>
  );
}

export function PlusGlyph(props: GlyphProps) {
  return <Glyph strokeWidth={2} {...props}><path d="M12 5v14M5 12h14" /></Glyph>;
}

export function DotsHorizontalGlyph({ size = 13, ...props }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false" {...props}>
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
  );
}

export function DotsVerticalGlyph({ size = 13, ...props }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false" {...props}>
      <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
    </svg>
  );
}

/** The tree's chevron: 10px, heavy stroke, rotated 90 degrees when open. */
export function TreeChevron({ open, size = 10, className, ...props }: GlyphProps & { open: boolean }) {
  return (
    <Glyph
      size={size}
      strokeWidth={2.6}
      className={className}
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms" }}
      data-open={open || undefined}
      {...props}
    >
      <path d="M9 6l6 6-6 6" />
    </Glyph>
  );
}

/** Three lines, the first two checked, the last a dot. */
export function ChecklistGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M3.5 6l1.2 1.2L7 4.8" />
      <path d="M3.5 12l1.2 1.2L7 10.8" />
      <circle cx="4.8" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function LinkGlyph(props: GlyphProps) {
  return <Glyph strokeWidth={2} {...props}><path d="M9 17H7a5 5 0 010-10h2M15 7h2a5 5 0 010 10h-2M8 12h8" /></Glyph>;
}

export function BranchGlyph(props: GlyphProps) {
  return (
    <Glyph strokeWidth={2} {...props}>
      <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 3-3 4-6 4.5-3 .5-6 1.5-6 3" />
    </Glyph>
  );
}

export function PullRequestGlyph(props: GlyphProps) {
  return (
    <Glyph strokeWidth={2} {...props}>
      <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V9a3 3 0 00-3-3h-2" /><path d="M15 4l-2 2 2 2" />
    </Glyph>
  );
}

export function MoonGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M21 13A9 9 0 1111 3a7 7 0 0010 10z" /></Glyph>;
}

export function MailGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></Glyph>;
}

export function KeyboardGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></Glyph>;
}

export function GearGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </Glyph>
  );
}

export function BugGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="8" y="6" width="8" height="14" rx="4" />
      <path d="M9.5 6.5L8 4M14.5 6.5L16 4M3 13h5M16 13h5M4 8l4 2M20 8l-4 2M4 19l4-2M20 19l-4-2M12 10v10" />
    </Glyph>
  );
}

/** The claude critter, filled in the caller's colour, eyes cut out in the
 *  panel's well colour. */
export function CritterGlyph({ size = 16, ...props }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false" {...props}>
      <rect x="6" y="7" width="12" height="10" rx="3" />
      <path d="M4 10h2v4H4zM18 10h2v4h-2zM7 5l2 2M17 5l-2 2M8 17l-1 3M16 17l1 3M11 17v3M13 17v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="10" cy="12" r="1.2" fill="var(--sidebar-well-bg)" />
      <circle cx="14" cy="12" r="1.2" fill="var(--sidebar-well-bg)" />
    </svg>
  );
}
