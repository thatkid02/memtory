/**
 * Installer: verifies the exact files each harness expects, and idempotency.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memtory-install-"));
const fakeHome = path.join(root, "home");
const cwd = path.join(root, "project");
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
process.env.HOME = fakeHome;
let failed = 0;

function ok(label, condition, extra = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failed++;
    console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
  }
}

const { install } = await import(path.join(here, "..", "src", "install.mjs"));
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const readJson = (file) => JSON.parse(read(file) || "{}");

console.log("\nclaude code");
const first = install({ cwd, targets: ["claude"] });
ok("reports hooks", first.lines.some((l) => l.includes("hook added: SessionStart")), first.lines.join(" | "));
const settings = readJson(path.join(cwd, ".claude", "settings.json"));
for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd"]) {
  const groups = settings.hooks?.[event] || [];
  const ours = groups.filter((g) => (g.hooks || []).some((h) => String(h.command).includes("hook claude-code")));
  ok(`${event} hook wired`, ours.length === 1, JSON.stringify(settings.hooks?.[event]));
}
ok(
  "SessionStart matcher scoped",
  settings.hooks.SessionStart[0].matcher === "startup|resume|clear|compact",
  JSON.stringify(settings.hooks.SessionStart[0]),
);
ok("PostToolUse matcher scoped to tools", settings.hooks.PostToolUse[0].matcher === "Bash|Edit|Write|MultiEdit");
const mcp = readJson(path.join(cwd, ".mcp.json"));
ok("mcp server declared", mcp.mcpServers?.memtory?.command === "node", JSON.stringify(mcp));
ok("mcp targets this project", mcp.mcpServers?.memtory?.env?.MEMTORY_PROJECT === cwd);
ok("mcp args point at the bin", String(mcp.mcpServers?.memtory?.args?.[0] || "").endsWith("bin/memtory.mjs"));

const second = install({ cwd, targets: ["claude"] });
ok("hooks are idempotent", second.lines.every((l) => l.includes("present") || l.includes("unchanged")), second.lines.join(" | "));
const again = readJson(path.join(cwd, ".claude", "settings.json"));
ok("no duplicate hook groups", again.hooks.SessionStart.length === 1, JSON.stringify(again.hooks.SessionStart));

console.log("\nexisting settings are preserved");
fs.writeFileSync(
  path.join(cwd, ".claude", "settings.json"),
  JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2),
);
install({ cwd, targets: ["claude"] });
const merged = readJson(path.join(cwd, ".claude", "settings.json"));
ok("foreign keys kept", merged.permissions?.allow?.[0] === "Bash(ls:*)");
ok("foreign hooks kept", merged.hooks.PreToolUse?.[0]?.hooks?.[0]?.command === "echo hi");
ok("our hooks still added", (merged.hooks.SessionStart || []).length === 1);

console.log("\nrefuses to clobber broken json");
fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "{ not json");
let threw = false;
try {
  install({ cwd, targets: ["claude"] });
} catch {
  threw = true;
}
ok("throws instead of overwriting", threw);
ok("file left untouched", read(path.join(cwd, ".claude", "settings.json")) === "{ not json");
fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "{}");

console.log("\ncodex");
const codex = install({ cwd, targets: ["codex"] });
const agents = read(path.join(cwd, "AGENTS.md"));
ok("AGENTS.md block added", agents.includes("<!-- memtory:start -->") && agents.includes("<!-- memtory:end -->"));
ok("AGENTS.md points at the recall command", /recall "<error line/.test(agents), agents.slice(0, 400));
ok("AGENTS.md mentions the guardrail", agents.includes("hints from other agents"));
const toml = read(path.join(fakeHome, ".codex", "config.toml"));
ok("codex mcp configured", /\[mcp_servers\.memtory\]/.test(toml) && toml.includes('"mcp"'), toml);
install({ cwd, targets: ["codex"] });
ok("codex config not duplicated", read(path.join(fakeHome, ".codex", "config.toml")).split("[mcp_servers.memtory]").length === 2);
ok("AGENTS.md block replaced once", read(path.join(cwd, "AGENTS.md")).split("<!-- memtory:start -->").length === 2);
ok("codex reports work", codex.lines.some((l) => l.includes("codex mcp")));

console.log("\npi");
const pi = install({ targets: ["pi"] });
const shim = path.join(fakeHome, ".pi", "agent", "extensions", "memtory.ts");
ok("shim written as .ts (pi auto-discovery needs .ts/.js)", fs.existsSync(shim) && !fs.lstatSync(shim).isSymbolicLink());
ok("re-exports the adapter by absolute path", read(shim).includes("adapters/pi/index.mjs"), read(shim));
ok("shim is marked generated", read(shim).includes("generated by"));
const piAgain = install({ targets: ["pi"] });
ok("idempotent", piAgain.lines.some((l) => l.includes("pi extension present")), piAgain.lines.join(" | "));

console.log("\ndry run");
const dryCwd = path.join(root, "dry");
fs.mkdirSync(dryCwd, { recursive: true });
const dry = install({ cwd: dryCwd, targets: ["claude", "codex"], dryRun: true });
ok("no settings written", !fs.existsSync(path.join(dryCwd, ".claude", "settings.json")));
ok("no mcp written", !fs.existsSync(path.join(dryCwd, ".mcp.json")));
ok("no agents written", !fs.existsSync(path.join(dryCwd, "AGENTS.md")));
ok("dry run explains itself", dry.lines.filter((l) => l.startsWith("would")).length >= 3, dry.lines.join(" | "));

fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\ninstall tests passed" : `\n${failed} install check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
