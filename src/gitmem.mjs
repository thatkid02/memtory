import fs from "node:fs";
import path from "node:path";
import { BRANCH, author, git, home, repoInfo, slug, storeDir, tryGit } from "./paths.mjs";

/**
 * The memory store is its own git repo in the cache dir, tracking ONLY the
 * memtory branch of the project's origin. It is never checked out inside the
 * project working tree, so it cannot pollute status, diffs, or builds.
 */

export function openStore(cwd = process.cwd()) {
  const repo = repoInfo(cwd);
  const dir = storeDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  initRepo(dir, repo);
  return { dir, repo };
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
    if (repo.remote && !tryGit(dir, ["remote", "get-url", "origin"])) {
      tryGit(dir, ["remote", "add", "origin", repo.remote]);
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
  const fetched = tryGit(dir, ["fetch", "--prune", "origin", BRANCH]);
  if (fetched === null) return { updated: false, reason: "no-branch" };
  const local = tryGit(dir, ["rev-parse", "HEAD"]);
  const remote = tryGit(dir, ["rev-parse", `origin/${BRANCH}`]);
  if (!remote || local === remote) return { updated: false, reason: "up-to-date" };

  // Unrelated histories happen when two machines each bootstrapped the store
  // before either pushed. Adopt the published one unless we hold notes of our own.
  if (tryGit(dir, ["merge-base", local, remote]) === null) {
    if (!fs.existsSync(path.join(dir, "entries"))) {
      git(dir, ["checkout", "-B", BRANCH, `origin/${BRANCH}`]);
      return { updated: true, reason: "adopted-remote" };
    }
    const merged = tryGit(dir, ["merge", "--allow-unrelated-histories", "--no-edit", "-m", "memtory: join histories", `origin/${BRANCH}`]);
    return { updated: merged !== null, reason: merged !== null ? "joined-histories" : "join-failed" };
  }

  if (tryGit(dir, ["rev-parse", "--is-ancestor", local, remote]) !== null) {
    tryGit(dir, ["merge", "--ff-only", `origin/${BRANCH}`]);
    return { updated: true, reason: "fast-forward" };
  }
  tryGit(dir, ["rebase", `origin/${BRANCH}`]);
  return { updated: true, reason: "rebase" };
}

export function commitAll(dir, message) {
  const status = tryGit(dir, ["status", "--porcelain"]);
  if (!status) return { committed: false };
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return { committed: true, head: tryGit(dir, ["rev-parse", "--short", "HEAD"]) };
}

export function push(dir, { retries = 2 } = {}) {
  if (!hasRemote(dir)) return { pushed: false, reason: "no-remote" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const out = tryGit(dir, ["push", "--quiet", "origin", `HEAD:${BRANCH}`]);
    if (out !== null) return { pushed: true };
    if (attempt === retries) return { pushed: false, reason: "push-failed" };
    pull(dir);
  }
  return { pushed: false, reason: "push-failed" };
}

/** durable write = commit + best-effort push (never throws on network failure) */
export function flush(dir, message) {
  const c = commitAll(dir, message);
  if (!c.committed) return { committed: false, pushed: false };
  const p = push(dir);
  return { committed: true, ...p, head: c.head };
}

export function sync(cwd = process.cwd()) {
  const { dir, repo } = openStore(cwd);
  const pulled = maybePull(dir, { force: true });
  return { dir, repo, ...pulled };
}
