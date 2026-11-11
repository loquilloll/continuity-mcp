// @ts-nocheck -- ported from upstream bun:test suites; runtime-verified under node:test, kept close to upstream for syncs
import { afterEach, test } from "node:test";
import { expect } from "./expect.ts";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as storage from "../src/storage.js";
import { runDistillation, inspectMemory, renderMemoryDocument, parseMemoryDocument, hashMemoryContent, applyProposals, refreshEpoch, tokens } from "../src/distill.js";

const temporary = [];
const start = Date.parse("2026-01-01T00:00:00Z");
const empty = JSON.stringify({ checkpoint: [], proposals: [] });
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(count = 1, text = "A deliberate source") {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "continuity-distill-"));
  temporary.push(workspace);
  const scope = await storage.resolveScope({ workspace });
  const config = { workspace, settings: { model: "test/fake", intervalHours: 2.5 }, paths: {}, hashes: {}, hash: "config-a" };
  const sources = Array.from({ length: count }, (_, i) => ({ version: 1, sequence: i + 1, id: `source-${i + 1}`,
    contentHash: hashMemoryContent(`${text} ${i}`), timestamp: new Date(start).toISOString(), workspace,
    storeId: scope.storeId, branchKey: scope.branchKey, section: "Progress", provenance: "test", plan: null,
    text: `${text} ${i}`, line: `- ${text} ${i}`, config }));
  await storage.withStore(scope, async () => {
    const state = await storage.readState(scope) ?? storage.createBranchState(scope);
    state.nextSequence = count + 1;
    state.pendingCount = count;
    state.oldestPendingSequence = count ? 1 : null;
    state.firstPendingAt = count ? new Date(start).toISOString() : null;
    const writes = [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) }];
    for (const source of sources) {
      const filename = `${String(source.sequence).padStart(12, "0")}.json`;
      writes.push({ path: `${scope.branchDir}/sources/${filename}`, content: JSON.stringify(source) },
        { path: `${scope.branchDir}/pending/${filename}`, content: JSON.stringify({ sequence: source.sequence, id: source.id, contentHash: source.contentHash }) });
    }
    await storage.commit(scope, writes);
  });
  return { scope, sources, config };
}
const inspect = (scope) => storage.withStore(scope, () => inspectMemory(scope));
const cite = (source) => [{ id: source.id, contentHash: source.contentHash }];
const proposal = (source, overrides = {}) => ({ operation: "add", targetId: null, priorHash: null, text: "Repository uses deterministic tests", classification: "no-contradiction", reason: "Explicit source assertion", citations: cite(source), ...overrides });

test("readable Markdown records roundtrip and reject unknown fields/hash edits", () => {
  const record = { id: "shared-one", text: "A fact", contentHash: hashMemoryContent("A fact"), citations: [{ id: "source", contentHash: hashMemoryContent("source") }] };
  expect(parseMemoryDocument("shared", renderMemoryDocument("shared", [record]))).toEqual([record]);
  expect(() => renderMemoryDocument("shared", [{ ...record, path: "../../escape" }])).toThrow();
  expect(() => renderMemoryDocument("shared", [{ ...record, text: "changed" }])).toThrow();
});

test("first attempt waits 2.5 hours, success reviews once and clean suppresses generation", async () => {
  const { scope } = await fixture();
  let calls = 0;
  const generate = async () => { calls++; return empty; };
  expect(await runDistillation(scope, { generate, now: start })).toMatchObject({ status: "not-due" });
  expect((await runDistillation(scope, { generate, now: start + 9000000 })).status).toBe("completed");
  expect((await runDistillation(scope, { generate, now: start + 18000000 })).status).toBe("clean");
  expect(calls).toBe(1);
  const memory = await inspect(scope);
  expect(memory.state.pendingCount).toBe(0);
  expect(memory.state.reviewedCount).toBe(1);
  expect(memory.checkpointRevision).toBeGreaterThan(1);
});

test("manual and automatic claim collisions generate once; generation is outside lock", async () => {
  const { scope } = await fixture();
  let entered;
  const began = new Promise((resolve) => { entered = resolve; });
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const first = runDistillation(scope, { manual: true, now: start, generate: async () => { entered(); return response; } });
  await began;
  expect((await runDistillation(scope, { manual: true, now: start, generate: () => { throw Error("duplicate"); } })).status).toBe("already-running");
  release(empty);
  expect((await first).status).toBe("completed");
});

