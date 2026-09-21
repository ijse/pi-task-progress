// Contract-first tests for Pi's project-local Otty todo snapshots.
//
// Required public, testable interfaces (intentionally explicit rather than
// inferred from an implementation):
//
//   ../otty-todos-core.mjs
//     export function parseTodoSnapshot(value): object | null
//       Returns null for an invalid envelope/task list. For a valid v2 envelope
//       with an invalid taskTiming value, returns that snapshot with taskTiming:
//       {}. Valid v1 snapshots remain readable.
//     export async function readSessionTiming(cwd, sessionId): Promise<object>
//       Restores only an exact same-session valid-v2 timing map, or {}.
//     export function deriveSessionMetrics(snapshot): {
//       visibleTotal, completedTotal, progressPercent, sampleCount,
//       medianDurationMs, confidence, currentTask, currentTaskRemainingMs,
//       currentTaskProgressPercent, planRemainingMs, planCompletionAt,
//       nextTasks, blockedTask, forecastAvailable
//     }
//       Forecast fields are null and forecastAvailable is false when timing is
//       invalid or fewer than three usable duration samples exist.
//     export function createTodoPublisher(options?): {
//       handleToolResult(event, ctx): void | Promise<void>,
//       publishCurrentState(ctx): void | Promise<void>,
//       waitForIdle?(): Promise<void>
//     }
//     `options.now` supplies epoch milliseconds and `options.beforeCommit`, if
//     supplied, is awaited immediately before a queued atomic commit. They are
//     deliberately small deterministic test seams; production need not pass
//     either option.
//
//   ../otty-todos-view.mjs
//     export async function selectSnapshot(projectPath, options?): Promise<object|null>
//     When `options.activeSessionId` identifies a valid snapshot, that snapshot
//     takes precedence over the normal newest-valid selection.
//     export function renderSnapshot(snapshot, options?): string
//     The returned frame includes the renderer-owned ANSI home/erase redraw
//     controls.  The executable module may additionally refresh forever when
//     run as a program; importing it must not start a timer.
//
// These names are the independently specified integration surface for this
// test suite. They expose the behavior required by the approved design without
// making the tests depend on extension-framework registration internals.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CORE_URL = new URL("../otty-todos-core.mjs", import.meta.url).href;
const VIEW_URL = new URL("../otty-todos-view.mjs", import.meta.url).href;
const VIEW_PATH = fileURLToPath(new URL("../otty-todos-view.mjs", import.meta.url));

async function core() {
  return import(CORE_URL);
}

async function view() {
  return import(VIEW_URL);
}

