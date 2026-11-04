import { fingerprint } from "./entry.mjs";
import { flush, maybePull, openStore, pull } from "./gitmem.mjs";
import { author } from "./paths.mjs";
import { rank } from "./rank.mjs";
import { findDuplicate, readAll, updateEntry, writeEntry } from "./store.mjs";

export function currentEnv(repoRoot, text) {
  const { env, deps } = fingerprint(repoRoot, text);
  return { ...env, deps };
}

export function recall(cwd, query, options = {}) {
  const { dir, repo } = openStore(cwd);
  let entries = readAll(dir);
  const current = currentEnv(repo.root, query);

  let pulled = maybePull(dir, { force: entries.length === 0 });
  if (pulled.updated) entries = readAll(dir);

  let hits = rank(entries, query, { ...options, current });

  // A miss is exactly when another user's note would help, so pay for one
  // extra fetch before reporting "nothing known".
  if (hits.length === 0 && pulled.reason !== "pull-disabled" && pulled.reason !== "no-remote") {
    const retried = maybePull(dir, { force: true });
    if (retried.updated) {
      entries = readAll(dir);
      hits = rank(entries, query, { ...options, current });
    }
  }

  return { dir, repo, total: entries.length, hits, query };
}

export function observe(cwd, input, options = {}) {
  const { dir, repo } = openStore(cwd);
  const candidate = { ...input, files: input.files ?? [] };

  const duplicate = findDuplicate(dir, candidate);
  if (duplicate && !options.force) {
    const bumped = updateEntry(dir, duplicate.entry.id, (entry) => ({
      ...entry,
      hits: (entry.hits || 0) + 1,
      confirmedAt: new Date().toISOString(),
    }));
    const flushed = options.flush === false ? { committed: false } : flush(dir, `memtory: reconfirm ${duplicate.entry.id}`);
    return { dir, repo, entry: bumped, deduped: true, similarity: Math.round(duplicate.score * 100) / 100, flushed };
  }

  const text = [candidate.symptom, candidate.fix, candidate.cause, (candidate.files || []).join(" ")].join("\n");
  const fp = fingerprint(repo.root, text);
  const { entry, file } = writeEntry(dir, {
    ...candidate,
    env: candidate.env ?? fp.env,
    deps: candidate.deps ?? fp.deps,
    author: candidate.author ?? author(),
    source: { ...(candidate.source || {}), head: repo.head ?? null },
  });
  const flushed = options.flush === false ? { committed: false } : flush(dir, `memtory: observe ${entry.id}`);
  return { dir, repo, entry, file, deduped: false, flushed };
}

export function refute(cwd, idPrefix, note = "") {
  const { dir } = openStore(cwd);
  const entry = updateEntry(dir, idPrefix, (e) => ({
    ...e,
    refutations: [...(e.refutations || []), { at: new Date().toISOString(), note }],
    confidence: "low",
    needsReview: true,
  }));
  if (!entry) throw new Error(`memtory: no entry matching "${idPrefix}"`);
  const flushed = flush(dir, `memtory: refute ${entry.id}`);
  return { entry, flushed };
}

export function confirm(cwd, idPrefix, note = "") {
  const { dir } = openStore(cwd);
  const entry = updateEntry(dir, idPrefix, (e) => ({
    ...e,
    confirmedAt: new Date().toISOString(),
    confidence: "high",
    needsReview: false,
    note: note || e.note,
  }));
  if (!entry) throw new Error(`memtory: no entry matching "${idPrefix}"`);
  const flushed = flush(dir, `memtory: confirm ${entry.id}`);
  return { entry, flushed };
}

export function syncFromRemote(cwd) {
  const { dir, repo } = openStore(cwd);
  const pulled = pull(dir);
  return { dir, repo, ...pulled };
}