test("unknown citations leave pending and failed attempts are rate limited", async () => {
  const { scope, sources } = await fixture();
  const result = await runDistillation(scope, { manual: true, now: start, generate: async () => JSON.stringify({ checkpoint: [{ text: "unsupported", citations: [{ ...cite(sources[0])[0], id: "invented" }] }], proposals: [] }) });
  expect(result.status).toBe("blocked");
  expect(result.error).toContain("citation");
  expect((await inspect(scope)).state.pendingCount).toBe(1);
  expect((await runDistillation(scope, { now: start + 1, generate: () => { throw Error("must not run"); } })).status).toBe("not-due");
});

test("hash transcription errors in citations are canonicalized to the batch truth", async () => {
  const { scope, sources } = await fixture();
  const sloppy = { id: sources[0].id, contentHash: `sha256:${"f".repeat(64)}` };
  const result = await runDistillation(scope, { manual: true, now: start, generate: async () => JSON.stringify({
    checkpoint: [{ text: "Canonicalized checkpoint", citations: [sloppy] }],
    proposals: [{ operation: "add", targetId: null, priorHash: null, text: "Canonicalized fact", classification: "no-contradiction", reason: "source", citations: [sloppy] }],
  }) });
  expect(result.status).toBe("completed");
  const memory = await inspect(scope);
  expect(memory.shared[0].citations[0].contentHash).toBe(sources[0].contentHash);
  expect(memory.checkpoint[0].citations[0].contentHash).toBe(sources[0].contentHash);
});

test("foreign workspace cannot manually hijack frozen owner", async () => {
  for (const initialized of [false, true]) {
    const { scope } = await fixture();
    if (initialized) await runDistillation(scope, { now: start });
    const statePath = path.join(scope.storeRoot, scope.branchDir, "state.json");
    const before = await readFile(statePath, "utf8");
    const files = (await readdir(scope.storeRoot, { recursive: true })).filter((name) => !name.startsWith("transactions")).sort();
    const sharedMetadata = await storage.readText(path.join(scope.storeRoot, "memory.json"));
    const result = await runDistillation(scope, { manual: true, workspace: "some-other-workspace", now: start + 1000, generate: () => { throw Error("must not generate"); } });
    expect(result.status).toBe("blocked");
    expect(result.error).toContain("owned by");
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect((await readdir(scope.storeRoot, { recursive: true })).filter((name) => !name.startsWith("transactions")).sort()).toEqual(files);
    expect(await storage.readText(path.join(scope.storeRoot, "memory.json"))).toBe(sharedMetadata);
  }
});

test("model context reserve and oversized inherited whole source block without consuming", async () => {
  const { scope } = await fixture();
  expect((await runDistillation(scope, { manual: true, now: start, modelContext: 100, generate: async () => empty })).status).toBe("blocked");
  expect((await inspect(scope)).state.pendingCount).toBe(1);
  const huge = await fixture(1, "oversized ".repeat(10000));
  const result = await runDistillation(huge.scope, { manual: true, now: start, generate: async () => empty });
  expect(result.error).toContain("whole-source");
  expect((await inspect(huge.scope)).state.pendingCount).toBe(1);
});

test("baseline revision edits fence even empty results and preserve pending", async () => {
  const { scope, sources } = await fixture();
  const result = await runDistillation(scope, { manual: true, now: start, generate: async () => {
    await storage.withStore(scope, async () => {
      await storage.commit(scope, [{ path: "shared.md", content: renderMemoryDocument("shared", [{ id: "external", text: "Manual fact", contentHash: hashMemoryContent("Manual fact"), citations: cite(sources[0]) }]) }]);
    });
    return empty;
  } });
  expect(result.status).toBe("blocked");
  expect(result.error).toContain("Stale");
  expect((await inspect(scope)).state.pendingCount).toBe(1);
});