async function project(t) {
  const path = await mkdtemp(join(tmpdir(), "otty-todos-contract-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function task(id, subject = `task ${id}`, overrides = {}) {
  return { id, subject, status: "pending", ...overrides };
}

function details(tasks, overrides = {}) {
  return {
    action: "update",
    params: {},
    nextId: 100,
    tasks,
    ...overrides,
  };
}

function todoResult(tasks, overrides = {}) {
  return { toolName: "todo", isError: false, details: details(tasks), ...overrides };
}

function context(cwd, options = {}) {
  const sessionFile = options.sessionFile ?? join(cwd, ".pi", "sessions", "session-a.jsonl");
  return {
    cwd,
    isProjectTrusted: () => options.trusted ?? true,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => options.branch ?? [],
    },
  };
}

async function settle(publisher) {
  // This is a public optional helper solely to make fire-and-forget I/O
  // observable. A short event-loop turn retains compatibility with a minimal
  // implementation that does not expose it.
  if (typeof publisher.waitForIdle === "function") await publisher.waitForIdle();
  else await new Promise((done) => setTimeout(done, 100));
}

function snapshotPath(cwd, session = "session-a") {
  return join(cwd, ".pi", "otty-todos", `${session}.json`);
}

async function snapshot(cwd, session) {
  return JSON.parse(await readFile(snapshotPath(cwd, session), "utf8"));
}

function branchEntry(result, timestamp) {
  const entry = { type: "message", message: { role: "toolResult", ...result } };
  if (timestamp !== undefined) entry.timestamp = timestamp;
  return entry;
}

function v1Snapshot(sessionId, updatedAt, tasks, cwd, extras = {}) {
  return { version: 1, sessionId, cwd, updatedAt, tasks, ...extras };
}

function v2Snapshot(sessionId, updatedAt, observedAt, tasks, cwd, taskTiming = {}, extras = {}) {
  return { version: 2, sessionId, cwd, updatedAt, observedAt, tasks, taskTiming, ...extras };
}

async function writeCandidate(cwd, name, value, mtimeMs = 1000) {
  const store = join(cwd, ".pi", "otty-todos");
  await mkdir(store, { recursive: true });
  const file = join(store, name);
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function delay(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(1000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function waitForOutput(child, output, expected, timeoutMs = 5000) {
  return new Promise((resolveWait, rejectWait) => {
    const fail = (reason) => {
      cleanup();
      rejectWait(new Error(`${reason}; stdout=${JSON.stringify(output())}`));
    };
    const check = () => {
      if (output().includes(expected)) {
        cleanup();
        resolveWait();
      }
    };
    const onData = () => check();
    const onExit = (code, signal) => fail(`renderer exited before emitting ${JSON.stringify(expected)} (code=${code}, signal=${signal})`);
    const onError = (error) => fail(`renderer failed before emitting ${JSON.stringify(expected)} (${error.message})`);
    const timer = setTimeout(() => fail(`timed out waiting for ${JSON.stringify(expected)}`), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
    else {
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
      check();
    }
  });
}

test("valid installed-harness TaskDetails produces the exact session-specific v2 snapshot", async (t) => {
  const { createTodoPublisher } = await core();
  assert.equal(typeof createTodoPublisher, "function");
  const cwd = await project(t);
  let clockCalls = 0;
  const publisher = createTodoPublisher({ now: () => { clockCalls += 1; return 123456789; } });
  const result = publisher.handleToolResult(todoResult([
    task(1, "first", { description: "details", status: "in_progress", blockedBy: [9] }),
    task(2, "done", { status: "completed" }),
    task(3, "gone", { status: "deleted" }),
  ]), context(cwd));

  // No test awaits the handler before inspecting the scheduling result. The
  // delayed-write test below proves any promise return is already settled rather
  // than awaiting file I/O.
  void result;
  await settle(publisher);
  assert.deepEqual(await snapshot(cwd), {
    version: 2,
    sessionId: "session-a",
    cwd: await realpath(cwd),
    updatedAt: 123456789,
    observedAt: 123456789,
    tasks: [
      { id: 1, subject: "first", description: "details", status: "in_progress", blockedBy: [9] },
      { id: 2, subject: "done", status: "completed" },
      { id: 3, subject: "gone", status: "deleted" },
    ],
    taskTiming: { 1: { startedAt: 123456789 }, 2: { completedAt: 123456789 } },
  });
  assert.equal(clockCalls, 1, "one live todo result must capture its observation time exactly once");
});

test("only a complete, error-free installed TaskDetails envelope is accepted", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  const publisher = createTodoPublisher({ now: () => 7 });
  const valid = todoResult([task(1)]);
  const invalid = [
    { toolName: "other", isError: false, details: valid.details },
    { ...valid, isError: true },
    { ...valid, details: { todos: [task(1)] } }, // tutorial-extension schema
    { ...valid, details: { ...valid.details, error: "in-band failure" } },
    { ...valid, details: { ...valid.details, action: "bogus" } },
    { ...valid, details: { ...valid.details, params: null } },
    { ...valid, details: { ...valid.details, params: [] } },
    { ...valid, details: { ...valid.details, nextId: "2" } },
    { ...valid, details: { ...valid.details, tasks: {} } },
    { ...valid, details: { ...valid.details, tasks: [task("1")] } },
    { ...valid, details: { ...valid.details, tasks: [task(1, 2)] } },
    { ...valid, details: { ...valid.details, tasks: [task(1, "x", { description: 9 })] } },
    { ...valid, details: { ...valid.details, tasks: [task(1, "x", { status: "blocked" })] } },
    { ...valid, details: { ...valid.details, tasks: [task(1, "x", { blockedBy: ["2"] })] } },
  ];
  for (const event of invalid) publisher.handleToolResult(event, context(cwd));
  await settle(publisher);
  await assert.rejects(readFile(snapshotPath(cwd)), { code: "ENOENT" });

  // An invalid later event must neither overwrite nor corrupt an existing valid
  // snapshot from the same session.
  publisher.handleToolResult(valid, context(cwd));
  await settle(publisher);
  publisher.handleToolResult(invalid.at(-1), context(cwd));
  await settle(publisher);
  assert.deepEqual((await snapshot(cwd)).tasks, [task(1)]);
});

test("all installed-harness TaskDetails actions are accepted", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  const publisher = createTodoPublisher({ now: () => 77 });
  for (const action of ["create", "update", "list", "get", "delete", "clear"]) {
    publisher.handleToolResult(todoResult([task(1, action)], { details: details([task(1, action)], { action }) }), context(cwd));
  }
  await settle(publisher);
  assert.equal((await snapshot(cwd)).tasks[0].subject, "clear");
});

test("branch replay selects the last valid todo tool-result and writes an empty state when none exists", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  const publisher = createTodoPublisher({ now: () => 88 });
  const oldResult = todoResult([task(1, "old")]);
  const newestResult = todoResult([task(2, "new", { status: "completed" })]);
  const ignored = branchEntry({ toolName: "todo", isError: true, details: details([task(99)]) });
  const ctx = context(cwd, {
    branch: [
      { type: "message", message: { role: "assistant", toolName: "todo", details: oldResult.details } },
      branchEntry(oldResult),
      ignored,
      branchEntry(newestResult),
      branchEntry({ toolName: "other", isError: false, details: newestResult.details }),
    ],
  });
  publisher.publishCurrentState(ctx);
  await settle(publisher);
  assert.deepEqual((await snapshot(cwd)).tasks, [task(2, "new", { status: "completed" })]);

  const emptyCwd = await project(t);
  publisher.publishCurrentState(context(emptyCwd, { branch: [ignored, { nope: true }] }));
  await settle(publisher);
  assert.deepEqual((await snapshot(emptyCwd)).tasks, []);
});

test("same-session queued writes are nonblocking, atomic, and newest revision wins even across publisher rebinding", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  const ctx = context(cwd);
  const base = createTodoPublisher({ now: () => 0 });
  base.handleToolResult(todoResult([task(0, "previous complete snapshot")]), ctx);
  await settle(base);

  let releaseFirst;
  const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
  const first = createTodoPublisher({
    now: () => 1,
    beforeCommit: async ({ revision }) => { if (revision === 2) await firstGate; },
  });
  const second = createTodoPublisher({ now: () => 2 });
  const returned = first.handleToolResult(todoResult([task(1, "stale")]), ctx);
  const settledBeforeIo = await Promise.race([
    Promise.resolve(returned).then(() => true),
    new Promise((done) => setTimeout(() => done(false), 25)),
  ]);
  assert.equal(settledBeforeIo, true, "tool_result handler must return before delayed file I/O");
  await new Promise((done) => setTimeout(done, 10));
  // A direct/truncating write would expose partial JSON here. The old snapshot
  // remains readable until the delayed temporary file is atomically renamed.
  assert.deepEqual((await snapshot(cwd)).tasks, [task(0, "previous complete snapshot")]);

  second.handleToolResult(todoResult([task(2, "latest")]), ctx);
  releaseFirst();
  await settle(first);
  await settle(second);
  assert.deepEqual((await snapshot(cwd)).tasks, [task(2, "latest")]);
  assert.equal((await snapshot(cwd)).updatedAt, 2);

  const entries = await readdir(join(cwd, ".pi", "otty-todos"));
  assert.deepEqual(entries.sort(), ["session-a.json"], "atomic temporary files must not remain in the store");
});

test("publishing is refused for untrusted or symlinked paths and creates restrictive POSIX store permissions", async (t) => {
  const { createTodoPublisher } = await core();
  const publisher = createTodoPublisher({ now: () => 1 });

  const untrusted = await project(t);
  publisher.handleToolResult(todoResult([task(1)]), context(untrusted, { trusted: false }));
  await settle(publisher);
  await assert.rejects(lstat(join(untrusted, ".pi")), { code: "ENOENT" });

  const linkedPi = await project(t);
  const outside = await project(t);
  await symlink(outside, join(linkedPi, ".pi"));
  publisher.handleToolResult(todoResult([task(1)]), context(linkedPi));
  await settle(publisher);
  await assert.rejects(lstat(join(outside, "otty-todos", "session-a.json")), { code: "ENOENT" });

  const linkedStore = await project(t);
  await mkdir(join(linkedStore, ".pi"));
  await symlink(outside, join(linkedStore, ".pi", "otty-todos"));
  publisher.handleToolResult(todoResult([task(1)]), context(linkedStore));
  await settle(publisher);
  await assert.rejects(lstat(join(outside, "session-a.json")), { code: "ENOENT" });

  const modes = await project(t);
  publisher.handleToolResult(todoResult([task(1)]), context(modes));
  await settle(publisher);
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(modes, ".pi", "otty-todos"))).mode & 0o777, 0o700);
    assert.equal((await lstat(snapshotPath(modes))).mode & 0o777, 0o600);
  }
});

