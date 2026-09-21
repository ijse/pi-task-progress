# Session Progress and ETA Forecast Design

## Purpose

Extend `pi-otty-todos` so Otty's sidebar shows the active Pi session's current task, overall progress, and explainable forecasts for the current task and the full todo plan. Forecasts are estimates derived solely from Pi `todo` state transitions; the package will not inspect prompts, tool inputs, command output, or project files.

## Chosen approach

Use session-local observation and historical task durations from todo snapshots. This requires no change to a user's Pi workflow and protects the existing privacy boundary. An explicit progress-reporting tool is out of scope for this release; it may be added later as an accuracy enhancement.

## Snapshot format

New writes use snapshot `version: 2`. They retain the v1 identity and task fields:

```json
{
  "version": 2,
  "sessionId": "…",
  "cwd": "/canonical/project/path",
  "updatedAt": 0,
  "observedAt": 0,
  "tasks": [],
  "taskTiming": {
    "42": { "startedAt": 0, "completedAt": 0 }
  }
}
```

- `observedAt` is the time at which the task state was observed, in epoch milliseconds.
- `taskTiming` is keyed by the decimal task ID. Every key must identify a task currently present in `tasks`; orphan records are invalid. A timing record may contain `startedAt`, `completedAt`, or both.
- Times must be finite, non-negative integers. `completedAt` must not precede `startedAt` when both are present.
- v1 snapshots remain valid for selection and rendering. They render the existing todo view without forecast values.
- v2 validation remains exact: unknown top-level or timing-record keys are rejected, as are malformed task arrays.

No separate telemetry file is used. The existing atomic per-session snapshot write and its 0600 permissions protect state and avoid cross-file consistency issues.

## Publisher behavior

The publisher keeps an in-memory timing map per canonical project/session registry entry. For a live todo result, it captures `now()` once, reconciles the last accepted task set with the next one, and uses that observation time for all transitions in that result.

| Transition | Action |
| --- | --- |
| first seen as `in_progress` | Set `startedAt` to the live observation time if absent. |
| non-completed → `completed` | Set `completedAt` to the live observation time. Do not synthesize a missing `startedAt`. |
| `completed` → non-completed | Remove `completedAt`; retain `startedAt` only if the task is still in progress, otherwise remove its timing. |
| any status → `deleted`, or task disappears | Remove timing. |
| `in_progress` → `pending` | Remove timing; a later restart gets a new start. |

On startup and hot reload, the publisher first restores the selected session's valid v2 timing map from its existing snapshot. Branch replay then scans ordered historical todo results only when each relevant result has a finite epoch-millisecond event timestamp. It uses those historical timestamps for transitions and never calls `now()` for replay. If any required transition timestamp is absent or invalid, the affected task receives no reconstructed timing; a later live transition begins a new observation. This avoids fabricated duration samples.

All existing per-session revision ordering rules apply. A queued write carries the reconciled timing and cannot overwrite a newer observation.

## Derived metrics and forecasts

The renderer derives metrics from a selected valid v2 snapshot; derived values are not persisted.

1. **Visible total** is every task except `deleted`.
2. **Overall progress** is `completed / visible total`, expressed as an integer percentage. Empty plans display `0%`.
3. **Duration samples** are valid `completedAt - startedAt` values for completed visible tasks. The representative duration is their median.
4. **Forecast threshold** is three valid samples. Below it, the UI says `Collecting samples` and omits minute and finish-time predictions.
5. **Current task** is the lowest-ID visible `in_progress` task. If multiple tasks are in progress, the UI says `N tasks running`; only the lowest-ID one receives the highlighted card and the plan forecast treats all in-progress tasks as remaining work.
6. **Current-task remaining** is `max(0, medianDuration - (observedAt - startedAt))` only when the highlighted task has a valid `startedAt`. Its visual progress is elapsed/median, clamped to 95% until its todo state becomes completed. Without `startedAt`, the card still shows the task and `Timing unavailable`; it omits elapsed time and task progress, and its remaining forecast is `~medianDuration` with an explicit `Estimated from plan average` label.
7. **Plan remaining** is the sum of a representative duration for every visible non-completed task. For a timed highlighted task it uses current-task remaining instead of a full duration. Blocked tasks remain in the count because they are planned work, but the UI warns that forecasts exclude external waiting.
8. **Plan completion** is `observedAt + plan remaining`.
9. **Confidence** is `low` for 3–4 samples, `medium` for 5–9, and `high` for 10 or more. Confidence describes sample volume, not a guarantee.

All displayed estimates use an explicit `Estimated` label. The renderer displays rounded minutes and local-clock completion time. It must never show a negative duration or a completion time before `observedAt`.

## Sidebar layout

For a valid v2 snapshot with enough samples, the renderer places these sections ahead of the existing grouped task list:

- header with current-session status and freshness;
- overall completed/total count, percentage, and terminal-safe text progress bar;
- highlighted current task with status, elapsed time, and estimated task progress;
- forecast rows for current-task remaining and plan completion, plus sample count/confidence;
- a concise next-task queue: up to two lowest-ID `pending` tasks whose dependencies are all completed, each with a representative-duration estimate; if none are eligible, show the lowest-ID blocked pending task with a `Blocked` label;
- existing grouped todo list for full detail.

The terminal renderer uses plain text and existing ANSI redraw controls only. It sanitizes all task-derived strings and does not use progress data in escape sequences. A no-snapshot, v1, insufficient-sample, invalid-data, or Otty CLI failure state remains safe and useful.

## Compatibility, error handling, and security

- Existing v1 consumers remain readable. They never receive fabricated timing or ETA.
- Invalid v2 timing data invalidates that snapshot rather than falling back to unsafe partial data.
- System-clock rollback is handled by ignoring negative elapsed intervals and withholding affected samples.
- The current path canonicalization, trusted-project gate, directory/file symlink rejection, size cap, permission mode, atomic write, and active-session selection behavior are unchanged.
- The Otty renderer continues refreshing every 750 ms, but it treats the persisted `observedAt` as the forecast reference: time does not advance in a stale snapshot merely because the display redraws.

## Tests

Independent contract tests will cover:

- v1 compatibility and exact valid/invalid v2 schemas;
- timing on start, completion, reopening, pause, deletion, and hot reload/replay;
- atomically ordered telemetry snapshots under consecutive publishes;
- median calculation, threshold behavior, multiple-running-task tie-breaking, blocked tasks, elapsed-time clamp, confidence bands, and clock rollback;
- terminal rendering of metrics and safe omission for insufficient or invalid data;
- existing snapshot-selection, path-safety, live-refresh, package-tarball, and Pi package-loading tests.