test("expired claim replacement fences late owner without overwriting winner", async () => {
  const { scope } = await fixture();
  let entered;
  const began = new Promise((resolve) => { entered = resolve; });
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  let time = start;
  const first = runDistillation(scope, { manual: true, now: () => time, generate: async () => { entered(); return response; } });
  await began;
  time += 300001;
  expect((await runDistillation(scope, { manual: true, now: () => time, generate: async () => empty })).status).toBe("completed");
  release(empty);
  expect((await first).status).toBe("blocked");
  expect((await inspect(scope)).state.reviewedCount).toBe(1);
});

test("changed meaning creates durable conflict instead of shared overwrite", () => {
  const source = { id: "s", contentHash: hashMemoryContent("evidence") };
  const original = { id: "stable", text: "Original", contentHash: hashMemoryContent("Original"), citations: cite(source) };
  const result = applyProposals({ shared: [original], conflicts: [] }, { checkpoint: [], proposals: [proposal(source, { operation: "update", targetId: "stable", priorHash: original.contentHash, classification: "changed", text: "Contradiction" })] });
  expect(result.shared).toEqual([original]);
  expect(parseMemoryDocument("conflicts", renderMemoryDocument("conflicts", result.conflicts))).toHaveLength(1);
});

test("repeated generation failures back off without losing pending sources", async () => {
  const { scope } = await fixture();
  const generate = async () => { throw new Error("provider failed"); };
  expect((await runDistillation(scope, { manual: true, now: start, generate })).status).toBe("blocked");
  const first = (await inspect(scope)).state;
  const retry = Date.parse(first.nextEligibleAt);
  expect((await runDistillation(scope, { now: retry, generate })).status).toBe("blocked");
  const second = (await inspect(scope)).state;
  expect(second.error.count).toBe(2);
  expect(Date.parse(second.nextEligibleAt) - retry).toBe(2 * (retry - start));
  expect(second.pendingCount).toBe(1);
});

test("markdown-fenced model output is parsed after stripping the fences", async () => {
  const { scope, sources } = await fixture();
  const fenced = "```json\n" + JSON.stringify({ checkpoint: [{ text: "Fenced checkpoint", citations: cite(sources[0]) }], proposals: [] }) + "\n```";
  const result = await runDistillation(scope, { manual: true, now: start, generate: async () => fenced });
  expect(result.status).toBe("completed");
  expect((await inspect(scope)).checkpoint[0].text).toBe("Fenced checkpoint");
});

test("unique target prefixes require a matching prior hash", () => {  const source = { id: "s", contentHash: hashMemoryContent("evidence") };
  const original = { id: "shared-abcdef12-3456", text: "Original", contentHash: hashMemoryContent("Original"), citations: cite(source) };
  const updated = applyProposals({ shared: [original], conflicts: [] }, { checkpoint: [], proposals: [proposal(source, { operation: "update", targetId: "shared-abcdef12", priorHash: original.contentHash, classification: "equivalent", text: "Original, clarified" })] });
  expect(updated.shared).toHaveLength(1);
  expect(updated.shared[0]).toMatchObject({ id: "shared-abcdef12-3456", text: "Original, clarified" });
  for (const priorHash of [null, "wrong", `sha256:${"0".repeat(64)}`]) {
    const result = applyProposals({ shared: [original], conflicts: [] }, { checkpoint: [], proposals: [proposal(source, { operation: "update", targetId: original.id, priorHash, classification: "equivalent", text: "Changed" })] });
    expect(result.shared).toEqual([original]);
    expect(result.conflicts[0].reason).toContain("prior hash mismatch");
  }
  try { applyProposals({ shared: [original, { ...original, id: "shared-abcdef99-9999" }], conflicts: [] }, { checkpoint: [], proposals: [proposal(source, { operation: "update", targetId: "shared-abcdef", priorHash: original.contentHash, classification: "equivalent", text: "Original, clarified" })] }); expect.unreachable() }
  catch (error) { expect(error.message).toContain("Unknown target") }
  try { applyProposals({ shared: [original], conflicts: [] }, { checkpoint: [], proposals: [proposal(source, { operation: "update", targetId: "nonexistent", priorHash: original.contentHash, classification: "equivalent", text: "x" })] }); expect.unreachable() }
  catch (error) { expect(error.message).toContain("Unknown target") }
});