test("canonical cwd prevents a symlink spelling from creating a second project store", async (t) => {
  const { createTodoPublisher } = await core();
  const realProject = await project(t);
  const aliasParent = await project(t);
  const alias = join(aliasParent, "project-alias");
  await symlink(realProject, alias);
  const publisher = createTodoPublisher({ now: () => 1 });
  publisher.handleToolResult(todoResult([task(1)]), context(alias));
  await settle(publisher);
  assert.equal((await snapshot(realProject)).cwd, await realpath(realProject));
  // `alias/.pi` necessarily resolves to the same directory as `realProject/.pi`;
  // the canonical `cwd` recorded above is the externally observable proof that
  // the symlink spelling was not retained as a separate project identity.
});

test("renderer selects only exact valid regular v1 snapshots by update time, mtime, then session ID", async (t) => {
  const { selectSnapshot } = await view();
  assert.equal(typeof selectSnapshot, "function");
  const cwd = await project(t);
  await writeCandidate(cwd, "old.json", v1Snapshot("old", 9, [task(1)], cwd), 5000);
  await writeCandidate(cwd, "time-winner.json", v1Snapshot("time-winner", 10, [task(2)], cwd), 1000);
  await writeCandidate(cwd, "mtime-winner.json", v1Snapshot("mtime-winner", 10, [task(3)], cwd), 2000);
  await writeCandidate(cwd, "z-winner.json", v1Snapshot("z-winner", 10, [task(4)], cwd), 2000);
  await writeCandidate(cwd, "bad-json.json", "{", 9999);
  await writeCandidate(cwd, "bad-version.json", v1Snapshot("bad", 100, [], cwd, { version: 2 }));
  await writeCandidate(cwd, "extra-field.json", v1Snapshot("extra", 100, [], cwd, { surprise: true }));
  await writeCandidate(cwd, "bad-task.json", v1Snapshot("bad-task", 100, [task(1, "x", { status: "wrong" })], cwd));
  await writeCandidate(cwd, "too-big.json", "x".repeat(256 * 1024 + 1));
  await symlink(join(cwd, ".pi", "otty-todos", "z-winner.json"), join(cwd, ".pi", "otty-todos", "linked.json"));

  const selected = await selectSnapshot(cwd);
  assert.equal(selected.sessionId, "z-winner");
  assert.deepEqual(selected.tasks, [task(4)]);
});

test("renderer prefers a valid active-session snapshot and otherwise uses the newest valid snapshot", async (t) => {
  const { selectSnapshot } = await view();
  const cwd = await project(t);
  await writeCandidate(cwd, "active.json", v1Snapshot("active", 10, [task(1)], cwd), 1000);
  await writeCandidate(cwd, "newest.json", v1Snapshot("newest", 20, [task(2)], cwd), 2000);
  await writeCandidate(cwd, "invalid-active.json", v1Snapshot("invalid-active", 30, [task(3, "bad", { status: "wrong" })], cwd), 3000);

  assert.equal((await selectSnapshot(cwd, { activeSessionId: "active" })).sessionId, "active");
  assert.equal((await selectSnapshot(cwd, { activeSessionId: "missing" })).sessionId, "newest");
  assert.equal((await selectSnapshot(cwd, { activeSessionId: "invalid-active" })).sessionId, "newest");
});

