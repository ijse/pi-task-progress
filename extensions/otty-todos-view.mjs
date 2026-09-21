#!/usr/local/bin/node
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { validTaskDetails } from "./otty-todos-core.mjs";

const MAX_BYTES = 256 * 1024;
const REDRAW = "\x1b[H\x1b[2J";
const execFile = promisify(execFileCallback);
const OTTY_CLI = "/Applications/Otty.app/Contents/MacOS/otty-cli";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function normalDirectory(path) {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function validSnapshot(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["cwd", "sessionId", "tasks", "updatedAt", "version"].join("\0")) return false;
  return value.version === 1
    && typeof value.sessionId === "string"
    && typeof value.cwd === "string"
    && Number.isFinite(value.updatedAt)
    && validTaskDetails({ action: "list", params: {}, nextId: 0, tasks: value.tasks });
}

export async function selectSnapshot(projectPath, { activeSessionId } = {}) {
  let project;
  try { project = await realpath(resolve(projectPath)); } catch { return null; }
  const piDir = join(project, ".pi");
  const store = join(piDir, "otty-todos");
  if (!(await normalDirectory(piDir)) || !(await normalDirectory(store))) return null;

  let names;
  try { names = await readdir(store); } catch { return null; }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(store, name);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
      const value = JSON.parse(await readFile(file, "utf8"));
      if (!validSnapshot(value)) continue;
      candidates.push({ value, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.value.updatedAt - a.value.updatedAt
    || b.mtimeMs - a.mtimeMs
    || b.value.sessionId.localeCompare(a.value.sessionId));
  return candidates.find(({ value }) => value.sessionId === activeSessionId)?.value ?? candidates[0]?.value ?? null;
}

async function activeOttySession(projectPath) {
  let project;
  try {
    project = await realpath(resolve(projectPath));
    const { stdout } = await execFile(OTTY_CLI, ["pane", "list", "--json"], {
      env: process.env,
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
    const panes = JSON.parse(stdout)?.data;
    if (!Array.isArray(panes)) return undefined;
    const matches = [];
    for (const pane of panes) {
      if (pane?.agent !== "Pi" || typeof pane.agent_session_id !== "string" || !pane.agent_session_id) continue;
      try {
        if (await realpath(pane.cwd) === project) matches.push(pane);
      } catch {}
    }
    matches.sort((a, b) => Number(b.agent_state === "processing") - Number(a.agent_state === "processing"));
    return matches[0]?.agent_session_id;
  } catch {
    return undefined;
  }
}

function safeText(value) {
  return String(value)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (char) => /[\n\r\t]/.test(char) ? " " : "");
}

export function renderSnapshot(snapshot) {
  if (!snapshot || !validSnapshot(snapshot)) return `${REDRAW}Pi todos\n\nNo Pi todos for this project.`;
  const visible = snapshot.tasks.filter((task) => task.status !== "deleted");
  const complete = visible.filter((task) => task.status === "completed").length;
  const tasksById = new Map(visible.map((task) => [task.id, task]));
  const blocked = (task) => task.status === "pending" && (task.blockedBy ?? []).some((id) => tasksById.get(id)?.status !== "completed");
  const groups = [
    ["In progress", visible.filter((task) => task.status === "in_progress")],
    ["Blocked", visible.filter(blocked)],
    ["Pending", visible.filter((task) => task.status === "pending" && !blocked(task))],
    ["Completed", visible.filter((task) => task.status === "completed")],
  ];
  const lines = ["Pi todos", `${complete} / ${visible.length} completed`];
  for (const [label, tasks] of groups) {
    if (!tasks.length) continue;
    lines.push("", label);
    for (const task of [...tasks].sort((a, b) => a.id - b.id)) {
      const marker = task.status === "completed" ? "✓" : task.status === "in_progress" ? "›" : task.status === "pending" && blocked(task) ? "!" : "○";
      lines.push(`  ${marker} #${task.id} ${safeText(task.subject)}`);
    }
  }
  return REDRAW + lines.join("\n");
}

async function main() {
  // Otty reuses a View process when its command and cwd match. A harmless
  // instance token changes the command so a config reload can launch a fresh
  // renderer without being mistaken for a project path.
  const project = process.argv.slice(2).find((arg) => !arg.startsWith("--instance=")) ?? process.cwd();
  const draw = async () => {
    const activeSessionId = await activeOttySession(project);
    process.stdout.write(renderSnapshot(await selectSnapshot(project, { activeSessionId })));
  };
  await draw();
  // Keep the terminal program alive: Otty needs subsequent redraws as the
  // snapshot changes. Do not unref this timer or Node exits after frame one.
  setInterval(() => { void draw(); }, 750);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
