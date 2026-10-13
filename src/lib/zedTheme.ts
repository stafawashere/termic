// Zed theme import: turns a Zed theme family file into editor syntax themes.
// Pure logic (no store, no IPC). The converted themes are plain data, so
// they can sit in prefs and survive a reload; the CodeMirror extension is
// built from that data at resolve time (`zedThemeExtension`). The mapping is
// lossy on purpose, see docs/themes.md.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import { tags as t, type Tag } from "@lezer/highlight";

export const ZED_MAX_INPUT_BYTES = 512 * 1024;
export const ZED_MAX_THEMES = 64;
const MAX_NAME_LENGTH = 80;
const MAX_CAPTURES = 256;
const MAX_CAPTURE_NAME_LENGTH = 64;

export type ZedAppearance = "dark" | "light";

export interface ZedSyntaxStyle {
  color?: string;
  italic?: true;
  weight?: number;
}

export interface ZedUiColors {
  background?: string;
  foreground?: string;
  gutterBackground?: string;
  lineNumber?: string;
  activeLine?: string;
  selection?: string;
  cursor?: string;
}

/** What gets stored in prefs. Every color is already validated. */
export interface ZedEditorTheme {
  /** `zed:<name>`, namespaced like `custom:` so it never shadows a built-in. */
  id: `zed:${string}`;
  name: string;
  appearance: ZedAppearance;
  ui: ZedUiColors;
  syntax: Record<string, ZedSyntaxStyle>;
}

export type ZedImportErrorCode = "too-large" | "invalid-json" | "no-themes";

export class ZedImportError extends Error {
  code: ZedImportErrorCode;

  constructor(code: ZedImportErrorCode) {
    super(code);
    this.code = code;
  }
}

const ZED_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Lowercased #rrggbb or #rrggbbaa, or null when the value is anything else. */
export function normalizeZedColor(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const isAccepted = ZED_COLOR_RE.test(trimmed);
  if (!isAccepted) return null;

  const lower = trimmed.toLowerCase();
  const isShort = lower.length === 4;
  if (!isShort) return lower;

  const [, red, green, blue] = lower;
  return `#${red}${red}${green}${green}${blue}${blue}`;
}

/** Zed capture name to the lezer tags it colors. Captures missing here fall
 *  back by dropping dotted suffixes (see `tagsForCapture`). */
const CAPTURE_TAGS: Record<string, Tag[]> = {
  attribute: [t.attributeName],
  boolean: [t.bool],
  comment: [t.comment],
  "comment.doc": [t.docString],
  constant: [t.constant(t.variableName), t.atom],
  constructor: [t.className],
  emphasis: [t.emphasis],
  "emphasis.strong": [t.strong],
  enum: [t.className],
  function: [t.function(t.variableName), t.function(t.propertyName)],
  keyword: [t.keyword],
  label: [t.labelName],
  link_text: [t.link],
  link_uri: [t.url],
  namespace: [t.namespace],
  number: [t.number],
  operator: [t.operator],
  preproc: [t.processingInstruction, t.meta],
  property: [t.propertyName],
  punctuation: [t.punctuation],
  "punctuation.bracket": [t.bracket],
  "punctuation.delimiter": [t.separator],
  string: [t.string],
  "string.escape": [t.escape],
  "string.regex": [t.regexp],
  "string.special": [t.special(t.string)],
  tag: [t.tagName],
  "text.literal": [t.monospace],
  title: [t.heading],
  type: [t.typeName],
  variable: [t.variableName],
  "variable.special": [t.special(t.variableName)],
};

/** Tags for a capture: the exact entry, else the nearest dotted ancestor
 *  (keyword.control -> keyword), else none, which leaves the editor
 *  foreground in place. Never throws. */
