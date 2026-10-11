// The footers' glyphs, from the "Footers" design's SVG paths, in the
// sidebar's stroke language (sidebarIcons.tsx). currentColor throughout.

import { Glyph, type GlyphProps } from "@/components/sidebar/sidebarIcons";

export function FooterMoonGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" /></Glyph>;
}

export function FooterSunGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </Glyph>
  );
}

export function FooterBugGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="8" y="7" width="8" height="13" rx="4" />
      <path d="M9.5 7a2.5 2.5 0 015 0M12 11v9M8 12H4M20 12h-4M8 16.5l-3.5 2M16 16.5l3.5 2M8 8.5L5 6.5M16 8.5l3-2" />
    </Glyph>
  );
}

export function FooterMailGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" /></Glyph>;
}

export function FooterKeyboardGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" /></Glyph>;
}

export function FooterPulseGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M3 12h4l3-7 4 14 3-7h4" /></Glyph>;
}

export function FooterGearGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </Glyph>
  );
}

export function FooterQueueGlyph(props: GlyphProps) {
  return <Glyph {...props}><path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H9l-5 4z" /><path d="M12 7v6M9 10h6" /></Glyph>;
}

export function FooterTerminalGlyph(props: GlyphProps) {
  return <Glyph {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></Glyph>;
}

export function FooterShieldOffGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3l8 3v5c0 2.3-.7 4.4-1.9 6.1M6.4 6.4L4 7v5c0 5 3.4 8.6 8 10 1.7-.5 3.2-1.3 4.4-2.4" />
      <path d="M3 3l18 18" />
    </Glyph>
  );
}

/** The sandbox shield. `filled` tints its body at 18% of the stroke colour,
 *  which is how the full cage is told apart from the filesystem-only one. */
export function FooterShieldGlyph({ filled, check = true, ...props }: GlyphProps & { filled: boolean; check?: boolean }) {
  const fill = filled ? "color-mix(in srgb, currentColor 18%, transparent)" : "none";

  return (
    <Glyph {...props}>
      <path d="M12 3l8 3v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z" fill={fill} />
      {check && <path d="M8.5 12l2.5 2.5 4.5-5" />}
    </Glyph>
  );
}