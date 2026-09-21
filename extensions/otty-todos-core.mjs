import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const ACTIONS = new Set(["create", "update", "list", "get", "delete", "clear"]);
export const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const MAX_BYTES = 256 * 1024;
const registryKey = Symbol.for("otty.todos.publisher.registry.v2");
const registry = globalThis[registryKey] ??= new Map();

function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value) { return Number.isInteger(value) && value >= 0; }
function validTask(task) {
  return plainObject(task) && Number.isFinite(task.id) && typeof task.subject === "string" && STATUSES.has(task.status)
    && (task.description === undefined || typeof task.description === "string")
    && (task.blockedBy === undefined || (Array.isArray(task.blockedBy) && task.blockedBy.every(Number.isFinite)));
}
export function validTaskDetails(details) {
  return plainObject(details) && !Object.hasOwn(details, "error") && ACTIONS.has(details.action) && plainObject(details.params)
    && Number.isFinite(details.nextId) && Array.isArray(details.tasks) && details.tasks.every(validTask);
}
function validTimingRecord(record) {
  if (!plainObject(record)) return false;
  const keys = Object.keys(record).sort();
  if (!keys.length || keys.some((key) => key !== "startedAt" && key !== "completedAt")) return false;
  if (record.startedAt !== undefined && !integer(record.startedAt)) return false;
  if (record.completedAt !== undefined && !integer(record.completedAt)) return false;
  return !(record.startedAt !== undefined && record.completedAt !== undefined && record.completedAt < record.startedAt);
}
function normalizeTasks(tasks) {
  return tasks.map((task) => {
    const value = { id: task.id, subject: task.subject, status: task.status };
    if (task.description !== undefined) value.description = task.description;
    if (task.blockedBy !== undefined) value.blockedBy = [...task.blockedBy];
    return value;
  });
}
function validV1(value) {
  return plainObject(value) && Object.keys(value).sort().join("\0") === ["cwd", "sessionId", "tasks", "updatedAt", "version"].join("\0")
    && value.version === 1 && typeof value.sessionId === "string" && value.sessionId && typeof value.cwd === "string" && value.cwd
    && integer(value.updatedAt) && Array.isArray(value.tasks) && value.tasks.every(validTask);
}
export function parseTodoSnapshot(value) {
  if (validV1(value)) return value;
  if (!plainObject(value) || Object.keys(value).sort().join("\0") !== ["cwd", "observedAt", "sessionId", "taskTiming", "tasks", "updatedAt", "version"].join("\0")) return null;
  if (value.version !== 2 || typeof value.sessionId !== "string" || !value.sessionId || typeof value.cwd !== "string" || !value.cwd
    || !integer(value.updatedAt) || !integer(value.observedAt) || !Array.isArray(value.tasks) || !value.tasks.every(validTask)) return null;
  const ids = new Set(value.tasks.map((task) => String(task.id)));
  let timingValid = plainObject(value.taskTiming);
  if (timingValid) for (const [id, timing] of Object.entries(value.taskTiming)) {
    if (!ids.has(id) || !validTimingRecord(timing)) { timingValid = false; break; }
  }
  return timingValid ? value : { ...value, taskTiming: {} };
}
async function lstatDirectory(path) { const stat = await lstat(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
async function ensureNormalDirectory(path) {
  try { if (!(await lstatDirectory(path))) return false; }
  catch (error) {
    if (error?.code !== "ENOENT") return false;
    try { await mkdir(path, { recursive: false, mode: 0o700 }); } catch (mkdirError) { if (mkdirError?.code !== "EEXIST") return false; }
    if (!(await lstatDirectory(path))) return false;
  }
  if (process.platform !== "win32") await chmod(path, 0o700).catch(() => {});
  return true;
}
async function safeStore(cwd) {
  const canonicalCwd = await realpath(cwd); const piDir = join(canonicalCwd, ".pi");
  if (!(await ensureNormalDirectory(piDir))) return null;
  const store = join(piDir, "otty-todos"); if (!(await ensureNormalDirectory(store))) return null;
  return { canonicalCwd, store };
}
export async function readSessionTiming(cwd, session) {
  try {
    const location = await safeStore(cwd); if (!location) return {};
    const file = join(location.store, `${session}.json`); const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return {};
    const snapshot = parseTodoSnapshot(JSON.parse(await readFile(file, "utf8")));
    return snapshot?.version === 2 && snapshot.sessionId === session && snapshot.cwd === location.canonicalCwd ? snapshot.taskTiming : {};
  } catch { return {}; }
}
async function atomicWrite(store, file, text) {
  const temp = join(store, `.${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`); let handle;
  try { handle = await open(temp, "wx", 0o600); await handle.writeFile(text, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    if (process.platform !== "win32") await chmod(temp, 0o600); await rename(temp, join(store, file)); if (process.platform !== "win32") await chmod(join(store, file), 0o600);
  } finally { await handle?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
}
function taskKey(task) { return String(task.id); }
function reconcile(previous, timing, next, at) {
  const prior = new Map(previous.map((task) => [taskKey(task), task])); const nextKeys = new Set(next.map(taskKey));
  for (const key of Object.keys(timing)) if (!nextKeys.has(key)) delete timing[key];
  for (const task of next) {
    const key = taskKey(task); const old = prior.get(key); const record = timing[key];
    if (task.status === "deleted" || (old?.status === "in_progress" && task.status === "pending")) { delete timing[key]; continue; }
    if (task.status === "in_progress") {
      if (old?.status === "completed" && timing[key]?.startedAt !== undefined) timing[key] = { startedAt: timing[key].startedAt };
      if (!timing[key]?.startedAt) timing[key] = { startedAt: at };
    } else if (task.status === "completed") {
      if (record?.startedAt !== undefined && at < record.startedAt) delete timing[key];
      else timing[key] = record?.startedAt !== undefined ? { startedAt: record.startedAt, completedAt: at } : { completedAt: at };
    } else if (task.status !== "completed") delete timing[key];
  }
}
function timestamp(entry) { const value = Date.parse(entry?.timestamp); return Number.isFinite(value) && value >= 0 ? value : null; }
function todoDetails(entry) { const message = entry?.message; return message?.role === "toolResult" && message.toolName === "todo" && message.isError !== true && validTaskDetails(message.details) ? message.details : null; }
function sessionId(ctx) { try { const file = ctx?.sessionManager?.getSessionFile?.(); if (file) return String(file).split("/").at(-1).replace(/\.jsonl$/, ""); } catch {} return `pid-${process.pid}`; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; }
export function deriveSessionMetrics(snapshot) {
  const parsed = parseTodoSnapshot(snapshot); const empty = { visibleTotal: 0, completedTotal: 0, progressPercent: 0, sampleCount: 0, medianDurationMs: null, confidence: null, currentTask: null, currentTaskRemainingMs: null, currentTaskProgressPercent: null, planRemainingMs: null, planCompletionAt: null, nextTasks: [], blockedTask: null, forecastAvailable: false };
  if (!parsed || parsed.version !== 2) return empty;
  const visible = parsed.tasks.filter((task) => task.status !== "deleted"); const completed = visible.filter((task) => task.status === "completed");
  const base = { ...empty, visibleTotal: visible.length, completedTotal: completed.length, progressPercent: visible.length ? Math.round(completed.length * 100 / visible.length) : 0 };
  const samples = completed.map((task) => parsed.taskTiming[String(task.id)]).filter((record) => record?.startedAt !== undefined && record?.completedAt !== undefined).map((record) => record.completedAt - record.startedAt).filter((value) => value >= 0);
  const taskMap = new Map(visible.map((task) => [task.id, task])); const currentTask = visible.filter((task) => task.status === "in_progress").sort((a, b) => a.id - b.id)[0] ?? null;
  const pending = visible.filter((task) => task.status === "pending"); const eligible = pending.filter((task) => (task.blockedBy ?? []).every((id) => taskMap.get(id)?.status === "completed")).sort((a, b) => a.id - b.id);
  const blockedTask = eligible.length ? null : pending.filter((task) => !eligible.includes(task)).sort((a, b) => a.id - b.id)[0] ?? null;
  if (samples.length < 3) return { ...base, sampleCount: samples.length, currentTask, nextTasks: eligible.slice(0, 2), blockedTask };
  const medianDurationMs = median(samples); const currentTiming = currentTask && parsed.taskTiming[String(currentTask.id)];
  const elapsed = currentTiming?.startedAt !== undefined ? Math.max(0, parsed.observedAt - currentTiming.startedAt) : null;
  const currentTaskRemainingMs = currentTask ? (elapsed === null ? medianDurationMs : Math.max(0, medianDurationMs - elapsed)) : null;
  const currentTaskProgressPercent = elapsed === null ? null : Math.min(95, Math.round(elapsed * 100 / medianDurationMs));
  let planRemainingMs = 0; for (const task of visible) if (task.status !== "completed") planRemainingMs += task.id === currentTask?.id ? currentTaskRemainingMs : medianDurationMs;
  const confidence = samples.length < 5 ? "low" : samples.length < 10 ? "medium" : "high";
  return { ...base, sampleCount: samples.length, medianDurationMs, confidence, currentTask, currentTaskRemainingMs, currentTaskProgressPercent, planRemainingMs, planCompletionAt: parsed.observedAt + planRemainingMs, nextTasks: eligible.slice(0, 2), blockedTask, forecastAvailable: true };
}
export function createTodoPublisher({ now = Date.now, beforeCommit } = {}) {
  const pending = new Set();
  const schedule = (ctx, next, at, replay = false, suppliedTiming) => {
    if (!ctx?.isProjectTrusted?.()) return; const session = sessionId(ctx); const key = `${resolve(ctx.cwd)}\0${session}`;
    let state = registry.get(key); if (!state) { state = { revision: 0, queue: Promise.resolve(), tasks: null, timing: null }; registry.set(key, state); }
    const revision = ++state.revision;
    const job = (async () => { const location = await safeStore(ctx.cwd); if (!location) return;
      if (state.tasks === null) { state.timing = await readSessionTiming(ctx.cwd, session); state.tasks = []; }
      const timing = suppliedTiming ? { ...suppliedTiming } : { ...(state.timing ?? {}) };
      if (!suppliedTiming) { if (replay && at === null) Object.keys(timing).forEach((key) => delete timing[key]); else reconcile(state.tasks, timing, next, at); }
      state.tasks = normalizeTasks(next); state.timing = timing;
      const snapshot = { version: 2, sessionId: session, cwd: location.canonicalCwd, updatedAt: replay ? (at ?? 0) : at, observedAt: replay ? (at ?? 0) : at, tasks: state.tasks, taskTiming: timing };
      state.queue = state.queue.catch(() => {}).then(async () => { await beforeCommit?.({ revision, snapshot }); if (state.revision !== revision) return; await atomicWrite(location.store, `${session}.json`, JSON.stringify(snapshot)); }).catch(() => {}); await state.queue;
    })().catch(() => {}); pending.add(job); job.finally(() => pending.delete(job));
  };
  return { handleToolResult(event, ctx) { const details = event?.toolName === "todo" && event.isError !== true && validTaskDetails(event.details) ? event.details : null; if (details) schedule(ctx, details.tasks, now()); },
    publishCurrentState(ctx) { let tasks = []; let previous = []; let timing = {}; let last = null; let invalid = false; for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) { const details = todoDetails(entry); if (!details) continue; tasks = details.tasks; const at = timestamp(entry); if (at === null || (last !== null && at < last)) { invalid = true; continue; } reconcile(previous, timing, details.tasks, at); previous = normalizeTasks(details.tasks); last = at; } schedule(ctx, tasks, last ?? 0, true, invalid ? {} : timing); },
    async waitForIdle() { while (pending.size) await Promise.allSettled([...pending]); } };
}
