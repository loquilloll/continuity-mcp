# continuity-mcp

A generic stdio [MCP](https://modelcontextprotocol.io) server providing **branch-isolated continuity memory** for AI coding agents: a shared, compaction-proof briefing that survives session restarts and context loss. This is a port of the opencode-continuity-tool redesign to the Model Context Protocol — any stdio MCP client (VS Code, OpenCode, Claude Code, Claude Desktop, …) can run it, alongside or instead of the opencode plugin.

- The vendored engine (`src/core.js`, `storage.js`, `runtime.js`, `distill.js`, `config.js`, `scheduler.js`, `schema.js`) is kept byte-close to upstream (local edits marked `mcp:`); `src/index.ts` is the MCP host adapter.
- Non-Git workspaces keep the legacy single-file `docs/CONTINUITY.md` behavior (read/update only).

## Why

AI coding assistants lose context between sessions and compactions. Continuity is a deliberate, validated memory: plans, decisions, progress, discoveries, and outcomes — branch-scoped, shared by every agent working on the branch, with a repository-wide distilled layer of durable knowledge.

## How it works

- **Store**: lives under `<git-common-dir>/opencode-continuity/` (i.e. inside `.git/`, never committed, invisible to ripgrep). Each branch gets its own namespace (`branches/<key>/`): its `CONTINUITY.md` source journal, generated bounded `checkpoint.md`, ledgers, and state. `shared.md` holds repository-wide distilled assertions with citations; `conflicts.md` records disagreements. Non-Git workspaces store under `<workspace>/.opencode-continuity/` (legacy mode).
- **One tool, five commands**:
  - `read` — bounded view: shared knowledge + branch checkpoint + new entries. Defaults to `mode: "delta"` (only new/changed memories for the session); `mode: "tail"` for a quick latest look; `read.memoryId` for targeted retrieval of entries a bounded read had to omit.
  - `update` — submit deliberate entries (`section`, `provenance`, `text` ≤400 chars, optional `plan` slug). Timestamps and stable IDs are assigned for you.
  - `search` — substring look-back across **every retained entry** (the store is invisible to grep); `all: true` sweeps every branch. Returns memory IDs for `read.memoryId`.
  - `status` — pending distillation work, claims, errors, config, capacity.
  - `distill` — request an immediate distillation run (see below).
- **Distillation**: model-driven promotion of durable branch facts into `shared.md` + `checkpoint.md`, with citations, token budgets, conflict detection, and transactional (crash-safe, fenced) commits. In this MCP server, generation runs via **MCP sampling**: the server asks the connected client to generate — keyless, the client pays and picks the actual model (the configured `model` is a hint only).
- **Read caps**: 8,000 tokens total (≤ shared 2,000 / checkpoint 1,000 / branch 5,000); entries beyond the budget are flagged for targeted `read.memoryId` retrieval.
- **Cross-process safe**: file locks with owner identity and recovery — the opencode plugin and this server can operate the same repo's store concurrently.

Not included: auto-scheduling of distillation (this server runs distill only on explicit `distill` commands; the opencode plugin can additionally automate it), transcripts harvesting, vectors, or cross-project graphs.

## Requirements

- [Node.js](https://nodejs.org/) ≥ 22.18 (TypeScript runs natively via type stripping)

## Installation

The server is started with `node src/index.ts` from this repository. Because MCP clients differ in whether they spawn the server with your project directory as the working directory, **always set `CONTINUITY_WORKTREE`** to the project root (the server falls back to the process working directory).

### VS Code

`.vscode/mcp.json` in the workspace:

```jsonc
{
  "servers": {
    "continuity": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/continuity-mcp/src/index.ts"],
      "env": { "CONTINUITY_WORKTREE": "${workspaceFolder}" }
    }
  }
}
```

For `distill` to work, sampling must be enabled (`chat.mcp.serverSampling` in VS Code settings). Clients without sampling support can still read/update/search/status — `distill` reports a clear error.

### OpenCode

`opencode.json` in the project (see the [MCP servers docs](https://opencode.ai/docs/mcp-servers/)):

```jsonc
{
  "mcp": {
    "continuity": {
      "type": "local",
      "command": ["node", "/path/to/continuity-mcp/src/index.ts"],
      "cwd": "."
    }
  }
}
```

### Claude Code

```bash
claude mcp add continuity --env CONTINUITY_WORKTREE=/path/to/project -- node /path/to/continuity-mcp/src/index.ts
```

For Claude Desktop, add the equivalent `mcpServers` entry (`command`, `args`, `env`) to `claude_desktop_config.json`.

## Worktree resolution

The worktree selects the repository (and its git common dir) the store lives in:

1. `$CONTINUITY_WORKTREE` (recommended — robust across every client)
2. the server process's working directory

Branch attribution is automatic: the store resolves the current checkout on every call. Same-branch agents across checkouts share the branch namespace; other branches see only the distilled shared layer.

## Configuration

Optional JSONC settings, merged per nested field:

- **Workspace:** `<worktree>/.opencode/continuity.jsonc` (shared with the opencode plugin)
- **Global:** `$OPENCODE_CONFIG_DIR/continuity.jsonc`, else `$XDG_CONFIG_HOME|~/.config /opencode/continuity.jsonc` (the same file the opencode plugin reads)

```jsonc
{
  "model": "zai-coding-plan/glm-5.3-flash", // advisory under MCP sampling — a hint to the client
  "intervalHours": 2.5,                      // plugin auto-distillation cadence (not used by this server)
}
```

No config file required — defaults apply. Invalid files fail visibly.

## Sessions

Delta reads deduplicate per session. The session id defaults to the connected MCP client's name (from the MCP handshake), so delta state persists across server restarts per client. Parallel sessions of the same client share one ledger — pass an explicit `read.sessionId` to isolate.

## Migration from the legacy docs/CONTINUITY.md engine

On the first tool call in a Git repository, the new store is created and existing `docs/CONTINUITY.md` / `MEMORY.md` are archived byte-for-byte under the store's `legacy/` directory (with path/hash/time manifests) — evidence only, never promoted. Old entries do not appear in new reads; each branch's history starts fresh. The old `continuity-mcp-ledger` temp directory becomes dead state and can be deleted.

## Entry sections

`[PLANS]` (next steps/checklists) · `[DECISIONS]` (choices + rationale) · `[PROGRESS]` (course changes and why) · `[DISCOVERIES]` (behaviors, tradeoffs, bugs) · `[OUTCOMES]` (achieved/remaining/lessons). Provenance on every entry: `USER`, `CODE`, `TOOL`, `ASSUMPTION`, `UNCONFIRMED`.

## Project structure

```
continuity-mcp/
  src/
    core.js, storage.js, runtime.js,     # vendored SDK-independent engine
    distill.js, config.js, scheduler.js, # (scheduler vendored unwired; no auto-distill in v2.0)
    schema.js
    index.ts                             # MCP stdio host adapter (tool, sampling, session defaults)
  tests/
    *.test.ts                            # ported upstream suites + MCP adapter suite
    expect.ts                            # bun:test→node:assert matcher bridge
  package.json
  tsconfig.json
```

## Development

```bash
npm install
npm test
npm run typecheck
```

Ported test suites are runtime-verified conversions of the upstream bun:test suites (marked `@ts-nocheck` to stay close to upstream); the adapter and shim are fully typechecked.

## License

No open-source license; all rights reserved. `package.json` marks the package private (not for npm publishing).
