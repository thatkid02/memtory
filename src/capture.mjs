/**
 * Hard-way detection: the only signal worth recording automatically is
 * "tried, failed, retried, succeeded". Everything else is noise.
 * Heuristic only — no model call, no network, no latency.
 */

const ERROR_HINT =
  /\b(error|err!|failed|failure|cannot|could not|unable to|not found|no such file|exception|traceback|denied|refused|timed out|timeout|enoent|eacces|eaddrinuse|exit code [1-9])\b/i;

const IGNORE_LINE = /^(wall time|exit code|command|stdout|stderr|output|duration)s?:?$/i;

export function outputOf(text) {
  const s = String(text ?? "");
  const marker = s.match(/\n(?:Output|Stdout|Stderr):\s*\n/i);
  return marker ? s.slice(marker.index + marker[0].length) : s;
}

export function locusOf(event) {
  const input = event?.input || {};
  const tool = event?.toolName || "";
  if (tool === "bash" || typeof input.command === "string") {
    const words = String(input.command || "")
      .trim()
      .replace(/^[a-z_]+=\S+\s+/i, "")
      .split(/\s+/)
      .slice(0, 2)
      .join(" ");
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
    .filter((l) => l && !IGNORE_LINE.test(l));
  if (lines.length === 0) return "";
  const errorish = lines.filter((l) => ERROR_HINT.test(l));
  const pick = errorish.length > 0 ? errorish[errorish.length - 1] : lines[0];
  return pick
    .replace(/\/Users\/[^\s:]+/g, (m) => m.split("/").pop())
    .replace(/\d+(\.\d+)*/g, (m) => (m.includes(".") ? m : "<n>"))
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function filesBetween(events, from, to) {
  const out = new Set();
  for (const event of events.slice(from, to)) {
    const p = event?.input?.path;
    if (p && /(edit|write|read|patch|apply)/i.test(event.toolName || "")) out.add(String(p));
  }
  return [...out];
}

function describeFix(failed, success) {
  const tool = success.toolName || "tool";
  const input = success.input || {};
  if (tool === "bash" || typeof input.command === "string") {
    const cmd = String(input.command || "").trim().slice(0, 300);
    const previous = failed.length ? String(failed[failed.length - 1].input?.command || "").trim() : "";
    if (previous && previous !== cmd) {
      return `Ran \`${cmd}\`\n\nEarlier attempt that failed: \`${previous.slice(0, 200)}\``;
    }
    return `Ran \`${cmd}\``;
  }
  if (input.path) {
    const paths = [...new Set([input.path, ...failed.map((f) => f.input?.path).filter(Boolean)])];
    return `Changed ${paths.map((p) => `\`${p}\``).join(", ")}`;
  }
  return `Used ${tool}`;
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

  const locus = locusOf(last);
  let firstFailIndex = -1;
  const failed = [];
  for (let i = 0; i < events.length - 1; i++) {
    const event = events[i];
    if (!event.isError) continue;
    if (locusOf(event) !== locus) continue;
    if (firstFailIndex === -1) firstFailIndex = i;
    failed.push(event);
  }
  if (failed.length < minFails) return null;

  const symptom = symptomOf(failed[0]) || symptomOf(failed[failed.length - 1]) || "";
  if (symptom.length < 8) return null;

  const dedupeKey = `${locus}|${symptom.slice(0, 90)}`;
  if (exclude.has(dedupeKey)) return null;

  const files = filesBetween(events, firstFailIndex, events.length - 1);
  return {
    dedupeKey,
    symptom,
    cause: "",
    fix: describeFix(failed, last),
    verify: String(last.input?.command || "").slice(0, 300) || "",
    files,
    tags: ["auto"],
    confidence: "low",
    needsReview: true,
    source: {
      harness: "auto",
      tool: last.toolName,
      attempts: failed.length,
      failedCommands: failed.map((f) => String(f.input?.command || "").slice(0, 200)).slice(-3),
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
