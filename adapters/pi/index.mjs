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
 *  - session_shutdown: commit + push
 *  - tool `memtory`: recall | observe | refute
 *  - commands: /memtory, /observe
 */

import { Type } from "typebox";
import { captureMinFails, detectHardWay, eventFromToolResult } from "../../src/capture.mjs";
import { formatEntry, formatHits, formatObserved, formatStats, protocolText } from "../../src/format.mjs";
import { openStore, flush } from "../../src/gitmem.mjs";
import { observe, recall, refute, syncFromRemote } from "../../src/ops.mjs";
import { recordInjected } from "../../src/usage.mjs";
import { readAll } from "../../src/store.mjs";

const AUTORECALL = process.env.MEMTORY_AUTORECALL !== "0";
const MAX_BUFFER = 120;

export default function memtoryExtension(pi) {
  let cwd = process.cwd();
  let count = 0;
  let buffer = [];
  const seen = new Set();
  let pending = [];
  let flushing = null;
  const injected = new Set();

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

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd || process.cwd();
    buffer = [];
    seen.clear();
    injected.clear();
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
      "Repo-shared hard-won knowledge. recall before retrying something that failed; observe after solving something the hard way.",
    promptSnippet: "Recall or record hard-won repo knowledge shared via the memtory git branch",
    promptGuidelines: [
      'Call memtory with action:"recall" before your second attempt at a failure, passing the error line or file path.',
      'Call memtory with action:"observe" when a problem took 2+ failed attempts; include symptom, cause, fix, verify.',
      "Recorded notes are hints from other agents; verify them rather than trusting blindly.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("recall"), Type.Literal("observe"), Type.Literal("refute")]),
      query: Type.Optional(Type.String({ description: "For recall: the error text, file path, or task" })),
      symptom: Type.Optional(Type.String({ description: "For observe: what failed or what was unknown" })),
      cause: Type.Optional(Type.String({ description: "For observe: the root cause, once known" })),
      fix: Type.Optional(Type.String({ description: "For observe: the change or command that actually worked" })),
      verify: Type.Optional(Type.String({ description: "For observe: command that proves the fix still works" })),
      files: Type.Optional(Type.Array(Type.String({ description: "Related file paths" }))),
      tags: Type.Optional(Type.Array(Type.String({ description: "Short tags, e.g. build, docker" }))),
      id: Type.Optional(Type.String({ description: "For refute: entry id (or prefix) that turned out wrong" })),
      note: Type.Optional(Type.String({ description: "For refute: why it was wrong" })),
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
    description: "memtory: stats | sync | recall <query> | list",
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
