# Zed keymap

The built-in editor uses CodeMirror's keys by default. If your hands know Zed,
Termic+ can switch the editor to a Zed preset. It covers multi-cursor,
selection, line editing and formatting. App shortcuts outside the editor do
not change.

## Turn it on

Choose **Zed** under Settings > Appearance > **Editor keymap**, or run
**Toggle Zed keymap** from the command palette (`Shift+Cmd+P`). The switch
applies to editors that are already open, and your cursor and undo history
stay as they were.

## Keys

| Key | Does |
| --- | --- |
| `Cmd+D` | Select the next occurrence |
| `Shift+Cmd+L` | Select all occurrences |
| `Opt+Cmd+Up` / `Opt+Cmd+Down` | Add a cursor above or below |
| `Opt+Up` / `Opt+Down` | Grow or shrink the selection by syntax |
| `Ctrl+Cmd+Up` / `Ctrl+Cmd+Down` | Move the line up or down |
| `Shift+Cmd+D` | Duplicate the line |
| `Ctrl+Shift+K` | Delete the line |
| `Cmd+L` | Select the line |
| `Cmd+Enter` / `Shift+Cmd+Enter` | Insert a line below or above |
| `Cmd+/` | Toggle a comment |
| `Shift+Cmd+I` | Format the document (needs [code intelligence](code-intelligence.md)) |

## Try it

1. Turn the preset on and open a file.
2. Put the cursor inside a function call's arguments and press `Opt+Up` a few
   times. The selection grows to the argument, the argument list, the call
   and the statement. `Opt+Down` walks back.
3. Double-click a variable name and press `Cmd+D` twice to add the next two
   uses, then type to change all three.
4. Press `Ctrl+Cmd+Up` to move the current line up.

## Things to know

- While the editor has focus, the preset wins over app shortcuts on the same
  key. For example `Cmd+L` focuses the main agent elsewhere but selects the
  line in the editor, and `Shift+Cmd+L` selects all occurrences instead of
  adding the selection to the agent.
- `Cmd+[` and `Cmd+]` stay back and forward.
- With the preset on, `Opt+Up` and `Opt+Down` never move a line, even when
  there is nothing larger to select. Use `Ctrl+Cmd+Up` and `Ctrl+Cmd+Down`.
- The preset follows Zed's macOS keys. On Linux and Windows `Cmd` is `Ctrl`.