test("exact normalized duplicates retain stable ID and merge citations", () => {
  const a = { id: "s1", contentHash: hashMemoryContent("one") };
  const b = { id: "s2", contentHash: hashMemoryContent("two") };
  const original = { id: "stable", text: "A fact", contentHash: hashMemoryContent("A fact"), citations: cite(a) };
  const result = applyProposals({ shared: [original], conflicts: [] }, { checkpoint: [], proposals: [proposal(b, { text: "A  fact" })] });
  expect(result.shared).toHaveLength(1);
  expect(result.shared[0].id).toBe("stable");
  expect(result.shared[0].citations).toHaveLength(2);
});

test("invalid stopped-runtime edit blocks visibly and preserves original bytes", async () => {
  const { scope } = await fixture();
  await inspect(scope);
  await storage.withStore(scope, () => storage.commit(scope, [{ path: "shared.md", content: "invalid manual bytes" }]));
  await expect(inspect(scope)).rejects.toThrow("Invalid shared Markdown");
  expect(await readFile(path.join(scope.storeRoot, "shared.md"), "utf8")).toBe("invalid manual bytes");
});

test("capacity rejects oversized shared baseline rather than truncating", () => {
  const source = { id: "s", contentHash: hashMemoryContent("evidence") };
  expect(() => renderMemoryDocument("shared", [{ id: "large", text: "word ".repeat(3000), contentHash: hashMemoryContent("word ".repeat(3000)), citations: cite(source) }])).toThrow("capacity");
});

test("engine passes the configured reasoning effort to the generator", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "continuity-distill-"));
  temporary.push(workspace);
  const scope = await storage.resolveScope({ workspace });
  const config = { workspace, settings: { model: "test/fake", intervalHours: 2.5, reasoning: "low" }, paths: {}, hashes: {}, hash: "config-low" };
  const source = { version: 1, sequence: 1, id: "reasoning-source", contentHash: hashMemoryContent("reasoning probe"),
    timestamp: new Date(start).toISOString(), workspace, storeId: scope.storeId, branchKey: scope.branchKey,
    section: "Progress", provenance: "test", plan: null, text: "reasoning probe", line: "- reasoning probe", config };
  await storage.withStore(scope, async () => {
    const state = Object.assign(storage.createBranchState(scope), { nextSequence: 2, pendingCount: 1, oldestPendingSequence: 1, firstPendingAt: new Date(start).toISOString(), nextEligibleAt: new Date(start).toISOString(),
      epoch: { revision: 1, workspace, snapshot: config, configHash: config.hash, anchor: new Date(start).toISOString() } })
    await storage.commit(scope, [
      { path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) },
      { path: `${scope.branchDir}/sources/000000000001.json`, content: JSON.stringify(source) },
      { path: `${scope.branchDir}/pending/000000000001.json`, content: JSON.stringify({ sequence: 1, id: source.id, contentHash: source.contentHash }) },
    ])
  })
  let seen
  const result = await runDistillation(scope, { manual: true, now: start + 9000000, generate: async (request) => { seen = request.reasoning; return empty } })
  expect(result.status).toBe("completed")
  expect(seen).toBe("low")
});

test("whole-source batching drains finite backlog at normal intervals", async () => {
  const { scope } = await fixture(12, "evidence ".repeat(400));
  let attempts = 0;
  let time = start;
  let pending = 12;
  while (pending) {
    const result = await runDistillation(scope, { manual: attempts === 0, now: time, generate: async ({ prompt, model, maxOutputTokens }) => {
      expect(model).toBe("test/fake");
      expect(maxOutputTokens).toBe(8000);
      expect(prompt).toContain("shared");
      return empty;
    } });
    expect(result.status).toBe("completed");
    const next = (await inspect(scope)).state.pendingCount;
    expect(next).toBeLessThan(pending);
    if (!attempts) expect(next).toBeGreaterThan(0);
    pending = next;
    attempts++;
    time += 9000000;
    expect(attempts).toBeLessThan(13);
  }
});

