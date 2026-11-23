---
name: distill
description: Manually distill pending continuity entries on the current branch into shared knowledge and a checkpoint, with the agent acting as the distillation model via the continuity-mcp CLI's two-phase flow. Use when the user asks to distill continuity memory, run distillation, or invoke the distill skill.
---

# Manual continuity distillation

Distillation promotes pending branch entries into repository-wide shared knowledge plus a branch checkpoint through one model call. This skill makes you, the agent, that model — run manually by the user, no MCP sampling or API keys involved. The two CLI phases are safe to run minutes apart: `--prompt` takes no store claim; `--apply` claims only for the instant of validating your answer.

## Steps

1. **Get the request.** From the user's project root (the repo whose continuity store should be distilled):

   ```
   continuity distill --prompt
   ```

   Use the installed `continuity` command (`npm install -g <continuity-mcp checkout>`); if it is not installed, run `node <continuity-mcp>/src/cli.ts distill --prompt` instead. Add `--worktree <path>` if you cannot cd there. stdout is the distillation request: an instruction line, then one JSON line with `baselineRevision`, `shared`, `checkpointRevision`, `checkpoint`, and `sources` (each source has `id`, `contentHash`, `text`, …). The hint on stderr says how many sources were selected.

   If stdout is a JSON `{"status": ...}` object instead (`clean`, `already-running`, `blocked`), report it to the user and stop — there is nothing to answer.

2. **Answer as the distillation model.** Follow the request's instructions exactly and produce ONLY JSON in the shape it specifies:

   ```json
   {"checkpoint":[{"text":"...","citations":[{"id":"...","contentHash":"..."}]}],"proposals":[{"operation":"add|update|conflict","targetId":null,"priorHash":null,"text":"...","classification":"no-contradiction|equivalent|changed|uncertain","reason":"...","citations":[{"id":"...","contentHash":"..."}]}]}
   ```

   - Cite ONLY `id`/`contentHash` pairs copied exactly from the request's `sources` array — never from the baseline or checkpoint, never invented.
   - Rebuild the checkpoint from the current sources alone; omit prior checkpoint items no source backs. Empty arrays are valid.
   - Only durable repository-wide facts; never promote branch progress, blockers, or unmerged implementation claims as shared facts.

3. **Commit the answer.** Save your JSON to a temp file (e.g. `$TMPDIR/distill-answer.json`) and run:

   ```
   continuity distill --apply <answer-file>
   ```

   (`--apply -` reads the answer from stdin; prepend `node <continuity-mcp>/src/cli.ts` when the command is not installed.)

4. **Report the result.** `{"status":"completed","reviewed":N,"conflicts":M,...}` on success — also mention M unresolved conflicts if nonzero. On `{"status":"blocked","error":"..."}` the store is unchanged and sources stay pending: explain the error (often an invalid or stale citation), fix your answer, and retry from step 3. Do not retry with a freshly generated `--prompt` unless the error says the batch changed — your answer must match the request you answered.
