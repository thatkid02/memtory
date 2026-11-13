import fs from "node:fs";
import path from "node:path";
import { makeEntry, normalizeKey } from "./entry.mjs";
import { deviceId } from "./paths.mjs";

const ENTRIES = "entries";

export function entriesRoot(dir) {
  return path.join(dir, ENTRIES);
}

function walk(dir, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out);
    else if (item.name.endsWith(".json")) out.push(full);
  }
  return out;
}

export function readAll(dir) {
  const out = [];
  for (const file of walk(entriesRoot(dir))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && parsed.id && parsed.symptom) out.push({ ...parsed, _file: file });
    } catch {}
  }
  return out;
}

export function entryPath(dir, entry, device = deviceId()) {
  const month = String(entry.createdAt || new Date().toISOString()).slice(0, 7);
  return path.join(entriesRoot(dir), device, month, `${entry.id}.json`);
}

export function writeEntry(dir, input, ctx = {}) {
  const entry = makeEntry(input, ctx);
  const file = entryPath(dir, entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  return { entry, file };
}

export function updateEntry(dir, idPrefix, mutate) {
  const matches = readAll(dir).filter((e) => e.id === idPrefix || e.id.startsWith(idPrefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`memtory: ambiguous id "${idPrefix}" (${matches.length} matches)`);
  const current = matches[0];
  const { _file, ...clean } = current;
  const next = mutate(clean) ?? clean;
  fs.writeFileSync(_file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Near-duplicate detection without embeddings: token Jaccard over the symptom
 * plus shared file/keys. Catches "same trap, different words".
 */
export function similarity(a, b) {
  const ta = new Set(normalizeKey(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeKey(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function findDuplicate(dir, candidate, threshold = 0.72, options = {}) {
  const { kind = "same" } = options;
  const codes = errorCodes(candidate.symptom);
  let best = null;
  for (const existing of readAll(dir)) {
    // A pattern and a trap can describe the same words with opposite meaning
    // ("postgres auth fails" vs "postgres auth, done right"), so they never
    // collapse into one another unless the caller asks for it.
    if (kind === "same" && (existing.kind ?? "observation") !== (candidate.kind ?? "observation")) continue;
    let score = similarity(candidate.symptom, existing.symptom);
    // A shared error code (ERR_PNPM_..., TS2345, EACCES) is a much stronger
    // signal than word overlap alone, so it relaxes the threshold.
    if (codes.size > 0) {
      const shared = errorCodes(existing.symptom);
      for (const code of codes) if (shared.has(code)) score += 0.25;
    }
    const files = new Set(existing.files || []);
    if ((candidate.files || []).some((f) => files.has(f))) score += 0.08;
    if (score >= threshold && (!best || score > best.score)) best = { entry: existing, score };
  }
  return best;
}

export function errorCodes(text) {
  return new Set(
    String(text || "").match(/\b(?:[A-Z]{2,}[A-Z0-9]*(?:_[A-Z0-9]+)+|E[A-Z]{3,}|TS\d{4,}|ERR_[A-Z0-9_]+)\b/g) || [],
  );
}
