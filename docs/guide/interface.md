# Interface tour

Termic+ reworks most of the window chrome. The features are the same as
upstream, but several things moved. This page walks through the window from
left to right.

## Sidebar

The button in the sidebar header switches between the project tree and status
buckets, which group tasks by whether their agents are working, waiting on you
or done. The choice is remembered per profile.

Hover a project to get its tray: a filter for its tasks, a menu, and `+` for a
new task. Task rows show the tab properties agents set (a ticket number, a
phase) next to the name, and when space runs short the properties shrink
before the name does. Subagents appear as rows under a `claude` tab (see
[Subagents](subagents.md)). There is one Add project button at the bottom, and
the sidebar footer holds Contact.

Try it: press `Shift+Cmd+F` and type part of a task name to narrow the tree.
Then click the view button in the sidebar header to see
the same tasks by status.

## Title bar and tabs

The task title sits in the center with its branch shown once. The session
strip on the right lists the agents running in the task and hides itself when
nothing is running. Buttons on the left and right open the panels and menus
that used to live in the toolbar.

Tabs sit in a well with their names centered. The separate close pill is
gone. A working agent's tab keeps its activity trace
while you look at another tab. "Split below" is now called "Split down".

## Footer and right panel

The sandbox state is one chip: off, enforcing, monitoring, Docker or
degraded. Agent usage is one meter per
window, labeled in words, and it hides when the bar is narrow.

Git, History, Compare, the PR card, Scratchpads and All files share one style.
All files gained a filter and file actions, described in
[File explorer](file-explorer.md).

## Themes

The redesign adds new theme tokens for the sidebar, title bar, tab bar,
footer and right panel. A custom theme that sets only the old tokens still
works and falls back to defaults for the new parts. The token list is in
[themes.md](../themes.md).