test("renderer refuses symlinked .pi and store paths and returns empty state when no valid snapshot exists", async (t) => {
  const { selectSnapshot, renderSnapshot } = await view();
  assert.equal(typeof renderSnapshot, "function");
  const empty = await project(t);
  assert.equal(await selectSnapshot(empty), null);
  assert.match(renderSnapshot(null), /no .*todo/i);

  const linkedPi = await project(t);
  const outside = await project(t);
  await mkdir(join(outside, ".pi", "otty-todos"), { recursive: true });
  await symlink(join(outside, ".pi"), join(linkedPi, ".pi"));
  assert.equal(await selectSnapshot(linkedPi), null);

  const linkedStore = await project(t);
  await mkdir(join(linkedStore, ".pi"));
  await symlink(join(outside, ".pi", "otty-todos"), join(linkedStore, ".pi", "otty-todos"));
  assert.equal(await selectSnapshot(linkedStore), null);
});

test("standalone renderer refreshes its frame after a snapshot revision", { timeout: 8000 }, async (t) => {
  const cwd = await project(t);
  const sessionId = "live-refresh";
  const initialSubject = "initial standalone frame";
  const refreshedSubject = "refreshed standalone frame";
  await writeCandidate(cwd, `${sessionId}.json`, v1Snapshot(sessionId, 100, [
    task(1, initialSubject, { status: "pending" }),
  ], cwd));

  const child = spawn(process.execPath, [VIEW_PATH, "--instance=contract-test", cwd], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  // Consume stderr so a launch failure cannot block the child on a full pipe.
  child.stderr.resume();
  t.after(() => terminate(child));

  try {
    await waitForOutput(child, () => stdout, `○ #1 ${initialSubject}`);
    const outputBeforeRevision = stdout.length;
    await writeCandidate(cwd, `${sessionId}.json`, v1Snapshot(sessionId, 200, [
      task(2, refreshedSubject, { status: "completed" }),
    ], cwd));

    // The new completed marker and progress prove both the changed task and its
    // status came from a redraw that occurred after the initial frame.
    await waitForOutput(child, () => stdout.slice(outputBeforeRevision), `✓ #2 ${refreshedSubject}`);
    assert.match(stdout.slice(outputBeforeRevision), /1 \/ 1 completed/);
  } finally {
    await terminate(child);
  }
});

test("renderer groups visible tasks, excludes deleted tasks, and sanitizes terminal/control/bidi input", async (t) => {
  const { renderSnapshot } = await view();
  const frame = renderSnapshot(v1Snapshot("render", 1, [
    task(9, "done", { status: "completed" }),
    task(8, "deleted", { status: "deleted" }),
    task(7, "open", { status: "pending" }),
    task(6, "blocked", { status: "pending", blockedBy: [99] }),
    task(5, "working\u001b[31m RED\u001b[0m\nnext\tcell\u202E", { status: "in_progress" }),
    task(4, "unblocked-by-completed", { status: "pending", blockedBy: [9] }),
  ], "/project"));

  // A frame must take ownership of cursor movement/erasure rather than trust
  // snapshot input to supply terminal escapes.
  assert.match(frame, /\x1b\[H/);
  assert.match(frame, /\x1b\[[0-9;]*[JK]/);
  assert.match(frame, /1\s*\/\s*5/, "deleted tasks are absent from the progress denominator");
  assert.doesNotMatch(frame, /deleted/);
  assert.doesNotMatch(frame, /\x1b\[31m|\x1b\]0|\u202e|\r|\nnext|\t/);
  assert.match(frame, /working RED next cell/);

  // Group order is in-progress, blocked pending, unblocked pending, completed;
  // numeric IDs must be ascending inside each group (7 before 4 would be wrong
  // only if the renderer failed to group before sorting).
  const pos = (text) => frame.indexOf(text);
  assert.ok(pos("working RED") < pos("blocked"));
  assert.ok(pos("blocked") < pos("unblocked-by-completed"));
  assert.ok(pos("unblocked-by-completed") < pos("done"));
  assert.ok(pos("unblocked-by-completed") < pos("open"), "unblocked group is sorted numerically by id");
});

test("v2 parser rejects malformed envelopes and degrades malformed timing without hiding todos", async () => {
  const { parseTodoSnapshot } = await core();
  assert.equal(typeof parseTodoSnapshot, "function");

  const valid = v2Snapshot("v2-session", 100, 100, [
    task(1, "finished", { status: "completed" }),
    task(2, "running", { status: "in_progress" }),
  ], "/canonical/project", {
    1: { startedAt: 10, completedAt: 100 },
    2: { startedAt: 90 },
  });
  assert.deepEqual(parseTodoSnapshot(valid), valid);
  assert.deepEqual(parseTodoSnapshot(v1Snapshot("legacy", 10, [task(1)], "/canonical/project")),
    v1Snapshot("legacy", 10, [task(1)], "/canonical/project"));

  const invalidEnvelopes = [
    { ...valid, extra: true },
    (() => { const { taskTiming, ...withoutTiming } = valid; return withoutTiming; })(),
    { ...valid, version: 3 },
    { ...valid, sessionId: "" },
    { ...valid, cwd: "" },
    { ...valid, updatedAt: 1.5 },
    { ...valid, observedAt: -1 },
    { ...valid, observedAt: 1.5 },
    { ...valid, tasks: {} },
    { ...valid, tasks: [task(1, "wrong", { status: "unknown" })] },
  ];
  for (const candidate of invalidEnvelopes) {
    assert.equal(parseTodoSnapshot(candidate), null, `invalid envelope must be rejected: ${JSON.stringify(candidate)}`);
  }

  const malformedTiming = [
    { 99: { startedAt: 1 } },
    { 1: {} },
    { nope: { startedAt: 1 } },
    { 1: { startedAt: -1 } },
    { 1: { startedAt: 1.5 } },
    { 1: { startedAt: 100, completedAt: 99 } },
    { 1: { startedAt: 1, completedAt: 2, extra: true } },
  ];
  for (const taskTiming of malformedTiming) {
    assert.deepEqual(parseTodoSnapshot({ ...valid, taskTiming }), { ...valid, taskTiming: {} },
      `malformed timing must degrade to the task-only v2 state: ${JSON.stringify(taskTiming)}`);
  }
});

test("readSessionTiming restores only an exact same-project v2 timing map", async (t) => {
  const { readSessionTiming } = await core();
  assert.equal(typeof readSessionTiming, "function");
  const cwd = await project(t);
  const canonicalCwd = await realpath(cwd);
  const timing = { 1: { startedAt: 10, completedAt: 20 } };

  await writeCandidate(cwd, "session-a.json", v2Snapshot("session-a", 20, 20, [
    task(1, "done", { status: "completed" }),
  ], canonicalCwd, timing));
  assert.deepEqual(await readSessionTiming(cwd, "session-a"), timing);

  await writeCandidate(cwd, "session-a.json", v2Snapshot("another-session", 20, 20, [
    task(1, "done", { status: "completed" }),
  ], canonicalCwd, timing));
  assert.deepEqual(await readSessionTiming(cwd, "session-a"), {}, "a filename is not a session identity");

  await writeCandidate(cwd, "session-a.json", v2Snapshot("session-a", 20, 20, [
    task(1, "done", { status: "completed" }),
  ], "/different/project", timing));
  assert.deepEqual(await readSessionTiming(cwd, "session-a"), {}, "a foreign cwd snapshot must not seed this project");

  await writeCandidate(cwd, "session-a.json", v2Snapshot("session-a", 20, 20, [
    task(1, "done", { status: "completed" }),
  ], canonicalCwd, { 1: { startedAt: 30, completedAt: 20 } }));
  assert.deepEqual(await readSessionTiming(cwd, "session-a"), {}, "bad timing is never partially restored");
});

test("live publisher reconciles start, completion, reopening, pause, deletion, disappearance, and hot reload timing", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  let now = 10;
  const publisher = createTodoPublisher({ now: () => now });
  const ctx = context(cwd);
  const publish = async (tasks) => {
    publisher.handleToolResult(todoResult(tasks), ctx);
    await settle(publisher);
    return snapshot(cwd);
  };

  assert.deepEqual((await publish([task(1, "work", { status: "in_progress" })])).taskTiming,
    { 1: { startedAt: 10 } });
  now = 20;
  assert.deepEqual((await publish([task(1, "work", { status: "completed" })])).taskTiming,
    { 1: { startedAt: 10, completedAt: 20 } });
  now = 30;
  assert.deepEqual((await publish([task(1, "work", { status: "in_progress" })])).taskTiming,
    { 1: { startedAt: 10 } }, "reopening keeps only an in-progress start");
  now = 40;
  assert.deepEqual((await publish([task(1, "work", { status: "pending" })])).taskTiming, {},
    "pausing an in-progress task drops its stale timing");
  now = 50;
  assert.deepEqual((await publish([task(1, "work", { status: "in_progress" })])).taskTiming,
    { 1: { startedAt: 50 } }, "a restart gets a new start time");
  now = 60;
  assert.deepEqual((await publish([task(1, "work", { status: "deleted" })])).taskTiming, {},
    "deletion removes timing");
  now = 70;
  await publish([task(2, "disappears", { status: "in_progress" })]);
  now = 80;
  assert.deepEqual((await publish([])).taskTiming, {}, "a disappeared task removes timing");

  const restoredCwd = await project(t);
  const canonicalRestoredCwd = await realpath(restoredCwd);
  await writeCandidate(restoredCwd, "session-a.json", v2Snapshot("session-a", 5, 5, [
    task(3, "restored", { status: "in_progress" }),
  ], canonicalRestoredCwd, { 3: { startedAt: 5 } }));
  const reloaded = createTodoPublisher({ now: () => 100 });
  reloaded.handleToolResult(todoResult([task(3, "restored", { status: "in_progress" })]), context(restoredCwd));
  await settle(reloaded);
  assert.deepEqual((await snapshot(restoredCwd)).taskTiming, { 3: { startedAt: 5 } },
    "a publisher hot reload restores valid selected-session timing before live reconciliation");
});

test("clock rollback clears affected timing without discarding the live todo state", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  let now = 100;
  const publisher = createTodoPublisher({ now: () => now });
  const ctx = context(cwd);
  publisher.handleToolResult(todoResult([task(1, "rollback", { status: "in_progress" })]), ctx);
  await settle(publisher);

  now = 90;
  publisher.handleToolResult(todoResult([task(1, "rollback", { status: "completed" })]), ctx);
  await settle(publisher);
  const rolledBack = await snapshot(cwd);
  assert.deepEqual(rolledBack.tasks, [task(1, "rollback", { status: "completed" })]);
  assert.deepEqual(rolledBack.taskTiming, {});
  assert.equal(rolledBack.observedAt, 90);

  now = 110;
  publisher.handleToolResult(todoResult([task(1, "rollback", { status: "in_progress" })]), ctx);
  await settle(publisher);
  assert.deepEqual((await snapshot(cwd)).taskTiming, { 1: { startedAt: 110 } },
    "a later live observation starts fresh instead of retaining a negative interval");
});

test("branch replay uses only valid entry timestamps and never the live clock", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  const publisher = createTodoPublisher({
    now: () => { throw new Error("branch replay must not call now()"); },
  });
  publisher.publishCurrentState(context(cwd, {
    branch: [
      branchEntry(todoResult([task(1, "replayed", { status: "in_progress" })]), "1970-01-01T00:00:01.000Z"),
      branchEntry(todoResult([task(1, "replayed", { status: "completed" })]), "1970-01-01T00:00:04.000Z"),
    ],
  }));
  await settle(publisher);
  const replayed = await snapshot(cwd);
  assert.equal(replayed.observedAt, 4000);
  assert.deepEqual(replayed.taskTiming, { 1: { startedAt: 1000, completedAt: 4000 } });
});

