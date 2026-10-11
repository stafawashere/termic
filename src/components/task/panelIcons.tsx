// Glyphs the right panel adds to the refined tree's set, drawn from the
// right panel design (24-unit box, round caps). They paint in currentColor
// like the rest of the set.

import { Glyph, type GlyphProps } from "@/components/sidebar/sidebarIcons";

const CLOSED_FOLDER = "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z";

export function FilePlusGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5M12 12v6M9 15h6" />
    </Glyph>
  );
}

export function NewFolderGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d={CLOSED_FOLDER} /><path d="M12 10v6M9 13h6" /></Glyph>;
}

export function CollapseInGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M7 4l5 5 5-5M7 20l5-5 5 5" /></Glyph>;
}

export function RefreshGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M20 11a8 8 0 00-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0014.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </Glyph>
  );
}

export function PinGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" /></Glyph>;
}

export function MagnifierGlyph(props: GlyphProps) {
  return <Glyph strokeWidth={2} {...props}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.3-4.3" /></Glyph>;
}

/** All files: a page in front of another. */
export function FilesGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M9 3h6l4 4v10a2 2 0 01-2 2H9a2 2 0 01-2-2V5a2 2 0 012-2z" />
      <path d="M15 3v4h4" />
      <path d="M4 8v11a2 2 0 002 2h8" />
    </Glyph>
  );
}

/** Scratchpad: a note with a folded corner. */
export function NoteGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M5 4h14a1 1 0 011 1v9l-6 6H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
      <path d="M14 20v-5a1 1 0 011-1h5" />
      <path d="M8 9h8M8 13h4" />
    </Glyph>
  );
}

/** The return key, for the hint at the end of an inline name field. */
export function ReturnKeyGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M19 5v7a2 2 0 01-2 2H6" /><path d="M10 10l-4 4 4 4" /></Glyph>;
}

/** A triangle with a bang: a read that failed. */
export function AlertGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M10.3 4.2L2.9 17a2 2 0 001.7 3h14.8a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" />
      <path d="M12 9.5v4M12 17h.01" />
    </Glyph>
  );
}

/** An open folder with nothing in it, for the tree's empty state. */
export function EmptyFolderGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <path d="M9 13h6" strokeDasharray="2 2.5" />
    </Glyph>
  );
}
