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
- v2 envelope validation remains exact: unknown top-level keys, malformed identity fields, or malformed task arrays reject the full snapshot. A malformed `taskTiming` map or record does not discard its otherwise valid task list: readers treat timing as absent and render the safe no-forecast v2 state.

No separate telemetry file is used. The existing atomic per-session snapshot write and its 0600 permissions protect state and avoid cross-file consistency issues.

## Publisher behavior

The publisher keeps an in-memory timing map per canonical project/session registry entry. For a live todo result, it captures `now()` once, reconciles the last accepted task set with the next one, and uses that observation time for all transitions in that result.

| Transition | Action |
| --- | --- |
| first seen as `in_progress` | Set `startedAt` to the live observation time if absent. |
| non-completed → `completed` | Set `completedAt` to the live observation time only if it is not before any retained `startedAt`. Do not synthesize a missing `startedAt`; on a clock rollback, remove the task timing record instead. |
| `completed` → non-completed | Remove `completedAt`; retain `startedAt` only if the task is still in progress, otherwise remove its timing. |
| any status → `deleted`, or task disappears | Remove timing. |
| `in_progress` → `pending` | Remove timing; a later restart gets a new start. |

On startup and hot reload, the publisher first restores the selected session's valid v2 timing map from its existing snapshot. Branch replay reads the ISO-8601 `timestamp` field on each session-tree `entry` that contains a todo tool-result (`Date.parse(entry.timestamp)`). It scans transitions only while that parse result is finite and non-negative, uses that historical epoch-millisecond value for transitions, and never calls `now()` for replay. If a required entry timestamp is absent, invalid, or precedes a retained start time, the affected task receives no reconstructed timing; a later live transition begins a new observation. This avoids fabricated or negative duration samples.

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

- v2 header: `PI / ACTIVE SESSION` when the selected session ID matches a pane returned by Otty, otherwise `PI / SESSION SNAPSHOT`; status is `RUNNING` for Otty `agent_state: processing`, `IDLE` for any other matching pane state, and `SNAPSHOT` when pane lookup fails or finds no matching Pi pane. Freshness is computed from `Date.now() - observedAt`: `UPDATED <1s AGO` for 0–999 ms, `UPDATED Ns AGO` for 1–10 seconds, `STALE · Ns AGO` after 10 seconds, and `CLOCK UNKNOWN` for a negative age. A `CLOCK UNKNOWN` header withholds ETA/progress-time values. V1 retains its original header-free frame;
- overall completed/total count, percentage, and terminal-safe text progress bar;
- highlighted current task with status, elapsed time, and estimated task progress;
- forecast rows for current-task remaining and plan completion, plus sample count/confidence;
- a concise next-task queue: up to two lowest-ID `pending` tasks whose dependencies are all completed, each with a representative-duration estimate; if none are eligible, show the lowest-ID blocked pending task with a `Blocked` label;
- existing grouped todo list for full detail.

The terminal renderer uses plain text and existing ANSI redraw controls only. It sanitizes all task-derived strings and does not use progress data in escape sequences. A no-snapshot, v1, insufficient-sample, invalid-data, or Otty CLI failure state remains safe and useful.

## Compatibility, error handling, and security

- Existing v1 consumers remain readable. They never receive fabricated timing or ETA.
- Invalid v2 envelope data invalidates that snapshot. Invalid timing data alone is discarded while its valid task list remains visible in the no-forecast v2 frame; no invalid timing is partially used.
- System-clock rollback is handled by clearing the affected task's timing record (without changing its todo status), ignoring negative elapsed intervals, and withholding affected samples.
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

## Acceptance Criteria

- AC-1: WHEN Pi observes a valid live `todo` state transition for a trusted project THE SYSTEM SHALL publish an atomically written v2 snapshot that preserves valid per-task timing without changing v1 snapshot safety behavior.
- AC-2: WHEN a selected v2 snapshot has at least three valid completed-task duration samples THE SYSTEM SHALL render the active task, completed/visible progress percentage, task and plan forecasts, sample count, and confidence with explicit estimated labels.
- AC-3: WHEN samples are insufficient, timing is missing, data is invalid, or the system clock moves backward THE SYSTEM SHALL preserve todo visibility and omit unsafe elapsed-time or ETA values rather than fabricate them.
- AC-4: WHEN Pi resumes or navigates a session tree THE SYSTEM SHALL use only valid `entry.timestamp` values to reconstruct transition timing and shall not call the live clock for replay.
- AC-5: WHEN the existing v1 snapshot format is selected THE SYSTEM SHALL retain the current grouped todo rendering without forecast content.
- AC-6: WHEN the renderer refreshes a selected session THE SYSTEM SHALL continue to prefer the active Otty Pi session and render terminal-safe task text without changing path, symlink, size, permission, or trusted-project protections.