test("missing, invalid, pre-epoch, and backward replay timestamps withhold timing until a later live transition", async (t) => {
  const { createTodoPublisher } = await core();
  const cwd = await project(t);
  let replaying = true;
  let now = 6000;
  const publisher = createTodoPublisher({
    now: () => {
      if (replaying) throw new Error("branch replay must not call now()");
      return now;
    },
  });
  const completed = (id, subject) => task(id, subject, { status: "completed" });
  publisher.publishCurrentState(context(cwd, {
    branch: [
      branchEntry(todoResult([task(1, "missing", { status: "in_progress" })]), "1970-01-01T00:00:01.000Z"),
      branchEntry(todoResult([completed(1, "missing"), task(2, "invalid", { status: "in_progress" })])),
      branchEntry(todoResult([completed(1, "missing"), completed(2, "invalid"), task(3, "pre-epoch", { status: "in_progress" })]), "not-a-timestamp"),
      branchEntry(todoResult([completed(1, "missing"), completed(2, "invalid"), completed(3, "pre-epoch"), task(4, "backward", { status: "in_progress" })]), "1969-12-31T23:59:59.000Z"),
      branchEntry(todoResult([completed(1, "missing"), completed(2, "invalid"), completed(3, "pre-epoch"), completed(4, "backward"), task(5, "backward", { status: "in_progress" })]), "1970-01-01T00:00:05.000Z"),
      branchEntry(todoResult([completed(1, "missing"), completed(2, "invalid"), completed(3, "pre-epoch"), completed(4, "backward"), completed(5, "backward")]), "1970-01-01T00:00:04.000Z"),
    ],
  }));
  await settle(publisher);
  assert.deepEqual((await snapshot(cwd)).taskTiming, {},
    "no timing sample may be fabricated from missing, unparsable, negative, or backward history");

  replaying = false;
  publisher.handleToolResult(todoResult([task(1, "missing", { status: "in_progress" })]), context(cwd));
  await settle(publisher);
  assert.deepEqual((await snapshot(cwd)).taskTiming, { 1: { startedAt: 6000 } });
  now = 7000;
  publisher.handleToolResult(todoResult([task(1, "missing", { status: "completed" })]), context(cwd));
  await settle(publisher);
  assert.deepEqual((await snapshot(cwd)).taskTiming, { 1: { startedAt: 6000, completedAt: 7000 } });
});

