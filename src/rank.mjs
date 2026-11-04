import { ageDays, entryText, isExpired } from "./entry.mjs";

const K1 = 1.4;
const B = 0.72;

const STOP = new Set(
  ("a an the and or but if then than so as of to in on at by for with from into over under again further once here there " +
    "all any both each few more most other some such no nor not only own same too very can will just should now " +
    "i me my we our you your he she it its they them their this that these those what which who whom when where why how " +
    "is are was were be been being do does did doing done have has had having would could may might must shall " +
    "about after before during while between through because get gets got make makes made use uses used using via per").split(
    " ",
  ),
);

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_@./:-]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function termFreq(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  return tf;
}

function envBoost(entry, current = {}) {
  let boost = 0;
  const env = entry.env || {};
  const deps = entry.deps || {};
  if (current.os && env.os) boost += current.os === env.os ? 0.06 : -0.04;
  for (const [name, version] of Object.entries(deps)) {
    const have = current.deps?.[name];
    if (!have) continue;
    const sameMajor = String(have).split(".")[0] === String(version).split(".")[0];
    boost += sameMajor ? 0.22 : -0.5; // wrong major = misleading, not just stale
  }
  return boost;
}

function qualityBoost(entry, now) {
  let boost = 0;
  const age = ageDays(entry, now);
  boost += Math.max(0, 0.3 - age / 900); // gentle preference for fresh, never decisive
  if (entry.confidence === "high") boost += 0.18;
  if (entry.confidence === "medium") boost += 0.08;
  boost += Math.min(0.2, (entry.hits || 0) * 0.02);
  boost -= Math.min(1, (entry.refutations || []).length) * 0.55;
  if (isExpired(entry, now)) boost -= 0.7;
  return boost;
}

export function rank(entries, query, options = {}) {
  const { limit = 3, now = Date.now(), current = {}, minScore = 0.05 } = options;
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || entries.length === 0) return [];

  const docs = entries.map((entry) => {
    const tokens = tokenize(entryText(entry));
    return { entry, tf: termFreq(tokens), len: tokens.length };
  });
  const avgLen = docs.reduce((sum, doc) => sum + doc.len, 0) / docs.length || 1;
  const total = docs.length;

  const idf = new Map();
  for (const term of queryTokens) {
    const df = docs.reduce((count, doc) => count + (doc.tf.has(term) ? 1 : 0), 0);
    idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }

  const scored = [];
  for (const doc of docs) {
    let bm25 = 0;
    let matched = 0;
    for (const term of queryTokens) {
      const freq = doc.tf.get(term);
      if (!freq) continue;
      matched++;
      const denom = freq + K1 * (1 - B + (B * doc.len) / avgLen);
      bm25 += (idf.get(term) || 0) * ((freq * (K1 + 1)) / denom);
    }
    if (matched === 0) continue;
    const coverage = matched / queryTokens.length;
    // Stopwords are gone by now, so a single shared word in a long query is weak
    // evidence. Require either decent coverage or a genuinely strong BM25 term.
    if (coverage < 0.25 && bm25 < 1.5) continue;
    const score =
      bm25 * (0.55 + 0.45 * coverage) + envBoost(doc.entry, current) + qualityBoost(doc.entry, now);
    if (score < minScore) continue;
    scored.push({ entry: doc.entry, score: Math.round(score * 100) / 100, coverage, matched });
  }

  scored.sort((a, b) => b.score - a.score || String(a.entry.id).localeCompare(String(b.entry.id)));
  return scored.slice(0, limit);
}
