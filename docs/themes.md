# Custom themes

Drop a JSON file in termic's themes folder and it shows up in the theme
picker as a first-class theme: chrome and terminal, coupled, exactly like
the built-ins. There is no theme editor UI. The files are the interface,
which makes themes trivially shareable and stowable from dotfiles.

## Where

```
~/.config/termic/themes/
```

(`$XDG_CONFIG_HOME/termic/themes/` if you set that variable. Same path on
every platform; release and dev builds share it.)

Themes are hand-authored, shareable config, so they live under `.config`
like other terminal tools (wezterm, starship, kitty), not in the app-owned
Application Support data dir, which makes them trivially stowable from
dotfiles.

When the folder is empty, termic seeds it with a `README.md` and an
`example.json.sample` (a complete theme, ready to `cp` to `my-theme.json`).
Neither ends in `.json`, so the picker ignores both. Delete them once you
have your own theme; they only come back if the folder is emptied. The
sources live in `src-tauri/assets/themes/`.

One JSON file per theme. The picker's "Open themes folder" row opens this
directory (and creates it if needed). Themes are read at startup and
re-read every time the picker opens, so the edit loop is: save the file,
hover the picker, done. No restart, no watcher.

## Picking a theme

Two ways, same as the built-ins:

- Hover the theme icon (sun/moon) in the title bar. Custom themes list
  below the built-ins, with an "Open themes folder" row at the bottom.
- ⇧⌘P, then "Change theme…". Arrow keys live-preview each theme; Enter
  commits, Escape rolls back to what you had.

The keyboard theme-cycle shortcut only cycles System / Light / Dark, so a
custom theme sticks until you explicitly pick something else.

The theme's id is its file name (a file named `rose-pine-moon.json` becomes
`custom:rose-pine-moon` internally), so a file named `claude.json` can
never shadow the built-in Claude theme.

## File format

```json
{
  "name": "Rosé Pine Moon",
  "colorScheme": "dark",
  "ui": {
    "bg": "#232136", "bg-1": "#2a273f", "bg-2": "#393552", "bg-3": "#44415a",
    "fg": "#e0def4", "fg-dim": "#908caa", "fg-faint": "#6e6a86",
    "border": "#56526e", "border-soft": "#393552",
    "hover": "rgba(224,222,244,0.05)", "sel": "rgba(196,167,231,0.22)",
    "accent": "#c4a7e7", "accent-soft": "rgba(196,167,231,0.22)", "accent-deep": "#6f5b9e",
    "accent-fg": "#232136",
    "ok": "#9ccfd8", "ok-fg": "#232136", "warn": "#f6c177", "err": "#eb6f92",
    "palette-red": "#eb6f92", "palette-orange": "#e89f6f", "palette-yellow": "#f6c177",
    "palette-green": "#97c9a3", "palette-teal": "#9ccfd8", "palette-blue": "#3e8fb0",
    "palette-purple": "#c4a7e7", "palette-pink": "#d8a0c9"
  },
  "terminal": {
    "background": "#232136", "foreground": "#e0def4",
    "cursor": "#c4a7e7", "selectionBackground": "#44415a",
    "black": "#393552", "red": "#eb6f92", "green": "#3e8fb0", "yellow": "#f6c177",
    "blue": "#9ccfd8", "magenta": "#c4a7e7", "cyan": "#ea9a97", "white": "#e0def4",
    "brightBlack": "#6e6a86", "brightRed": "#eb6f92", "brightGreen": "#3e8fb0",
    "brightYellow": "#f6c177", "brightBlue": "#9ccfd8", "brightMagenta": "#c4a7e7",
    "brightCyan": "#ea9a97", "brightWhite": "#e0def4"
  }
}
```

### Top-level fields

| Field | Required | Values | Notes |
| --- | --- | --- | --- |
| `name` | yes | string | Picker label. Falls back to the file name if empty. |
| `colorScheme` | yes | `"dark"` or `"light"` | Drives form controls, the editor's auto syntax theme, and the `COLORFGBG` env var agents use to pick their TUI theme. Anything other than `"light"` is treated as `"dark"`. |
| `ui` | no | object | Chrome colors, see below. |
| `terminal` | no | object | xterm palette, see below. |

Unknown top-level fields are ignored (forward compatibility).

### `ui` keys

Every key is optional and maps to the `--color-<key>` CSS variable. Missing
keys fall back to the built-in palette matching your `colorScheme` (Dark+
for dark themes, Light for light ones), so a minimal theme can override
just `bg` and `accent` and still look coherent.

| Key | What it paints |
| --- | --- |
| `bg` | main content area |
| `bg-1` | chrome: sidebar, title bar, tabs |
| `bg-2` | nested cards, badges |
| `bg-3` | hover and active surfaces |
| `fg` | primary text |
| `fg-dim` | muted text |
| `fg-faint` | faint icons, secondary text |
| `border` | standard borders |
| `border-soft` | hairline borders |
| `hover` | hover overlay (usually a low-alpha rgba) |
| `sel` | selection tint |
| `accent` | brand accent (buttons, active states) |
| `accent-soft` | accent-tinted backgrounds (usually low-alpha rgba) |
| `accent-deep` | accent for filled buttons |
| `accent-fg` | ink on a solid `accent` fill (count badges, filled CTAs). Defaults to white; set a dark ink if your accent is light |
| `ok` | success green |
| `ok-fg` | ink on a solid `ok` fill (toggle knobs). Defaults to white |
| `warn` | warning yellow |
| `err` | error red |
| `palette-red` … `palette-pink` | hue-named accent ramp for user-assigned marks (state marks and links, and the source of the accent presets below). 8 keys: `palette-red`, `palette-orange`, `palette-yellow`, `palette-green`, `palette-teal`, `palette-blue`, `palette-purple`, `palette-pink`. Tune shades to your theme, but keep each hue recognizable: users pick colors by name and expect "red" to stay red across themes |
| `swatch-red` … `swatch-pink` | the accent presets users pick for group folders, task groups and profiles. Not a theme key: each is derived from its `palette-*` key (57% chroma, mixed toward `fg-dim`), so tuning the palette retunes the swatches |

