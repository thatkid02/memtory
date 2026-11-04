import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardWay } from "./capture.mjs";
import { formatEntry, protocolText } from "./format.mjs";
import { flush, maybePull, openStore } from "./gitmem.mjs";
import { observe, recall } from "./ops.mjs";
import { home } from "./paths.mjs";
import { readAll } from "./store.mjs";

const BIN = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "bin", "memtory.mjs");
const MAX_EVENTS = 120;

function sessionFile(sessionId) {
  const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return path.join(home(), "state", "sessions", `${safe}.json`);
}

function readSession(sessionId) {
  try {
    return { events: [], keys: [], ...JSON.parse(fs.readFileSync(sessionFile(sessionId), "utf8")) };
  } catch {
    return { events: [], keys: [] };
  }
}

function writeSession(sessionId, session) {
  const file = sessionFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const trimmed = { ...session, events: session.events.slice(-MAX_EVENTS) };
  fs.writeFileSync(file, JSON.stringify(trimmed));
}

function readPayload(stdin) {
  return new Promise((resolve) => {
    let body = "";
    if (!stdin) return resolve({});
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      body += chunk;
    });
    stdin.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    stdin.on("error", () => resolve({}));
    stdin.resume();
  });
}

function isErrorResponse(response) {
  if (response === undefined || response === null) return false;
  if (typeof response === "string") return /\b(error|failed|not found|cannot|exit code [1-9])\b/i.test(response);
  if (response.is_error || response.isError || response.success === false || response.interrupted) return true;
  const code = response.exit_code ?? response.exitCode;
  if (typeof code === "number") return code !== 0;
  for (const key of ["error", "stderr"]) {
    const value = response[key];
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}

function responseText(response) {
  if (response === undefined || response === null) return "";
  if (typeof response === "string") return response.slice(0, 4000);
  const parts = [];
  for (const key of ["stdout", "stderr", "output", "content", "result", "error"]) {
    const value = response[key];
    if (typeof value === "string" && value) parts.push(value);
  }
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(response));
    } catch {}
  }
  return parts.join("\n").slice(0, 4000);
}

function recentTitles(dir, limit = 5) {
  return readAll(dir)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map((e) => `- ${e.symptom.replace(/\s+/g, " ").slice(0, 110)} [${e.id}]`)
    .join("\n");
}

function context(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

async function onSessionStart(payload) {
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { dir } = openStore(cwd);
  maybePull(dir);
  const entries = readAll(dir);
  const body = [protocolText(entries.length), entries.length ? `\nRecent notes:\n${recentTitles(dir)}` : ""]
    .filter(Boolean)
    .join("\n");
  return context("SessionStart", body.slice(0, 9000));
}

async function onUserPromptSubmit(payload) {
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const prompt = payload.prompt || "";
  if (!prompt.trim()) return undefined;
  const result = recall(cwd, prompt, { limit: 1, source: "hook-prompt" });
  const hit = result.hits[0];
  if (!hit) return undefined;
  const strong = hit.coverage >= 0.66 ? hit.matched >= 2 && hit.score > 0.6 : hit.score > 1.2;
  if (!strong || hit.fuzzy) return undefined;
  const body = `A note from this repo's memtory branch may already answer this — verify before relying on it:\n\n${formatEntry(
    hit.entry,
    0,
  ).slice(0, 3000)}`;
  return context("UserPromptSubmit", body);
}

async function onPostToolUse(payload) {
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = payload.session_id || "default";
  const session = readSession(sessionId);
  const response = payload.tool_response ?? payload.tool_result ?? payload.result;
  session.events.push({
    toolName: payload.tool_name || "",
    input: payload.tool_input || {},
    content: responseText(response),
    isError: isErrorResponse(response),
  });

  const candidate = detectHardWay(session.events, { minFails: 2, exclude: new Set(session.keys) });
  if (candidate) {
    session.keys.push(candidate.dedupeKey);
    try {
      observe(cwd, { ...candidate, source: { ...candidate.source, harness: "claude-code" } }, { flush: false });
    } catch {}
  }
  writeSession(sessionId, session);
  return undefined;
}

async function onSessionEnd(payload) {
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = payload.session_id || "default";
  // Claude's SessionEnd timeout is short: hand the push to a detached process.
  try {
    fs.rmSync(sessionFile(sessionId), { force: true });
  } catch {}
  const child = spawn(process.execPath, [BIN, "flush"], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  return undefined;
}

const HANDLERS = {
  SessionStart: onSessionStart,
  UserPromptSubmit: onUserPromptSubmit,
  PostToolUse: onPostToolUse,
  SessionEnd: onSessionEnd,
};

function normalizeEvent(name) {
  const cleaned = String(name || "")
    .replace(/[-_\s]/g, "")
    .toLowerCase();
  for (const key of Object.keys(HANDLERS)) {
    if (key.toLowerCase() === cleaned) return key;
  }
  return null;
}

/**
 * Runs a harness hook. Always resolves; hook failures must never block the
 * calling agent. Returns the JSON payload to print on stdout (or undefined).
 */
export async function runHook(harness, event, options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const payload = await readPayload(stdin);
  const name = normalizeEvent(event || payload.hook_event_name);
  if (!name) return undefined;
  const handler = HANDLERS[name];
  if (!handler) return undefined;
  try {
    const result = await handler(payload);
    if (result) stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`memtory hook (${harness}/${name}): ${error.message}\n`);
    return undefined;
  }
}

/** Used by the detached flush path. */
export async function flushStore(cwd = process.cwd()) {
  const { dir } = openStore(cwd);
  return flush(dir, "memtory: session end");
}