function forecastFixture({ observedAt = 600000, taskTiming, tasks } = {}) {
  const defaultTasks = [
    task(1, "one", { status: "completed" }),
    task(2, "two", { status: "completed" }),
    task(3, "three", { status: "completed" }),
    task(4, "active", { status: "in_progress" }),
    task(5, "next", { status: "pending", blockedBy: [1] }),
    task(10, "also running", { status: "in_progress" }),
  ];
  const defaultTiming = {
    1: { startedAt: 0, completedAt: 60000 },
    2: { startedAt: 0, completedAt: 180000 },
    3: { startedAt: 0, completedAt: 300000 },
    4: { startedAt: 480000 },
    10: { startedAt: 500000 },
  };
  return v2Snapshot("metrics", observedAt, observedAt, tasks ?? defaultTasks, "/project", taskTiming ?? defaultTiming);
}

function completedSampleSnapshot(count, observedAt = 100000) {
  const tasks = [];
  const taskTiming = {};
  for (let id = 1; id <= count; id += 1) {
    tasks.push(task(id, `sample ${id}`, { status: "completed" }));
    taskTiming[id] = { startedAt: 0, completedAt: id * 1000 };
  }
  return v2Snapshot("samples", observedAt, observedAt, tasks, "/project", taskTiming);
}

