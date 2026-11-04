/**
 * Loads the pi adapter against a mock ExtensionAPI and drives a realistic
 * failure → retry → success sequence. Guards the hook wiring, not just core.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memtory-adapter-"));
const work = path.join(root, "project");
const home = path.join(root, "home");
let failed = 0;

function ok(label, condition, extra = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failed++;
    console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
  }
}

// Minimal typebox stand-in: the adapter must not need a real install to load.
const stub = path.join(repoRoot, "node_modules", "typebox");
const stubPkg = path.join(stub, "package.json");
const stubIndex = path.join(stub, "index.mjs");
const createdStub = !fs.existsSync(stub);
if (createdStub) {
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(stubPkg, JSON.stringify({ name: "typebox", version: "0.0.0", type: "module", main: "index.mjs" }));
  fs.writeFileSync(
    stubIndex,
    `export const Type = {
  Object: (props = {}) => ({ type: "object", properties: props, required: Object.entries(props).filter(([, v]) => !v || !v.__optional).map(([k]) => k) }),
  String: (o = {}) => ({ type: "string", ...o }),
  Optional: (schema) => ({ ...schema, __optional: true }),
  Union: (schemas) => ({ anyOf: schemas }),
  Literal: (value) => ({ const: value }),
  Array: (items) => ({ type: "array", items }),
};
`,
  );
}

fs.mkdirSync(work, { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: work });
execFileSync("git", ["config", "user.name", "test"], { cwd: work });
execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
fs.writeFileSync(path.join(work, "package.json"), '{"name":"demo"}');
execFileSync("git", ["add", "-A"], { cwd: work });
execFileSync("git", ["commit", "-m", "init"], { cwd: work });
process.env.MEMTORY_HOME = home;

const handlers = {};
const tools = new Map();
const commands = new Map();
const notices = [];
const mockPi = {
  on: (name, fn) => {
    (handlers[name] ??= []).push(fn);
  },
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand: (name, cmd) => commands.set(name, cmd),
};
const ctx = {
  cwd: work,
  hasUI: true,
  mode: "print",
  ui: { notify: (msg) => notices.push(msg) },
};

async function fire(name, event) {
  const results = [];
  for (const fn of handlers[name] ?? []) results.push(await fn(event, ctx));
  return results.filter(Boolean);
}

const mod = await import(path.join(repoRoot, "adapters", "pi", "index.mjs"));
mod.default(mockPi);

console.log("\nhandler registration");
ok("session_start", Boolean(handlers.session_start));
ok("before_agent_start", Boolean(handlers.before_agent_start));
ok("tool_result", Boolean(handlers.tool_result));
ok("session_shutdown", Boolean(handlers.session_shutdown));
ok("memtory tool", tools.has("memtory"));
ok("memtory command", commands.has("memtory"));
ok("observe command", commands.has("observe"));

console.log("\nprotocol injection");
await fire("session_start", { reason: "startup" });
const options = { appendSystemPrompt: "" };
await fire("before_agent_start", { messageType: "user", prompt: "fix the install", systemPromptOptions: options });
ok("protocol appended", options.appendSystemPrompt.includes("<memtory>"), options.appendSystemPrompt);
await fire("before_agent_start", { messageType: "user", prompt: "fix the install", systemPromptOptions: options });
ok("protocol not duplicated", options.appendSystemPrompt.split("<memtory>").length - 1 === 1);

console.log("\nauto-observe from tool results");
const fail = (content) => ({ toolName: "bash", input: { command: "pnpm install" }, content: [{ type: "text", text: content }], isError: true });
await fire("tool_result", fail("Exit code: 1\nOutput:\nERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19"));
await fire("tool_result", fail("Exit code: 1\nOutput:\nERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19"));
await fire("tool_result", { toolName: "edit", input: { path: "package.json" }, content: [{ type: "text", text: "ok" }], isError: false });
await fire("tool_result", {
  toolName: "bash",
  input: { command: "pnpm install" },
  content: [{ type: "text", text: "Exit code: 0\nOutput:\ndone" }],
  isError: false,
});
const storeDirs = fs.readdirSync(path.join(home, "repos"));
const entryFiles = execFileSync("find", [path.join(home, "repos"), "-name", "*.json", "-path", "*/entries/*"], {
  encoding: "utf8",
}).trim();
ok("observation written", entryFiles.length > 0, `storeDirs=${storeDirs} files=${entryFiles}`);
ok("ui notified", notices.some((n) => n.includes("recorded")), notices.join(" | "));

console.log("\nauto-recall on the next prompt");
const recalled = await fire("before_agent_start", {
  messageType: "user",
  prompt: "pnpm install fails: ERR_PNPM_PEER_DEP_ISSUES unmet peer dependency react",
  systemPromptOptions: { appendSystemPrompt: "<memtory>\n</memtory>" },
});
ok("injected a matching note", recalled.some((r) => r.message?.customType === "memtory-recall"), JSON.stringify(recalled));
const again = await fire("before_agent_start", {
  messageType: "user",
  prompt: "pnpm install fails: ERR_PNPM_PEER_DEP_ISSUES unmet peer dependency react",
  systemPromptOptions: { appendSystemPrompt: "<memtory>\n</memtory>" },
});
ok("does not repeat the same note", !again.some((r) => r.message?.customType === "memtory-recall"));

console.log("\ntool surface");
const tool = tools.get("memtory");
const recallOut = await tool.execute("id1", { action: "recall", query: "ERR_PNPM_PEER_DEP_ISSUES" }, null, null, ctx);
ok("recall returns a hit", recallOut.content[0].text.includes("ERR_PNPM_PEER_DEP_ISSUES"), recallOut.content[0].text);
const observeOut = await tool.execute(
  "id2",
  { action: "observe", symptom: "tsc fails with TS2345 on Buffer.concat generic", fix: "annotate Uint8Array", confidence: "high" },
  null,
  null,
  ctx,
);
ok("observe records", observeOut.content[0].text.includes("recorded"), observeOut.content[0].text);
const refuteOut = await tool.execute("id3", { action: "refute", id: "nope", note: "x" }, null, null, ctx);
ok("bad refute reports an error", refuteOut.isError === true);

console.log("\nsession shutdown flushes");
await fire("session_shutdown", { reason: "quit" });
const { execFileSync: ex } = await import("node:child_process");
const head = ex("git", ["log", "--oneline"], { cwd: fs.readdirSync(path.join(home, "repos"))[0] ? path.join(home, "repos", fs.readdirSync(path.join(home, "repos"))[0]) : work, encoding: "utf8" });
ok("entries committed", head.includes("memtory:"), head);

if (createdStub) fs.rmSync(path.dirname(stub), { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\nadapter tests passed" : `\n${failed} adapter check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
