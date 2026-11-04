import fs from "node:fs";
import { flush, openStore, push, syncStatus } from "./gitmem.mjs";
import { readAll } from "./store.mjs";
import { confirm, observe, recall, refute, syncFromRemote } from "./ops.mjs";
import { formatEntry, formatHits, formatObserved, formatStats } from "./format.mjs";
import { formatUsage, readUsage } from "./usage.mjs";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--stdin") flags.stdin = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--global") flags.global = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--no-push") flags.push = false;
    else if (arg === "--claude") flags.targets = [...(flags.targets || []), "claude"];
    else if (arg === "--codex") flags.targets = [...(flags.targets || []), "codex"];
    else if (arg === "--pi") flags.targets = [...(flags.targets || []), "pi"];
    else if (arg === "--verbose" || arg === "-v") flags.verbose = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      const value = inline !== undefined ? inline : argv[++i];
      flags[key] = value;
    } else positional.push(arg);
  }
  return { flags, positional };
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function collect(flags, single, multi) {
  const out = {};
  for (const key of single) if (flags[key] !== undefined) out[key] = flags[key];
  for (const key of multi) {
    if (flags[key] === undefined) continue;
    out[key] = String(flags[key]).split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const HELP = `memtory — hard-won knowledge, shared through a git branch

  memtory recall <query...>        search this repo's notes (reads only)
  memtory observe [flags]          record a note (or JSON on --stdin)
  memtory review [--json]          show notes that need a human look
  memtory list [--json]            dump every note
  memtory stats [--json]           counts, review queue, estimated savings
  memtory confirm <id>             mark a note as still correct
  memtory refute <id> [note]       mark a note as wrong/stale
  memtory sync                     merge notes written by others and push
  memtory flush                    commit + push local notes (used by hooks)
  memtory init                     create/attach the store
  memtory path                     print the local store path

  memtory mcp                      run the MCP stdio server (Claude Code, Codex, Cursor)
  memtory hook <harness> <event>   run a harness hook (reads the payload on stdin)
  memtory install [--claude] [--codex] [--pi] [--global] [--dry-run]
                                   wire memtory into your agents

observe flags:
  --symptom "<what failed>"  --cause "<why>"  --fix "<what worked>"
  --verify "<command>"       --file <path,...>  --tag <t,...>
  --confidence high|medium|low

env: MEMTORY_HOME (~/.memtory)  MEMTORY_PROJECT  MEMTORY_PULL_TTL (ms)
     MEMTORY_NO_PULL=1  MEMTORY_AUTORECALL=0  MEMTORY_SAVED_TOKENS  MEMTORY_SAVED_STEPS
`;

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const [command = "help", ...rest] = positional;
  const cwd = process.cwd();

  try {
    switch (command) {
      case "recall": {
        const query = rest.join(" ").trim() || readStdin().trim();
        if (!query) throw new Error("memtory recall: pass a query (error text, file path, or task)");
        const result = recall(cwd, query, { limit: Number(flags.limit || 3), source: "cli" });
        if (flags.json) console.log(JSON.stringify({ query, total: result.total, fuzzy: result.fuzzy, hits: result.hits }, null, 2));
        else console.log(formatHits(result));
        return 0;
      }
      case "observe": {
        let input;
        if (flags.stdin) {
          const raw = readStdin().trim();
          if (!raw) throw new Error("memtory observe: --stdin expects JSON on stdin");
          input = JSON.parse(raw);
        } else {
          input = collect(flags, ["symptom", "cause", "fix", "verify", "confidence", "ttlDays"], ["file", "tag", "key"]);
          if (input.file) input.files = input.file;
          if (input.tag) input.tags = input.tag;
          if (input.key) input.keys = input.key;
          delete input.file;
          delete input.tag;
          delete input.key;
        }
        if (!input.symptom) throw new Error("memtory observe: --symptom is required");
        const result = observe(cwd, input, { force: Boolean(flags.force), flush: flags.push !== false });
        if (flags.json) console.log(JSON.stringify(result, null, 2));
        else console.log(formatObserved(result));
        return 0;
      }
      case "review": {
        const { dir } = openStore(cwd);
        const entries = readAll(dir)
          .filter((e) => e.needsReview)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
          .slice(0, Number(flags.limit || 20));
        if (flags.json) {
          console.log(JSON.stringify(entries, null, 2));
          return 0;
        }
        if (entries.length === 0) {
          console.log("memtory: review queue is empty");
          return 0;
        }
        console.log(`memtory: ${entries.length} note(s) need a look — \`memtory confirm <id>\` or \`memtory refute <id> "<why>"\`\n`);
        console.log(entries.map((e, i) => formatEntry(e, i + 1)).join("\n\n"));
        return 0;
      }
      case "list": {
        const { dir } = openStore(cwd);
        const entries = readAll(dir).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        if (flags.json) console.log(JSON.stringify(entries, null, 2));
        else if (entries.length === 0) console.log("memtory: no notes yet");
        else console.log(entries.map((e, i) => formatEntry(e, i + 1)).join("\n\n"));
        return 0;
      }
      case "stats": {
        const { dir, repo } = openStore(cwd);
        const entries = readAll(dir);
        const usage = readUsage();
        if (flags.json) {
          console.log(
            JSON.stringify(
              { dir, remote: repo.remote, notes: entries, usage, needsReview: entries.filter((e) => e.needsReview).length },
              null,
              2,
            ),
          );
          return 0;
        }
        console.log(formatStats(entries));
        console.log("");
        console.log(formatUsage(usage));
        const sync = syncStatus(dir);
        console.log("");
        if (sync.localOnly) {
          console.log("sync: NOT PUBLISHED — no git remote for this folder");
          console.log("      add an origin remote, or set MEMTORY_REMOTE=<git url>, then `memtory sync`");
        } else {
          console.log(`sync: ${sync.remote} (branch memtory)`);
          console.log(
            `      ${sync.unpushed === null ? "branch not on origin yet" : `${sync.unpushed} unpushed commit(s)`}${
              sync.lastPushError ? ` · last push failed: ${sync.lastPushError}` : ""
            }`,
          );
        }
        console.log(`\nstore: ${dir}`);
        return 0;
      }
      case "confirm": {
        const result = confirm(cwd, rest[0], rest.slice(1).join(" "));
        console.log(`memtory: confirmed [${result.entry.id}]`);
        return 0;
      }
      case "refute": {
        const result = refute(cwd, rest[0], rest.slice(1).join(" "));
        console.log(`memtory: refuted [${result.entry.id}] — it will rank lower for everyone`);
        return 0;
      }
      case "sync": {
        const result = syncFromRemote(cwd);
        const { dir } = openStore(cwd);
        const pushed = flags.push !== false ? flush(dir, "memtory: sync") : { pushed: false };
        const sync = syncStatus(dir);
        const tail = pushed.pushed
          ? ", pushed"
          : sync.localOnly
            ? " · local only (no git remote)"
            : pushed.error
              ? ` · push failed: ${pushed.error}`
              : "";
        console.log(
          `memtory: ${result.updated ? result.reason : result.reason || "up-to-date"}${tail} · ${readAll(dir).length} notes`,
        );
        return 0;
      }
      case "flush": {
        const { dir } = openStore(cwd);
        const result = flush(dir, "memtory: flush");
        console.log(`memtory: ${result.committed ? `committed${result.pushed ? " and pushed" : ""}` : "nothing to flush"}`);
        return 0;
      }
      case "init": {
        const { dir, repo } = openStore(cwd);
        const pushed = repo.remote ? push(dir) : { pushed: false };
        console.log(
          `memtory: store at ${dir}${
            repo.remote ? ` ← ${repo.remote} (branch memtory${pushed.pushed ? ", published" : ""})` : " (no origin remote: local only)"
          }`,
        );
        return 0;
      }
      case "path": {
        const { dir } = openStore(cwd);
        console.log(dir);
        return 0;
      }
      case "mcp": {
        const { serve } = await import("./mcp.mjs");
        await serve({ cwd: flags.cwd || process.env.MEMTORY_PROJECT || cwd });
        return 0;
      }
      case "hook": {
        const { runHook } = await import("./hooks.mjs");
        await runHook(rest[0] || "claude-code", rest[1] || "", {});
        return 0;
      }
      case "install": {
        const { install } = await import("./install.mjs");
        const result = install({
          cwd,
          global: Boolean(flags.global),
          dryRun: Boolean(flags.dryRun),
          targets: flags.targets,
        });
        for (const line of result.lines) console.log(`  ${line}`);
        if (!flags.dryRun) console.log("\nmemtory: restart your agent sessions to pick this up");
        return 0;
      }
      case "help":
      case "--help":
        console.log(HELP);
        return 0;
      default:
        console.error(`memtory: unknown command "${command}"\n`);
        console.log(HELP);
        return 1;
    }
  } catch (error) {
    console.error(`memtory: ${error.message}`);
    if (flags.verbose) console.error(error.stack);
    return 1;
  }
}
