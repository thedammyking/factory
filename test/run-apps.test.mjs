// run-apps.test.mjs — run-apps.mjs spawned as a process against runs on a throwaway project whose apps are stubs: tiny
// node HTTP servers listening on the port they're given.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, STUB_SERVER } from "./harness.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts");
const script = (name, cwd, args, env = process.env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(SCRIPTS, name), ...args], { cwd, env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
const get = (url) => fetch(url).then((r) => r.json());
const answers = (url) => fetch(url).then(() => true, () => false);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Stands for a package manager's wrapper: the server it starts is its child, or with "detached" escapes its process group.
const WRAPPER = `import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
spawn(process.execPath, [fileURLToPath(new URL("server.mjs", import.meta.url)), process.argv[2]], { stdio: "inherit", detached: process.argv[3] === "detached" });
setInterval(() => fs.existsSync(process.env.ALIVE) || process.exit(), 100);
`;

// A project whose main commit holds `recipe`, the stub server and `files`, with `env` and ALIVE (the file every stub
// lives by) in .factory/env.local. start() begins a run; apps(s, ...args) runs run-apps.mjs for it. After the test,
// pass or fail, every run's apps are brought down and ALIVE goes, so no stub outlives it.
function stack(t, recipe, { env = {}, files = {} } = {}) {
  const p = project({ recipe });
  for (const [f, text] of Object.entries({ "server.mjs": STUB_SERVER, ...files })) {
    fs.mkdirSync(path.dirname(path.join(p.dir, f)), { recursive: true });
    fs.writeFileSync(path.join(p.dir, f), text);
  }
  p.git("add", "."); p.git("commit", "-qm", "stub apps");
  const alive = path.join(p.dir, ".alive");
  fs.writeFileSync(alive, "");
  fs.writeFileSync(path.join(p.dir, ".factory/env.local"), Object.entries({ ALIVE: alive, ...env }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const runs = [];
  const apps = (s, ...args) => script("run-apps.mjs", p.dir, [...args, "--run", s.id]);
  t.after(async () => {
    for (const s of runs) await apps(s, "down");
    fs.rmSync(alive, { force: true });
  });
  const start = (request) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "run-state.mjs"), "init"], { cwd: p.dir, input: request, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    runs.push(JSON.parse(r.stdout));
    return runs.at(-1);
  };
  const recorded = (s) => JSON.parse(fs.readFileSync(path.join(s.run_dir, "apps.json"), "utf8"));
  return { ...p, start, apps, recorded };
}

const WEB_API = {
  apps: [
    { name: "web", type: "web", path: "web", dev: "node ../server.mjs {port:web}", health: "http://localhost:{port:web}/", checks: { test: "true" } },
    { name: "api", type: "backend", path: ".", dev: "PORT={port:api} node server.mjs", health: "http://localhost:{port:api}/health", checks: { test: "true" } },
  ],
};

test("two worktrees' apps run at once, each on ports of its own, recorded in apps.json and filled into commands, URLs and env", async (t) => {
  const p = stack(t, WEB_API, { env: { API_URL: "http://localhost:{port:api}/v1" }, files: { "web/.keep": "" } });
  const [a, b] = [p.start("Add a CSV export"), p.start("Fix the login crash")];
  const ups = await Promise.all([a, b].map((s) => script("run-apps.mjs", p.dir, ["up", "--run", s.id], { ...process.env, DEVELOPER_ONLY: "from my shell" })));
  for (const r of ups) assert.equal(r.status, 0, r.stdout + r.stderr);
  const [ra, rb] = [p.recorded(a), p.recorded(b)];
  const ports = [ra, rb].flatMap((r) => [r.apps.web.port, r.apps.api.port]);
  assert.ok(ports.every(Number.isInteger));
  assert.equal(new Set(ports).size, 4, "no two apps share a port");
  for (const [s, r] of [[a, ra], [b, rb]]) {
    assert.equal(r.apps.web.url, `http://localhost:${r.apps.web.port}/`);
    const web = await get(r.apps.web.url);
    assert.equal(web.cwd, path.join(s.worktree, "web"), "an app runs in its path in its own worktree");
    assert.deepEqual(web.argv, [String(r.apps.web.port)]);
    assert.equal(web.env.API_URL, `http://localhost:${r.apps.api.port}/v1`, "a web app reaches its own worktree's API");
    assert.ok(!("DEVELOPER_ONLY" in web.env), "the developer's shell never reaches an app");
    assert.equal((await get(r.apps.api.url)).env.PORT, String(r.apps.api.port));
  }
  assert.match(ups[0].stdout, new RegExp(`^run-apps up: profile=default web=${ra.apps.web.url} api=${ra.apps.api.url}$`, "m"));
  assert.deepEqual((await p.apps(a, "status")).stdout.trim().split("\n"), [`web up ${ra.apps.web.url}`, `api up ${ra.apps.api.url}`]);
  assert.equal((await p.apps(a, "down")).status, 0);
  assert.deepEqual([await answers(ra.apps.web.url), await answers(ra.apps.api.url)], [false, false]);
  assert.deepEqual([await answers(rb.apps.web.url), await answers(rb.apps.api.url)], [true, true], "a sibling worktree's apps keep running");
  assert.equal((await p.apps(a, "status")).stdout.trim(), "no apps up");
});

test("fix 4: a profile's env goes over .factory/env.local's and `app: null` leaves an app stopped; down kills each app's process group, then frees only the ports it recorded, listeners only", async (t) => {
  const p = stack(t, {
    apps: [
      { name: "web", path: ".", dev: "node wrapper.mjs {port:web}", health: "http://localhost:{port:web}/", checks: { test: "true" } },
      { name: "api", path: ".", dev: "node wrapper.mjs {port:api} detached", health: "http://localhost:{port:api}/", checks: { test: "true" } },
    ],
    profiles: { default: { web: { MODE: "default", FLAG: "on" } }, "api-down": { web: { MODE: "api-down" }, api: null } },
  }, { env: { MODE: "from env.local", LIMIT: "5" }, files: { "wrapper.mjs": WRAPPER } });
  const s = p.start("Rate limit the export");
  let r = await p.apps(s, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const first = p.recorded(s);
  const web = await get(first.apps.web.url), api = await get(first.apps.api.url);
  assert.deepEqual([web.env.MODE, web.env.FLAG, web.env.LIMIT], ["default", "on", "5"]);
  assert.notEqual(web.pid, first.apps.web.pid, "the server is the wrapper's child, as under pnpm");
  // A bystander: a server of its own, and a client holding a connection to the web app's port.
  const bystander = spawn(process.execPath, ["-e", `const s = require("node:http").createServer((q, res) => res.end("mine")).listen(0, () =>
    require("node:net").connect(${first.apps.web.port}, () => console.log(s.address().port)).on("error", () => {}));`]);
  t.after(() => bystander.kill());
  const port = Number(await new Promise((resolve) => bystander.stdout.once("data", resolve)));

  r = await p.apps(s, "up", "--profile", "api-down");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const second = p.recorded(s);
  assert.match(r.stdout, /^run-apps up: profile=api-down web=\S+ api=skip$/m);
  assert.deepEqual([second.profile, second.apps.api.ok], ["api-down", "skip"]);
  assert.ok(!("pid" in second.apps.api), "a skipped app has no process to record");
  const restarted = await get(second.apps.web.url);
  assert.deepEqual([restarted.env.MODE, restarted.env.FLAG], ["api-down", "on"], "the named profile goes over the default one");
  for (const pid of [first.apps.web.pid, web.pid, first.apps.api.pid]) assert.ok(!alive(pid), `${pid}: the group went down whole`);
  assert.ok(!alive(api.pid), "the server that escaped its group went with the port it held");
  assert.equal(await answers(first.apps.api.url), false);
  assert.ok(alive(bystander.pid), "a client connected to a recorded port is never killed");
  assert.ok(await answers(`http://localhost:${port}/`), "nor is a server on a port nobody recorded");

  r = await p.apps(s, "up", "--profile", "no-such");
  assert.deepEqual([r.status, r.stderr.trim()], [2, "run-apps: no profile no-such in the recipe"]);
  assert.ok(await answers(second.apps.web.url), "an unknown profile leaves the apps as they were");
  assert.equal((await p.apps(s, "down")).status, 0);
  assert.ok(!alive(restarted.pid));
  assert.ok(alive(bystander.pid));
});

test("with db.create and db.drop each worktree gets its own database, created once and one at a time, and dropped with its worktree", async (t) => {
  // A create that overlaps another fails on the .creating marker the first one holds.
  const p = stack(t, { apps: [WEB_API.apps[1]], db: {
    create: 'mkdir "$DBS/.creating" && sleep 0.3 && mkdir "$DBS/{name}" && rmdir "$DBS/.creating"',
    drop: 'rmdir "$DBS/{name}"',
  } }, { env: { DATABASE_URL: "postgres://localhost:5432/{db}" } });
  const dbs = path.join(p.dir, ".dbs");
  fs.mkdirSync(dbs);
  fs.appendFileSync(path.join(p.dir, ".factory/env.local"), `DBS=${dbs}\n`);
  const [a, b] = [p.start("Add a CSV export"), p.start("Fix the login crash")];
  for (const r of await Promise.all([a, b].map((s) => p.apps(s, "up")))) assert.equal(r.status, 0, r.stdout + r.stderr);
  const [ra, rb] = [p.recorded(a), p.recorded(b)];
  assert.deepEqual(fs.readdirSync(dbs).sort(), [ra.db, rb.db].sort(), "two databases, made one after the other");
  for (const r of [ra, rb]) assert.equal((await get(r.apps.api.url)).env.DATABASE_URL, `postgres://localhost:5432/${r.db}`);
  let r = await p.apps(a, "up");
  assert.equal(r.status, 0, `a worktree's database is created once: ${r.stdout}`);
  assert.equal((await p.apps(a, "down")).status, 0);
  assert.ok(fs.existsSync(path.join(dbs, ra.db)), "down keeps the database");

  const rs = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, "run-state.mjs"), ...args, "--run", a.id], { cwd: p.dir, encoding: "utf8" });
  assert.equal(rs("set", "stage", "delivered").status, 0);
  r = rs("snapshot");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(a.worktree));
  assert.deepEqual(fs.readdirSync(dbs), [rb.db], "the database went with its worktree, and only that one");
  // A worktree git won't remove keeps its database too.
  fs.writeFileSync(path.join(b.worktree, "notes.txt"), "work in progress\n");
  const rsb = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, "run-state.mjs"), ...args, "--run", b.id], { cwd: p.dir, encoding: "utf8" });
  assert.equal(rsb("set", "stage", "delivered").status, 0);
  assert.match(rsb("snapshot").stdout, /worktree kept/);
  assert.deepEqual(fs.readdirSync(dbs), [rb.db]);
  assert.equal(await answers(rb.apps.api.url), false, "its apps went down all the same");
  r = await p.apps(b, "down", "--drop");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(dbs), []);
  assert.equal(p.recorded(b).db, undefined);
});