## Delivery Coverage

| Surface | Required change | Acceptance IDs |
| --- | --- | --- |
| API/data | v2 snapshot validation, timing reconciliation, derived forecast helpers | AC-1, AC-3, AC-4 |
| UI | Terminal forecast header, progress, active task, queue, and v1 fallback | AC-2, AC-3, AC-5 |
| Integration | Existing extension event wiring and active Otty-session selection remain compatible | AC-1, AC-4, AC-6 |
| Migration/configuration | Read v1 without migration; no new Otty configuration fields | AC-5, AC-6 |
| Tests/docs/operations | Extend contract suite and update README screenshot-free behavior documentation | AC-1–AC-6 |

## Verification Plan

Run from `/Users/liyi/Workspace/pi-otty-todos` on macOS with Node 20 or later: `npm test`, which resolves to the inspected `node --test extensions/tests/*.test.mjs` runner. The test suite must pass all existing and new contract tests. Run `npm pack --dry-run` to verify the manifest still ships the renderer and its core import. The Pi smoke requires Pi 0.86.1, a configured noninteractive model provider, and its required network availability; it must not record credentials. Run `tmpdir=$(mktemp -d); out=$(mktemp); err=$(mktemp); (cd "$tmpdir" && pi -e /Users/liyi/Workspace/pi-otty-todos --print 'Reply only: OK' >"$out" 2>"$err"); status=$?; ! grep -Eqi '(extension.*(error|failed)|((error|failed).*extension))' "$err"; clean=$?; rm -rf "$tmpdir"; rm -f "$out" "$err"; test "$status" -eq 0 && test "$clean" -eq 0`. The deterministic package-load proof is exit 0 with no extension-load error in Pi diagnostics; model text is not asserted.

## Open Decisions

None.

## Implementation Plan

Plan revision: 4
Base commit: 6de20574a65897df7ffd19a757394980a4ae9a93
Requirements SHA256: 840d6c38563f8797e707cb45de1a918227844465eccc0ca8124e90991fd1161a
Readiness: READY

### Identity

- Repository: `ijse/pi-otty-todos`
- Prepared: 2026-09-21 against clean branch `feat/session-progress-forecast`; the base commit is the approved-spec revision above.
- Manual freshness validation: at clean target `28251cf9ed78cc81726fbdff90ba17e11ebbd7a9`, `git diff --quiet 6de20574a65897df7ffd19a757394980a4ae9a93..28251cf9ed78cc81726fbdff90ba17e11ebbd7a9 -- extensions package.json README.md` succeeded. The only intervening files are this canonical specification/plan document; all implementation paths are byte-identical to the base. Before execution, repeat that comparison from the target checkout and block implementation if it differs.
- Supersedes: Plan revisions 1–3 in this document.
- Canonical local requirements and plan: this document. No issue tracker is used for this local-only workflow.

### Repository Evidence

| Path and symbol | Observed responsibility or pattern | Planned use |
| --- | --- | --- |
| `extensions/otty-todos-core.mjs::validTaskDetails` and `createTodoPublisher` | Strict installed-harness todo validation; trusted-project, canonical-path, per-session queued atomic snapshots; `now` is an injected deterministic seam. | Extend snapshot construction/replay without weakening validation or ordered writes. |
| `extensions/otty-todos-view.mjs::selectSnapshot` and `renderSnapshot` | Exact v1 snapshot acceptance; symlink/file-size defenses; active Otty-session selection; terminal-safe grouped rendering. | Add version-aware v2 selection and forecast rendering while retaining the v1 frame. |
| `extensions/otty-todos.ts` | Registers one publisher; forwards `tool_result`, `session_start`, and `session_tree` to live publish or branch replay. | Keep event wiring unchanged; publisher owns timing semantics. |
| `extensions/tests/otty-todos.test.mjs` | Node built-in contract tests use temporary projects, injected time, branch fixtures, and a standalone renderer child process. | Add deterministic v2 timing, forecast, compatibility, and rendering contracts in the same runner. |
| `package.json::scripts.test` | Defines the only current verification command: `node --test extensions/tests/*.test.mjs`. | Run it unchanged after the new tests are added. |