The `--color-cli-*` agent tint variables are not themeable in v1; they keep
their defaults. So do `--color-pr-merged` / `--color-pr-open`, the pull-request
state tints on the sidebar and dashboard task rows: like the agent tints they
are matched to somebody else's palette (GitHub's), so a theme re-shading them
would make the glyph stop reading as the state it names. Both flip with
`colorScheme`, so a light theme gets the darker pair automatically.

### `terminal` keys

Standard xterm.js `ITheme` keys, all optional: `background`, `foreground`,
`cursor`, `cursorAccent`, `selectionBackground`, `selectionForeground`,
`selectionInactiveBackground`, the ANSI 8 (`black` through `white`), and
the bright ANSI 8 (`brightBlack` through `brightWhite`).

Missing keys fall back to the built-in palette matching your `colorScheme`
(Dark+ for dark themes, Light for light ones), so a partial block still
yields a complete, readable ANSI 16.

### Color values

Hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) and `rgb()` / `rgba()` /
`hsl()` / `hsla()` notation. Named CSS colors are not accepted.

## Sidebar tokens

The sidebar (GH #90) paints only with `--sidebar-*` tokens in
`src/index.css`: surfaces (`bg-top`, `bg-bottom`, `well-bg`, `tray-bg`,
`card-bg`, `popover-bg`, `footer-top`, `footer-bottom`), inks (`ink`,
`muted`, `meta`, `faint`, `icon`, `chevron`, `eyebrow`), selection
(`sel-from`, `sel-to`, `sel-bar`), work state (`running`, `settled`),
and the rest (dividers, guides, keycaps, drag and focus rings). Dark+
defines them as literals inside `@theme`; every other built-in theme, and
any custom theme, gets them derived from its own `bg-1`, `fg`, `accent` and
palette, so a custom theme restyles the sidebar without naming one. They
are not keys in a theme file.

## Title bar tokens

The title bar (docs/ui.md "Title bar contents") is the same material
family, so it reuses the `--sidebar-*` tokens wherever the value matches
(wells, raised chips, segment and icon hover, inks, menu rows and
dividers, the running and settled colours, the focus ring) and adds
`--titlebar-*` only for what the sidebar has no value for: the bar's own
gradient, border, shadow, sheen and grain opacity (`bg-top`, `bg-bottom`,
`border`, `shadow`, `sheen`, `grain-opacity`), the well shadow with its
inner rim (`well-shadow`), raised-chip hover and pressed states
(`chip-hover-top`, `chip-hover-bottom`, `pressed-bg`, `pressed-shadow`),
dividers (`divider`, `title-divider`, `groove`), the title pill's hover
(`title-hover-bg`, `title-hover-border`, `title-hover-shadow`,
`title-text-shadow`) and the menu material (`menu-top`, `menu-bottom`,
`menu-shadow`). Same arrangement as the sidebar's: Dark+ literals in
`@theme`, derived from `--color-*` for the other dark themes and custom
themes, and their own block for light, where the grain is off. The
session strip's running word and trace take `--color-accent`. They are not
keys in a theme file.

## The subagent view paints with claude's palette

The subagent transcript view (docs/ui.md "The subagent transcript view")
is the one place colours do not come from a termic theme. It imitates the
claude tab beside it, and claude draws with its own palette chosen by its
own `theme` setting, so the view does too: `src/lib/claudePalette.ts`
holds one table per claude theme (`dark`, `light`, `dark-daltonized`,
`light-daltonized`, `dark-ansi`, `light-ansi`), with the rgb numbers
claude 2.1.296 ships, applied as `--cc-*` custom properties on the pane
root. They are `rgb()` data in that table rather than `@theme` tokens
because no termic theme should be able to change them. The two ansi
themes name terminal colours instead, which resolve against the active
terminal theme's ANSI palette, so they follow a custom theme's
`terminal` keys exactly as the claude tab does. The spinner's stall red, rgb(171,43,63), is a constant in claude rather
than a role, and lives beside the table as `STALL_RED`. When claude
changes its palette, update the table and its test together.

## Error handling

Nothing about a theme file can break the app:

- A file that fails to parse is skipped (the rest still list). Check the
  dev console / stderr for a `[themes] skipping ...` line.
- An unknown key or a malformed color value is dropped; the key falls back
  to its default.
- Deleting the active theme's file falls back to the Claude theme on the
  next picker open or launch.

## Notes

- Two files with the same `name` both list (their ids differ). The picker
  shows whatever the files say.
- The active custom theme's payload is cached in localStorage so the first
  paint after launch uses it directly. The folder is re-read right after
  startup and reconciled (edits re-apply, deletions fall back).
