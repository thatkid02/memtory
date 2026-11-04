import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BRANCH = "memtory";

export function home() {
  return process.env.MEMTORY_HOME || path.join(os.homedir(), ".memtory");
}

export function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

export function tryGit(cwd, args, opts = {}) {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
}

export function isRepo(cwd = process.cwd()) {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]) !== null;
}

/**
 * Non-git folders (notes, scratch dirs) can still publish by setting
 * MEMTORY_REMOTE or {"remote": "..."} in ~/.memtory/config.json.
 */
export function configuredRemote() {
  if (process.env.MEMTORY_REMOTE) return process.env.MEMTORY_REMOTE;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home(), "config.json"), "utf8"));
    return config.remote || null;
  } catch {
    return null;
  }
}

export function repoInfo(cwd = process.cwd()) {
  const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) {
    return {
      toplevel: null,
      remote: configuredRemote(),
      head: null,
      root: path.resolve(cwd),
      isRepo: false,
    };
  }
  return {
    toplevel,
    remote: tryGit(toplevel, ["remote", "get-url", "origin"]) || configuredRemote(),
    head: tryGit(toplevel, ["rev-parse", "--short", "HEAD"]),
    branch: tryGit(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]),
    root: toplevel,
    isRepo: true,
  };
}

export function slug(repo) {
  // Must be the *target* directory, not process.cwd(): hooks and the MCP server
  // can be asked about a repo other than the one they were launched from.
  const basis = repo.remote || repo.toplevel || repo.root || process.cwd();
  const clean = basis
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-40);
  const hash = createHash("sha1").update(basis).digest("hex").slice(0, 8);
  return `${clean}__${hash}`;
}

/** git dir can be a file (worktrees/submodules); resolve it through git itself. */
export function gitDir(toplevel) {
  const raw = tryGit(toplevel, ["rev-parse", "--git-dir"]);
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(toplevel, raw);
}

/** Stable store identity for folders that are not git repos. */
export function pointerPathFor(dirPath) {
  const hash = createHash("sha1").update(path.resolve(dirPath)).digest("hex").slice(0, 16);
  return path.join(home(), "pointers", `${hash}.store`);
}

export function storeDir(repo) {
  return path.join(home(), "repos", slug(repo));
}

export function deviceId() {
  const file = path.join(home(), "device.json");
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed.id) return parsed.id;
    } catch {}
  }
  const host = os.hostname().replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 20);
  const id = `${host || "dev"}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2));
  return id;
}

export function author() {
  const user = os.userInfo().username || "unknown";
  return {
    name: process.env.GIT_AUTHOR_NAME || tryGit(process.cwd(), ["config", "user.name"]) || user,
    email: process.env.GIT_AUTHOR_EMAIL || tryGit(process.cwd(), ["config", "user.email"]) || `${user}@localhost`,
  };
}
