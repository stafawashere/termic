# Workspaces

Termic+ organizes work the same way upstream Termic does, in three levels.
Older Termic builds and some placeholders still say "workspace" for what the
app now calls a task.

A **project** is a git repository you added. Each **task** is one piece of
work in a project, with its own git worktree (a separate checkout on its own
branch), its own terminals and agents, and its own ports, so agents in two
tasks never touch each other's files. Above both sits the **profile**, a whole separate set of
projects, tasks and settings in its own window, which is how you keep work and
personal projects apart.

## Start a task

1. Press `Cmd+N`.
2. Name the task and pick the agent to start. Termic creates a branch and a
   worktree for it and runs the project's setup script if it has one.
3. The task opens with the agent in its first tab. Add more agent or shell
   tabs from the `+` in the tab bar, or from the `+` that appears when you
   hover the project row in the sidebar if you want another task instead.
4. When the work is merged, archive the task from its menu. The worktree is
   removed and the task moves to History.

A task can also run in the project's main checkout instead of a worktree. Pick
that when creating it if the work has to happen on the branch you already have
checked out.

## Run several at once

1. Start two or three tasks.
2. Give each a different job. Since every task has its own branch, two agents
   editing the same file in different tasks do not conflict until you merge.
3. Switch to the status view in the sidebar header to see which agents are
   working, which are waiting on you and which are done.
4. Use the Git tab in the right panel of each task to review its diff, then
   merge or open a pull request from there.

## Use a second profile

1. Open Settings > Profiles and create a profile.
2. Open it. It appears in a new window with no projects.
3. Add projects to it. They, their tasks and the profile's settings stay in
   that window, and the first profile cannot see them.

Two profiles can be open side by side, for example on two monitors. Running
an agent under a separate login is described in
[agent-accounts.md](../agent-accounts.md).