// An up for s that hasn't settled after `ms` is waiting; resolves to { up }, the up's own promise.
async function waits(p, s, ms = 1000) {
  let settled = false;
  const up = p.apps(s, "up").then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, ms));
  assert.equal(settled, false, `${s.id} waits for the lock`);
  return { up };
}

test("a db without the pair is one database the worktrees share, so their apps hold the per-project lock from up to down, and a lock whose apps are all gone is taken over", async (t) => {
  const p = stack(t, { ...WEB_API, db: {} }, { files: { "web/.keep": "" } });
  const [a, b] = [p.start("Add a CSV export"), p.start("Fix the login crash")];
  let r = await p.apps(a, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { up: waiting } = await waits(p, b);
  assert.equal((await p.apps(a, "down")).status, 0);
  r = await waiting;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^run-apps: waiting for the per-project lock, held by run ${a.id}$`, "m"));
  // b's apps die without a down, as in a crash.
  const groups = Object.values(p.recorded(b).apps).map((x) => -x.pid);
  for (const g of groups) process.kill(g, "SIGKILL");
  while (groups.some(alive)) await new Promise((res) => setTimeout(res, 50));
  r = await p.apps(a, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /waiting/, "a lock its holder's apps all left is free");
  assert.equal((await p.apps(b, "down")).status, 0);
  const { up: again } = await waits(p, b, 700);
  assert.equal((await p.apps(a, "down")).status, 0, "b's down never releases a lock a took over");
  assert.equal((await again).status, 0);
});

test("an app whose port can't be set from outside keeps its health URL's port under the per-project lock, and up refuses that port when another process holds it", async (t) => {
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const p = stack(t, { apps: [
    { name: "api", path: ".", dev: `node server.mjs ${port}`, health: `http://localhost:${port}/`, checks: { test: "true" } },
    { name: "worker", path: ".", dev: "node server.mjs", health: "http://localhost:{port:worker}/", checks: { test: "true" } },
  ], profiles: { default: { worker: { PORT: "{port:worker}" } } } });
  const [a, b] = [p.start("Add a CSV export"), p.start("Fix the login crash")];
  const other = net.createServer().listen(port);
  t.after(() => other.close());
  await new Promise((res) => other.once("listening", res));
  let r = await p.apps(a, "up");
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`^--- api port ${port} is already in use$`, "m"));
  assert.equal((await p.apps(a, "down")).status, 0);
  assert.ok(other.listening, "a port held by someone else is never freed");
  await new Promise((res) => other.close(res));

  r = await p.apps(a, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { api, worker } = p.recorded(a).apps;
  assert.equal(api.port, port);
  assert.notEqual(worker.port, port, "an app given {port:<app>} through its env gets a port of its own");
  assert.equal((await get(worker.url)).env.PORT, String(worker.port));
  const { up: waiting } = await waits(p, b);
  assert.equal((await p.apps(a, "down")).status, 0);
  r = await waiting;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((await get(`http://localhost:${port}/`)).cwd, b.worktree);
});

