/**
 * MCP stdio server: real subprocess, real JSON-RPC, real store.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "memtory.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memtory-mcp-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
let failed = 0;

function ok(label, condition, extra = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failed++;
    console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
  }
}

fs.mkdirSync(cwd, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
execFileSync("git", ["config", "user.email", "t@e.com"], { cwd });
execFileSync("git", ["config", "user.name", "t"], { cwd });
fs.writeFileSync(path.join(cwd, "a.txt"), "x");
execFileSync("git", ["add", "-A"], { cwd });
execFileSync("git", ["commit", "-qm", "init"], { cwd });

const child = spawn(process.execPath, [BIN, "mcp"], {
  cwd,
  env: { ...process.env, MEMTORY_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 0;
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});

function rpc(method, params) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
  });
}

function textOf(response) {
  return (response?.result?.content || []).map((part) => part.text).join("\n");
}

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  ok("initialize handshake", init.result?.serverInfo?.name === "memtory", JSON.stringify(init));
  ok("protocol version echoed", init.result?.protocolVersion === "2025-06-18");
  ok("instructions carry the protocol", String(init.result?.instructions || "").includes("<memtory>"));
  ok("tools capability", Boolean(init.result?.capabilities?.tools));

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((tool) => tool.name);
  ok("four tools listed", names.length === 4, names.join(","));
  ok("recall tool", names.includes("memtory_recall"));
  ok("observe tool", names.includes("memtory_observe"));
  ok("schemas are JSON Schema", list.result?.tools?.every((t) => t.inputSchema?.type === "object"));

  const observed = await rpc("tools/call", {
    name: "memtory_observe",
    arguments: {
      symptom: "ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19 on pnpm 9",
      cause: "pnpm 9 errors on unmet peers",
      fix: "pnpm.peerDependencyRules.ignoreMissing react",
      verify: "pnpm install --frozen-lockfile",
      files: ["package.json"],
      confidence: "high",
    },
  });
  ok("observe via mcp", textOf(observed).includes("recorded"), JSON.stringify(observed));

  await new Promise((resolve) => setTimeout(resolve, 400));
  const recalled = await rpc("tools/call", { name: "memtory_recall", arguments: { query: "pnpm unmet peer dependency react" } });
  ok("recall via mcp", textOf(recalled).includes("ERR_PNPM_PEER_DEP_ISSUES"), textOf(recalled));
  ok("recall shows provenance", textOf(recalled).includes("hints from other agents") || textOf(recalled).includes("Hint, not truth"));

  const miss = await rpc("tools/call", { name: "memtory_recall", arguments: { query: "how do I center a div" } });
  ok("miss is honest", textOf(miss).includes("no notes matched"), textOf(miss));

  const badArgs = await rpc("tools/call", { name: "memtory_recall", arguments: {} });
  ok("arg validation", badArgs.result?.isError === true, JSON.stringify(badArgs));

  const unknown = await rpc("definitely/not/a/method", {});
  ok("unknown method errors", unknown.error?.code === -32601, JSON.stringify(unknown));

  const ping = await rpc("ping", {});
  ok("ping", ping.result && Object.keys(ping.result).length === 0);

  const id = (textOf(recalled).match(/\[([a-z0-9-]+)\]/) || [])[1];
  const refuted = await rpc("tools/call", { name: "memtory_refute", arguments: { id, note: "pnpm 10 changed it" } });
  ok("refute via mcp", textOf(refuted).includes("refuted"), textOf(refuted));

  const sync = await rpc("tools/call", { name: "memtory_sync", arguments: {} });
  ok("sync via mcp", textOf(sync).includes("memtory:"), textOf(sync));
} catch (error) {
  failed++;
  console.log(`  FAIL unexpected: ${error.message}\n${stderr}`);
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nmcp tests passed" : `\n${failed} mcp check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
