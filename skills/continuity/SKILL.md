---
name: continuity
description: Branch-isolated continuity memory via the continuity CLI — read the briefing at task start, record deliberate plans/decisions/progress/discoveries/outcomes as work proceeds, and search past entries. Use when starting or resuming work in a repo, when asked about prior direction, decisions or progress, or when the user mentions continuity.
---

# Continuity memory (CLI)

Continuity is deliberate, validated memory shared by every agent working on the branch: it survives session restarts and context compaction. The store lives under the git common dir (`.git/opencode-continuity/`) — invisible to grep — so always go through the CLI, never the files.

## When

- **Task start or resume**: `continuity read` — the delta briefing shows only what this session has not seen yet (`--mode tail` for a quick latest look).
- **During work**: after a real decision, discovery, course change, or outcome, record it immediately — one entry, one deliberate fact. Do not batch a session transcript.
- **"Where were we?" / "why did we do X?"**: `continuity search <words>` (`--all` sweeps every branch), then `continuity read --memory <id>` to retrieve the full entry behind a truncated result.
- **Health**: `continuity status` for pending distillation work, errors, and capacity.
- **Distillation**: pending entries become shared knowledge via the `distill` skill (manual, two-phase) — load it when the user asks for a distill run.

## Commands

```bash
continuity read                                # delta briefing (default)
continuity read --mode tail                    # latest entries only
continuity read --memory <id>                  # one entry by memory id
continuity update --section DECISIONS --provenance USER --text "switched auth to tokens" [--plan my-plan]
continuity search auth tokens                  # substring across retained entries
continuity search --all flaky                  # every branch
continuity status
```

Run from the project root (or pass `--worktree <path>`). If the command is not installed, prefix with `node <continuity-mcp>/src/cli.ts`. Writes attach to the current checkout's branch — other branches see only the distilled shared layer.

## What to record

- Section: `PLANS` next steps/checklists · `DECISIONS` choices + rationale · `PROGRESS` course changes and why · `DISCOVERIES` behaviors, tradeoffs, bugs · `OUTCOMES` achieved/remaining/lessons.
- Provenance: `USER` the user said it · `CODE` verified in code · `TOOL` a tool reported it · `ASSUMPTION` · `UNCONFIRMED`.
- Text: one line, ≤400 chars, no leading metadata. A `--plan` slug (`[a-z0-9][a-z0-9.-]*`) groups entries of a named plan.
- Record facts and direction, never secrets, credentials, or throwaway output.
