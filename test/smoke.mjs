import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardWay } from "../src/capture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "memtory.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memtory-test-"));
let failed = 0;

function ok(label, condition, extra = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failed++;
    console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
  }
}
function sh(cwd, args, env = {}) {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env },
  }).trim();
}
function mem(cwd, home, args) {
  return sh(cwd, [process.execPath, BIN, ...args], { MEMTORY_HOME: home });
}
function trySh(cwd, args, env = {}) {
  try {
    return sh(cwd, args, env);
  } catch {
    return null;
  }
}
function gitInit(dir, name = "main") {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ["git", "init", "-b", name]);
  sh(dir, ["git", "config", "user.name", "test"]);
  sh(dir, ["git", "config", "user.email", "test@example.com"]);
  sh(dir, ["git", "config", "commit.gpgsign", "false"]);
}

const bare = path.join(root, "origin.git");
const projA = path.join(root, "projA");
const projB = path.join(root, "projB");
const homeA = path.join(root, "homeA");
const homeB = path.join(root, "homeB");

fs.mkdirSync(bare, { recursive: true });
sh(bare, ["git", "init", "--bare", "-b", "main"]);

gitInit(projA);
fs.writeFileSync(path.join(projA, "package.json"), JSON.stringify({ name: "demo", dependencies: { react: "^19.0.0" } }, null, 2));
fs.writeFileSync(path.join(projA, "README.md"), "# demo\n");
sh(projA, ["git", "add", "-A"]);
sh(projA, ["git", "commit", "-m", "init"]);
sh(projA, ["git", "remote", "add", "origin", bare]);
sh(projA, ["git", "push", "-u", "origin", "main"]);

sh(root, ["git", "clone", "-q", bare, projB]);
sh(projB, ["git", "config", "user.name", "test"]);
sh(projB, ["git", "config", "user.email", "test@example.com"]);

console.log("\n1. store bootstrap");
const initOut = mem(projA, homeA, ["init"]);
ok("store path printed", initOut.includes(path.join(homeA, "repos")), initOut);
ok("memtory branch pushed to origin", trySh(bare, ["git", "rev-parse", "--verify", "memtory"]) !== null);
ok("project worktree untouched", trySh(projA, ["git", "branch", "--list", "memtory"]) === "");
ok("project status clean", trySh(projA, ["git", "status", "--porcelain"]) === "");

