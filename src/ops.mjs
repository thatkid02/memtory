import fs from "node:fs";
import { isGenericSymptom } from "./capture.mjs";
import { fingerprint } from "./entry.mjs";
import { commitAll, flush, maybePull, openStore, pull, syncStatus } from "./gitmem.mjs";
import { author } from "./paths.mjs";
import { fuzzyRank, rank } from "./rank.mjs";
import { findDuplicate, readAll, updateEntry, writeEntry } from "./store.mjs";
import { recordObserve, recordRecall, recordRefute } from "./usage.mjs";

export function currentEnv(repoRoot, text) {
  const { env, deps } = fingerprint(repoRoot, text);
  return { ...env, deps };
}

export function recall(cwd, query, options = {}) {
  const { source = "cli", record = true, ...rankOptions } = options;
  const { dir, repo } = openStore(cwd);
  let entries = readAll(dir);
  const current = currentEnv(repo.root, query);

  let pulled = maybePull(dir, { force: entries.length === 0 });
  if (pulled.updated) entries = readAll(dir);

  const search = () => {
    const exact = rank(entries, query, { ...rankOptions, current });
    if (exact.length > 0) return { hits: exact, fuzzy: false };
    return { hits: fuzzyRank(entries, query, { ...rankOptions, current }), fuzzy: true };
  };

  let result = search();

  // A miss is exactly when another user's note would help, so pay for one
  // extra fetch before reporting "nothing known".
  if (result.hits.length === 0 && pulled.reason !== "pull-disabled" && pulled.reason !== "no-remote") {
    const retried = maybePull(dir, { force: true });
    if (retried.updated) {
      entries = readAll(dir);
      result = search();
    }
  }

  const tokens = result.hits.reduce((sum, h) => sum + Math.ceil((h.entry.symptom.length + (h.entry.fix || "").length) / 4), 0);
  if (record) recordRecall({ hits: result.hits.length, tokens, source });

  return {
    dir,
    repo,
    total: entries.length,
    hits: result.hits,
    fuzzy: result.fuzzy && result.hits.length > 0,
    query,
  };
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
  recordObserve();
  return { dir, repo, entry, file, deduped: false, flushed, sync: syncStatus(dir) };
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
  recordRefute();
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

/**
 * Auto-captured notes whose symptom nobody could ever search for are dead weight.
 * Lists by default; only deletes with { apply: true }.
 */
export function pruneNoise(cwd, options = {}) {
  const { dir } = openStore(cwd);
  const candidates = readAll(dir).filter(
    (entry) =>
      // only auto-captured notes: a human may have a reason for a vague symptom
      ((entry.tags || []).includes("auto") || entry.source?.harness === "auto") &&
      entry.confidence === "low" &&
      entry.needsReview !== false &&
      !(entry.refutations || []).length &&
      isGenericSymptom(entry.symptom),
  );
  if (!options.apply || candidates.length === 0) {
    return { dir, entries: candidates, applied: false, flushed: { committed: false } };
  }
  for (const entry of candidates) {
    try {
      fs.rmSync(entry._file, { force: true });
    } catch {}
  }
  const flushed = flush(dir, `memtory: prune ${candidates.length} unsearchable note(s)`);
  return { dir, entries: candidates, applied: true, flushed };
}

export function syncFromRemote(cwd) {
  const { dir, repo } = openStore(cwd);
  // Commit local work first so a merge cannot refuse on uncommitted changes.
  commitAll(dir, "memtory: sync");
  const pulled = pull(dir);
  return { dir, repo, ...pulled };
}