test("derived metrics use the visible median, three-sample threshold, all running work, and confidence bands", async () => {
  const { deriveSessionMetrics } = await core();
  assert.equal(typeof deriveSessionMetrics, "function");
  const metrics = deriveSessionMetrics(forecastFixture());
  assert.equal(metrics.visibleTotal, 6);
  assert.equal(metrics.completedTotal, 3);
  assert.equal(metrics.progressPercent, 50);
  assert.equal(metrics.sampleCount, 3);
  assert.equal(metrics.medianDurationMs, 180000);
  assert.equal(metrics.confidence, "low");
  assert.equal(metrics.forecastAvailable, true);
  assert.equal(metrics.currentTask.id, 4, "the lowest numeric in-progress ID is highlighted");
  assert.equal(metrics.currentTaskRemainingMs, 60000);
  assert.equal(metrics.planRemainingMs, 420000,
    "the other running task and the pending task count as planned work");
  assert.equal(metrics.planCompletionAt, 1020000);
  assert.deepEqual(metrics.nextTasks.map((item) => item.id), [5]);
  assert.equal(metrics.blockedTask, null);

  const threshold = deriveSessionMetrics(completedSampleSnapshot(2));
  assert.equal(threshold.sampleCount, 2);
  assert.equal(threshold.forecastAvailable, false);
  assert.equal(threshold.medianDurationMs, null);
  assert.equal(threshold.planRemainingMs, null);
  assert.equal(threshold.planCompletionAt, null);

  for (const [count, confidence] of [[3, "low"], [4, "low"], [5, "medium"], [9, "medium"], [10, "high"]]) {
    const sampleMetrics = deriveSessionMetrics(completedSampleSnapshot(count));
    assert.equal(sampleMetrics.confidence, confidence, `${count} samples has ${confidence} confidence`);
    assert.equal(sampleMetrics.forecastAvailable, true);
  }
});

test("derived metrics cap current progress, keep missing current timing explicit, and return a deterministic next-task queue", async () => {
  const { deriveSessionMetrics } = await core();
  const elapsed = deriveSessionMetrics(forecastFixture({ observedAt: 1000000, taskTiming: {
    1: { startedAt: 0, completedAt: 60000 },
    2: { startedAt: 0, completedAt: 180000 },
    3: { startedAt: 0, completedAt: 300000 },
    4: { startedAt: 0 },
  } }));
  assert.equal(elapsed.currentTaskRemainingMs, 0);
  assert.equal(elapsed.currentTaskProgressPercent, 95, "an in-progress card never visually reaches 100%");

  const missingStart = deriveSessionMetrics(forecastFixture({ taskTiming: {
    1: { startedAt: 0, completedAt: 60000 },
    2: { startedAt: 0, completedAt: 180000 },
    3: { startedAt: 0, completedAt: 300000 },
  } }));
  assert.equal(missingStart.forecastAvailable, true);
  assert.equal(missingStart.currentTask.id, 4);
  assert.equal(missingStart.currentTaskRemainingMs, 180000);
  assert.equal(missingStart.currentTaskProgressPercent, null);

  const queued = deriveSessionMetrics(forecastFixture({ tasks: [
    task(1, "done", { status: "completed" }),
    task(2, "done", { status: "completed" }),
    task(3, "done", { status: "completed" }),
    task(20, "later", { status: "pending", blockedBy: [1] }),
    task(8, "first", { status: "pending", blockedBy: [2] }),
    task(30, "third", { status: "pending", blockedBy: [3] }),
  ], taskTiming: {
    1: { startedAt: 0, completedAt: 60000 },
    2: { startedAt: 0, completedAt: 180000 },
    3: { startedAt: 0, completedAt: 300000 },
  } }));
  assert.deepEqual(queued.nextTasks.map((item) => item.id), [8, 20]);
  assert.equal(queued.blockedTask, null);

  const allBlocked = deriveSessionMetrics(forecastFixture({ tasks: [
    task(1, "done", { status: "completed" }),
    task(2, "done", { status: "completed" }),
    task(3, "done", { status: "completed" }),
    task(9, "later blocked", { status: "pending", blockedBy: [99] }),
    task(7, "first blocked", { status: "pending", blockedBy: [77] }),
  ], taskTiming: {
    1: { startedAt: 0, completedAt: 60000 },
    2: { startedAt: 0, completedAt: 180000 },
    3: { startedAt: 0, completedAt: 300000 },
  } }));
  assert.deepEqual(allBlocked.nextTasks, []);
  assert.equal(allBlocked.blockedTask.id, 7);
  assert.equal(allBlocked.planRemainingMs, 360000, "blocked tasks remain planned work in the full-plan forecast");

  const invalidTiming = deriveSessionMetrics(forecastFixture({ taskTiming: {
    1: { startedAt: 100, completedAt: 50 },
    2: { startedAt: 0, completedAt: 180000 },
    3: { startedAt: 0, completedAt: 300000 },
  } }));
  assert.equal(invalidTiming.forecastAvailable, false);
  assert.equal(invalidTiming.medianDurationMs, null);
  assert.equal(invalidTiming.planCompletionAt, null);
});

test("renderer selects an exact v2 envelope while degrading malformed timing to a task-only state", async (t) => {
  const { selectSnapshot, renderSnapshot } = await view();
  const cwd = await project(t);
  const canonicalCwd = await realpath(cwd);
  await writeCandidate(cwd, "valid-v2.json", v2Snapshot("valid-v2", 10, 10, [
    task(1, "valid timing", { status: "completed" }),
  ], canonicalCwd, { 1: { startedAt: 0, completedAt: 10 } }));
  await writeCandidate(cwd, "degraded-v2.json", v2Snapshot("degraded-v2", 20, 20, [
    task(2, "timing is safely absent", { status: "pending" }),
  ], canonicalCwd, { 99: { startedAt: 1 } }));
  await writeCandidate(cwd, "bad-v2.json", v2Snapshot("bad-v2", 30, 30, [
    task(3, "must not select", { status: "pending" }),
  ], canonicalCwd, {}, { unexpected: true }));

  const selected = await selectSnapshot(cwd);
  assert.equal(selected.sessionId, "degraded-v2");
  assert.deepEqual(selected.taskTiming, {});
  const frame = renderSnapshot(selected, {
    now: () => 20,
    activeSession: { sessionId: "degraded-v2", agentState: "processing" },
  });
  assert.match(frame, /timing is safely absent/);
  assert.match(frame, /(?:Timing unavailable|Collecting samples)/);
  assert.doesNotMatch(frame, /Estimated/);
});

