# Code intelligence: rename, format and code actions

Upstream Termic already uses language servers for go to definition, find
usages and symbol search in the built-in editor. Termic+ adds three commands
that change code through the server.

| Command | Default key | Does |
| --- | --- | --- |
| Rename symbol | `F2` | Renames the symbol under the cursor everywhere the server knows about it |
| Format document | `Shift+Alt+F` | Formats the whole file with the server's formatter |
| Code actions | `Cmd+.` | Lists the server's quick fixes and refactors for the cursor or selection |

All three are also in the command palette (`Shift+Cmd+P`, Task section) while an
editor with code intelligence on is in front of you. The keys can be changed
in Settings > Shortcuts under Code navigation.

## Before you start

Code intelligence has to be on for the task. Open a file in the editor and
turn it on from the code intelligence chip in the task view. Which server runs
for each language, and whether Termic can install a missing one, is under
Settings > Projects, in the project's own settings.

## Try it

1. Open a TypeScript file that exports a function used in other files.
2. Put the cursor on the function name and press `F2`.
3. Type the new name and press `Enter`.
4. The open file changes in the editor and its tab shows unsaved changes.
   Files that were not open are written to disk directly. If a file cannot be
   written, a message names it.
5. Make a small formatting mess in the file and press `Shift+Alt+F`.
6. Put the cursor on an error the server reports (an unused import works well)
   and press `Cmd+.`. Pick a fix with the arrow keys and `Enter`, or press
   `Escape` to close the list.

## Things to know

- Rename writes unopened files straight to disk. Editor undo does not reach
  them, so commit or check `git diff` before a large rename.
- Some servers keep their own index and only notice files changed on disk when
  they next read them. Results right after a rename can be stale for a moment.
- What each command offers depends on the server. A server without a
  formatter makes Format document do nothing.
