import fs from "node:fs";
import { isGenericSymptom } from "./capture.mjs";
import { assessSelf } from "./self.mjs";
import { fingerprint, kindOf } from "./entry.mjs";
import { commitAll, flush, maybePull, openStore, pull, syncStatus } from "./gitmem.mjs";
import { author } from "./paths.mjs";
import { mergeNote, shouldStorePattern } from "./rate.mjs";
import { fuzzyRank, rank } from "./rank.mjs";
import { findDuplicate, readAll, updateEntry, writeEntry } from "./store.mjs";
import { recordObserve, recordRate, recordRecall, recordRefute } from "./usage.mjs";

export function currentEnv(repoRoot, text) {
  const { env, deps } = fingerprint(repoRoot, text);
  return { ...env, deps };
}

export function recall(cwd, query, options = {}) {
  const { source = "cli", record = true, kind = null, ...rankOptions } = options;
  const { dir, repo } = openStore(cwd);
  let entries = readAll(dir);
  const current = currentEnv(repo.root, query);

  let pulled = maybePull(dir, { force: entries.length === 0 });
  if (pulled.updated) entries = readAll(dir);

  const search = () => {
    // Resolved notes stay in the branch for regression hunting but must not be
    // served as advice: they describe something that no longer happens.
    const live = entries.filter((entry) => !entry.resolvedAt && (!kind || kindOf(entry) === kind));
    const exact = rank(live, query, { ...rankOptions, current });
    if (exact.length > 0) return { hits: exact, fuzzy: false };
    return { hits: fuzzyRank(live, query, { ...rankOptions, current }), fuzzy: true };
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

  const { entry, file } = storeNote(dir, repo, candidate);
  const flushed = options.flush === false ? { committed: false } : flush(dir, `memtory: observe ${entry.id}`);
  recordObserve();
  return { dir, repo, entry, file, deduped: false, flushed, sync: syncStatus(dir) };
}

/** One write path for both kinds, so env/deps/author provenance can never drift. */
function storeNote(dir, repo, candidate) {
  const text = [candidate.symptom, candidate.fix, candidate.cause, (candidate.files || []).join(" ")].join("\n");
  const fp = fingerprint(repo.root, text);
  return writeEntry(dir, {
    ...candidate,
    env: candidate.env ?? fp.env,
    deps: candidate.deps ?? fp.deps,
    author: candidate.author ?? author(),
    source: { ...(candidate.source || {}), head: repo.head ?? null },
  });
}

const RATINGS = ["good", "bad"];

/**
 * Rate a session (or a note that recall served). A good rating stores the pattern
 * that worked; a bad rating stores nothing and says why, because a session that
 * went badly already has a home in `observe` (the trap).
 */
export function rate(cwd, input = {}, options = {}) {
  const { dir, repo } = openStore(cwd);
  const value = String(input.rating ?? input.value ?? "good").trim().toLowerCase();
  if (!RATINGS.includes(value)) throw new Error(`memtory: rating must be "good" or "bad" (got "${input.rating}")`);
  const note = String(input.note ?? input.reason ?? "").trim();
  const at = new Date().toISOString();

  // Rating a note recall already served is a review action, not a new note.
  if (input.id) {
    const target = value === "good" ? confirm(cwd, input.id, note) : refute(cwd, input.id, note);
    recordRate({ value, stored: false });
    return { dir, repo, rating: value, entry: target.entry, stored: false, reviewed: target.entry.id, flushed: target.flushed };
  }

  const task = String(input.task ?? input.symptom ?? "").trim();
  if (!task) throw new Error("rate: --task is required (what you were asked to do, and it worked)");
  const approach = mergeNote(input.approach ?? input.fix, note);

  if (value === "bad") {
    recordRate({ value, stored: false });
    return {
      dir,
      repo,
      rating: value,
      stored: false,
      reason: "a session that went badly has no pattern to reuse; record the trap with observe",
    };
  }

  const gate = shouldStorePattern({ task, approach });
  if (!gate.ok) {
    recordRate({ value, stored: false });
    return { dir, repo, rating: value, stored: false, reason: gate.reason };
  }

  const candidate = {
    kind: "pattern",
    task,
    symptom: task,
    approach,
    fix: approach,
    verify: String(input.verify ?? "").trim(),
    files: input.files ?? [],
    keys: input.keys ?? [],
    tags: ["rated", ...(input.tags ?? [])],
  };

  const duplicate = findDuplicate(dir, candidate, 0.72, { kind: "same" });
  if (duplicate && !options.force) {
    const bumped = updateEntry(dir, duplicate.entry.id, (entry) => ({
      ...entry,
      hits: (entry.hits || 0) + 1,
      confirmedAt: at,
    }));
    const flushed = options.flush === false ? { committed: false } : flush(dir, `memtory: rate ${duplicate.entry.id}`);
    recordRate({ value, stored: false });
    return {
      dir,
      repo,
      rating: value,
      entry: bumped,
      stored: false,
      deduped: true,
      similarity: Math.round(duplicate.score * 100) / 100,
      flushed,
    };
  }

  const { entry, file } = storeNote(dir, repo, {
    ...candidate,
    // A human said it went well, so the note is already reviewed — but only a
    // proof earns `high`. "It worked on my machine" and "the suite passes" differ.
    confidence: String(input.confidence || (candidate.verify ? "high" : "medium")),
    needsReview: false,
    rating: { value, note, at, source: input.source?.harness ?? "cli" },
    source: { ...(input.source || {}), harness: input.source?.harness ?? "rate", session: input.session ?? null },
  });
  const flushed = options.flush === false ? { committed: false } : flush(dir, `memtory: rate ${entry.id}`);
  recordRate({ value, stored: true });
  return { dir, repo, rating: value, entry, file, stored: true, flushed, sync: syncStatus(dir) };
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

/** Fixed and no longer a live trap: kept for history, never served by recall. */
export function resolve(cwd, idPrefix, note = "") {
  const { dir } = openStore(cwd);
  const entry = updateEntry(dir, idPrefix, (e) => ({
    ...e,
    resolvedAt: new Date().toISOString(),
    resolution: note || e.resolution || "",
    needsReview: false,
    confidence: "high",
  }));
  if (!entry) throw new Error(`memtory: no entry matching "${idPrefix}"`);
  const flushed = flush(dir, `memtory: resolve ${entry.id}`);
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
  if (options.resolvedOnly) {
    const resolved = readAll(dir).filter((entry) => Boolean(entry.resolvedAt));
    if (!options.apply || resolved.length === 0) {
      return { dir, entries: resolved, applied: false, flushed: { committed: false } };
    }
    for (const entry of resolved) {
      try {
        fs.rmSync(entry._file, { force: true });
      } catch {}
    }
    const flushed = flush(dir, `memtory: prune ${resolved.length} resolved note(s)`);
    return { dir, entries: resolved, applied: true, flushed };
  }
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

export function selfCheck(cwd, options = {}) {
  const { dir } = openStore(cwd);
  const entries = readAll(dir);
  return { dir, ...assessSelf(entries, options) };
}

export function syncFromRemote(cwd) {
  const { dir, repo } = openStore(cwd);
  // Commit local work first so a merge cannot refuse on uncommitted changes.
  commitAll(dir, "memtory: sync");
  const pulled = pull(dir);
  return { dir, repo, ...pulled };
}
