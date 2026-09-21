// Contract-first tests for Pi's project-local Otty todo snapshots.
//
// Required public, testable interfaces (intentionally explicit rather than
// inferred from an implementation):
//
//   ../otty-todos-core.mjs
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
//     export function renderSnapshot(snapshot): string
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
import test from "node:test";

const ROOT = "/Users/liyi/.pi/agent/extensions";
const CORE_URL = new URL("../otty-todos-core.mjs", import.meta.url).href;
const VIEW_URL = new URL("../otty-todos-view.mjs", import.meta.url).href;

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

function branchEntry(result) {
  return { type: "message", message: { role: "toolResult", ...result } };
}

function v1Snapshot(sessionId, updatedAt, tasks, cwd, extras = {}) {
  return { version: 1, sessionId, cwd, updatedAt, tasks, ...extras };
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

test("valid installed-harness TaskDetails produces the exact session-specific v1 snapshot", async (t) => {
  const { createTodoPublisher } = await core();
  assert.equal(typeof createTodoPublisher, "function");
  const cwd = await project(t);
  const publisher = createTodoPublisher({ now: () => 123456789 });
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
    version: 1,
    sessionId: "session-a",
    cwd: await realpath(cwd),
    updatedAt: 123456789,
    tasks: [
      { id: 1, subject: "first", description: "details", status: "in_progress", blockedBy: [9] },
      { id: 2, subject: "done", status: "completed" },
      { id: 3, subject: "gone", status: "deleted" },
    ],
  });
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

  const child = spawn(process.execPath, [join(ROOT, "otty-todos-view.mjs"), "--instance=contract-test", cwd], {
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