test("capacity failure leaves pending; corrected proposal resumes manually", async () => {
  const { scope, sources } = await fixture();
  const result = await runDistillation(scope, { manual: true, now: start, generate: async () => JSON.stringify({ checkpoint: [], proposals: [proposal(sources[0], { text: "fact ".repeat(2200) })] }) });
  expect(result.status).toBe("blocked");
  expect(result.error).toContain("capacity");
  expect((await inspect(scope)).state.pendingCount).toBe(1);
  expect((await runDistillation(scope, { manual: true, now: start + 1, generate: async () => empty })).status).toBe("completed");
});

test("owner refresh preserves anchor, uses frozen settings, and fences captured config", async () => {
  const { scope, config } = await fixture();
  const result = await runDistillation(scope, { manual: true, now: start, generate: async ({ model }) => {
    expect(model).toBe("test/fake");
    expect(await refreshEpoch(scope, { ...config, settings: { model: "test/new", intervalHours: 5 }, hash: "config-b" })).toBe(true);
    return empty;
  } });
  expect(result.status).toBe("blocked");
  const memory = await inspect(scope);
  expect(memory.state.pendingCount).toBe(1);
  expect(memory.state.epoch.anchor).toBe(new Date(start).toISOString());
  expect(memory.state.nextEligibleAt).toBe(new Date(start + 18000000).toISOString());
});

test("source hash mutation fences even checkpoint-only result", async () => {
  const { scope, sources } = await fixture();
  const result = await runDistillation(scope, { manual: true, now: start, generate: async () => {
    await storage.withStore(scope, () => writeFile(storage.sourcePath(scope, 1), JSON.stringify({ ...sources[0], text: "tampered" })));
    return JSON.stringify({ checkpoint: [{ text: "Checkpoint", citations: cite(sources[0]) }], proposals: [] });
  } });
  expect(result.status).toBe("blocked");
  expect(result.error).toContain("Source changed");
  expect((await inspect(scope)).state.pendingCount).toBe(1);
});

test("durable conflicts survive a later empty checkpoint rewrite", async () => {
  const { scope, sources } = await fixture();
  const baseline = { id: "stable", text: "Original", contentHash: hashMemoryContent("Original"), citations: cite(sources[0]) };
  await storage.withStore(scope, () => storage.commit(scope, [{ path: "shared.md", content: renderMemoryDocument("shared", [baseline]) }]));
  const first = await runDistillation(scope, { manual: true, now: start, generate: async () => JSON.stringify({ checkpoint: [], proposals: [proposal(sources[0], { operation: "conflict", targetId: baseline.id, priorHash: baseline.contentHash, classification: "changed", text: "Different assertion" })] }) });
  expect(first.status).toBe("completed");
  expect(first.reviewed).toBe(1);
  const conflict = (await inspect(scope)).conflicts[0];
  await storage.withStore(scope, async () => {
    const state = await storage.readState(scope);
    const source = { ...sources[0], sequence: 2, id: "source-2", text: "Later deliberate source", contentHash: hashMemoryContent("Later deliberate source") };
    state.nextSequence = 3;
    state.pendingCount = 1;
    state.oldestPendingSequence = 2;
    state.firstPendingAt = source.timestamp;
    await storage.commit(scope, [
      { path: `${scope.branchDir}/sources/000000000002.json`, content: JSON.stringify(source) },
      { path: `${scope.branchDir}/pending/000000000002.json`, content: JSON.stringify({ sequence: 2, id: source.id, contentHash: source.contentHash }) },
      { path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) },
    ]);
  });
  expect((await runDistillation(scope, { now: start + 9000000, generate: async () => empty })).status).toBe("completed");
  const after = await inspect(scope);
  expect(after.conflicts).toEqual([conflict]);
  expect(after.shared).toEqual([baseline]);
  expect(after.state.reviewedCount).toBe(2);
});