export function tagsForCapture(capture: string): Tag[] {
  let candidate = capture;

  while (candidate.length > 0) {
    const hasEntry = Object.prototype.hasOwnProperty.call(CAPTURE_TAGS, candidate);
    if (hasEntry) return CAPTURE_TAGS[candidate];

    const lastDot = candidate.lastIndexOf(".");
    const hasParent = lastDot > 0;
    if (!hasParent) return [];

    candidate = candidate.slice(0, lastDot);
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const isRecord = typeof value === "object" && value !== null && !Array.isArray(value);
  return isRecord ? (value as Record<string, unknown>) : null;
}

function readColor(source: Record<string, unknown>, key: string): string | undefined {
  return normalizeZedColor(source[key]) ?? undefined;
}

function readUi(style: Record<string, unknown>): ZedUiColors {
  const players = Array.isArray(style.players) ? style.players : [];
  const firstPlayer = asRecord(players[0]) ?? {};

  const ui: ZedUiColors = {
    background: readColor(style, "editor.background"),
    foreground: readColor(style, "editor.foreground"),
    gutterBackground: readColor(style, "editor.gutter.background"),
    lineNumber: readColor(style, "editor.line_number"),
    activeLine: readColor(style, "editor.active_line.background"),
    selection: readColor(firstPlayer, "selection") ?? readColor(style, "element.selection_background"),
    cursor: readColor(firstPlayer, "cursor"),
  };

  return stripUndefined(ui);
}

function stripUndefined<T extends object>(value: T): T {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries) as T;
}

function readSyntaxStyle(raw: unknown): ZedSyntaxStyle | null {
  const record = asRecord(raw);
  if (!record) return null;

  const style: ZedSyntaxStyle = {};

  const color = normalizeZedColor(record.color);
  if (color) style.color = color;

  const isItalic = record.font_style === "italic" || record.font_style === "oblique";
  if (isItalic) style.italic = true;

  const weight = record.font_weight;
  const isUsableWeight = typeof weight === "number" && Number.isFinite(weight) && weight >= 100 && weight <= 900;
  if (isUsableWeight) style.weight = Math.round(weight);

  const hasContent = Object.keys(style).length > 0;
  return hasContent ? style : null;
}

function readSyntax(style: Record<string, unknown>): Record<string, ZedSyntaxStyle> {
  const rawSyntax = asRecord(style.syntax) ?? {};
  const syntax: Record<string, ZedSyntaxStyle> = {};

  for (const [capture, raw] of Object.entries(rawSyntax).slice(0, MAX_CAPTURES)) {
    const isUsableName = capture.length > 0 && capture.length <= MAX_CAPTURE_NAME_LENGTH;
    if (!isUsableName) continue;

    const parsed = readSyntaxStyle(raw);
    if (parsed) syntax[capture] = parsed;
  }

  return syntax;
}

function readTheme(entry: unknown): ZedEditorTheme | null {
  const record = asRecord(entry);
  if (!record) return null;

  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  const hasName = rawName.length > 0;
  const style = asRecord(record.style);
  if (!hasName || !style) return null;

  const name = rawName.slice(0, MAX_NAME_LENGTH);

  return {
    id: `zed:${name}`,
    name,
    appearance: record.appearance === "light" ? "light" : "dark",
    ui: readUi(style),
    syntax: readSyntax(style),
  };
}

/** Parse a Zed theme family file (text or already-parsed JSON) into one
 *  theme per usable entry. Throws `ZedImportError` for an oversized or
 *  unparseable file, or one with nothing usable in it. */
export function convertZedTheme(input: unknown): ZedEditorTheme[] {
  let parsed: unknown = input;

  if (typeof input === "string") {
    const byteLength = new TextEncoder().encode(input).length;
    if (byteLength > ZED_MAX_INPUT_BYTES) throw new ZedImportError("too-large");

    try {
      parsed = JSON.parse(input);
    } catch {
      throw new ZedImportError("invalid-json");
    }
  }

  const family = asRecord(parsed);
  const entries = family && Array.isArray(family.themes) ? family.themes : [];

  const converted: ZedEditorTheme[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries.slice(0, ZED_MAX_THEMES)) {
    const theme = readTheme(entry);
    if (!theme) continue;

    const isDuplicate = seenIds.has(theme.id);
    if (isDuplicate) continue;

    seenIds.add(theme.id);
    converted.push(theme);
  }

  if (converted.length === 0) throw new ZedImportError("no-themes");
  return converted;
}

