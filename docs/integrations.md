# Integrations

One store, three heads. Everything below reads and writes the same `memtory` branch.

## pi

Installing writes a small generated re-export shim, not a symlink: pi auto-discovers
only `.ts`/`.js` here, and a symlink would break the adapter's relative imports.

```bash
node bin/memtory.mjs install --pi      # writes ~/.pi/agent/extensions/memtory.ts
```

The extension adds:

| Surface | Behavior |
|---|---|
| `before_agent_start` | 5-line recall protocol + one strong hit for the prompt |
| `tool_result` | detects failed-twice-then-worked, records it (no model call) |
| `session_start` / `session_shutdown` | pulls other users' notes, commits and pushes yours |
| `memtory` tool | `recall` \| `observe` \| `refute` |
| `/memtory`, `/observe` | manual control |

## Claude Code

```bash
node bin/memtory.mjs install --claude            # project: .claude/settings.json + .mcp.json
node bin/memtory.mjs install --claude --global   # user: ~/.claude/settings.json + ~/.claude.json
```

Hooks registered (Claude's documented shape — event → matcher group → command):

| Event | Matcher | What memtory does |
|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | pulls notes, injects the protocol + 5 recent titles as `additionalContext` |
| `UserPromptSubmit` | — | injects a matching note when the hit is strong |
| `PostToolUse` | `Bash\|Edit\|Write\|MultiEdit` | buffers tool events per session, records hard-way notes |
| `SessionEnd` | — | hands the git push to a detached process (Claude's timeout is short) |

Each prints the documented payload:

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "..." } }
```

Hook execution never blocks the agent: failures go to stderr, exit code stays 0.

## Codex

```bash
node bin/memtory.mjs install --codex
```

- Adds a managed `<!-- memtory:start -->` block to `AGENTS.md` (Codex reads it automatically) with the exact CLI commands.
- Appends to `~/.codex/config.toml`:

```toml
[mcp_servers.memtory]
command = "node"
args = ["/absolute/path/to/memtory/bin/memtory.mjs", "mcp"]
```

## Any MCP client

```bash
node bin/memtory.mjs mcp
```

Stdio JSON-RPC, no dependencies. Tools:

| Tool | Arguments |
|---|---|
| `memtory_recall` | `query`, `limit?` |
| `memtory_observe` | `symptom`, `cause?`, `fix?`, `verify?`, `files?`, `tags?`, `confidence?` |
| `memtory_refute` | `id`, `note?` |
| `memtory_sync` | — |

The `instructions` field of the `initialize` response carries the recall protocol, so
clients that surface it get the behavior without any config.

Client JSON (Claude `.mcp.json`, Cursor, etc.):

```json
{
  "mcpServers": {
    "memtory": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/memtory/bin/memtory.mjs", "mcp"],
      "env": { "MEMTORY_PROJECT": "/absolute/path/to/repo" }
    }
  }
}
```

`MEMTORY_PROJECT` pins the MCP server to a repo when the client does not spawn it in the
workspace directory. Without it, the server uses its own `cwd`.

## Where the local copy lives

`~/.memtory/repos/<remote-or-path>__<hash>/` — its own git repo tracking only the
`memtory` branch. A per-clone pointer in `.git/memtory-store` keeps that identity stable
when a remote is added or its URL changes.

## Where a push goes

The store's `origin` is the project's own `origin`. So:

| You run an agent in | Push target |
|---|---|
| a git repo (or any subdirectory of one) | that repo's `memtory` branch |
| a folder inside a repo, e.g. `repo/src/ui` | the repo root's `memtory` branch |
| a folder that is not a git repo | nowhere, unless `MEMTORY_REMOTE` is set |

The `memtory` branch is created on origin by the first pushed note (or `memtory sync`).

Background pushes can be turned off per store, so notes stay local:

```bash
memtory autopush off     # commits still happen; `memtory sync` still pushes
MEMTORY_NO_PUSH=1 ...    # global switch for one process
```

Turn it off if you ever run an agent inside a repository you do not own and have write
access to — otherwise a note can create a `memtory` branch there.

## Folders that are not git repos

Notes still record, but they stay local: there is no `origin` to push to. `stats` says so:

```
sync: NOT PUBLISHED — no git remote for this folder
```

Fix either way:

```bash
git init && git remote add origin <url>      # make the folder a repo
MEMTORY_REMOTE=<git url> memtory sync        # or publish to a dedicated notes repo
```

`MEMTORY_REMOTE` (or `{"remote": "..."}` in `~/.memtory/config.json`) is used whenever the
folder has no `origin`. Push failures are recorded, not swallowed: `observe` prints
`push failed — <reason>` and `stats` keeps the last error.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MEMTORY_HOME` | `~/.memtory` | cache + usage state |
| `MEMTORY_PROJECT` | `cwd` | repo the MCP server targets |
| `MEMTORY_REMOTE` | unset | publish target for folders that are not git repos |
| `MEMTORY_PULL_TTL` | `120000` | ms between background fetches |
| `MEMTORY_NO_PULL` | unset | `1` disables network entirely |
| `MEMTORY_AUTORECALL` | on | `0` disables prompt-time note injection |
| `MEMTORY_SAVED_TOKENS` | `6000` | assumptions used by `stats` |
| `MEMTORY_SAVED_STEPS` | `8` | assumptions used by `stats` |
