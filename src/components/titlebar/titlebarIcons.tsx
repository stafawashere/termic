// The title bar's glyphs, from the "Focus title" design's SVG paths, in the
// sidebar's stroke language (sidebarIcons.tsx). currentColor throughout.

import { Glyph, type GlyphProps } from "@/components/sidebar/sidebarIcons";

export function SidebarLeftGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14" /></Glyph>;
}

export function SidebarRightGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M15 5v14" /></Glyph>;
}

export function PeopleGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
      <path d="M16 5.2a3 3 0 010 5.6" />
      <path d="M17.5 14.3c2.2.6 3.5 2.2 3.5 4.7" />
    </Glyph>
  );
}

export function WrenchGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M14.5 6.5a4 4 0 00-5.2 5.2L3 18l3 3 6.3-6.3a4 4 0 005.2-5.2L14.7 12l-2.7-2.7z" /></Glyph>;
}

export function StopGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="6" y="6" width="12" height="12" rx="2" /></Glyph>;
}

export function PlayGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M7 5l12 7-12 7z" /></Glyph>;
}

export function ChevronDownGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M6 9l6 6 6-6" /></Glyph>;
}

export function PromptsGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 13h7M7 16h4" /></Glyph>;
}

export function TerminalGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></Glyph>;
}

export function PaletteGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 10l3 2-3 2" /></Glyph>;
}

export function ArchiveGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v9a2 2 0 002 2h10a2 2 0 002-2V9M10 13h4" /></Glyph>;
}

export function FolderOpenGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v1H6.5a2 2 0 00-1.9 1.4L3 17z" />
      <path d="M3 17l1.6-5.6A2 2 0 016.5 10H22l-2.4 7.6A2 2 0 0117.7 19H3z" />
    </Glyph>
  );
}

export function SendUpGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M5 4h14M12 20V9M7.5 13.5L12 9l4.5 4.5" /></Glyph>;
}

export function TitleBranchGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" />
      <path d="M6 7.2v9.6M18 10.2c0 3.5-3 4.2-6 4.8-2.5.5-4.5 1.2-5.5 2.8" />
    </Glyph>
  );
}
