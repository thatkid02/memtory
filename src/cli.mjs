import fs from "node:fs";
import { openStore, flush, push } from "./gitmem.mjs";
import { readAll } from "./store.mjs";
import { confirm, observe, recall, refute, syncFromRemote } from "./ops.mjs";
import { formatHits, formatObserved, formatStats } from "./format.mjs";
import { formatEntry } from "./format.mjs";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--stdin") flags.stdin = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--no-push") flags.push = false;
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
  memtory list [--json]            dump every note
  memtory stats                    counts, review queue, refutations
  memtory confirm <id>             mark a note as still correct
  memtory refute <id> [note]       mark a note as wrong/stale
  memtory sync                     fetch notes written by others
  memtory init                     create/attach the store
  memtory path                     print the local store path

observe flags:
  --symptom "<what failed>"  --cause "<why>"  --fix "<what worked>"
  --verify "<command>"       --file <path,...>  --tag <t,...>
  --confidence high|medium|low

env: MEMTORY_HOME (default ~/.memtory)
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
        const result = recall(cwd, query, { limit: Number(flags.limit || 3) });
        if (flags.json) console.log(JSON.stringify({ query, total: result.total, hits: result.hits }, null, 2));
        else console.log(formatHits(result));
        return 0;
      }
      case "observe": {
        let input;
        if (flags.stdin || flags.json && !flags.symptom) {
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
        if (flags.json) console.log(JSON.stringify({ dir, remote: repo.remote, count: entries.length }, null, 2));
        else console.log(formatStats(entries));
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
        console.log(
          `memtory: ${result.dir} (${result.updated ? result.reason : result.reason || "up-to-date"})${
            pushed.pushed ? ", pushed" : ""
          }`,
        );
        return 0;
      }
      case "init": {
        const { dir, repo } = openStore(cwd);
        const pushed = repo.remote ? push(dir) : { pushed: false };
        console.log(
          `memtory: store at ${dir}${repo.remote ? ` ← ${repo.remote} (branch memtory${pushed.pushed ? ", published" : ""})` : " (no origin remote: local only)"}`,
        );
        return 0;
      }
      case "path": {
        const { dir } = openStore(cwd);
        console.log(dir);
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
