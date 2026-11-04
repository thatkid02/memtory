import fs from "node:fs";
import path from "node:path";
import { BRANCH, author, git, gitDir, home, pointerPathFor, repoInfo, storeDir, tryGit } from "./paths.mjs";

/**
 * The memory store is its own git repo in the cache dir, tracking ONLY the
 * memtory branch of the project's origin. It is never checked out inside the
 * project working tree, so it cannot pollute status, diffs, or builds.
 */

/**
 * The pointer file lives inside the project's git dir, so it is per-clone and
 * never committed. Without it, adding a remote (or switching ssh <-> https)
 * changes the store slug and silently forks your local notes.
 */
function pointerFile(repo) {
  const gdir = repo.toplevel ? gitDir(repo.toplevel) : null;
  if (gdir) return path.join(gdir, "memtory-store");
  return repo.root ? pointerPathFor(repo.root) : null;
}

function readPointer(repo) {
  const file = pointerFile(repo);
  if (!file) return null;
  try {
    const dir = fs.readFileSync(file, "utf8").trim();
    return dir && fs.existsSync(path.join(dir, ".git")) ? dir : null;
  } catch {
    return null;
  }
}

function writePointer(repo, dir) {
  const file = pointerFile(repo);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${dir}\n`);
  } catch {}
}

/**
 * A folder does not need to be a git repo to share notes. Resolution order:
 * the project's own origin, then MEMTORY_REMOTE / ~/.memtory/config.json,
 * then a machine-local bare repo that every such folder shares.
 */
export function globalRepoPath() {
  return path.join(home(), "global.git");
}

let globalReady = null;
export function ensureGlobalRepo() {
  if (globalReady) return globalReady;
  const target = globalRepoPath();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      git(path.dirname(target), ["init", "--bare", "-b", BRANCH, target]);
    } catch (error) {
      return null;
    }
  }
  globalReady = target;
  return target;
}

export function resolveRemote(repo) {
  return repo.remote || repo.fallbackRemote || ensureGlobalRepo();
}

export function remoteSource(repo) {
  if (repo.remote) return "project origin";
  if (repo.fallbackRemote) return "MEMTORY_REMOTE / config.json";
  return `local shared store (${globalRepoPath()})`;
}

export function openStore(cwd = process.cwd()) {
  const repo = repoInfo(cwd);
  const effective = { ...repo, remote: resolveRemote(repo) };
  const existing = readPointer(repo);
  if (existing) {
    initRepo(existing, effective);
    return { dir: existing, repo: effective };
  }
  const dir = storeDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  initRepo(dir, effective);
  writePointer(repo, dir);
  return { dir, repo: effective };
}

function initRepo(dir, repo) {
  const gitDir = path.join(dir, ".git");
  if (!fs.existsSync(gitDir)) {
    git(dir, ["init", "-b", BRANCH]);
    tryGit(dir, ["config", "core.autocrlf", "false"]);
    tryGit(dir, ["config", "commit.gpgsign", "false"]);
    tryGit(dir, ["config", "tag.gpgsign", "false"]);
    tryGit(dir, ["config", "rebase.autoStash", "true"]);
    const a = author();
    tryGit(dir, ["config", "user.name", "memtory"]);
    tryGit(dir, ["config", "user.email", a.email]);
    if (repo.remote) tryGit(dir, ["remote", "add", "origin", repo.remote]);

    // Join an already-published store instead of forking a parallel history.
    const joined = Boolean(repo.remote) && tryGit(dir, ["fetch", "--quiet", "origin", BRANCH]) !== null;
    if (joined) tryGit(dir, ["checkout", "-B", BRANCH, `origin/${BRANCH}`]);

    writeIfMissing(path.join(dir, ".gitattributes"), "*.json text eol=lf\n");
    writeIfMissing(
      path.join(dir, "README.md"),
      "# memtory\n\nHard-won knowledge for this repository, one JSON file per observation.\n" +
        "Written by agents via the memtory tool. Read by agents before they re-learn it.\n",
    );
    tryGit(dir, ["add", "-A"]);
    if (tryGit(dir, ["status", "--porcelain"])) {
      tryGit(dir, ["-c", "commit.gpgsign=false", "commit", "-m", joined ? "memtory: attach store" : "memtory: init store"]);
    }
  } else {
    const a = author();
    if (!tryGit(dir, ["config", "user.email"])) {
      tryGit(dir, ["config", "user.email", a.email]);
    }
    const configured = tryGit(dir, ["remote", "get-url", "origin"]);
    if (repo.remote && !configured) {
      tryGit(dir, ["remote", "add", "origin", repo.remote]);
    } else if (repo.remote && configured && configured !== repo.remote) {
      tryGit(dir, ["remote", "set-url", "origin", repo.remote]);
      // Tracking refs from the old remote would make flush() think the branch
      // is already published there. Drop them so the next push is real.
      const stale = tryGit(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]) || "";
      for (const ref of stale.split("\n").map((line) => line.trim()).filter(Boolean)) {
        tryGit(dir, ["update-ref", "-d", ref]);
      }
    }
  }
  return dir;
}

function writeIfMissing(file, body) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, body);
}

export function hasRemote(dir) {
  return Boolean(tryGit(dir, ["remote", "get-url", "origin"]));
}

function stateFile(dir) {
  return path.join(home(), "state", `${path.basename(dir)}.json`);
}

export function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(dir, patch) {
  const file = stateFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readState(dir), ...patch }, null, 2));
}

/** Pull only when the cache is stale or empty; keeps in-turn recall fast. */
export function maybePull(dir, { force = false, ttlMs = Number(process.env.MEMTORY_PULL_TTL ?? 120000) } = {}) {
  if (process.env.MEMTORY_NO_PULL === "1") return { updated: false, reason: "pull-disabled" };
  if (!force && Date.now() - (readState(dir).lastPullAt ?? 0) < ttlMs) {
    return { updated: false, reason: "fresh" };
  }
  const result = pull(dir);
  writeState(dir, { lastPullAt: Date.now() });
  return result;
}

/** Fast-forward is impossible here (we always have local commits), so rebase. */
export function pull(dir) {
  if (!hasRemote(dir)) return { updated: false, reason: "no-remote" };
  try {
    // Explicit refspec: a bare `fetch origin memtory` may leave
    // refs/remotes/origin/memtory stale, which makes push look safe when it is not.
    git(dir, ["fetch", "--prune", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
  } catch (error) {
    const line = errorLine(error);
    if (!/couldn't find remote ref|no such remote|not found/i.test(line)) {
      writeState(dir, { lastFetchError: line, lastFetchAt: Date.now() });
    }
    return { updated: false, reason: "no-branch" };
  }
  const local = tryGit(dir, ["rev-parse", "HEAD"]);
  const remote = tryGit(dir, ["rev-parse", `origin/${BRANCH}`]);
  if (!remote) return { updated: false, reason: "no-branch" };
  if (local === remote) return { updated: false, reason: "up-to-date" };
  // Remote already contained in local: nothing to take, push will happen later.
  if (tryGit(dir, ["merge-base", "--is-ancestor", remote, local]) !== null) {
    return { updated: false, reason: "local-ahead" };
  }
  // Merge, never rebase. Entries are unique files, so a merge is always additive;
  // rebasing diverged stores is what left them rejected and unpushed.
  const merged = tryGit(dir, [
    "merge",
    "--no-edit",
    "--allow-unrelated-histories",
    "-m",
    "memtory: join histories",
    `origin/${BRANCH}`,
  ]);
  if (merged === null) {
    const reason = errorLine(tryGit(dir, ["status"]) || "merge failed");
    tryGit(dir, ["merge", "--abort"]);
    writeState(dir, { lastMergeError: reason, lastMergeAt: Date.now() });
    return { updated: false, reason: "merge-conflict" };
  }
  return { updated: true, reason: /Already up to date/i.test(merged) ? "up-to-date" : "merged" };
}

export function commitAll(dir, message) {
  const status = tryGit(dir, ["status", "--porcelain"]);
  if (!status) return { committed: false };
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return { committed: true, head: tryGit(dir, ["rev-parse", "--short", "HEAD"]) };
}

function errorLine(error) {
  const raw = String(error?.stderr || error?.message || error || "").trim();
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.filter((line) => /fatal|error|denied|rejected|not found/i.test(line)).pop() || lines.pop() || "unknown").slice(0, 300);
}

/** Manual opt-out: background pushes off, commits still happen. */
export function pushDisabledReason(dir) {
  if (process.env.MEMTORY_NO_PUSH === "1") return "MEMTORY_NO_PUSH=1";
  if (tryGit(dir, ["config", "memtory.autopush"]) === "false") return "memtory.autopush=false";
  return null;
}

export function push(dir, { retries = 2, force = false } = {}) {
  const disabled = force ? null : pushDisabledReason(dir);
  if (disabled) return { pushed: false, reason: "push-disabled", disabled };
  if (!hasRemote(dir)) {
    writeState(dir, { localOnly: true, lastPushError: null });
    return { pushed: false, reason: "no-remote" };
  }
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      git(dir, ["push", "--quiet", "origin", `HEAD:${BRANCH}`]);
      writeState(dir, { lastPushError: null, lastPushAt: Date.now(), localOnly: false });
      return { pushed: true };
    } catch (error) {
      lastError = errorLine(error);
      if (attempt === retries) break;
      pull(dir);
    }
  }
  writeState(dir, { lastPushError: lastError, lastPushAt: Date.now(), localOnly: false });
  return { pushed: false, reason: "push-failed", error: lastError };
}

/** durable write = commit + best-effort push (never throws on network failure) */
export function flush(dir, message, { forcePush = false } = {}) {
  const c = commitAll(dir, message);
  if (c.committed) {
    const p = push(dir, { force: forcePush });
    return { committed: true, ...p, head: c.head };
  }
  // Nothing to commit, but the branch may still be missing or ahead on origin
  // (first sync, or notes committed before a remote existed).
  if (!hasRemote(dir)) return { committed: false, pushed: false };
  const local = tryGit(dir, ["rev-parse", "HEAD"]);
  const remote = tryGit(dir, ["rev-parse", "--verify", `refs/remotes/origin/${BRANCH}`]);
  if (remote && remote === local) {
    if (readState(dir).lastPushError) writeState(dir, { lastPushError: null });
    return { committed: false, pushed: false };
  }
  const p = push(dir, { force: forcePush });
  return { committed: false, ...p };
}

/** What a human needs to know when a note did not leave the machine. */
export function syncStatus(dir) {
  const remote = tryGit(dir, ["remote", "get-url", "origin"]);
  const state = readState(dir);
  const unpushed = remote ? tryGit(dir, ["rev-list", "--count", `origin/${BRANCH}..HEAD`]) : null;
  return {
    remote: remote || null,
    localOnly: !remote,
    unpushed: unpushed === null ? null : Number(unpushed),
    onOrigin: remote ? tryGit(dir, ["rev-parse", "--verify", `refs/remotes/origin/${BRANCH}`]) !== null : false,
    // A stale failure from an earlier attempt is noise once nothing is pending.
    lastPushError: unpushed === "0" || unpushed === 0 ? null : state.lastPushError || null,
    lastFetchError: state.lastFetchError || null,
    pushDisabled: pushDisabledReason(dir),
  };
}

export function sync(cwd = process.cwd()) {
  const { dir, repo } = openStore(cwd);
  const pulled = maybePull(dir, { force: true });
  return { dir, repo, ...pulled };
}