### Resolved Decisions and Contracts

- D-1: `createTodoPublisher` writes schema version 2 for every new snapshot. A v2 snapshot has exactly `version`, `sessionId`, `cwd`, `updatedAt`, `observedAt`, `tasks`, and `taskTiming`; its timing map contains only current task IDs and strictly valid non-negative timestamps. Add exported `parseTodoSnapshot(value)` and `readSessionTiming(cwd, sessionId)` in the core module: the parser returns a full-invalid result for malformed envelope/tasks, and a valid task-only result with empty timing for malformed timing; the reader reuses `safeStore`, lstat regular-file/no-symlink checks, the 256 KiB cap, and JSON parsing before restoring only an exact same-session v2 record. Existing v1 snapshots remain accepted only by the renderer.
- D-2: Publisher registry state owns the previous normalized task set and task-timing map per canonical cwd/session. A live valid todo result reconciles at one injected `now()` epoch-millisecond time. `in_progress` first observes `startedAt`; completion records `completedAt` only when not earlier than `startedAt`; pending/deleted/disappeared/reopened tasks clear timing as specified. Clock rollback clears timing for that task and never blocks persistence of the todo status.
- D-3: `publishCurrentState` restores a valid same-session v2 timing map before tree replay. Pi `0.86.1` declares `SessionEntryBase.timestamp: string` and `SessionManager.getBranch(): SessionEntry[]` in `dist/core/session-manager.d.ts`; therefore replay obtains historical time only from `entry.timestamp`, parsed using `Date.parse`. Replay never calls `now()`. A missing, invalid, negative, or backward timestamp clears/withholds timing for the affected task. Live observations thereafter create new timing. The branch-replay loop continues to select only valid todo results.
- D-4: Add a pure exported forecast helper in `otty-todos-core.mjs`, named `deriveSessionMetrics(snapshot)`. It returns a structured result for visible/completed counts, percentage, median duration, valid sample count, confidence, highlighted current task, task remaining, plan remaining, plan completion timestamp, and eligible next tasks. It returns a no-forecast result below three samples or on invalid timing; it never returns negative durations. The current task is the lowest numeric in-progress ID; its progress is capped at 95%; blocked pending tasks remain in plan work; next tasks are lowest-ID dependency-satisfied pending tasks, with a blocked fallback.
- D-5: `selectSnapshot` accepts exact valid v1 and v2 snapshots, preserving current sort and active-session preference. `activeOttySession` returns `{ sessionId, agentState }` or `undefined`; `renderSnapshot(snapshot, { now = Date.now, activeSession } = {})` owns the exact v2 header/freshness states defined in Sidebar layout. `renderSnapshot` leaves v1 output behavior intact. For forecast-eligible v2 it prefixes the existing groups with terminal-safe progress, highlighted task, forecast/confidence, and queue sections. Missing `startedAt` shows `Timing unavailable` plus a plan-average estimate but no elapsed/task-progress field. Below the threshold, malformed timing, or a clock-unknown header it says `Collecting samples` or `Timing unavailable` and never renders an ETA; malformed envelope/tasks produce the existing no-todos frame.
- D-6: No new dependencies, config, Otty CLI calls, telemetry files, or data collection sources are introduced. The existing trusted-project check, canonicalization, lstat/symlink defense, 256 KiB renderer limit, atomic 0600 writes, ANSI redraw model, and 750 ms refresh remain unchanged.
- D-7: README documentation explains that v2 ETA is a local session estimate based on completed todo durations, the three-sample minimum, explicit uncertainty/confidence, blocked-task limitation, and v1 compatibility. It does not promise execution-level measurement.

### Ordered Implementation Steps

