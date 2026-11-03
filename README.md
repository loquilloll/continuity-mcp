# continuity-mcp

A generic stdio [MCP](https://modelcontextprotocol.io) server that provides structured, validated management of `CONTINUITY.md` — a living document designed to survive context compaction across AI coding sessions. The tool enforces canonical formatting, shared UTC timestamps, provenance tracking, and automatic token-budget compaction with archival to the colocated `MEMORY.md`. Both files use the selected continuity directory, which defaults to `<worktree>/docs`.

This is a port of pi-continuity-tool (itself a port of opencode-continuity-tool) to the Model Context Protocol. The `CONTINUITY.md`/`MEMORY.md` format, memory IDs, delta ledger, and compaction algorithm are unchanged; only the host layer is new — any stdio MCP client (VS Code, OpenCode, Claude Code, Claude Desktop, …) can run it.

## Why

AI coding assistants lose context between sessions. `CONTINUITY.md` acts as a persistent briefing document that captures plans, decisions, progress, discoveries, and outcomes in a structured, machine-readable format. This server ensures every entry is validated, timestamped, and formatted consistently — and that the document never grows beyond a configurable token budget.

## Features

- **One tool, two commands** — `read` (non-mutating) and `update` (append entries with optional compaction)
- **Session-aware delta reads** — `read` defaults to `mode: "delta"`; the session id defaults to the connected MCP client's name, so no caller bookkeeping is needed
- **Shared UTC timestamp** — all entries in a single `update` call share one timestamp
- **Provenance tracking** — every entry is tagged with its source (`USER`, `CODE`, `TOOL`, `ASSUMPTION`, `UNCONFIRMED`)
- **Plan linking** — optional `[plan:slug]` tags connect entries to build plans
- **Schema validation** — section, provenance, plan slug, and text length are validated via the tool's zod input schema (client-enforced); text-line rules are enforced in the core
- **Auto-creation** — on `update`, the selected directory and `CONTINUITY.md` are created from a canonical template when missing; `read` reports a missing file without creating one
- **Token-budget compaction** — when the document exceeds a configurable upper token threshold, oldest entries are trimmed per-section down to a lower target
- **Archival** — compacted entries are preserved in the colocated `MEMORY.md` under their original section headers
- **Silent successful updates** — update returns an empty tool output on success; errors surface as `isError` tool results

## Requirements

- [Node.js](https://nodejs.org/) ≥ 22.18 (to run the server and the tests; TypeScript runs natively via type stripping)
- [tiktoken](https://github.com/openai/tiktoken) (installed as a dependency; used for token counting)

## Installation

The server is started with `node src/index.ts` from this repository. Because MCP clients differ in whether they spawn the server with your project directory as the working directory, **always set `CONTINUITY_WORKTREE`** to the project root (the server falls back to the process working directory).

### VS Code

`.vscode/mcp.json` in the workspace:

```jsonc
{
  "servers": {
    "continuity": {
      "command": "node",
      "args": ["/path/to/continuity-mcp/src/index.ts"],
      "env": { "CONTINUITY_WORKTREE": "${workspaceFolder}" }
    }
  }
}
```

Then use the tool from Copilot Chat (agent mode): *“use the continuity tool to read the current state”*.

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

The worktree selects where `CONTINUITY.md` lives and which delta ledger is used:

1. `$CONTINUITY_WORKTREE` (recommended — robust across every client)
2. the server process's working directory

## File location configuration

The tool always keeps the fixed filenames `CONTINUITY.md` and `MEMORY.md` together in one selected directory. Without configuration, that directory is `<worktree>/docs`.

Location configuration uses standalone JSON sidecar files:

- **Global:** `$XDG_CONFIG_HOME/continuity/continuity.json`, or `~/.config/continuity/continuity.json` when `XDG_CONFIG_HOME` is unset or blank
- **Project:** `<worktree>/.continuity/continuity.json`

Both sidecars use the same strict JSON shape:

```json
{
  "directory": ".ai-memory"
}
```

Precedence is `project > global > docs`. A missing sidecar falls through to the next level; a present invalid sidecar fails the tool call instead. Sidecars are read on every tool invocation, so a valid change applies on the next call without restarting the server.

Relative values from either sidecar resolve against the resolved worktree. Absolute values remain absolute. Bare `~` and paths beginning with `~/` expand to the current user's home directory; any other `~`-prefixed form, including `~user/...`, is rejected.

Sidecars must contain valid JSON with exactly one non-blank string field named `directory`. Malformed JSON, missing, blank, or non-string `directory` values, extra keys, and paths that already exist as non-directory files are rejected. A selected directory that does not yet exist is created when needed.

Changing the configured directory does not move or copy existing files. Absolute directories can intentionally share one continuity document between projects, but concurrent writers are not protected by a cross-process lock (updates are only serialized within one server process).

## Document Structure

The tool manages `CONTINUITY.md` in the selected directory, defaulting to `<worktree>/docs`, with five canonical sections:

```markdown
# CONTINUITY

## [PLANS]
- [id:plans-202603011822-user-2d3f9d713e4c] 2026-03-01T18:22Z [USER] [plan:01-mcp-port] Next steps and checklists.

## [DECISIONS]
- [id:decisions-202603011822-code-e81db3c11d10] 2026-03-01T18:22Z [CODE] Architectural choices and rationale.

## [PROGRESS]
- [id:progress-202603011822-tool-8edacabeec94] 2026-03-01T18:22Z [TOOL] Course changes and why.

## [DISCOVERIES]
- [id:discoveries-202603011822-tool-15767297c53d] 2026-03-01T18:22Z [TOOL] Notable behaviors, tradeoffs, bugs.

## [OUTCOMES]
- [id:outcomes-202603011822-code-330d1194f0f8] 2026-03-01T18:22Z [CODE] Completion summaries.
```

### Entry Format

```
- [id:<memory-id>] YYYY-MM-DDTHH:MMZ [PROVENANCE] [plan:slug] <text>
```

Legacy bullets without `[id:...]` remain readable; a deterministic memory ID is derived from section, timestamp, provenance, plan, and normalized text.

| Field | Description | Required |
|---|---|---|
| Memory ID | Stable identity for the memory entry. New writes include it explicitly; legacy entries derive it on read. | Yes for new writes |
| Timestamp | ISO 8601 UTC, minute precision. Auto-generated. | Yes |
| Provenance | One of `USER`, `CODE`, `TOOL`, `ASSUMPTION`, `UNCONFIRMED` | Yes |
| Plan slug | Lowercase alphanumeric with dots/hyphens (e.g., `01-mcp-port`) | No |
| Text | Single-line, non-blank, 1-400 characters | Yes |

## Usage

### Read

`read` defaults to `mode: "delta"`; the session id defaults to the connected MCP client's name, so a plain read works:

```js
continuity({ command: "read" })
```

Explicit delta with options:

```js
continuity({
  command: "read",
  read: {
    sessionId: "session-123", // optional: overrides the client-name default
    includePinned: true,
    includeUnresolved: true,
  },
})
```

Tail mode (latest N bullet lines per section):

```js
continuity({
  command: "read",
  read: {
    mode: "tail",
    linesPerSection: 5, // optional, default: 5
  },
})
```

**Output:** a text report with section headers in canonical order and the eligible bullet entries under each. Read output omits internal `[id:...]` prefixes. When delta mode finds nothing new it returns `No new or changed task memories.`

Delta mode stores its seen-ledger in OS temporary storage (`<tmp>/continuity-mcp-ledger/<worktreeHash>/<sessionId>.json`), independently of the selected continuity directory. The default session id is the MCP client name reported at initialization (e.g. `visual-studio-code`), so delta state survives server restarts per client; parallel sessions of the same client share one ledger — pass an explicit `sessionId` to isolate them.

### Update

Appends validated entries to the specified sections and optionally triggers compaction.

```js
continuity({
  command: "update",
  updates: [
    { section: "PLANS", provenance: "USER", plan: "01-mcp-port", text: "Next steps." },
    { section: "DECISIONS", provenance: "CODE", text: "Reuse the host-agnostic core from pi-continuity-tool." },
  ],
  compaction: { upperTokenThreshold: 10000 }, // optional
})
```

**Output:** an empty output string on success. Errors are surfaced as `isError` tool results.

## Parameters

| Parameter | Type | Command | Description |
|---|---|---|---|
| `command` | `"read"` \| `"update"` | Both | **Required.** Operation mode. |
| `updates` | `Update[]` | `update` | **Required for update.** Array of entries to append. |
| `compaction` | `Compaction` | `update` | Optional. Token-budget compaction settings. |
| `read` | `ReadConfig` | `read` | Optional. Read output configuration. |

### Update Object

| Field | Type | Description |
|---|---|---|
| `section` | enum | One of `PLANS`, `DECISIONS`, `PROGRESS`, `DISCOVERIES`, `OUTCOMES` |
| `provenance` | enum | One of `USER`, `CODE`, `TOOL`, `ASSUMPTION`, `UNCONFIRMED` |
| `plan` | `string?` | Optional slug matching `^[a-z0-9][a-z0-9.-]*$` |
| `text` | `string` | Single-line, non-blank, 1-400 characters |

### Compaction Object

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Enable/disable automatic compaction. |
| `upperTokenThreshold` | `integer` | `10000` | Token count that triggers compaction. |
| `lowerTokenThreshold` | `integer` | `upperTokenThreshold / 2` | Target after compaction. The effective value is always derived from `upperTokenThreshold`. |
| `totalTokenThreshold` | `integer` | — | Legacy alias for `upperTokenThreshold`. |
| `encoding` | `string` | `"cl100k_base"` | tiktoken encoding name. |

Threshold precedence: explicit `upperTokenThreshold`, else legacy `totalTokenThreshold`, else inferred `lowerTokenThreshold * 2`, else `10000`.

### ReadConfig Object

| Field | Type | Default | Description |
|---|---|---|---|
| `linesPerSection` | `integer` | `5` | Number of most recent bullet lines per section (tail mode). |
| `mode` | `"tail"` \| `"delta"` | `"delta"` | Read mode. |
| `sessionId` | `string` | MCP client name | Session identity for the delta ledger. |
| `includePinned` | `boolean` | `false` | In delta mode, include pinned entries even when unchanged. |
| `includeUnresolved` | `boolean` | `false` | In delta mode, include `[status:unresolved]` entries even when unchanged. |

## Compaction

When the total token count of `CONTINUITY.md` exceeds the upper threshold after an update, the tool automatically:

1. Computes per-section token budgets using ratio weights (derived from real-world continuity data).
2. Removes oldest bullet entries within each section until each meets its budget.
3. Continues trimming the most over-budget section until the document is at or below the lower target.
4. Archives removed entries into the colocated `MEMORY.md` under their original section headers.
5. Logs a compaction event in the `DISCOVERIES` section.

### Section Ratio Weights

| Section | Weight | Approximate % |
|---|---|---|
| PLANS | 4,339 | 9.1% |
| DECISIONS | 5,175 | 10.8% |
| PROGRESS | 22,471 | 47.1% |
| DISCOVERIES | 6,622 | 13.9% |
| OUTCOMES | 9,126 | 19.1% |

### MEMORY.md

`MEMORY.md` is the archival file colocated with `CONTINUITY.md`. It is not a source of truth — it preserves entries removed during compaction. It includes reserved `[THEMES]` and `[MILESTONES]` sections for future compaction phases.

## Validation & Error Handling

The tool rejects invalid input or location configuration without modifying managed files:

| Condition | Error |
|---|---|
| Multi-line text (contains `\n` or `\r`) | `text must be a single line` |
| Blank text | `text must not be blank` |
| Missing section header in existing file | `Missing section header(s): <names>` |
| Duplicate section header | `Duplicate section header: <name>` |
| `updates` provided with `read` command | `updates are not supported for read command` |
| Empty `updates` with `update` command | `updates must be provided for update command` |
| Text begins with bracketed metadata-like token | `text must not start with a bracketed token` |
| Malformed location sidecar JSON | error identifies the invalid sidecar |
| Missing, blank, or non-string `directory` | error identifies the invalid field and sidecar |
| Extra sidecar keys | error identifies the unsupported configuration |
| Existing non-directory target | error identifies the configured target |
| Unsupported `~`-prefixed path (e.g. `~user/...`) | `Unsupported home-directory path` |

Compatibility behaviors: `compaction` on `read` is ignored, `read` on `update` is ignored, and `lowerTokenThreshold` is normalized from `upperTokenThreshold` when needed.

## Project Structure

```
continuity-mcp/
  src/
    continuity.ts    # Host-agnostic core (parsing, ledger, compaction)
    index.ts         # MCP stdio server entry (registerTool adapter)
  tests/
    continuity.test.ts  # Core suite (45 tests)
    adapter.test.ts     # MCP adapter suite (5 tests, incl. spawned-server E2E)
  docs/                 # Default selected continuity directory (git-ignored runtime data)
  package.json
  tsconfig.json
```

## Development

```bash
npm install
npm test
npm run typecheck
```

## Roadmap

The broader layered-memory rollout lives in the source project's `docs/plans/04-layered-continuity-memory.md` (opencode-continuity-tool).

| Phase | Status | Description |
|---|---|---|
| **Phase 1** | Done | Raw truncation with oldest-first removal and MEMORY.md archival |
| **Phase 2** | Planned | Generate `[THEMES]` and `[MILESTONES]` from compacted entries |
| **Phase 3** | Planned | Replace raw archived lines in MEMORY.md with grouped summaries |

## License

No open-source license; all rights reserved. `package.json` marks the package private (not for npm publishing).
