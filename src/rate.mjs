/**
 * The other half of capture.
 *
 * `detectHardWay` records traps: something failed twice, then worked. That
 * misses the most reusable knowledge — a task that went well first try because
 * the approach was right. A trap teaches what to avoid; a pattern teaches what
 * to repeat, and an agent starting a similar task needs the second one.
 *
 * Rating is explicit ("this went well"), so there is no guessing about quality.
 * Everything after that stays deterministic: the session distills itself from
 * the tool events it already emitted, no model call, and the same gate applies —
 * a vague "it worked" never becomes a note nobody could search for.
 */

import { isGenericSymptom } from "./capture.mjs";

const CHANGE_TOOL = /(edit|write|patch|apply|notebook)/i;
const VERIFY_COMMAND = /\b(test|spec|lint|typecheck|tsc|build|check|bench|e2e|coverage)\b/i;

function push(list, value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed && !list.includes(trimmed)) list.push(trimmed);
}

function clean(text, max = 240) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * A prompt is the best available statement of what the session was asked to do.
 * Keep the first sentence: the rest is usually constraints, pasted logs, or
 * instructions that do not belong in a recallable headline.
 */
export function taskFromPrompt(prompt, max = 200) {
  const body = String(prompt ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return "";
  const first = body.split(/(?<=[.!?])\s/)[0] ?? body;
  const head = first.length >= 12 ? first : body;
  return clean(head, max);
}

/**
 * Turn a finished session into a candidate pattern, using only what the session
 * produced: files it changed and commands that succeeded. A session with neither
 * has no evidence, and evidence is what makes a pattern worth keeping.
 *
 * @param session { prompt, events: [{ toolName, input, content, isError }], note }
 */
export function distillSession(session = {}, options = {}) {
  const { maxFiles = 6, maxCommands = 6 } = options;
  const events = (Array.isArray(session.events) ? session.events : []).filter(
    (event) => event && !event.isError && event.toolName !== "memtory",
  );
  const task = taskFromPrompt(session.prompt);
  if (!task) return null;

  const files = [];
  const commands = [];
  for (const event of events) {
    const file = event.input?.path;
    if (file && CHANGE_TOOL.test(event.toolName || "")) push(files, String(file));
    const command = event.input?.command;
    if (typeof command === "string") push(commands, command);
  }

  const recentFiles = files.slice(-maxFiles);
  const recentCommands = commands.slice(-maxCommands);
  const verify = [...recentCommands].reverse().find((command) => VERIFY_COMMAND.test(command)) ?? "";
  const last = recentCommands[recentCommands.length - 1];

  const parts = [];
  if (recentFiles.length) parts.push(`Changed ${recentFiles.map((file) => `\`${file}\``).join(", ")}`);
  if (last) parts.push(`${parts.length ? "then " : ""}ran \`${clean(last, 200)}\``);
  // A human's one-line "why it worked" beats an empty approach in a chat-only session.
  if (parts.length === 0 && session.note) parts.push(clean(session.note, 240));

  return {
    task,
    approach: parts.join(" "),
    verify: clean(verify, 300),
    files: recentFiles,
    signals: { commands: recentCommands.length, files: recentFiles.length, events: events.length },
  };
}

/** The human's "why it worked" is signal, not decoration: keep it with the evidence. */
export function mergeNote(approach, note) {
  const base = String(approach || "").replace(/\s+/g, " ").trim();
  const extra = String(note || "").replace(/\s+/g, " ").trim();
  if (!extra) return base;
  if (base.includes(extra)) return base;
  return base ? `${base} — ${extra}` : extra;
}

/** Same reason as the capture gate: if nobody could search for it, do not store it. */
export function shouldStorePattern(candidate = {}) {
  const task = String(candidate.task ?? candidate.symptom ?? "").trim();
  const approach = String(candidate.approach ?? candidate.fix ?? "").trim();
  if (task.length < 12) return { ok: false, reason: "the task is too short to be recalled by anyone" };
  if (approach.length < 8) return { ok: false, reason: "nothing to learn: no file changed, no command ran, no note" };
  if (isGenericSymptom(task, { minDistinctive: 3 })) {
    return { ok: false, reason: "the task has no distinctive words; a future agent could not match it" };
  }
  return { ok: true };
}
