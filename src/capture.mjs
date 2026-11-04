/**
 * Hard-way detection: the only signal worth recording automatically is
 * "tried, failed, retried, succeeded — and something actually changed".
 * Heuristic only — no model call, no network, no latency.
 *
 * Quality gate, because a noisy store is worse than an empty one:
 *  - a retry of the identical command with no file edit is transient, not knowledge
 *  - a symptom with no error code, path, quoted identifier, or distinctive words
 *    can never be recalled by anyone, so it is not recorded
 */

const ERROR_HINT =
  /\b(error|err!|failed|failure|cannot|could not|unable to|not found|no such file|exception|traceback|denied|refused|timed out|timeout|enoent|eacces|eaddrinuse|exit code [1-9])\b/i;

const IGNORE_LINE = /^(wall time|exit code|command|stdout|stderr|output|duration)s?:?$/i;

/** Harness metadata is not a symptom: agent_browser and friends report shape, not failure. */
const METADATA_LINE = /^(?:result\s*category|failure\s*category|pi\s*tool|is\s*error|istoolerror|category|tool)\s*[:=]/i;

/** Words that make a symptom unrecallable: they appear in half of all failures. */
const BOILERPLATE = new Set(
  (
    "error errors err typeerror referenceerror syntaxerror rangeerror evalerror uri error failed failure exception " +
    "undefined null nan true false cannot can not could unable read reading property properties propertie " +
    "function function_call object array string number boolean promise rejected unhandled " +
    "unexpected token unexpected end input command exit code status non zero nonzero is was were not defined " +
    "the a an of at in on to for with from this that it its which what when while during and or but if then than"
  ).split(" "),
);