/** Re-validate themes read back from storage, which a user can hand-edit. */
export function sanitizeZedThemes(value: unknown): ZedEditorTheme[] {
  if (!Array.isArray(value)) return [];

  const sanitized: ZedEditorTheme[] = [];
  const seenIds = new Set<string>();

  for (const entry of value.slice(0, ZED_MAX_THEMES)) {
    const record = asRecord(entry);
    if (!record) continue;

    const ui = asRecord(record.ui) ?? {};
    const syntax = asRecord(record.syntax) ?? {};

    const theme = readTheme({
      name: record.name,
      appearance: record.appearance,
      style: storedToZedStyle(ui, syntax),
    });
    const isDuplicate = theme !== null && seenIds.has(theme.id);
    if (!theme || isDuplicate) continue;

    seenIds.add(theme.id);
    sanitized.push(theme);
  }

  return sanitized;
}

/** Stored data back into the Zed key layout so `readTheme` can validate it. */
function storedToZedStyle(ui: Record<string, unknown>, syntax: Record<string, unknown>) {
  const rebuiltSyntax: Record<string, unknown> = {};

  for (const [capture, raw] of Object.entries(syntax)) {
    const style = asRecord(raw) ?? {};
    rebuiltSyntax[capture] = {
      color: style.color,
      font_style: style.italic === true ? "italic" : undefined,
      font_weight: style.weight,
    };
  }

  return {
    "editor.background": ui.background,
    "editor.foreground": ui.foreground,
    "editor.gutter.background": ui.gutterBackground,
    "editor.line_number": ui.lineNumber,
    "editor.active_line.background": ui.activeLine,
    players: [{ selection: ui.selection, cursor: ui.cursor }],
    syntax: rebuiltSyntax,
  };
}

function highlightSpecs(syntax: Record<string, ZedSyntaxStyle>): TagStyle[] {
  const byDepth = Object.entries(syntax).sort(
    ([a], [b]) => a.split(".").length - b.split(".").length,
  );
  const specs: TagStyle[] = [];

  for (const [capture, style] of byDepth) {
    const tagList = tagsForCapture(capture);
    if (tagList.length === 0) continue;

    const spec: TagStyle = { tag: tagList };
    if (style.color) spec.color = style.color;
    if (style.italic) spec.fontStyle = "italic";
    if (style.weight !== undefined) spec.fontWeight = String(style.weight);
    specs.push(spec);
  }

  return specs;
}

function editorRules(ui: ZedUiColors): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  const setRule = (selector: string, property: string, value: string | undefined) => {
    if (!value) return;
    rules[selector] = { ...rules[selector], [property]: value };
  };

  setRule("&", "backgroundColor", ui.background);
  setRule("&", "color", ui.foreground);
  setRule(".cm-gutters", "backgroundColor", ui.gutterBackground);
  setRule(".cm-gutters", "color", ui.lineNumber);
  setRule(".cm-activeLine", "backgroundColor", ui.activeLine);
  setRule(".cm-selectionBackground, &.cm-focused .cm-selectionBackground", "backgroundColor", ui.selection);
  setRule(".cm-cursor, .cm-dropCursor", "borderLeftColor", ui.cursor ?? ui.foreground);

  return rules;
}

const extensionCache = new WeakMap<ZedEditorTheme, Extension>();

/** The CodeMirror extension for one stored theme. Cached per theme object so
 *  every tab sharing a theme reuses one instance. */
export function zedThemeExtension(theme: ZedEditorTheme): Extension {
  const cached = extensionCache.get(theme);
  if (cached) return cached;

  const isDark = theme.appearance === "dark";
  const surface = EditorView.theme(editorRules(theme.ui), { dark: isDark });
  const highlight = syntaxHighlighting(HighlightStyle.define(highlightSpecs(theme.syntax)));

  const extension: Extension = [surface, highlight];
  extensionCache.set(theme, extension);
  return extension;
}