test("epoch refresh freezes originating global config path across runtimes", async () => {
  const { scope, config } = await fixture();
  await runDistillation(scope, { now: start });
  const original = { ...config, paths: { global: path.resolve(os.tmpdir(), "v1/continuity.jsonc") }, hash: "v1-root" };
  await storage.withStore(scope, async () => {
    const state = await storage.readState(scope);
    state.epoch.snapshot = original;
    state.epoch.configHash = original.hash;
    await storage.commit(scope, [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) }]);
  });
  const statePath = path.join(scope.storeRoot, scope.branchDir, "state.json");
  const before = await readFile(statePath, "utf8");
  const files = (await readdir(scope.storeRoot, { recursive: true })).filter((name) => !name.startsWith("transactions")).sort();
  expect(await refreshEpoch(scope, { ...original, paths: { global: path.resolve(os.tmpdir(), "v2/continuity.jsonc") }, settings: { model: "other/model", intervalHours: 1 }, hash: "v2-root" })).toBe(false);
  expect(await readFile(statePath, "utf8")).toBe(before);
  expect((await readdir(scope.storeRoot, { recursive: true })).filter((name) => !name.startsWith("transactions")).sort()).toEqual(files);
  expect(await refreshEpoch(scope, { ...original, settings: { ...original.settings, intervalHours: 5 }, hash: "v1-changed" })).toBe(true);
  const state = await storage.readState(scope);
  expect(state.epoch.snapshot.paths.global).toBe(original.paths.global);
  expect(state.epoch.snapshot.settings.intervalHours).toBe(5);
});

test("epoch refresh uses latest attempt anchor and retains longer error backoff", async () => {
  const { scope, config } = await fixture();
  await runDistillation(scope, { now: start });
  const attempt = new Date(start + 9000000).toISOString();
  const backoff = new Date(start + 36000000).toISOString();
  await storage.withStore(scope, async () => {
    const state = await storage.readState(scope);
    state.lastAttemptAt = attempt;
    state.nextEligibleAt = backoff;
    state.error = { message: "provider backoff", at: attempt };
    await storage.commit(scope, [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) }]);
  });
  await refreshEpoch(scope, { ...config, hash: "shorter-interval", settings: { ...config.settings, intervalHours: 1 } });
  let state = await storage.readState(scope);
  expect(state.epoch.anchor).toBe(attempt);
  expect(state.nextEligibleAt).toBe(backoff);
  await storage.withStore(scope, async () => {
    state.error = null;
    await storage.commit(scope, [{ path: `${scope.branchDir}/state.json`, content: JSON.stringify(state) }]);
  });
  await refreshEpoch(scope, { ...config, hash: "no-error", settings: { ...config.settings, intervalHours: 1 } });
  state = await storage.readState(scope);
  expect(state.nextEligibleAt).toBe(new Date(Date.parse(attempt) + 3600000).toISOString());
});

test("smaller model context selects fitting whole batch and advances oldest pending", async () => {
  const { scope, sources } = await fixture(3, "evidence ".repeat(400));
  let firstPrompt;
  const first = await runDistillation(scope, { manual: true, now: start, generate: async ({ prompt }) => { firstPrompt = prompt; return empty; } });
  expect(first.reviewed).toBe(3);
  const payload = JSON.parse(firstPrompt.slice(firstPrompt.indexOf("\n") + 1));
  payload.sources = [sources[0]];
  const oneSourceTokens = tokens(`${firstPrompt.slice(0, firstPrompt.indexOf("\n"))}\n${JSON.stringify(payload)}`);
  const second = await fixture(3, "evidence ".repeat(400));
  const modelContext = oneSourceTokens + 4000 + 100;
  const result = await runDistillation(second.scope, { manual: true, now: start, modelContext, generate: async ({ prompt }) => {
    expect(tokens(prompt) + 4000).toBeLessThanOrEqual(modelContext);
    const selected = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).sources;
    expect(selected.map((s) => s.sequence)).toEqual([1]);
    return empty;
  } });
  expect(result.status).toBe("completed");
  expect(result.reviewed).toBe(1);
  let state = await storage.readState(second.scope);
  expect(state.oldestPendingSequence).toBe(2);
  expect(state.pendingCount).toBe(2);
  // A historical pointer must not be reopened after the persisted lower bound advances.
  await writeFile(storage.pendingPath(second.scope, 1), "obsolete unreadable pointer");
  const next = await runDistillation(second.scope, { now: start + 9000000, modelContext, generate: async () => empty });
  expect(next.status).toBe("completed");
  expect(next.reviewed).toBe(1);
  state = await storage.readState(second.scope);
  expect(state.oldestPendingSequence).toBe(3);
  expect(state.pendingCount).toBe(1);
});
