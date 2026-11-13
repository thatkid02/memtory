# memtory

Learn something the hard way once. The next agent gets it as context.

Notes live in a reserved `memtory` branch of your repo (append-only JSON files), so every
agent that touches the repo — pi, Claude Code, Codex, Cursor, or a human — reads and writes
the same knowledge. Nothing is checked out in your working tree; it cannot pollute
`git status`, diffs, or builds.

```bash
memtory recall "ERR_PNPM_PEER_DEP_ISSUES react"
# memtory: 1 match for "ERR_PNPM_PEER_DEP_ISSUES react" (7 stored, shared via git@…)
# 1. [mw1n9g2-yn7q1z] ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependency react@19 …
#    cause: pnpm 9 treats unmet peers as an error
#    fix: add pnpm.peerDependencyRules.ignoreMissing to package.json
#    verify: pnpm install --frozen-lockfile
#    12d old · high · by alice
#
# Hint, not truth: verify with `verify` or rerun it before trusting.
```

## Why it works

- **Records the trap, not the tutorial.** `symptom → cause → fix → verify → deps`.
- **Records the trap, and the pattern.** `symptom → cause → fix → verify → deps` for something
  that broke; `task → approach → verify` for something that simply went right. Failures are
  captured automatically; successes are captured when you rate them, because "good output" is
  a judgement, not something a heuristic can infer.
- **Triggered by struggle, gated by usefulness.** Auto-detected when a step failed twice
  and then worked *and something changed* — an identical retry that suddenly passes is
  transient, and a symptom with no error code, path, or distinctive words could never be
  recalled anyway. No model call, no latency.
- **Recalled by symptom.** Indexed on the error line, error code, and file path — the
  things an agent actually has in front of it. BM25 plus a character-trigram fallback for
  typos. No embeddings, no API keys.
- **Version-aware.** Entries carry `os`/`node`/mentioned deps. A different major version of
  the relevant package demotes the note instead of confidently misleading you.
- **Refutable.** If a note turns out wrong, `refute` demotes it for everyone and puts it in
  the review queue.

## Install

```bash
node bin/memtory.mjs install --pi                  # pi extension (re-export shim)
node bin/memtory.mjs install --claude              # project .claude/settings.json + .mcp.json
node bin/memtory.mjs install --claude --global     # user-level Claude config
node bin/memtory.mjs install --codex               # AGENTS.md block + ~/.codex/config.toml
node bin/memtory.mjs install --dry-run             # show what would change
```

`install` is idempotent, merges instead of clobbering, refuses to edit invalid JSON, and
prints what it touched. See [docs/integrations.md](docs/integrations.md) for the exact hook
tables and MCP declarations.

## Rate a session that went well

Failures are captured automatically. Successes are not: "the output was good" is a judgement,
and guessing at it would fill the store with noise. Rate it instead.

```bash
memtory rate good --task "bump vitest to v2 and keep jsdom snapshots passing" \
                  --approach "overrode environment in vitest.config.ts; ran pnpm test -u" \
                  --verify "pnpm test"
# memtory: rated good → recorded [mw1n9g2-yn7q1z] as a pattern (high, pushed)
#   task: bump vitest to v2 and keep jsdom snapshots passing
#   approach: overrode environment in vitest.config.ts; ran pnpm test -u
#   verify: pnpm test

memtory rate good --id mw1n9g2-yn7q1z --note "still the right approach"   # confirmed
memtory rate bad  --id mw1n9g2-yn7q1z --note "only for jsdom, broke node"  # refuted
```

In pi, `/rate good` does the same thing without you describing the session: it distills the
opening prompt (the task), the files that were changed, and the last command that succeeded,
and only stores the note if that evidence is concrete. `/rate good <why it worked> || <task>`
overrides either half. A bad rating stores nothing — a session that went badly already has a
home in `observe`, which records the trap instead.

Rating a note that recall returned is a review action: `good` confirms it, `bad` refutes it.

## Use

