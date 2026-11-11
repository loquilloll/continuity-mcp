// vendored from opencode-continuity-tool@d3c55ec - local edits marked mcp:
// V2 consumes JSON Schema directly; V1's legacy wrapper retains its Zod contract.
import { SECTIONS, PROVENANCE } from "./core.js"

export const description = "Branch-isolated continuity for primary agents and subagents. Deliberately record direction, findings and progress; reads combine shared knowledge with this branch only. Read defaults to delta; supply sessionId (tail needs none). status shows pending distillation; distill requests an immediate run. Load the `continuity` skill for when/what to record and read."
export const input = {
  type: "object", additionalProperties: false, required: ["command"],
  properties: {
    command: { type: "string", enum: ["read", "update", "status", "distill", "search"] },
    query: { type: "string", minLength: 1, maxLength: 200, description: "search command: case-insensitive substring matched against every retained entry (all branches with all=true, default current branch + shared knowledge). Results are memory IDs for read.memoryId." },
    all: { type: "boolean", description: "search command: sweep every branch of this repository instead of the current branch + shared knowledge." },
    branch: { type: "string", minLength: 1 },
    updates: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object", additionalProperties: false, required: ["section", "provenance", "text"],
      properties: { section: { type: "string", enum: SECTIONS }, provenance: { type: "string", enum: PROVENANCE },
        text: { type: "string", minLength: 1, maxLength: 400 }, plan: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]*$" } },
    } },
    read: { type: "object", additionalProperties: false, properties: {
      mode: { type: "string", enum: ["tail", "delta"] }, sessionId: { type: "string" },
      linesPerSection: { type: "integer", minimum: 1 }, includePinned: { type: "boolean" },
      includeUnresolved: { type: "boolean" }, memoryId: { type: "string", minLength: 1 },
    } },
    compaction: { type: "object", additionalProperties: false, properties: {
      enabled: { type: "boolean" }, encoding: { type: "string" },
      upperTokenThreshold: { type: "integer", minimum: 1 }, lowerTokenThreshold: { type: "integer", minimum: 1 },
      totalTokenThreshold: { type: "integer", minimum: 1 },
    } },
  },
}
