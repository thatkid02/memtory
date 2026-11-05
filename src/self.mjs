/**
 * Self-assessment: which notes are about memtory itself?
 *
 * A note that says "push failed after adding a remote" or "the extension was
 * inert because of a symlink" is a bug report about this tool, not project
 * knowledge. Those are the ones worth turning into fixes.
 */

const STRONG = [
  [/(?:^|[\s(`'"[])(?:src\/[a-z0-9_-]+\.mjs|adapters\/pi\/[a-z0-9._-]+\.(?:mjs|ts))/i, "code-path"],
  [/\bMEMTORY_[A-Z0-9_]+\b/, "env-var"],
  [/\bmemtory\s+(?:recall|observe|sync|prune|autopush|install|stats|review|confirm|refute|mcp|hook|flush|init|self)\b/i, "cli"],
  [/\.memtory\/(?:config|global|device|pointers|state|repos)/i, "state-path"],
  [/\b(?:before_agent_start|tool_result|resources_discover|SessionStart|UserPromptSubmit|PostToolUse|SessionEnd|ExtensionAPI|jiti|typebox)\b/, "harness-api"],
  [/\bmemtory\s+(?:branch|store|adapter|extension|plugin|tool|hook)\b/i, "self-noun"],
  [/\b(?:detectHardWay|auto-observe|auto-recall|autopush|notify|push failed|unpushed|origin\/memtory)\b/i, "internals"],
];

const CATEGORIES = [
  ["sync", /\b(push|pushed|fetch|remote|origin|branch|unpushed|rebase|merge|non-fast-forward|credential|rejected|device not configured)\b/i],
  ["capture", /\b(auto-observe|capture|detectHardWay|symptom|noise|gate|minFails|duplicate|dedupe|prune)\b/i],
  ["recall", /\b(recall|rank|bm25|fuzzy|score|hit|miss|inject|recall)\b/i],
  ["adapter", /\b(adapter|extension|hook|SessionStart|PostToolUse|UserPromptSubmit|SessionEnd|resources_discover|before_agent_start|tool_result|\bpi\b|claude|codex|mcp)\b/i],
  ["store", /\b(entry|schema|json|store|pointer|device|ttl|confidence|needsReview|refut)\b/i],
  ["install", /\b(install|shim|symlink|settings\.json|AGENTS\.md|config\.toml)\b/i],
];

export function selfSignals(entry) {
  const text = [entry.symptom, entry.cause, entry.fix, entry.verify, (entry.files || []).join(" ")]
    .filter(Boolean)
    .join("\n");
  const matched = STRONG.filter(([re]) => re.test(text)).map(([, name]) => name);
  const category = CATEGORIES.map(([name, re]) => [name, (text.match(new RegExp(re.source, "gi")) || []).length])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "other";
  return { isSelf: matched.length > 0, signals: matched, category };
}

function stateOf(entry) {
  if ((entry.refutations || []).length > 0) return "refuted";
  if (entry.confirmedAt) return "confirmed";
  return "open";
}

const CATEGORY_WEIGHT = { sync: 6, capture: 5, recall: 4, adapter: 4, store: 3, install: 3, other: 2 };

function priority(entry, info, now) {
  const age = Math.max(0, (now - Date.parse(entry.createdAt || 0)) / 86400000);
  let score = CATEGORY_WEIGHT[info.category] ?? 2;
  score += Math.max(0, 4 - age / 3); // fresh reports first
  score += Math.min(3, info.signals.length);
  if (entry.verify) score += 1;
  if (stateOf(entry) === "refuted") score -= 4;
  if (entry.confidence === "high") score += 1;
  return Math.round(score * 10) / 10;
}

export function assessSelf(entries, options = {}) {
  const { now = Date.now(), includeSettled = false } = options;
  const items = [];
  for (const entry of entries) {
    const info = selfSignals(entry);
    if (!info.isSelf) continue;
    const state = stateOf(entry);
    if (!includeSettled && state === "confirmed") continue;
    items.push({
      id: entry.id,
      symptom: entry.symptom,
      cause: entry.cause || "",
      fix: entry.fix || "",
      verify: entry.verify || "",
      files: entry.files || [],
      category: info.category,
      signals: info.signals,
      state,
      confidence: entry.confidence,
      createdAt: entry.createdAt,
      ageDays: Math.round(Math.max(0, (now - Date.parse(entry.createdAt || 0)) / 86400000)),
      priority: priority(entry, info, now),
    });
  }
  items.sort((a, b) => b.priority - a.priority);

  const byCategory = {};
  for (const item of items) (byCategory[item.category] ||= []).push(item);
  return {
    total: entries.length,
    selfCount: items.length,
    byCategory,
    items,
    top: items[0] || null,
  };
}

export function formatSelfReport(report, options = {}) {
  const { limit = 12 } = options;
  const { total, selfCount, byCategory, items } = report;
  if (selfCount === 0) {
    return `memtory self-check: no notes look like memtory issues (${total} note${total === 1 ? "" : "s"} scanned).`;
  }
  const lines = [`memtory self-check: ${selfCount} of ${total} notes look like memtory issues`, ""];
  let shown = 0;
  for (const [category, list] of Object.entries(byCategory).sort((a, b) => (b[1][0]?.priority ?? 0) - (a[1][0]?.priority ?? 0))) {
    if (shown >= limit) break;
    lines.push(`${category.toUpperCase()} (${list.length})`);
    for (const item of list) {
      if (shown >= limit) break;
      shown++;
      const meta = [
        `${item.ageDays}d old`,
        item.state,
        item.confidence,
        item.priority ? `priority ${item.priority}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  ${shown}. [${item.id}] ${item.symptom.replace(/\s+/g, " ").slice(0, 160)}`);
      if (item.fix) lines.push(`     fix: ${item.fix.replace(/\s+/g, " ").slice(0, 160)}`);
      if (item.files.length) lines.push(`     files: ${item.files.slice(0, 3).join(", ")}`);
      lines.push(`     ${meta}${item.verify ? ` · verify: ${item.verify.slice(0, 90)}` : ""}`);
    }
    lines.push("");
  }
  if (selfCount > shown) lines.push(`… ${selfCount - shown} more (raise --limit)`);
  lines.push(
    "Work the top item, then close the loop: `memtory confirm <id>` (still true, fixed) or `memtory refute <id> \"<why>\"`.",
  );
  return lines.join("\n").trim();
}
