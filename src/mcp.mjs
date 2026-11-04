import readline from "node:readline";
import { openStore, flush, maybePull } from "./gitmem.mjs";
import { protocolText } from "./format.mjs";
import { formatHits, formatObserved } from "./format.mjs";
import { observe, recall, refute } from "./ops.mjs";
import { readAll } from "./store.mjs";
import { VERSION } from "./version.mjs";

const TOOLS = [
  {
    name: "memtory_recall",
    description:
      "Search this repository's shared memtory branch for hard-won knowledge (traps another agent already paid for). Call this before your second attempt at a failure.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The error line, error code, file path, or task you are stuck on" },
        limit: { type: "number", description: "Max notes to return (default 3)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memtory_observe",
    description:
      "Record hard-won knowledge for this repository: what failed, why, what fixed it, and how to verify. Use after solving something the hard way (2+ failed attempts).",
    inputSchema: {
      type: "object",
      properties: {
        symptom: { type: "string", description: "What failed or what was unknown (include the error text)" },
        cause: { type: "string", description: "Root cause, once known" },
        fix: { type: "string", description: "The change or command that actually worked" },
        verify: { type: "string", description: "Command that proves the fix still works" },
        files: { type: "array", items: { type: "string" }, description: "Related file paths" },
        tags: { type: "array", items: { type: "string" }, description: "Short tags, e.g. build, docker" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["symptom"],
    },
  },
  {
    name: "memtory_refute",
    description: "Mark a remembered note as wrong or stale so it stops misleading other agents.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entry id (or unique prefix) from a recall result" },
        note: { type: "string", description: "Why it was wrong" },
      },
      required: ["id"],
    },
  },
  {
    name: "memtory_sync",
    description: "Pull notes written by other agents/users and push any local ones.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(body, isError = false) {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

async function callTool(name, args, cwd) {
  switch (name) {
    case "memtory_recall": {
      if (!args?.query) return text("memtory: query is required", true);
      const result = recall(cwd, args.query, { limit: Number(args.limit) || 3, source: "mcp" });
      return text(formatHits(result));
    }
    case "memtory_observe": {
      if (!args?.symptom) return text("memtory: symptom is required", true);
      const result = observe(cwd, { ...args, source: { harness: "mcp" } }, { flush: false });
      void (async () => {
        try {
          const { dir } = openStore(cwd);
          flush(dir, "memtory: observe via mcp");
        } catch {}
      })();
      return text(formatObserved(result));
    }
    case "memtory_refute": {
      if (!args?.id) return text("memtory: id is required", true);
      const result = refute(cwd, args.id, args.note || "");
      return text(`memtory: refuted [${result.entry.id}]; it will rank lower for everyone.`);
    }
    case "memtory_sync": {
      const { dir } = openStore(cwd);
      const pulled = maybePull(dir, { force: true });
      const pushed = flush(dir, "memtory: sync via mcp");
      const count = readAll(dir).length;
      return text(
        `memtory: ${pulled.updated ? pulled.reason : "up-to-date"}${pushed.pushed ? ", pushed" : ""} · ${count} notes`,
      );
    }
    default:
      return text(`memtory: unknown tool "${name}"`, true);
  }
}

export async function serve(options = {}) {
  const cwd = options.cwd || process.env.MEMTORY_PROJECT || process.cwd();
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  let instructions = "";
  try {
    const { dir } = openStore(cwd);
    instructions = protocolText(readAll(dir).length);
  } catch {}

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const done = new Promise((resolve) => rl.on("close", resolve));

  rl.on("line", async (line) => {
    const raw = line.trim();
    if (!raw) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      fail(null, -32700, "parse error");
      return;
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize":
          reply(id, {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "memtory", version: VERSION },
            instructions,
          });
          return;
        case "notifications/initialized":
        case "initialized":
          return;
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: TOOLS });
          return;
        case "tools/call": {
          const result = await callTool(params?.name, params?.arguments || {}, cwd);
          reply(id, result);
          return;
        }
        case "resources/list":
          reply(id, { resources: [] });
          return;
        case "prompts/list":
          reply(id, { prompts: [] });
          return;
        default:
          if (isNotification) return;
          fail(id, -32601, `method not found: ${method}`);
      }
    } catch (error) {
      if (isNotification) return;
      fail(id, -32603, error?.message || "internal error");
    }
  });

  if (input !== process.stdin) input.resume?.();
  return done;
}
