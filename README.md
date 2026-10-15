# pr-panel

A Claude Code mod: a pane showing a GitHub pull request's description and its discussion
(comments, reviews with their verdict, and review threads on code lines, replies included),
oldest first. The UI is in Italian.

- `/pr-panel` lists the open pull requests of the session's repository; press one to open it.
- `/pr-panel 22` opens pull request #22. Also accepted: `owner/repo 22`, `owner/repo#22`, a pull request URL.
- **Aggiorna** (`r`) reloads; **Elenco PR** (`l`) goes back to the list. An open pane reloads by itself every 2 minutes.

It reads GitHub only, never writes. It uses the session's GitHub MCP server (named `github`) when there is one,
otherwise the `gh` CLI (`gh api`), so for a private repository `gh auth login` must have been run.
The repository comes from the session's `git remote get-url origin`, unless given in the command.

The pane needs a surface that draws mod panes: a local Claude Code session in the terminal or the desktop app.

## Install

At the prompt of a terminal session:

```
/plugin install pr-panel --marketplace nunziati/pr-panel
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install pr-panel --marketplace nunziati/pr-panel
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins,
Add marketplace with `nunziati/pr-panel`, then Add plugin.
