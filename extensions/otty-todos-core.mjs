import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ACTIONS = new Set(["create", "update", "list", "get", "delete", "clear"]);
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const registryKey = Symbol.for("otty.todos.publisher.registry.v1");
const registry = globalThis[registryKey] ??= new Map();

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTask(task) {
  return plainObject(task)
    && Number.isFinite(task.id)
    && typeof task.subject === "string"
    && STATUSES.has(task.status)
    && (task.description === undefined || typeof task.description === "string")
    && (task.blockedBy === undefined || (Array.isArray(task.blockedBy) && task.blockedBy.every(Number.isFinite)));
}

export function validTaskDetails(details) {
  return plainObject(details)
    && !Object.hasOwn(details, "error")
    && ACTIONS.has(details.action)
    && plainObject(details.params)
    && Number.isFinite(details.nextId)
    && Array.isArray(details.tasks)
    && details.tasks.every(validTask);
}

function normalizeTasks(tasks) {
  return tasks.map((task) => {
    const value = { id: task.id, subject: task.subject, status: task.status };
    if (task.description !== undefined) value.description = task.description;
    if (task.blockedBy !== undefined) value.blockedBy = [...task.blockedBy];
    return value;
  });
}

function validTodoResult(event) {
  return event?.toolName === "todo" && event.isError !== true && validTaskDetails(event.details)
    ? event.details
    : null;
}

function sessionId(ctx) {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (file) return String(file).split("/").at(-1).replace(/\.jsonl$/, "");
  } catch {}
  return `pid-${process.pid}`;
}

async function lstatDirectory(path) {
  const stat = await lstat(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function ensureNormalDirectory(path) {
  try {
    if (!(await lstatDirectory(path))) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") return false;
    }
    if (!(await lstatDirectory(path))) return false;
  }
  if (process.platform !== "win32") await chmod(path, 0o700).catch(() => {});
  return true;
}

async function safeStore(cwd) {
  const canonicalCwd = await realpath(cwd);
  const piDir = join(canonicalCwd, ".pi");
  if (!(await ensureNormalDirectory(piDir))) return null;
  const store = join(piDir, "otty-todos");
  if (!(await ensureNormalDirectory(store))) return null;
  return { canonicalCwd, store };
}

async function atomicWrite(store, file, text) {
  const temp = join(store, `.${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temp, 0o600);
    await rename(temp, join(store, file));
    if (process.platform !== "win32") await chmod(join(store, file), 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

function enqueue(ctx, tasks, now, beforeCommit) {
  if (!ctx?.isProjectTrusted?.()) return;
  const session = sessionId(ctx);
  // Allocate the revision synchronously, before any path I/O can reorder calls.
  // `safeStore()` later canonicalizes the actual filesystem target.
  const key = `${resolve(ctx.cwd)}\0${session}`;
  let state = registry.get(key);
  if (!state) {
    state = { revision: 0, queue: Promise.resolve() };
    registry.set(key, state);
  }
  const revision = ++state.revision;
  const request = (async () => {
    const location = await safeStore(ctx.cwd);
    if (!location) return;
    const snapshot = {
      version: 1,
      sessionId: session,
      cwd: location.canonicalCwd,
      updatedAt: now(),
      tasks: normalizeTasks(tasks),
    };
    state.queue = state.queue.catch(() => {}).then(async () => {
      await beforeCommit?.({ revision, snapshot });
      if (state.revision !== revision) return;
      await atomicWrite(location.store, `${session}.json`, JSON.stringify(snapshot));
    }).catch(() => {});
    await state.queue;
  })().catch(() => {});
  return request;
}

export function createTodoPublisher({ now = Date.now, beforeCommit } = {}) {
  const pending = new Set();
  const schedule = (ctx, tasks) => {
    const job = enqueue(ctx, tasks, now, beforeCommit);
    if (!job) return;
    pending.add(job);
    job.finally(() => pending.delete(job));
  };
  return {
    handleToolResult(event, ctx) {
      const details = validTodoResult(event);
      if (details) schedule(ctx, details.tasks);
    },
    publishCurrentState(ctx) {
      let tasks = [];
      try {
        for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
          if (entry?.type !== "message") continue;
          const message = entry.message;
          const details = validTodoResult(message);
          if (message?.role === "toolResult" && details) tasks = details.tasks;
        }
      } catch {}
      schedule(ctx, tasks);
    },
    async waitForIdle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export { STATUSES };
