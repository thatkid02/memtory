---
name: memtory-fix-self
description: Triage memtory notes that are actually bug reports about memtory itself (push/sync, capture, recall, adapters) and turn them into fixes. Use when asked to improve or audit memtory, when memory quality feels off, or when /memtory self is mentioned.
---

# memtory fix-self

Notes on the `memtory` branch are meant to be project knowledge. Some of them are
complaints about memtory: a push that never happened, a capture gate that recorded
noise, an adapter that silently loaded nothing. Those are the highest-value notes in
the store — they are free bug reports from your own past sessions.

## 1. Triage

```bash
memtory self            # ranked list, grouped by area
memtory self --json     # same data, machine readable
memtory self --all      # include notes already marked confirmed
```

In pi: `/memtory self`, or `memtory { action: "self" }`.

Entries are classified by the files, CLI commands and env vars they mention, so a
note about Vercel will not show up here. An empty report is a good report.

## 2. Work one item

Take the top item only:

1. Read `symptom`, `cause`, `fix`, `files`, `verify` from the report.
2. **Reproduce before changing code**, using the `verify` command or the note's own
   repro steps. If it does not reproduce, the note is stale — refute it and stop.
3. Find the root cause. A note about "push failed" is rarely about the error message.
4. Add a regression test that fails before the fix. memtory's own tests live in
   `test/` and run with `npm test`.
5. Close the loop:
   - `memtory resolve <id>` — fixed. The note is kept for regression hunting but is
     never served by recall again. This is the right close for a fixed defect.
   - `memtory confirm <id>` — accurate and still relevant as advice.
   - `memtory refute <id> "<why>"` — the note was wrong.

   Never delete a solved note. `memtory prune --resolved --apply` exists, but history
   in the branch is what lets a future regression be recognised in one call.

## 3. Rules

- One item per pass. Fixing three things at once hides which change worked.
- Never delete a note you have not understood. `refute` keeps the history.
- A `refuted` note is evidence that a heuristic misjudged, not proof of a bug.
- Do not "fix" a note by rewording it. Either the code changes or the note is refuted.
- If the item exposes a missing feature rather than a defect, implement it and record
  the decision with `memtory observe`.
