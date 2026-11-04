/**
 * Harness hooks: drives the real Claude Code payload shapes through runHook.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memtory-hooks-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
process.env.MEMTORY_HOME = home;
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

const { runHook } = await import(path.join(here, "..", "src", "hooks.mjs"));
const { openStore } = await import(path.join(here, "..", "src", "gitmem.mjs"));
const { readAll } = await import(path.join(here, "..", "src", "store.mjs"));

async function hook(event, payload) {
  const out = [];
  const stdout = { write: (chunk) => out.push(chunk) };
  const result = await runHook("claude-code", event, {
    stdin: Readable.from([JSON.stringify(payload)]),
    stdout,
  });
  const printed = out.join("");
  return { result, printed, json: printed ? JSON.parse(printed) : null };
}

const session = "sess-123";

console.log("\nSessionStart");
const start = await hook("SessionStart", { session_id: session, cwd, source: "startup" });
ok("emits hookSpecificOutput", start.json?.hookSpecificOutput?.hookEventName === "SessionStart", start.printed);
ok("carries the protocol", String(start.json?.hookSpecificOutput?.additionalContext).includes("<memtory>"), start.printed);
ok("bounded size", start.printed.length < 9000, String(start.printed.length));

console.log("\nPostToolUse -> auto-observe");
const fail = (command, text) => ({
  session_id: session,
  cwd,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { success: false, exit_code: 1, stderr: text },
});
const pass = (command) => ({
  session_id: session,
  cwd,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { success: true, exit_code: 0, stdout: "done" },
});

await hook("PostToolUse", fail("pnpm install", "ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19"));
await hook("PostToolUse", fail("pnpm install --force", "ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19"));
await hook("PostToolUse", {
  session_id: session,
  cwd,
  tool_name: "Edit",
  tool_input: { file_path: "package.json" },
  tool_response: { success: true },
});
const done = await hook("PostToolUse", pass("pnpm install"));

const { dir } = openStore(cwd);
const entries = readAll(dir);
ok("observation recorded from hooks", entries.length === 1, JSON.stringify(entries.map((e) => e.symptom)));
ok("symptom captured", (entries[0]?.symptom || "").includes("ERR_PNPM_PEER_DEP_ISSUES"), entries[0]?.symptom);
ok("no stdout noise on PostToolUse", done.printed === "", done.printed);
ok("session buffer written", fs.readdirSync(path.join(home, "state", "sessions")).length === 1);

console.log("\nUserPromptSubmit");
const prompt = await hook("UserPromptSubmit", {
  session_id: session,
  cwd,
  prompt: "pnpm install fails: ERR_PNPM_PEER_DEP_ISSUES unmet peer dependency react",
});
ok("injects a matching note", String(prompt.json?.hookSpecificOutput?.additionalContext || "").includes("ERR_PNPM_PEER_DEP_ISSUES"), prompt.printed);
const unrelated = await hook("UserPromptSubmit", { session_id: session, cwd, prompt: "how do I center a div with flexbox" });
ok("stays quiet on a miss", unrelated.printed === "", unrelated.printed);

console.log("\nSessionEnd");
await hook("SessionEnd", { session_id: session, cwd, reason: "other" });
ok("session buffer cleaned up", !fs.existsSync(path.join(home, "state", "sessions", `${session}.json`)));

console.log("\nrobustness");
const garbage = await runHook("claude-code", "SessionStart", {
  stdin: Readable.from(["not json at all"]),
  stdout: { write: () => {} },
});
ok("survives a malformed payload", true);
const unknownEvent = await hook("NotARealEvent", { cwd });
ok("unknown event is a no-op", unknownEvent.printed === "");

await new Promise((resolve) => setTimeout(resolve, 600));
fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\nhook tests passed" : `\n${failed} hook check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
