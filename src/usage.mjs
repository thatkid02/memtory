import fs from "node:fs";
import path from "node:path";
import { home } from "./paths.mjs";

const EMPTY = {
  recalls: 0,
  hits: 0,
  misses: 0,
  injected: 0,
  tokensReturned: 0,
  observed: 0,
  rated: 0,
  ratedGood: 0,
  ratedBad: 0,
  patterns: 0,
  refuted: 0,
  bySource: {},
  firstAt: null,
  lastAt: null,
};

export const SAVED_TOKENS = Number(process.env.MEMTORY_SAVED_TOKENS ?? 6000);
export const SAVED_STEPS = Number(process.env.MEMTORY_SAVED_STEPS ?? 8);

function file() {
  return path.join(home(), "state", "usage.json");
}

export function readUsage() {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(file(), "utf8")) };
  } catch {
    return { ...EMPTY, bySource: {} };
  }
}

function writeUsage(usage) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(usage, null, 2));
  fs.renameSync(tmp, target);
}

function update(mutate) {
  const usage = readUsage();
  const now = new Date().toISOString();
  usage.firstAt = usage.firstAt || now;
  usage.lastAt = now;
  mutate(usage);
  try {
    writeUsage(usage);
  } catch {}
  return usage;
}

export function recordRecall({ hits = 0, tokens = 0, injected = false, source = "cli" } = {}) {
  return update((usage) => {
    usage.recalls += 1;
    if (hits > 0) usage.hits += 1;
    else usage.misses += 1;
    if (injected) usage.injected += 1;
    usage.tokensReturned += tokens;
    usage.bySource[source] = (usage.bySource[source] || 0) + 1;
  });
}

export function recordInjected() {
  return update((usage) => {
    usage.injected += 1;
  });
}

export function recordObserve() {
  return update((usage) => {
    usage.observed += 1;
  });
}

export function recordRefute() {
  return update((usage) => {
    usage.refuted += 1;
  });
}

/** `patterns` counts good ratings that actually became a note, not approvals. */
export function recordRate({ value = "good", stored = false } = {}) {
  return update((usage) => {
    usage.rated += 1;
    if (value === "bad") usage.ratedBad += 1;
    else usage.ratedGood += 1;
    if (stored) usage.patterns += 1;
  });
}

/** Deliberately conservative and clearly labelled as an estimate. */
export function savings(usage = readUsage()) {
  const avoidedTokens = usage.hits * SAVED_TOKENS;
  const avoidedSteps = usage.hits * SAVED_STEPS;
  const spentTokens = usage.tokensReturned;
  return {
    hits: usage.hits,
    recalls: usage.recalls,
    hitRate: usage.recalls ? Math.round((usage.hits / usage.recalls) * 100) : 0,
    avoidedTokens,
    avoidedSteps,
    tokensReturned: spentTokens,
    netTokens: avoidedTokens - spentTokens,
    assumptions: { tokensPerAvoidedSearch: SAVED_TOKENS, stepsPerAvoidedSearch: SAVED_STEPS },
  };
}

export function formatUsage(usage = readUsage()) {
  const s = savings(usage);
  const sources = Object.entries(usage.bySource || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return [
    `recall calls: ${usage.recalls} · hits: ${s.hits} (${s.hitRate}%) · misses: ${usage.misses}`,
    `observed: ${usage.observed} · refuted: ${usage.refuted} · injected into prompts: ${usage.injected}`,
    `rated: ${usage.rated} (good ${usage.ratedGood}, bad ${usage.ratedBad}) · patterns stored: ${usage.patterns}`,
    `estimated avoided: ~${s.avoidedSteps} tool calls / ~${s.avoidedTokens} tokens (returned ${s.tokensReturned})`,
    `assumption: ${s.assumptions.tokensPerAvoidedSearch} tokens + ${s.assumptions.stepsPerAvoidedSearch} steps per avoided search`,
    sources ? `sources: ${sources}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