- [ ] S-1: In `extensions/otty-todos-core.mjs`, add `parseTodoSnapshot(value)`, `readSessionTiming(cwd, sessionId)`, and pure `deriveSessionMetrics(snapshot)`; reuse `safeStore` plus lstat regular/no-symlink and 256 KiB checks to restore only a same-session v2 timing map. Extend the global publisher registry and `createTodoPublisher` reconciliation so live results emit v2 timing and `publishCurrentState` replays `SessionEntry.timestamp` from Pi 0.86.1 `getBranch()` entries. Preserve publisher methods and queued atomic-write behavior. Prerequisite: none. Finish when v2 writes satisfy D-1–D-4 and no live/replay path fabricates timing.
- [ ] S-2: In `extensions/otty-todos-view.mjs`, replace its v1-only snapshot validator with `parseTodoSnapshot` results and use `deriveSessionMetrics` in `renderSnapshot(snapshot, options)`. Change `activeOttySession` to return session ID plus agent state; render exactly the D-5 header/freshness labels, forecast sections, task-only malformed-timing frame, and v1/no-todos fallbacks. Preserve active-session selection and terminal safety. Prerequisite: S-1. Finish when every D-5/D-6 renderer state produces a terminal-safe deterministic frame.
- [ ] S-3: In `extensions/tests/otty-todos.test.mjs`, replace the hard-coded global renderer spawn path with a URL/path derived from this test file's `import.meta.url`, so the child process runs the repository renderer. Add fixtures/assertions for envelope rejection versus timing-only degradation, all timing transitions, Pi `SessionEntry.timestamp` replay, rollback, median/threshold/confidence/current-task/queue rules, exact D-5 header/freshness states, v1 fallback, and live v2 refresh. Do not reduce existing assertions. Prerequisites: S-1 and S-2 interfaces are finalized. Finish when `npm test` proves AC-1 through AC-6.
- [ ] S-4: Update `README.md` feature and behavior documentation for forecast semantics, privacy scope, estimate caveats, sample threshold, and the unchanged Otty installation command. Prerequisite: S-2. Finish when documented behavior matches D-7 and no instruction requires new configuration.
- [ ] S-5: On macOS with Pi 0.86.1, a configured noninteractive provider, and required network available, run from repository root `npm test` and `npm pack --dry-run`; then run the exact diagnostic-capture smoke command in Verification Plan. Expected result is exit 0, package contents include all extensions, and captured stderr has no extension-load error; model stdout is not asserted. Obtain an independent test-agent report and a separate read-only implementation review against the final commit before opening the pull request. Prerequisites: S-1 through S-4. Finish when all commands exit 0 and both reports find no unresolved issue.

### Acceptance-to-Verification Mapping

| Acceptance ID | Decisions | Steps | Verification and command source | Expected result |
| --- | --- | --- | --- | --- |
| AC-1 | D-1, D-2, D-6 | S-1, S-3 | New publisher transition/schema tests via `npm test` in repository root; existing `package.json` script | Exact safe v2 writes; prior atomic/path tests still pass. |
| AC-2 | D-4, D-5 | S-1, S-2, S-3 | New pure-metric and renderer-frame tests via `npm test` | Threshold-qualified v2 frame contains progress/current task/ETA/confidence. |
| AC-3 | D-2, D-4, D-5 | S-1, S-2, S-3 | New rollback/missing-timing/invalid-data tests via `npm test` | Todo stays visible; unsafe timing and ETA are omitted. |
| AC-4 | D-2, D-3 | S-1, S-3 | New branch entry timestamp fixtures via `npm test` | Replay uses valid entry time only and never live `now()`. |
| AC-5 | D-1, D-5 | S-2, S-3 | Existing and new v1 render tests via `npm test` | v1 snapshot retains grouped todo rendering without forecasts. |
| AC-6 | D-5, D-6 | S-2, S-3, S-5 | Existing selection/path/live-refresh contracts via `npm test`; package checks from Verification Plan | Active session and safety controls are preserved; package remains loadable. |

### Blockers and Escalation

None. Pi 0.86.1 supplies `entry.timestamp` on every `SessionEntry`; no alternate source is permitted. If a future Pi version violates that declared contract, stop S-1 and return the observed shape to the planner.

### Delivery Gates

- A separate test subagent owns new and updated test coverage and reports final command output; production implementation does not weaken test assertions.
- A separate read-only reviewer subagent with `read`, `grep`, `find`, `ls`, and `bash` capacity reviews the final commit and must report no unresolved implementation issue before PR creation.
- Required final-commit commands are the three checks in the Verification Plan, all from a clean repository root.
- Authenticated repository evidence on 2026-09-21: `gh api repos/ijse/pi-otty-todos/branches/main/protection` returns `404 Branch not protected`, and `.github/` has no workflow files; therefore no additional CI, deployment, or branch-protection gate exists beyond the named commands and reviews.
- Open one pull request from `feat/session-progress-forecast` to `main`; merge only after the tests and both independent reports are successful.

### Readiness

READY. The requirements are approved by the user, spec review passed on the third review, base commit is reproducible and clean, current source paths and runner were inspected, all decisions/acceptance/verification mappings are settled, and no external prerequisite is unresolved.
