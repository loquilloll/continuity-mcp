// @ts-nocheck -- ported from upstream bun:test suites; runtime-verified under node:test, kept close to upstream for syncs
// Real Bun processes exercise the same lock and recovery path as independent runtimes.
import { test } from "node:test"
import { expect } from "./expect.ts"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveScope, withStore, commit, readJson } from "../src/storage.js"

const storageURL = new URL("../src/storage.js", import.meta.url).href
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await pause(20) }
  throw new Error(`Timed out waiting for ${label}`)
}
async function exists(file) { try { await fs.access(file); return true } catch (e) { if (e.code === "ENOENT") return false; throw e } }

const worker = `
import fs from "node:fs/promises";
import path from "node:path";
import { resolveScope, withStore, commit, readText } from ${JSON.stringify(storageURL)};
const [root, mode, id] = process.argv.slice(2);
const scope = await resolveScope({workspace:root});
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const mark = name => fs.writeFile(path.join(root,name), "ready");
const exists = async name => {try {await fs.access(path.join(root,name));return true} catch(e) {if(e.code==="ENOENT")return false;throw e}};
const wait = async name => {const end=Date.now()+30000; while(!await exists(name)){if(Date.now()>end)throw new Error("gate timeout: "+name);await pause(20)}};
const snapshot = async () => withStore(scope, async () => {
  const a=await readText(path.join(scope.storeRoot,"a.md"));
  await pause(5);
  const b=await readText(path.join(scope.storeRoot,"b.md"));
  if(a!==b)throw new Error("mixed snapshot: "+a+"/"+b);
  return Number(a);
}, {timeoutMs:30000});
if(mode==="writer") {
  await mark("ready-"+id); await wait("go");
  for(let i=0;i<4;i++) await withStore(scope,async()=>{
    const old=Number(await readText(path.join(scope.storeRoot,"a.md")));
    await pause(25);
    await commit(scope,[{path:"a.md",content:String(old+1)},{path:"b.md",content:String(old+1)}]);
  },{timeoutMs:30000});
  await mark("done-"+id);
} else if(mode==="reader") {
  await mark("ready-reader"); await wait("go");
  let count=0;
  do {await snapshot();count++} while(!await exists("done-1") || !await exists("done-2") || count<2);
  console.log(JSON.stringify({count,final:await snapshot()}));
} else if(mode==="crash") {
  await withStore(scope,async()=>{
    try {await commit(scope,[{path:"a.md",content:"1"},{path:"b.md",content:"1"}],{failAfter:1})}
    catch(e){if(!e.message.includes("Injected"))throw e}
    await mark("prepared");
    await new Promise(()=>{setInterval(()=>{},1000)});
  });
} else if(mode==="once") {
  await mark("reader-started");
  console.log(JSON.stringify({value:await snapshot()}));
} else if(mode==="guard-crash") {
  const rename=fs.rename;
  fs.rename=async(source,destination)=>{
    await rename(source,destination);
    if(destination===path.join(scope.storeRoot,".lock.recovery")) {
      await mark("guard-acquired");
      await new Promise(()=>{setInterval(()=>{},1000)});
    }
  };
  await withStore(scope,()=>{throw new Error("must die holding recovery guard")});
} else if(mode==="blocked") {
  const start=Date.now();let entered=false;
  try {await withStore(scope,()=>{entered=true},{timeoutMs:250});throw new Error("unexpected acquisition")}
  catch(e){if(!e.message.includes("Store lock unavailable"))throw e}
  console.log(JSON.stringify({entered,elapsed:Date.now()-start}));
}
`