test("an app that doesn't come up fails up, its full output saved and its digest printed", async (t) => {
  const crash = "for (let i = 0; i < 100; i++) console.log(`compiling ${i}`);\nconsole.error('Error: connect ECONNREFUSED 127.0.0.1:5432');\nprocess.exit(1);\n";
  const p = stack(t, { apps: [
    { name: "api", path: ".", dev: "node crash.mjs {port:api}", health: "http://localhost:{port:api}/", checks: { test: "true" } },
    { name: "worker", path: ".", dev: "node server.mjs {port:worker}", checks: { test: "true" } },
    WEB_API.apps[0],
  ] }, { files: { "crash.mjs": crash, "web/.keep": "" } });
  const s = p.start("Add a CSV export");
  const r = await p.apps(s, "up");
  assert.equal(r.status, 1);
  const { apps } = p.recorded(s);
  assert.deepEqual([apps.api.ok, apps.worker.ok, apps.web.ok], [false, false, true]);
  const full = fs.readFileSync(apps.api.log, "utf8").trimEnd().split("\n");
  assert.equal(full.length, 102, "every line the app wrote, then why it failed");
  assert.deepEqual(full.slice(-2), ["Error: connect ECONNREFUSED 127.0.0.1:5432", "run-apps: api exited 1"]);
  const digest = r.stdout.split("--- api exited 1\n")[1].split("\n--- ")[0].trimEnd().split("\n");
  assert.ok(digest.length <= 40, `${digest.length} lines`);
  assert.deepEqual(digest.slice(-3), ["Error: connect ECONNREFUSED 127.0.0.1:5432", "run-apps: api exited 1", `full output: ${apps.api.log}`]);
  assert.match(r.stdout, /^--- worker has no health URL in the recipe$/m);
  assert.ok(await answers(apps.web.url), "an app that did come up stays up for down to stop");
});
