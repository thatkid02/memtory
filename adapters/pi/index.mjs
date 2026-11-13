/**
 * pi adapter for memtory.
 *
 * Install (symlink keeps relative imports resolvable):
 *   ln -s /path/to/memtory/adapters/pi/index.mjs ~/.pi/agent/extensions/memtory.mjs
 *
 * What it does:
 *  - session_start: pull notes written by other agents/users (background)
 *  - before_agent_start: 5-line recall protocol; plus one strong hit for the prompt
 *  - tool_result: detects "failed twice then worked" and records it automatically
 *  - /rate good|bad: rates the session and stores the pattern that worked
 *  - session_shutdown: commit + push
 *  - tool `memtory`: recall | observe | rate | refute
 *  - commands: /memtory, /observe, /rate
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { captureMinFails, detectHardWay, eventFromToolResult } from "../../src/capture.mjs";
import { formatEntry, formatHits, formatObserved, formatRated, formatStats, protocolText } from "../../src/format.mjs";
import { openStore, flush } from "../../src/gitmem.mjs";
import { observe, rate, recall, refute, selfCheck, syncFromRemote } from "../../src/ops.mjs";
import { distillSession } from "../../src/rate.mjs";
import { recordInjected } from "../../src/usage.mjs";
import { readAll } from "../../src/store.mjs";
import { formatSelfReport } from "../../src/self.mjs";

const AUTORECALL = process.env.MEMTORY_AUTORECALL !== "0";
const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");
const MAX_BUFFER = 120;

export default function memtoryExtension(pi) {
  let cwd = process.cwd();
  let count = 0;
  let buffer = [];
  const seen = new Set();
  let pending = [];
  let flushing = null;
  const injected = new Set();
  // The last user prompt is the best statement of what this session was asked to
  // do, so `/rate good` can store the task without asking for it again.
  let lastPrompt = "";

  function refreshCount() {
    try {
      const { dir } = openStore(cwd);
      count = readAll(dir).length;
    } catch {
      count = 0;
    }
  }

  function scheduleFlush(reason) {
    if (flushing) return flushing;
    if (pending.length === 0) return null;
    const batch = pending;
    pending = [];
    flushing = (async () => {
      try {
        const { dir } = openStore(cwd);
        flush(dir, `memtory: ${reason} (${batch.length})`);
      } catch {
        /* offline or no remote: entries stay committed locally */
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  pi.on("resources_discover", async () => ({ skillPaths: [SKILLS_DIR] }));

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd || process.cwd();
    buffer = [];
    seen.clear();
    injected.clear();
    lastPrompt = "";
    refreshCount();
    void (async () => {
      try {
        const result = syncFromRemote(cwd);
        if (result.updated) refreshCount();
      } catch {}
    })();
  });

  pi.on("session_shutdown", async () => {
    scheduleFlush("session end");
    if (flushing) {
      await Promise.race([flushing, new Promise((resolve) => setTimeout(resolve, 4000))]);
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (event.messageType !== "user" || !event.prompt) return;
    // Track the session's opening task, not the latest "also add tests" follow-up.
    const prompt = String(event.prompt).trim();
    if (!lastPrompt && prompt.length >= 12) lastPrompt = prompt;
    const options = event.systemPromptOptions;
    if (options) {
      const protocol = protocolText(count);
      if (!String(options.appendSystemPrompt || "").includes("<memtory>")) {
        options.appendSystemPrompt = [options.appendSystemPrompt, protocol].filter(Boolean).join("\n\n");
      }
    }
    if (!AUTORECALL) return;

    let hit = null;
    try {
      const result = recall(cwd, event.prompt, { limit: 1, source: "inject" });
      hit = result.hits[0] ?? null;
    } catch {
      return;
    }
    if (!hit) return;
    const strong = hit.coverage >= 0.66 ? hit.matched >= 2 && hit.score > 0.6 : hit.score > 1.2;
    if (!strong || injected.has(hit.entry.id)) return;
    injected.add(hit.entry.id);
    recordInjected();
    const body = formatEntry(hit.entry, 0).slice(0, 1100);
    return {
      message: {
        customType: "memtory-recall",
        display: true,
        content: `A note from this repo's memtory branch may already answer this — verify before relying on it:\n\n${body}`,
      },
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.parentToolCallId) return;
    if (event.toolName === "memtory") return;
    buffer.push(eventFromToolResult(event));
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);

    const candidate = detectHardWay(buffer, { minFails: captureMinFails(), exclude: seen });
    if (!candidate) return;
    seen.add(candidate.dedupeKey);
    try {
      const result = observe(cwd, candidate, { flush: false });
      if (!result.deduped) {
        pending.push(result.entry.id);
        count += 1;
        scheduleFlush("auto-observe");
        if (ctx.hasUI) {
          ctx.ui.notify(`memtory: recorded [${result.entry.id}] ${result.entry.symptom.slice(0, 70)}`, "info");
        }
      }
    } catch {}
  });

  pi.registerTool({
    name: "memtory",
    label: "Memtory",
    description:
      "Repo-shared hard-won knowledge. recall before retrying something that failed; observe after solving something the hard way; rate a session that went well so its pattern is kept too.",
    promptSnippet: "Recall, record, and rate repo knowledge shared via the memtory git branch",
    promptGuidelines: [
      'Call memtory with action:"recall" before your second attempt at a failure, passing the error line or file path.',
      'Call memtory with action:"observe" when a problem took 2+ failed attempts; include symptom, cause, fix, verify.',
      'When the user says a session, task, or output went well, call memtory with action:"rate", rating:"good", task, approach — successes are worth keeping, not just failures.',
      "Recorded notes are hints from other agents; verify them rather than trusting blindly.",
      'Use action:"self" when asked whether memtory itself is misbehaving: it lists notes that describe memtory bugs.', 
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("recall"),
        Type.Literal("observe"),
        Type.Literal("rate"),
        Type.Literal("refute"),
        Type.Literal("self"),
      ]),
      rating: Type.Optional(
        Type.Union([Type.Literal("good"), Type.Literal("bad")], {
          description: 'For rate: "good" stores the pattern that worked, "bad" stores nothing',
        }),
      ),
      task: Type.Optional(Type.String({ description: "For rate: what the session was asked to do" })),
      approach: Type.Optional(Type.String({ description: "For rate: what actually worked" })),
      query: Type.Optional(Type.String({ description: "For recall: the error text, file path, or task" })),
      symptom: Type.Optional(Type.String({ description: "For observe: what failed or what was unknown" })),
      cause: Type.Optional(Type.String({ description: "For observe: the root cause, once known" })),
      fix: Type.Optional(Type.String({ description: "For observe: the change or command that actually worked" })),
      verify: Type.Optional(Type.String({ description: "For observe: command that proves the fix still works" })),
      files: Type.Optional(Type.Array(Type.String({ description: "Related file paths" }))),
      tags: Type.Optional(Type.Array(Type.String({ description: "Short tags, e.g. build, docker" }))),
      id: Type.Optional(Type.String({ description: 'For refute, or rate: entry id (or prefix); rating good confirms, bad refutes' })),
      note: Type.Optional(Type.String({ description: "For refute/rate: why it was wrong, or why it worked" })),
      confidence: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
          description: "For observe: how sure you are",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwdNow = ctx?.cwd || cwd;
      try {
        if (params.action === "recall") {
          if (!params.query) throw new Error("memtory recall needs a query");
          const result = recall(cwdNow, params.query, { limit: 3, source: "tool" });
          return {
            content: [{ type: "text", text: formatHits(result) }],
            details: { hits: result.hits.length, total: result.total, ids: result.hits.map((h) => h.entry.id) },
          };
        }
        if (params.action === "observe") {
          if (!params.symptom) throw new Error("memtory observe needs a symptom");
          const result = observe(
            cwdNow,
            {
              ...params,
              confidence: params.confidence ?? "medium",
              source: { harness: "pi", model: ctx?.model?.id ?? null, tool: "memtory" },
            },
            { flush: false },
          );
          pending.push(result.entry.id);
          if (!result.deduped) count += 1;
          scheduleFlush("observe");
          return {
            content: [{ type: "text", text: formatObserved(result) }],
            details: { id: result.entry.id, deduped: Boolean(result.deduped) },
          };
        }
        if (params.action === "rate") {
          const result = rate(
            cwdNow,
            { ...params, source: { harness: "pi", model: ctx?.model?.id ?? null, tool: "memtory" } },
            { flush: false },
          );
          if (result.stored) {
            pending.push(result.entry.id);
            count += 1;
            scheduleFlush("rate");
          }
          return {
            content: [{ type: "text", text: formatRated(result) }],
            details: { rating: result.rating, stored: Boolean(result.stored), id: result.entry?.id ?? null },
          };
        }
        if (params.action === "self") {
          const result = selfCheck(cwdNow, { includeSettled: Boolean(params.note) });
          return {
            content: [{ type: "text", text: formatSelfReport(result, { limit: 10 }) }],
            details: { selfCount: result.selfCount, total: result.total, categories: Object.keys(result.byCategory) },
          };
        }
        if (params.action === "refute") {
          if (!params.id) throw new Error("memtory refute needs an id");
          const result = refute(cwdNow, params.id, params.note || "");
          return {
            content: [{ type: "text", text: `memtory: refuted [${result.entry.id}]; it will rank lower for everyone.` }],
            details: { id: result.entry.id },
          };
        }
        throw new Error(`memtory: unknown action "${params.action}"`);
      } catch (error) {
        return { content: [{ type: "text", text: `memtory: ${error.message}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerCommand("memtory", {
    description: "memtory: stats | sync | recall <query> | list | self",
    handler: async (args, ctx) => {
      const [sub = "stats", ...rest] = (args || "").trim().split(/\s+/);
      const query = rest.join(" ");
      try {
        if (sub === "sync") {
          const result = syncFromRemote(ctx.cwd);
          refreshCount();
          ctx.ui.notify(`memtory: ${result.updated ? result.reason : "up-to-date"} · ${count} notes`, "info");
          return;
        }
        if (sub === "recall") {
          if (!query) return ctx.ui.notify("usage: /memtory recall <query>", "warning");
          ctx.ui.notify(formatHits(recall(ctx.cwd, query, { limit: 3, source: "command" })).slice(0, 2000), "info");
          return;
        }
        if (sub === "self") {
          ctx.ui.notify(formatSelfReport(selfCheck(ctx.cwd), { limit: 8 }).slice(0, 2000), "info");
          return;
        }
        if (sub === "list") {
          const { dir } = openStore(ctx.cwd);
          const entries = readAll(dir).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
          const text = entries.slice(0, 12).map((e, i) => formatEntry(e, i + 1)).join("\n\n") || "no notes yet";
          ctx.ui.notify(text.slice(0, 2000), "info");
          return;
        }
        const { dir } = openStore(ctx.cwd);
        ctx.ui.notify(`${formatStats(readAll(dir))}\nstore: ${dir}`, "info");
      } catch (error) {
        ctx.ui.notify(`memtory: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("rate", {
    description:
      "Rate this session: /rate good [why it worked] || [task] keeps the pattern that worked; /rate bad [why] keeps nothing",
    handler: async (args, ctx) => {
      const raw = String(args || "").trim();
      const [value = "good", ...rest] = raw.split(/\s+/);
      const rating = value.toLowerCase() === "bad" ? "bad" : "good";
      // Same shape as /observe: free text first, the structured part after `||`.
      const [note = "", taskOverride = ""] = rest.join(" ").split("||").map((part) => part.trim());
      try {
        const distilled = distillSession({ prompt: lastPrompt, events: buffer, note });
        const task = taskOverride || distilled?.task || "";
        if (!task) return ctx.ui.notify("memtory: nothing to rate yet — no task prompt in this session", "warning");
        const result = rate(
          ctx.cwd,
          {
            task,
            approach: distilled?.approach || "",
            verify: distilled?.verify || "",
            files: distilled?.files || [],
            rating,
            note,
            source: { harness: "pi", tool: "command" },
          },
          { flush: false },
        );
        if (result.stored) {
          pending.push(result.entry.id);
          count += 1;
          scheduleFlush("rate");
        }
        const hint = result.stored || result.deduped || result.reviewed ? "" : "\n  hint: /rate good <why it worked> || <one-line task>";
        ctx.ui.notify(`${formatRated(result)}${hint}`, result.stored ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`memtory: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("observe", {
    description: "Record a hard-won note: /observe <symptom> || <fix>",
    handler: async (args, ctx) => {
      const [symptom, fix] = String(args || "").split("||").map((s) => s.trim());
      if (!symptom) return ctx.ui.notify("usage: /observe <what failed> || <what worked>", "warning");
      try {
        const result = observe(
          ctx.cwd,
          { symptom, fix, confidence: "high", source: { harness: "pi", tool: "command" } },
          { flush: false },
        );
        pending.push(result.entry.id);
        scheduleFlush("observe");
        ctx.ui.notify(formatObserved(result), "info");
      } catch (error) {
        ctx.ui.notify(`memtory: ${error.message}`, "error");
      }
    },
  });
}