const CODE_RE = /\b(?:ERR_[A-Z0-9_]+|E[A-Z]{3,}|TS\d{4,}|[A-Z]{2,}[A-Z0-9]*(?:_[A-Z0-9]+)+|SQLSTATE \w{5})\b/;
const PATH_RE = /(?:^|\s)[\w.@-]+\/[\w./@-]+|\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|rs|go|java|kt|swift|json|toml|ya?ml|ini|cfg|env)\b/i;
const QUOTED_RE = /`[^`]{2,}`|"[^"]{3,}"|'[^']{3,}'/;

export function outputOf(text) {
  const s = String(text ?? "");
  const marker = s.match(/\n(?:Output|Stdout|Stderr):\s*\n/i);
  return marker ? s.slice(marker.index + marker[0].length) : s;
}

/** Strip env assignments and `cd x &&` so a wrapper prefix cannot fake a locus match. */
export function commandCore(command) {
  let s = String(command || "").trim();
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S+)\s+/, "")
      .replace(/^(?:cd|pushd|popd)\s+("[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;|\|\|)\s*/, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim();
}

export function locusOf(event) {
  const input = event?.input || {};
  const tool = event?.toolName || "";
  if (tool === "bash" || typeof input.command === "string") {
    const words = commandCore(input.command).split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    return words ? `cmd:${words}` : "cmd:?";
  }
  if (input.path) return `file:${String(input.path).replace(/^.*?(?=[^/]+\/[^/]+$)/, "")}`;
  return `tool:${tool}`;
}

export function symptomOf(event) {
  const body = outputOf(event?.content ?? event?.text ?? "");
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !IGNORE_LINE.test(l) && !METADATA_LINE.test(l));
  if (lines.length === 0) return "";
  const errorish = lines.filter((l) => ERROR_HINT.test(l));
  const pick = errorish.length > 0 ? errorish[errorish.length - 1] : lines[0];
  return pick
    .replace(/\/Users\/[^\s:]+/g, (m) => m.split("/").pop())
    .replace(/\d+(\.\d+)*/g, (m) => (m.includes(".") ? m : "<n>"))
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

/**
 * Could another agent ever find this by pasting their error? If the symptom is
 * only boilerplate ("TypeError: cannot read properties of undefined"), no.
 */
export function isGenericSymptom(symptom) {
  const s = String(symptom || "");
  // Our own tool envelopes are never recallable by a human pasting an error.
  if (/failureCategory|Result category|Pi tool isError/i.test(s)) return true;
  if (CODE_RE.test(s)) return false;
  if (PATH_RE.test(s)) return false;
  if (QUOTED_RE.test(s)) return false;
  const distinctive = s
    .toLowerCase()
    .split(/[^a-z0-9_@.:/-]+/)
    .filter((token) => token.length >= 4 && !BOILERPLATE.has(token));
  return new Set(distinctive).size < 2;
}

function commandOf(event) {
  return String(event?.input?.command || "");
}

function normalizeCommand(command) {
  return commandCore(command).replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

function filesBetween(events, from, to) {
  const out = new Set();
  for (const event of events.slice(from, to)) {
    const p = event?.input?.path;
    if (p && /(edit|write|patch|apply|notebook)/i.test(event.toolName || "")) out.add(String(p));
  }
  return [...out];
}

function describeFix(failed, success, files = []) {
  const tool = success.toolName || "tool";
  const input = success.input || {};
  const changed = files.map((f) => `\`${f}\``).join(", ");
  if (tool === "bash" || typeof input.command === "string") {
    const cmd = String(input.command || "").trim().slice(0, 300);
    const previous = failed.length ? String(failed[failed.length - 1].input?.command || "").trim() : "";
    if (previous && normalizeCommand(previous) !== normalizeCommand(cmd)) {
      return `Ran \`${cmd}\`\n\nEarlier attempt that failed: \`${previous.slice(0, 200)}\``;
    }
    // Same command, but the folder changed in between: that was the actual fix.
    if (changed) return `Changed ${changed}, then ran \`${cmd}\``;
    return `Ran \`${cmd}\``;
  }
  if (input.path) {
    const paths = [...new Set([input.path, ...failed.map((f) => f.input?.path).filter(Boolean)])];
    return `Changed ${paths.map((p) => `\`${p}\``).join(", ")}`;
  }
  return `Used ${tool}`;
}

/** Default 2 failed attempts. MEMTORY_CAPTURE=aggressive records a single retry. */
export function captureMinFails() {
  return process.env.MEMTORY_CAPTURE === "aggressive" ? 1 : 2;
}

/**
 * @param events ordered tool events: { toolName, input, content, isError }
 * @param options.minFails how many failures before the success count as "hard way"
 * @returns candidate observation or null
 */
export function detectHardWay(events, options = {}) {
  const { minFails = 2, exclude = new Set() } = options;
  if (!Array.isArray(events) || events.length < 2) return null;
  const last = events[events.length - 1];
  if (last.isError) return null;

  // Only tools that expose a command or a file can teach anything reusable.
  // Browser/QA tools report "category: failure" with no locus worth recording.
  const signal = commandOf(last) || String(last.input?.path || "");
  if (!signal) return null;

  const locus = locusOf(last);
  if (locus === "cmd:?" || locus === "cmd:" || locus === "tool:") return null;

  let firstFailIndex = -1;
  const failed = [];
  for (let i = 0; i < events.length - 1; i++) {
    const event = events[i];
    if (!event.isError || locusOf(event) !== locus) continue;
    if (firstFailIndex === -1) firstFailIndex = i;
    failed.push(event);
  }
  if (failed.length < minFails) return null;

  const symptom = symptomOf(failed[0]) || symptomOf(failed[failed.length - 1]) || "";
  if (symptom.length < 8) return null;

  const files = filesBetween(events, firstFailIndex, events.length - 1);
  const successCommand = commandOf(last);
  const lastFailCommand = commandOf(failed[failed.length - 1]);
  const commandChanged =
    Boolean(successCommand) && normalizeCommand(successCommand) !== normalizeCommand(lastFailCommand);

  // Identical command, nothing edited, suddenly works: transient (flaky network,
  // stale cache, a lock releasing). Recording it would teach the next agent nothing.
  if (!commandChanged && files.length === 0) return null;
  if (isGenericSymptom(symptom)) return null;

  const dedupeKey = `${locus}|${symptom.slice(0, 90)}`;
  if (exclude.has(dedupeKey)) return null;

  return {
    dedupeKey,
    symptom,
    cause: "",
    fix: describeFix(failed, last, files),
    verify: successCommand.slice(0, 300) || "",
    files,
    tags: ["auto"],
    confidence: "low",
    needsReview: true,
    source: {
      harness: "auto",
      tool: last.toolName,
      attempts: failed.length,
      failedCommands: failed.map((f) => commandOf(f).slice(0, 200)).slice(-3),
    },
  };
}

export function eventFromToolResult(event) {
  const text = Array.isArray(event.content)
    ? event.content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n")
    : String(event.content ?? "");
  return {
    toolName: event.toolName || "",
    input: event.input || {},
    content: text,
    isError: Boolean(event.isError),
  };
}
