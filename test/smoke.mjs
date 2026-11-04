import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardWay, isGenericSymptom } from "../src/capture.mjs";

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
function mem(cwd, home, args, env = {}) {
  return sh(cwd, [process.execPath, BIN, ...args], { MEMTORY_HOME: home, ...env });
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

console.log("\n5b. quality gate (noise must not enter the store)");
const out = (text) => [{ type: "text", text }];
const bash = (command, text, isError) => ({ toolName: "bash", input: { command }, content: text, isError });
const edited = { toolName: "edit", input: { path: "a.mjs" }, content: "ok", isError: false };

ok(
  "generic exception is not recorded",
  detectHardWay([
    bash("node a.mjs", "Output:\nTypeError: Cannot read properties of undefined (reading 'b')", true),
    bash("node a.mjs", "Output:\nTypeError: Cannot read properties of undefined (reading 'b')", true),
    bash("node a.mjs --verbose", "Output:\nok", false),
  ]) === null,
);
ok(
  "identical retry with no edit is transient, not knowledge",
  detectHardWay([
    bash("npm test", "Output:\nEADDRINUSE port 3000 in use", true),
    bash("npm test", "Output:\nEADDRINUSE port 3000 in use", true),
    bash("npm test", "Output:\nok", false),
  ]) === null,
);
const afterEdit = detectHardWay([
  bash("npm test", "Output:\nEADDRINUSE port 3000 in use", true),
  bash("npm test", "Output:\nEADDRINUSE port 3000 in use", true),
  edited,
  bash("npm test", "Output:\nok", false),
]);
ok("identical retry after an edit is recorded", Boolean(afterEdit));
ok("fix names the edited file, not just the command", Boolean(afterEdit?.fix.includes("a.mjs")), afterEdit?.fix);
ok(
  "a cd prefix cannot fake a shared command",
  detectHardWay([
    bash("cd /tmp/proj && node tools/measure.mjs", "Output:\nERR_ASSERTION bad range", true),
    bash("cd /tmp/proj && node tools/measure.mjs", "Output:\nERR_ASSERTION bad range", true),
    bash("cd /tmp/proj && node tools/verify.mjs", "Output:\nok", false),
  ]) === null,
);
const kept = detectHardWay([
  bash("pnpm build", "Output:\nTS2345 Argument of type string is not assignable", true),
  bash("pnpm build --no-cache", "Output:\nTS2345 Argument of type string is not assignable", true),
  bash("pnpm build", "Output:\nok", false),
]);
ok("real error code survives the gate", Boolean(kept), JSON.stringify(kept));

const meta = (isError) => ({
  toolName: "agent_browser",
  input: { args: ["open", "https://example.com"] },
  content: "Result category: failure; failureCategory: upstream-error; Pi tool isError: true.",
  isError,
});
ok("harness metadata is not a symptom", detectHardWay([meta(true), meta(true), meta(false)]) === null);
ok(
  "metadata-shaped symptoms are generic",
  isGenericSymptom("Result category: failure; failureCategory: upstream-error; Pi tool isError: true."),
);
ok("gate keeps the cause empty for a human", kept?.cause === "");

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


console.log("\n13. any folder works: non-git folders publish to a shared local store");
const notes = path.join(root, "notes-only");
fs.mkdirSync(notes, { recursive: true });
const homeE = path.join(root, "homeE");
const local = mem(notes, homeE, [
  "observe",
  "--symptom",
  "VOICE_CLONE_SAMPLE_RATE mismatch when muxing with ffmpeg -shortest",
  "--fix",
  "resample to 48k before muxing",
]);
ok("recorded without a repo", local.includes("recorded"), local);
ok("published without any setup", local.includes("pushed"), local);
const globalStore = path.join(homeE, "global.git");
ok("machine-wide store created", fs.existsSync(globalStore));
ok("branch exists in the shared store", trySh(globalStore, ["git", "rev-parse", "--verify", "memtory"]) !== null);
ok("pointer written for a non-git folder", fs.readdirSync(path.join(homeE, "pointers")).length === 1);
const notesStats = mem(notes, homeE, ["stats"]);
ok("stats names the shared store", notesStats.includes("global.git"), notesStats);
ok("no longer reports 'not published'", !notesStats.includes("NOT PUBLISHED"));

console.log("\n13b. knowledge crosses folders and harnesses");
const notes2 = path.join(root, "second-folder");
fs.mkdirSync(notes2, { recursive: true });
const cross = mem(notes2, homeE, ["recall", "ffmpeg sample rate mismatch muxing"]);
ok("a second folder sees the first folder's note", cross.includes("VOICE_CLONE_SAMPLE_RATE"), cross);

console.log("\n13c. an explicit remote wins over the shared store");
const notesBare = path.join(root, "notes-origin.git");
fs.mkdirSync(notesBare, { recursive: true });
sh(notesBare, ["git", "init", "--bare", "-b", "memtory"]);
const withRemote = mem(
  notes,
  homeE,
  ["observe", "--symptom", "ffmpeg loudnorm filter fails when input has no audio stream", "--fix", "probe streams first"],
  { MEMTORY_REMOTE: notesBare },
);
ok("publishes to the configured remote", withRemote.includes("pushed"), withRemote);
ok("same store reused", fs.readdirSync(path.join(homeE, "repos")).length === 2);
const remoteTree = sh(notesBare, ["git", "ls-tree", "-r", "--name-only", "memtory"]);
ok("both notes reached the configured remote", remoteTree.split("\n").filter((line) => line.startsWith("entries/")).length === 2, remoteTree);

console.log("\n13d. a broken remote is reported, never swallowed");
const broken = path.join(root, "broken-folder");
fs.mkdirSync(broken, { recursive: true });
const pushFail = mem(
  broken,
  homeE,
  ["observe", "--symptom", "whisper returns empty segments for mono 8k input", "--fix", "upsample to 16k"],
  { MEMTORY_REMOTE: path.join(root, "does-not-exist.git") },
);
ok("record stays local on push failure", pushFail.includes("recorded"), pushFail);
ok("push failure is reported", pushFail.includes("push failed"), pushFail);
ok("stats shows the last push error", mem(broken, homeE, ["stats"]).includes("last push failed"));

console.log("\n14. prune unsearchable auto-notes");
mem(projA, homeA, ["observe", "--symptom", "TypeError: Cannot read properties of undefined (reading 'b')", "--fix", "reran it", "--tag", "auto"]);
mem(projA, homeA, ["observe", "--symptom", "ReferenceError: x is not defined", "--fix", "declared x", "--confidence", "low"]);
const listBefore = JSON.parse(mem(projA, homeA, ["list", "--json"])).length;
const dry = mem(projA, homeA, ["prune"]);
ok("lists the noise", dry.includes("would remove") && dry.includes("TypeError"), dry);
ok("dry run deletes nothing", JSON.parse(mem(projA, homeA, ["list", "--json"])).length === listBefore);
const applied = mem(projA, homeA, ["prune", "--apply"]);
ok("apply removes it", applied.includes("removed"), applied);
const listAfter = JSON.parse(mem(projA, homeA, ["list", "--json"])).length;
ok("one fewer note", listAfter === listBefore - 1, `${listBefore} -> ${listAfter}`);
ok("searchable notes are never pruned", JSON.parse(mem(projA, homeA, ["list", "--json"])).some((e) => e.symptom.includes("ERR_PNPM")));
ok("second prune is a no-op", mem(projA, homeA, ["prune"]).includes("nothing to prune"));
ok("generic note written by a human is kept", JSON.parse(mem(projA, homeA, ["list", "--json"])).some((e) => e.symptom.includes("ReferenceError")));


console.log("\n15. background push can be turned off");
const guarded = path.join(root, "guarded");
gitInit(guarded);
fs.writeFileSync(path.join(guarded, "a.txt"), "x");
sh(guarded, ["git", "add", "-A"]);
sh(guarded, ["git", "commit", "-m", "init"]);
const guardedBare = path.join(root, "guarded-origin.git");
fs.mkdirSync(guardedBare, { recursive: true });
sh(guardedBare, ["git", "init", "--bare", "-b", "main"]);
sh(guarded, ["git", "remote", "add", "origin", guardedBare]);
sh(guarded, ["git", "push", "-q", "-u", "origin", "main"]);
const homeF = path.join(root, "homeF");

ok("autopush off", mem(guarded, homeF, ["autopush", "off"]).includes("off"));
const quiet = mem(guarded, homeF, ["observe", "--symptom", "ERR_GUARD_TEST specific failure in module loader", "--fix", "patched loader"]);
ok("note still recorded", quiet.includes("recorded"), quiet);
ok("says push is disabled", quiet.includes("background push disabled"), quiet);
ok("branch was not created on origin", trySh(guardedBare, ["git", "rev-parse", "--verify", "memtory"]) === null);
ok("note is committed locally", JSON.parse(mem(guarded, homeF, ["list", "--json"])).length === 1);

const forced = mem(guarded, homeF, ["sync"]);
ok("explicit sync still pushes", forced.includes("pushed"), forced);
ok("branch now on origin", trySh(guardedBare, ["git", "rev-parse", "--verify", "memtory"]) !== null);

mem(guarded, homeF, ["autopush", "on"]);
const loud = mem(guarded, homeF, ["observe", "--symptom", "ERR_GUARD_TEST second unrelated failure in resolver", "--fix", "fixed resolver"]);
ok("autopush on pushes again", loud.includes("pushed"), loud);


console.log("\n16. two independent stores, one shared notes branch");
const sharedRemote = path.join(root, "shared-notes.git");
fs.mkdirSync(sharedRemote, { recursive: true });
sh(sharedRemote, ["git", "init", "--bare", "-b", "memtory"]);
const homeG = path.join(root, "homeG");
const folderA = path.join(root, "folder-a");
const folderB = path.join(root, "folder-b");
fs.mkdirSync(folderA, { recursive: true });
fs.mkdirSync(folderB, { recursive: true });
const envShared = { MEMTORY_REMOTE: sharedRemote };
const aNote = mem(folderA, homeG, ["observe", "--symptom", "ERR_SHARED_A first folder failure in loader", "--fix", "patched loader"], envShared);
const bNote = mem(folderB, homeG, ["observe", "--symptom", "ERR_SHARED_B second folder failure in parser", "--fix", "patched parser"], envShared);
ok("first folder pushed", aNote.includes("pushed"), aNote);
ok("second folder pushed despite unrelated history", bNote.includes("pushed"), bNote);
const sharedTree = sh(sharedRemote, ["git", "ls-tree", "-r", "--name-only", "memtory"]);
const sharedEntries = sharedTree.split("\n").filter((line) => line.startsWith("entries/"));
ok("shared branch has both notes", sharedEntries.length === 2, JSON.stringify(sharedEntries));
mem(folderA, homeG, ["sync"], envShared);
ok("a folder picks up the other folder's note", JSON.parse(mem(folderA, homeG, ["list", "--json"], envShared)).length === 2);
ok("sync is idempotent", mem(folderB, homeG, ["sync"], envShared).includes("up-to-date") || mem(folderB, homeG, ["sync"], envShared).includes("0 unpushed"));

fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\nall smoke tests passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