test("v2 renderer uses exact active/snapshot status and freshness fallback text", async () => {
  const { renderSnapshot } = await view();
  const snapshotValue = forecastFixture({ observedAt: 1000 });
  const render = (now, activeSession) => renderSnapshot(snapshotValue, { now: () => now, activeSession });

  const running = render(1000, { sessionId: "metrics", agentState: "processing" });
  assert.match(running, /PI \/ ACTIVE SESSION/);
  assert.match(running, /RUNNING/);
  assert.match(running, /UPDATED <1s AGO/);
  assert.match(running, /Estimated/);
  assert.match(running, /3 samples/i);
  assert.match(running, /low/i);

  assert.match(render(2000, { sessionId: "metrics", agentState: "processing" }), /UPDATED 1s AGO/);
  assert.match(render(11000, { sessionId: "metrics", agentState: "processing" }), /UPDATED 10s AGO/);
  assert.match(render(12000, { sessionId: "metrics", agentState: "processing" }), /STALE · 11s AGO/);

  const idle = render(1000, { sessionId: "metrics", agentState: "waiting" });
  assert.match(idle, /PI \/ ACTIVE SESSION/);
  assert.match(idle, /IDLE/);

  const noMatchingPane = render(1000, { sessionId: "other-session", agentState: "processing" });
  assert.match(noMatchingPane, /PI \/ SESSION SNAPSHOT/);
  assert.match(noMatchingPane, /SNAPSHOT/);
  const cliFailure = render(1000, undefined);
  assert.match(cliFailure, /PI \/ SESSION SNAPSHOT/);
  assert.match(cliFailure, /SNAPSHOT/);

  const clockUnknown = render(999, { sessionId: "metrics", agentState: "processing" });
  assert.match(clockUnknown, /CLOCK UNKNOWN/);
  assert.doesNotMatch(clockUnknown, /Estimated|Elapsed|ETA/i,
    "a rollback at display time withholds every forecast/time-progress value");
});

test("v1 rendering remains header-free and v2 below threshold retains todos without forecast text", async () => {
  const { renderSnapshot } = await view();
  const legacy = renderSnapshot(v1Snapshot("legacy", 1, [
    task(1, "legacy pending"),
    task(2, "legacy done", { status: "completed" }),
  ], "/project"));
  assert.match(legacy, /Pi todos/);
  assert.match(legacy, /legacy pending/);
  assert.doesNotMatch(legacy, /PI \/ (?:ACTIVE SESSION|SESSION SNAPSHOT)|Estimated|Collecting samples|Timing unavailable/);

  const collecting = renderSnapshot(completedSampleSnapshot(2), {
    now: () => 100000,
    activeSession: { sessionId: "samples", agentState: "processing" },
  });
  assert.match(collecting, /PI \/ ACTIVE SESSION/);
  assert.match(collecting, /Collecting samples/);
  assert.match(collecting, /sample 1/);
  assert.doesNotMatch(collecting, /Estimated/);
});

test("standalone renderer refreshes a v2 forecast frame after a snapshot revision", { timeout: 8000 }, async (t) => {
  const cwd = await project(t);
  const sessionId = "live-v2-refresh";
  const initialSubject = "initial v2 standalone frame";
  const refreshedSubject = "refreshed v2 standalone frame";
  const canonicalCwd = await realpath(cwd);
  const completedTasks = [
    task(1, "first sample", { status: "completed" }),
    task(2, "second sample", { status: "completed" }),
    task(3, "third sample", { status: "completed" }),
  ];
  const sampleTiming = {
    1: { startedAt: 0, completedAt: 60000 },
    2: { startedAt: 0, completedAt: 180000 },
    3: { startedAt: 0, completedAt: 300000 },
  };
  await writeCandidate(cwd, `${sessionId}.json`, v2Snapshot(sessionId, 100, 300000, [
    ...completedTasks,
    task(4, initialSubject),
  ], canonicalCwd, sampleTiming));

  const child = spawn(process.execPath, [VIEW_PATH, "--instance=contract-v2-test", cwd], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.resume();
  t.after(() => terminate(child));

  try {
    await waitForOutput(child, () => stdout, `○ #4 ${initialSubject}`);
    assert.match(stdout, /PI \/ SESSION SNAPSHOT/);
    const outputBeforeRevision = stdout.length;
    await writeCandidate(cwd, `${sessionId}.json`, v2Snapshot(sessionId, 200, 300000, [
      ...completedTasks,
      task(4, refreshedSubject, { status: "completed" }),
    ], canonicalCwd, sampleTiming));
    await waitForOutput(child, () => stdout.slice(outputBeforeRevision), `✓ #4 ${refreshedSubject}`);
    assert.match(stdout.slice(outputBeforeRevision), /4 \/ 4 completed/);
  } finally {
    await terminate(child);
  }
});