```bash
memtory observe --symptom "pnpm install fails on unmet peer react@19" \
                --cause "pnpm 9 treats unmet peers as errors" \
                --fix "add pnpm.peerDependencyRules.ignoreMissing" \
                --verify "pnpm install --frozen-lockfile" --file package.json
memtory recall "react@19 peer"
memtory rate good --task "bump vitest to v2, keep jsdom snapshots" --approach "changed vitest.config.ts; ran pnpm test -u"
memtory review                     # notes that need a human look
memtory self                       # triage notes that describe memtory bugs
memtory prune                      # list auto-notes nobody could search for
memtory confirm <id>               # still accurate and useful
memtory resolve <id>               # fixed: kept for history, never recalled
memtory refute <id> "pnpm 10 fixed it"
memtory prune --apply              # delete them
memtory autopush off               # keep notes local for this store
memtory stats                      # counts + estimated savings
memtory sync                       # merge what others wrote, push yours
memtory mcp                        # MCP stdio server
```

`stats` reports honest bookkeeping, not a vanity metric:

```
entries: 4
confidence: high=2 low=2
needs review: 2

recall calls: 11 · hits: 6 (54%) · misses: 5
observed: 4 · refuted: 1 · injected into prompts: 3
estimated avoided: ~48 tool calls / ~36000 tokens (returned 1800)
assumption: 6000 tokens + 8 steps per avoided search
```

## How it is stored

```
memtory branch (in origin)
└── entries/<writer-device>/<yyyy-mm>/<id>.json    # append-only, one file per note
```

Append-only per-entry files mean two agents on two machines never conflict: merges are
additive. The local copy lives in `~/.memtory/repos/<remote-or-path>__<hash>/` as its own
git repo tracking only that branch, so the project worktree is never touched.

Each clone keeps a pointer at `.git/memtory-store` (never committed), so adding a remote or
switching `ssh` → `https` reuses the same store instead of silently forking your notes.
Set `MEMTORY_REMOTE` (or `remote` in `~/.memtory/config.json`) once and *every* note from
*every* folder — git repo or not — pushes to that one repo's `memtory` branch. Without it,
notes stay with the project, and non-git folders use a machine-wide
`~/.memtory/global.git` so recall still works across folders.

Adapters: **pi** (native extension, full hook surface), **Claude Code** (SessionStart /
UserPromptSubmit / PostToolUse / SessionEnd hooks), **Codex** (AGENTS.md + MCP), **anything
else** (MCP server or the CLI).

## Design rules

1. Never write on every tool call — only on failure → retry → success, or an explicit observe.
2. Never inject all of memory — one protocol block, plus at most one matched note.
3. Never trust a note implicitly — every recall ends with "verify before relying on it".
4. Never let a stale note win — refutations and major-version mismatches demote it.
5. Never block the agent — hooks fail open, pushes run detached or at session end.

## Status

Working: auto-capture quality gate + prune, rated-success patterns, shared store + branch sync, BM25 + trigram recall, error-code-aware dedupe,
hard-way detection, refutation, review queue, version-aware ranking, savings accounting,
pi adapter, Claude Code hooks, Codex install, zero-dependency MCP server, offline mode.

`memtory self` closes the loop on the tool itself: notes that describe memtory's own
behavior (a push that never happened, capture that recorded noise, an adapter that loaded
nothing) are ranked into a fix list, and the `memtory-fix-self` skill is registered with the
pi extension so an agent knows how to work it.

Next: team review UI, note merging across device forks, optional embeddings for cross-repo
recall, GitHub Action that flags notes touched by a dependency bump.

## Tests

```bash
npm test
```

Five suites, all against real git repos and real subprocesses:

| Suite | Covers |
|---|---|
| `test/smoke.mjs` | two clones + two device homes, sync, recall, dedupe, refutation, fuzzy, savings, review, capture gate, prune, rated patterns |
| `test/adapter.mjs` | mock pi ExtensionAPI driving a failure → retry → success run |
| `test/mcp.mjs` | real MCP subprocess: handshake, tools/list, all four tools, error paths |
| `test/hooks.mjs` | Claude Code payload shapes: context output, auto-observe, session cleanup |
| `test/install.mjs` | exact config files, idempotency, merge safety, dry run |
