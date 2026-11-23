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

Install globally from a checkout (Node ≥ 22.18 runs the TypeScript sources natively; `private` only blocks publishing, not installing):

```bash
npm install -g /path/to/continuity-mcp
```

This provides two commands, usable from any directory: `continuity` (the CLI, see below) and `continuity-mcp` (the stdio server). For development, `npm link` does the same from the checkout. To remove: `npm rm -g continuity-mcp`.

Alternatively, run straight from the checkout with `node src/index.ts` (server) / `node src/cli.ts` (CLI). Because MCP clients differ in whether they spawn the server with your project directory as the working directory, **always set `CONTINUITY_WORKTREE`** to the project root when configuring the server (the server falls back to the process working directory).

### VS Code

`.vscode/mcp.json` in the workspace:

```jsonc
{
  "servers": {
    "continuity": {
      "type": "stdio",
      "command": "continuity-mcp",
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
      "command": ["continuity-mcp"],
      "cwd": "."
    }
  }
}
```

### Claude Code

```bash
claude mcp add continuity --env CONTINUITY_WORKTREE=/path/to/project -- continuity-mcp
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

## CLI

`src/cli.ts` is a terminal front end over the same store and the same tool entry point as the MCP server — handy for inspecting what agents wrote, or recording entries yourself. Installed (`npm install -g`), the command is just `continuity`; from the checkout use `node src/cli.ts`:

```bash
continuity update --section PROGRESS --provenance USER --text "switched auth to tokens"
continuity read --mode tail               # delta is the default, like the tool
continuity search token refresh           # query = words after the command
continuity search --all flaky             # every branch
continuity status
```

`--branch <name>` targets another branch, `--worktree <path>` overrides the project root (else `$CONTINUITY_WORKTREE`, else the cwd). Delta reads use session id `cli` (`--session` to isolate).

### Manual distillation (CLI + skill)

The CLI replaces MCP sampling with a two-phase flow you drive by hand:

```bash
continuity distill --prompt              # 1. prints the distillation request (claims nothing)
#                                          2. get ANY model to answer it — or use the skill below
continuity distill --apply answer.json   # 3. commits the answer ("-" reads stdin)
```

`--prompt` selects the same deterministic batch the server would and reports store status (`clean`, `already-running`, `blocked`) when there is nothing to answer. `--apply` re-selects that batch, takes the store claim, and validates your answer transactionally — citations must match the request's `sources` exactly; a rejected answer leaves all sources pending. If the store changed between the phases so the batch differs, `--apply` fails safely; regenerate the prompt and re-answer.

**The `distill` skill** ([`skills/distill/SKILL.md`](skills/distill/SKILL.md)) makes your agent the model: copy it into the project as `.opencode/skill/distill/SKILL.md` (OpenCode discovers it there), then invoke it manually when you want a distillation run. It runs `--prompt`, answers the request itself under the request's citation rules, and commits via `--apply` — keyless and manual, matching this server's no-auto-distillation stance.

### Skills

Two agent skills ship in [`skills/`](skills/), each installed by copying its folder into the project as `.opencode/skill/<name>/` (OpenCode discovers them there; other agents can read them as plain instructions):

- **`continuity`** — memory hygiene for any agent working in the repo: read the delta briefing at task start, record deliberate entries (PLANS/DECISIONS/PROGRESS/DISCOVERIES/OUTCOMES with provenance) as work proceeds, search past entries. The tool description references exactly this skill.
- **`distill`** — the manual two-phase distillation run described above.

## Project structure

```
continuity-mcp/
  src/
    core.js, storage.js, runtime.js,     # vendored SDK-independent engine
    distill.js, config.js, scheduler.js, # (scheduler vendored unwired; no auto-distill in v2.0)
    schema.js
    index.ts                             # MCP stdio host adapter (tool, sampling, session defaults)
    cli.ts                               # CLI host adapter (argv → same tool entry point)
    skills/distill/SKILL.md              # manually-invoked agent skill: agent answers the distill prompt
    skills/continuity/SKILL.md           # agent skill: read/record/search continuity via the CLI
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