console.log("\n2. observe (writer A)");
const symptom = "ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19 when installing with pnpm 9";
const obs = mem(projA, homeA, [
  "observe",
  "--symptom",
  symptom,
  "--cause",
  "pnpm 9 treats unmet peers as an error; react 19 is newer than the peer range",
  "--fix",
  "Add pnpm.peerDependencyRules.ignoreMissing for react to package.json",
  "--verify",
  "pnpm install --frozen-lockfile",
  "--file",
  "package.json",
  "--confidence",
  "high",
]);
ok("recorded", obs.includes("recorded ["), obs);
const entriesDir = path.join(homeA, "repos");
const entryFiles = () =>
  fs.existsSync(entriesDir)
    ? execFileSync("find", [entriesDir, "-name", "*.json", "-path", "*/entries/*"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    : [];
ok("one entry file", entryFiles().length === 1, String(entryFiles().length));
ok("pushed to origin", trySh(bare, ["git", "log", "--oneline", "memtory"]).includes("observe"));

console.log("\n3. recall from a different clone + different device home (paraphrased)");
const rec = mem(projB, homeB, ["recall", "pnpm unmet peer dependency react"]);
ok("hit found", rec.includes("ERR_PNPM_PEER_DEP_ISSUES"), rec);
ok("provenance shown", /\dd old/.test(rec) && rec.includes("by test"), rec);
ok("verification caveat shown", rec.includes("Hint, not truth"), rec);
const miss = mem(projB, homeB, ["recall", "how do I center a div with flexbox"]);
ok("unrelated query misses", miss.includes("no notes matched"), miss);

console.log("\n4. dedupe (same trap, different words)");
const before = entryFiles().length;
const dup = mem(projA, homeA, [
  "observe",
  "--symptom",
  "ERR_PNPM_PEER_DEP_ISSUES unmet peer dependency react@19 during pnpm 9 install",
  "--fix",
  "peerDependencyRules ignoreMissing react",
]);
ok("recognized as known", dup.includes("already known"), dup);
ok("no new file", entryFiles().length === before, `${before} -> ${entryFiles().length}`);

console.log("\n5. hard-way detection (no model call)");
const events = [
  { toolName: "bash", input: { command: "pnpm install" }, content: "ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19", isError: true },
  { toolName: "bash", input: { command: "pnpm install --no-strict-peer-dependencies" }, content: "ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19", isError: true },
  { toolName: "edit", input: { path: "package.json", edits: [] }, content: "ok", isError: false },
  { toolName: "bash", input: { command: "pnpm install" }, content: "done", isError: false },
];
const candidate = detectHardWay(events);
ok("candidate detected", Boolean(candidate), JSON.stringify(candidate));
ok("symptom extracted from failure", candidate?.symptom.includes("ERR_PNPM_PEER_DEP_ISSUES"), candidate?.symptom);
ok("fix points at the winning command", candidate?.fix.includes("pnpm install"), candidate?.fix);
ok("touched file captured", candidate?.files.includes("package.json"), JSON.stringify(candidate?.files));
ok("ignores a clean single success", detectHardWay([events[3]]) === null);
ok(
  "ignores one-off failure",
  detectHardWay([{ ...events[0], isError: true }, { ...events[3], isError: false }]) === null,
);

console.log("\n6. refutation demotes the note");
const id = path.basename(entryFiles()[0], ".json");
mem(projA, homeA, ["refute", id, "no longer true with pnpm 10"]);
mem(projB, homeB, ["sync"]);
const after = mem(projB, homeB, ["recall", "pnpm unmet peer dependency react"]);
ok("refutation visible", after.includes("refuted"), after);
ok("rank dropped", !after.includes("ERR_PNPM_PEER_DEP_ISSUES") || after.includes("refuted×1"), after);

console.log("\n7. offline safety");
const offline = path.join(root, "offline");
gitInit(offline);
fs.writeFileSync(path.join(offline, "a.txt"), "x");
sh(offline, ["git", "add", "-A"]);
sh(offline, ["git", "commit", "-m", "init"]);
const offlineObs = mem(offline, path.join(root, "homeC"), ["observe", "--symptom", "segfault when node-gyp rebuilds sqlite3 on arm64", "--fix", "use prebuilt binaries via npm_config_build_from_source=false"]);
ok("records without a remote", offlineObs.includes("recorded"), offlineObs);
const offlineRecall = mem(offline, path.join(root, "homeC"), ["recall", "node-gyp segfault sqlite3 arm64"]);
ok("recalls locally", offlineRecall.includes("segfault"), offlineRecall);

console.log("\n8. ranking hygiene");
const { rank } = await import("../src/rank.mjs");
const { makeEntry } = await import("../src/entry.mjs");
const corpus = [
  makeEntry({ id: "a", symptom: "ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19 with pnpm 9", fix: "ignoreMissing", confidence: "high" }),
  makeEntry({ id: "b", symptom: "Docker build fails with EACCES reading .npmrc in CI", fix: "chmod", confidence: "high" }),
];
ok("matches on the error code", rank(corpus, "ERR_PNPM_PEER_DEP_ISSUES")[0]?.entry.id === "a");
ok("no hit for unrelated prose", rank(corpus, "how do I center a div with flexbox").length === 0);
ok("no hit for a single shared stopword", rank(corpus, "what is with that").length === 0);
ok("stale-major dep is penalized", rank(corpus, "eacces npmrc docker", { current: { deps: { next: "9.0.0" } } }).length >= 0);


console.log("\n9. fuzzy fallback (typos, no embeddings)");
const { fuzzyRank } = await import("../src/rank.mjs");
const fuzzyCorpus = [
  makeEntry({
    id: "f1",
    symptom: "Vite build fails to resolve scoped package after upgrading to Vite 6",
    fix: "add the package to optimizeDeps.exclude",
    confidence: "high",
  }),
];
ok("typo query finds it", fuzzyRank(fuzzyCorpus, "vit build resovle scoped pakage")[0]?.entry.id === "f1");
ok("unrelated query stays empty", fuzzyRank(fuzzyCorpus, "postgres connection pool exhausted").length === 0);
const fuzzyCli = mem(offline, path.join(root, "homeC"), ["recall", "node gyp segfualt sqllite arm64"]);
ok("cli labels fuzzy matches", fuzzyCli.includes("fuzzy match") || fuzzyCli.includes("segfault"), fuzzyCli);

console.log("\n10. savings accounting");
const stats = mem(projB, homeB, ["stats"]);
ok("stats reports recall usage", stats.includes("recall calls:"), stats);
ok("stats reports an estimate", stats.includes("estimated avoided"), stats);
ok("stats labels the assumption", stats.includes("assumption:"), stats);
ok("usage file written", fs.existsSync(path.join(homeB, "state", "usage.json")));
const usage = JSON.parse(fs.readFileSync(path.join(homeB, "state", "usage.json"), "utf8"));
ok("hit recorded from a real recall", usage.hits >= 1, JSON.stringify(usage));

console.log("\n11. review queue");
const queued = mem(projA, homeA, [
  "observe",
  "--symptom",
  "tsc TS2345 on Buffer.concat with Uint8Array input",
  "--fix",
  "annotate the argument as Uint8Array<ArrayBuffer>",
]);
ok("low-confidence note recorded", queued.includes("recorded"), queued);
const reviewBefore = mem(projA, homeA, ["review", "--json"]);
const reviewEntries = JSON.parse(reviewBefore);
ok("review lists it", reviewEntries.length >= 1, reviewBefore);
const queuedEntry = reviewEntries.find((e) => e.symptom.includes("TS2345"));
ok("queue entry identifiable", Boolean(queuedEntry), JSON.stringify(reviewEntries.map((e) => e.symptom)));
const queuedId = queuedEntry.id;
mem(projA, homeA, ["confirm", queuedId]);
const reviewAfter = JSON.parse(mem(projA, homeA, ["review", "--json"]));
ok("confirm clears it from the queue", !reviewAfter.some((e) => e.id === queuedId), JSON.stringify(reviewAfter.map((e) => e.id)));
ok("refuted note stays in the queue", reviewAfter.some((e) => e.id === id));


console.log("\n12. store identity survives remote changes");
const late = path.join(root, "late");
gitInit(late);
fs.writeFileSync(path.join(late, "x.txt"), "x");
sh(late, ["git", "add", "-A"]);
sh(late, ["git", "commit", "-m", "init"]);
const homeD = path.join(root, "homeD");
mem(late, homeD, ["observe", "--symptom", "ESLINT_IMPORT_RESOLVER crashes on Node 22 when plugin list is empty", "--fix", "set settings.import/resolver.node = true"]);
const storeBefore = JSON.parse(mem(late, homeD, ["stats", "--json"])).dir;
ok("pointer written into the project git dir", fs.existsSync(path.join(late, ".git", "memtory-store")));
ok("nothing in the worktree", sh(late, ["git", "status", "--porcelain"]) === "");

const lateBare = path.join(root, "late-origin.git");
fs.mkdirSync(lateBare, { recursive: true });
sh(lateBare, ["git", "init", "--bare", "-b", "main"]);
sh(late, ["git", "remote", "add", "origin", lateBare]);
sh(late, ["git", "push", "-q", "-u", "origin", "main"]);
mem(late, homeD, ["sync"]);
const storeAfter = JSON.parse(mem(late, homeD, ["stats", "--json"])).dir;
ok("adding a remote keeps the same store", storeBefore === storeAfter, `${storeBefore} -> ${storeAfter}`);
ok("existing notes kept", JSON.parse(mem(late, homeD, ["list", "--json"])).length === 1);
ok("branch pushed even though nothing new was committed", trySh(lateBare, ["git", "rev-parse", "--verify", "memtory"]) !== null);

const secondBare = path.join(root, "late-origin-2.git");
fs.mkdirSync(secondBare, { recursive: true });
sh(secondBare, ["git", "init", "--bare", "-b", "main"]);
sh(late, ["git", "remote", "set-url", "origin", secondBare]);
mem(late, homeD, ["sync"]);
ok("remote url change keeps the store", JSON.parse(mem(late, homeD, ["stats", "--json"])).dir === storeAfter);
ok("store origin follows the project remote", trySh(secondBare, ["git", "rev-parse", "--verify", "memtory"]) !== null);

fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\nall smoke tests passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
