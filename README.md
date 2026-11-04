# memtory

Learn something the hard way once. The next agent gets it as context.

Notes live in a reserved `memtory` branch of your repo (append-only JSON files), so every
agent that touches the repo — pi, Claude Code, Codex, or a human — reads and writes the
same knowledge. Nothing is checked out in your working tree; it cannot pollute `git status`,
diffs, or builds.

## Why it works

- **Records the trap, not the tutorial.** `symptom → cause → fix → verify → deps`.
- **Triggered by struggle.** Auto-detected when a step failed twice and then worked.
  No "save everything" noise, no model call, no latency.
- **Recalled by symptom.** Indexed on the error line, error code, and file path — the
  things an agent actually has in front of it. No embeddings, no API keys.
- **Version-aware.** Entries carry `os`/`node`/mentioned-deps. A different major version
  of the relevant package demotes the note instead of confidently misleading you.
- **Refutable.** If a note turns out wrong, `refute` demotes it for everyone.

## Install

```bash
# CLI (works anywhere)
ln -s "$PWD/bin/memtory.mjs" /usr/local/bin/memtory

# pi extension
ln -s "$PWD/adapters/pi/index.mjs" ~/.pi/agent/extensions/memtory.mjs
```

## Use

```bash
memtory recall "ERR_PNPM_PEER_DEP_ISSUES react"
memtory observe --symptom "pnpm install fails on unmet peer react@19" \
                --cause "pnpm 9 treats unmet peers as errors" \
                --fix "add pnpm.peerDependencyRules.ignoreMissing" \
                --verify "pnpm install --frozen-lockfile" --file package.json
memtory sync
memtory stats
```

In pi: the agent gets a 5-line protocol, a matching note injected when one exists, and the
`memtory` tool (`recall` | `observe` | `refute`). Commands: `/memtory`, `/observe`.

## How it is stored

```
memtory branch (in origin)
└── entries/<writer-device>/<yyyy-mm>/<id>.json    # append-only, one file per note
```

Append-only per-entry files mean two agents on two machines never conflict: merges are
additive. The local copy lives in `~/.memtory/repos/<remote-or-path>__<hash>/` as its own
git repo tracking only that branch.

## Design rules

1. Never write on every tool call — only on failure → retry → success, or an explicit observe.
2. Never inject all of memory into the prompt — one protocol block, plus at most one matched note.
3. Never trust a note implicitly — every recall ends with "verify before relying on it".
4. Never let a stale note win — refutations and major-version mismatches demote it.

## Status

Working: store + branch sync, BM25 recall, dedupe (error-code aware), hard-way detection,
refutation, version-aware ranking, pi adapter, offline fallback.

Next: MCP server for Claude Code / Codex, `memtory stats --savings`, team review queue,
optional embeddings for fuzzy recall.

## Tests

```bash
npm test
```

Two suites: core (`test/smoke.mjs`, real git remotes, two clones, two device homes) and
adapter (`test/adapter.mjs`, mock ExtensionAPI driving a real failure→retry→success run).