async function fixture(run) {
  const parent = path.join(os.tmpdir(), "opencode")
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, "continuity-process-")), children = []
  try {
    const script = path.join(root, "worker.mjs")
    await fs.writeFile(script, worker)
    const scope = await resolveScope({ workspace: root })
    const spawnWorker = (mode, id = "") => {
      // mcp: node port — Bun.spawn → node spawn; streams collected via data handlers.
      const child = spawn(process.execPath, [script, root, mode, id], { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = "", stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      const result = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })))
      const entry = { child, result }
      children.push(entry)
      return entry
    }
    const finish = async entry => {
      let output
      await waitFor(async () => { if (entry.child.exitCode !== null) { output = await entry.result; return true } return false }, "worker completion", 40000)
      if (output.code !== 0) throw new Error(`Worker exited ${output.code}: ${output.stderr}\n${output.stdout}`)
      return output.stdout.trim() ? JSON.parse(output.stdout.trim()) : null
    }
    await run({ root, scope, spawn: spawnWorker, finish })
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL")
    await Promise.all(children.map(entry => entry.result))
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("two real writers lose no read-modify-write updates; concurrent reader never sees mixed files", () => fixture(async ({ root, scope, spawn, finish }) => {
  await withStore(scope, () => commit(scope, [{ path: "a.md", content: "0" }, { path: "b.md", content: "0" }]))
  const first = spawn("writer", "1"), second = spawn("writer", "2"), reader = spawn("reader")
  await waitFor(async () => (await Promise.all(["ready-1", "ready-2", "ready-reader"].map(name => exists(path.join(root, name))))).every(Boolean), "all worker gates")
  await fs.writeFile(path.join(root, "go"), "go")
  const [, , observations] = await Promise.all([finish(first), finish(second), finish(reader)])
  expect(observations.count).toBeGreaterThanOrEqual(2)
  expect(observations.final).toBe(8)
}), 60000)
test("killed recovery-guard owner is reclaimed; live guard remains fenced", () => fixture(async ({ root, scope, spawn, finish }) => {
  await withStore(scope, () => commit(scope, [{ path: "a.md", content: "0" }, { path: "b.md", content: "0" }]))
  const lock = path.join(scope.storeRoot, ".lock"), guard = `${lock}.recovery`
  await fs.mkdir(lock)
  await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ token: "dead-main-owner", pid: 2147483647, processStart: "dead" }))
  const owner = spawn("guard-crash")
  await waitFor(() => exists(path.join(root, "guard-acquired")), "guard acquisition")
  const guardOwner = await readJson(path.join(guard, "owner.json"))
  expect(guardOwner.pid).toBe(owner.child.pid)
  expect((await finish(spawn("blocked"))).entered).toBe(false)
  expect((await readJson(path.join(guard, "owner.json"))).token).toBe(guardOwner.token)
  owner.child.kill("SIGKILL"); await owner.result
  expect((await finish(spawn("once"))).value).toBe(0)
  expect(await exists(guard)).toBe(false)
  expect((await readJson(path.join(`${guard}.stale-${guardOwner.token}`, "owner.json"))).token).toBe(guardOwner.token)
}), 60000)

test("killed lock owner leaves prepared transaction; next process recovers before reading", () => fixture(async ({ root, scope, spawn, finish }) => {
  await withStore(scope, () => commit(scope, [{ path: "a.md", content: "0" }, { path: "b.md", content: "0" }]))
  const owner = spawn("crash")
  await waitFor(() => exists(path.join(root, "prepared")), "prepared transaction")
  const ownership = await readJson(path.join(scope.storeRoot, ".lock/owner.json"))
  expect(ownership.pid).toBe(owner.child.pid)
  expect(await fs.readFile(path.join(scope.storeRoot, "a.md"), "utf8")).toBe("1")
  expect(await fs.readFile(path.join(scope.storeRoot, "b.md"), "utf8")).toBe("0")
  const reader = spawn("once")
  await waitFor(() => exists(path.join(root, "reader-started")), "reader launch")
  owner.child.kill("SIGKILL")
  await owner.result
  expect((await finish(reader)).value).toBe(1)
  expect(await exists(path.join(scope.storeRoot, ".lock"))).toBe(false)
}), 60000)

test("fresh process refuses malformed and ownerless locks with bounded timeout", () => fixture(async ({ scope, spawn, finish }) => {
  const lock = path.join(scope.storeRoot, ".lock")
  await fs.mkdir(lock, { recursive: true })
  for (const malformed of [false, true]) {
    if (malformed) await fs.writeFile(path.join(lock, "owner.json"), '{"pid":')
    const result = await finish(spawn("blocked"))
    expect(result.entered).toBe(false)
    expect(result.elapsed).toBeGreaterThanOrEqual(250)
    expect(result.elapsed).toBeLessThan(15000)
    expect(await exists(lock)).toBe(true)
  }
}), 60000)
