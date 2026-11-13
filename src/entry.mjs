import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;

/**
 * A note is either a trap (something failed) or a pattern (something worked).
 * Both are recalled the same way; only the wording and the confidence differ.
 */
export const KINDS = ["observation", "pattern"];

const KIND_ALIASES = {
  trap: "observation",
  failure: "observation",
  error: "observation",
  pattern: "pattern",
  success: "pattern",
  lesson: "pattern",
  win: "pattern",
};

export function normalizeKind(value = "observation") {
  const raw = String(value || "observation").trim().toLowerCase();
  const kind = KIND_ALIASES[raw] ?? raw;
  if (!KINDS.includes(kind)) throw new Error(`memtory: kind must be one of ${KINDS.join("|")} (got "${value}")`);
  return kind;
}

/** Entries written before kinds existed are traps. */
export function kindOf(entry) {
  return entry?.kind ?? "observation";
}

const MAX_FIELD = 4000;

function clip(value, max = MAX_FIELD) {
  if (value === undefined || value === null) return "";
  const s = String(value).replace(/\r\n/g, "\n").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function newId(now = Date.now()) {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[0-9a-f]{7,40}/g, "<sha>")
    .replace(/\d+(\.\d+)*/g, "<n>")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function makeEntry(input, ctx = {}) {
  const kind = normalizeKind(input.kind);
  // For a pattern the searchable headline is the task, not the failure; it lands
  // in `symptom` so recall, dedupe and rendering stay one code path.
  const symptom = clip(input.symptom ?? input.problem ?? input.error ?? input.task ?? input.goal);
  if (!symptom) {
    throw new Error(
      kind === "pattern"
        ? "memtory: a pattern needs a task (what you were asked to do, and it worked)"
        : "memtory: a symptom (what failed / what you didn't know) is required",
    );
  }
  const files = (input.files ?? []).flatMap((f) => String(f).split(",")).map((f) => f.trim()).filter(Boolean);
  const tags = (input.tags ?? []).flatMap((t) => String(t).split(",")).map((t) => t.trim()).filter(Boolean);
  const keys = (input.keys ?? []).flatMap((k) => String(k).split(",")).map((k) => k.trim()).filter(Boolean);
  const now = new Date().toISOString();
  return {
    v: SCHEMA_VERSION,
    id: input.id ?? newId(),
    kind,
    symptom,
    keys: unique([...keys, ...extractKeys(symptom, files)]),
    cause: clip(input.cause),
    fix: clip(input.fix ?? input.solution ?? input.approach),
    verify: clip(input.verify, 500),
    files: unique(files).slice(0, 20),
    tags: unique(tags).slice(0, 12),
    env: input.env ?? {},
    deps: input.deps ?? {},
    confidence: input.confidence ?? "low",
    needsReview: input.needsReview ?? (input.confidence ?? "low") === "low",
    rating: input.rating ?? null,
    source: input.source ?? {},
    author: input.author ?? {},
    createdAt: input.createdAt ?? now,
    confirmedAt: input.confirmedAt ?? null,
    refutations: input.refutations ?? [],
    hits: input.hits ?? 0,
    ttlDays: input.ttlDays ?? 365,
  };
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

const STOP = new Set(
  "the a an and or of to in on for with is are was were be been being it its this that these those as at by from not no you your we our".split(" "),
);

export function extractKeys(...texts) {
  const out = new Set();
  for (const text of texts) {
    for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9_@./:-]+/)) {
      if (raw.length < 3 || STOP.has(raw)) continue;
      out.add(raw);
      if (out.size >= 24) return [...out];
    }
  }
  return [...out];
}

/** Cheap env fingerprint for ranking: only deps actually mentioned in the entry. */
export function fingerprint(repoRoot, text) {
  const env = { os: process.platform, arch: process.arch, node: process.versions.node };
  const deps = {};
  const pkgFile = repoRoot ? path.join(repoRoot, "package.json") : null;
  if (pkgFile && fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const haystack = String(text || "").toLowerCase();
      for (const [name, version] of Object.entries(all)) {
        if (haystack.includes(name.toLowerCase())) deps[name] = String(version).replace(/^[^\d]*/, "");
      }
    } catch {}
  }
  return { env, deps };
}

export function entryText(e) {
  return [e.symptom, e.cause, e.fix, (e.keys || []).join(" "), (e.files || []).join(" "), (e.tags || []).join(" ")]
    .join("\n")
    .toLowerCase();
}

export function ageDays(e, now = Date.now()) {
  return Math.max(0, (now - Date.parse(e.createdAt || 0)) / 86400000);
}

export function isExpired(e, now = Date.now()) {
  return ageDays(e, now) > (e.ttlDays ?? 365);
}
