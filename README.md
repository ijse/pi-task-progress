# pi-task-progress

A [Pi](https://pi.dev) package that mirrors the active Pi session's todos into a live [Otty](https://otty.sh) sidebar view.

## What it does

- Publishes validated `todo` tool results to per-session snapshots at `<project>/.pi/otty-todos/`.
- Keeps snapshots isolated by Pi session and restores them on session start or tree navigation.
- Uses Otty's running pane metadata to prefer the active Pi session over newer snapshots from unrelated sessions.
- Renders a live sidebar with progress, in-progress, blocked, pending, and completed tasks.
- Estimates the active task and whole-plan completion time after at least three completed task-duration samples, with explicit confidence labels.

The extension is Pi-only and targets macOS installations of Otty.

## Install

```sh
pi install git:github.com/ijse/pi-task-progress
```

Restart Pi or run `/reload` after installation.

## Add the Otty View

Create an Otty **Terminal Program** View with:

| Field | Value |
| --- | --- |
| Name | `Pi Todos Live` |
| Command | `/usr/local/bin/node /Users/YOU/.pi/agent/git/github.com/ijse/pi-task-progress/extensions/otty-todos-view.mjs --instance=1` |
| Folder | `${cwd}` |

Replace `YOU` with your macOS username. The instance token is intentional: Otty shares terminal-view processes with the same command and working directory, so increment it after changing the renderer command to force a fresh process.

The view refreshes every 750 ms. It reads snapshots only; task edits remain in Pi.

## Forecasts

Forecasts are local, per-session estimates—not execution telemetry. The package records only `todo` status transitions: it observes when a task becomes in progress or completed, then uses the median duration of at least three completed tasks to estimate the running task and remaining plan. The sidebar labels every estimate and reports low, medium, or high confidence from the available sample count. Blocked work remains in the plan estimate, so external waiting is not predicted. If timing is incomplete, stale, or has fewer than three samples, the sidebar keeps the todo list visible and shows that it is collecting samples instead of inventing an ETA.

## Security and storage

The extension writes only for trusted Pi projects. It uses canonical project paths, refuses symlinked snapshot directories, writes atomically with restrictive POSIX permissions, and ignores malformed task results. The renderer likewise ignores invalid, oversized, or symlinked snapshots and sanitizes task text before writing to the terminal.

## Development

Requires Node.js 20 or newer.

```sh
npm test
```

The test suite covers task-result validation, branch replay, ordered atomic writes, path safety, session selection, terminal-safe rendering, and live refresh.

## License

[MIT](LICENSE)
