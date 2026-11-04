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
import { fakeDevice, DEVICES } from "./device.mjs";

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
function stack(t, recipe, { env = {}, files = {}, cli = process.env } = {}) {
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
  const apps = (s, ...args) => script("run-apps.mjs", p.dir, [...args, "--run", s.id], cli);
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

test("two tickets of one run have their apps up at once, each worktree with a database and a record of its own, and down in one leaves the other's as they were", async (t) => {
  const p = stack(t, { ...WEB_API, db: { create: 'mkdir "$DBS/{name}"', drop: 'rmdir "$DBS/{name}"' } }, { files: { "web/.keep": "" } });
  const dbs = path.join(p.dir, ".dbs");
  fs.mkdirSync(dbs);
  fs.appendFileSync(path.join(p.dir, ".factory/env.local"), `DBS=${dbs}\n`);
  const s = p.start("Add a CSV export");
  const [one, two] = ["01", "02"].map((n) => {
    const wt = path.join(p.dir, ".factory/worktrees", `${s.id}-${n}`);
    fs.mkdirSync(path.join(s.run_dir, "tickets"), { recursive: true });
    fs.writeFileSync(path.join(s.run_dir, "tickets", `${n}-part.md`), `# ${n}: part\n\nStatus: in-progress\nBlocked by: none\n`);
    p.git("worktree", "add", "-q", "-b", `factory/${s.id}/${n}`, wt);
    return wt;
  });
  const apps = (wt, ...args) => script("run-apps.mjs", wt, [...args, "--run", s.id]);
  t.after(async () => { for (const wt of [one, two]) await apps(wt, "down"); });
  const urls = (r) => Object.fromEntries([...r.stdout.matchAll(/ (\w+)=(http\S+)/g)].map(([, name, url]) => [name, url]));
  const ups = [await apps(one, "up"), await apps(two, "up")];  // the second while the first's apps run
  for (const r of ups) assert.equal(r.status, 0, r.stdout + r.stderr);
  const [ua, ub] = ups.map(urls);
  assert.deepEqual(await Promise.all([ua.web, ua.api, ub.web, ub.api].map(answers)), [true, true, true, true], "a sibling ticket's up never stops a ticket's apps");
  const recorded = (n) => JSON.parse(fs.readFileSync(path.join(s.run_dir, "tickets", n, "apps.json"), "utf8"));
  const [ra, rb] = [recorded("01"), recorded("02")];
  assert.deepEqual([ra.apps.web.url, rb.apps.web.url], [ua.web, ub.web], "each worktree's record is beside its ticket's plan");
  assert.ok(!fs.existsSync(path.join(s.run_dir, "apps.json")), "and the run worktree's is untouched");
  for (const [wt, u] of [[one, ua], [two, ub]]) assert.equal((await get(u.web)).cwd, path.join(wt, "web"));
  assert.deepEqual([ra.db, rb.db], [`factory_${s.id.replaceAll("-", "_")}_01`, `factory_${s.id.replaceAll("-", "_")}_02`]);
  assert.deepEqual(fs.readdirSync(dbs).sort(), [ra.db, rb.db]);

  assert.equal((await apps(one, "down")).status, 0);
  assert.deepEqual(await Promise.all([ua.web, ua.api, ub.web, ub.api].map(answers)), [false, false, true, true], "down stops only its own worktree's apps");
  assert.deepEqual(recorded("02"), rb, "and leaves the sibling's record as it was");
  assert.deepEqual((await apps(two, "status")).stdout.trim().split("\n"), [`web up ${ub.web}`, `api up ${ub.api}`]);

  // A run that ends takes every ticket worktree's apps down with its own, and their databases with it.
  const rs = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, "run-state.mjs"), ...args, "--run", s.id], { cwd: p.dir, encoding: "utf8" });
  assert.equal(rs("abandon").status, 0);
  const r = rs("snapshot");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(s.worktree));
  assert.deepEqual(await Promise.all([ub.web, ub.api].map(answers)), [false, false]);
  assert.deepEqual(fs.readdirSync(dbs), []);
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

// A mobile app whose build makes the platform's .app or .apk and prints its path last, as a real build ends.
const BUILD = 'if [ "$FACTORY_PLATFORM" = ios ]; then mkdir -p build/Shop.app && echo compiled && echo build/Shop.app; '
  + "else mkdir -p build && touch build/shop.apk && echo compiled && echo build/shop.apk; fi";
const MOBILE = (fields = {}) => ({ name: "mobile", type: "mobile", path: "mobile", build: BUILD, app_id: "com.example.shop", checks: { test: "true" }, ...fields });
const DEV_SERVER = "node ../server.mjs {port:mobile}";
const until = async (ok, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); await new Promise((res) => setTimeout(res, 50))) if (Date.now() > end) throw new Error(`not so after ${ms} ms`);
};
// [the calls that match, the rest in order]: a device log's stream starts in the background, so its place among the
// other calls is the OS's to pick
const split = (calls, match) => [calls.filter(match), calls.filter((c) => !match(c))];
// A stack whose .factory/env.local records the platform's device, as setup does, with run-apps on a fake device.
function mobile(t, platform, recipe, { device } = {}) {
  const d = fakeDevice(t, device);
  const env = { ios: { FACTORY_IOS_DEVICE: DEVICES.ios.udid }, android: { FACTORY_ANDROID_DEVICE: DEVICES.android.avd } }[platform];
  return { ...stack(t, recipe, { env, files: { "mobile/.keep": "" }, cli: d.env }), d };
}

test("an iOS app: up boots the simulator only when it's down, builds, installs and launches by URL, healthy once in front; shot is 1x; down puts back the look it recorded and shuts down what it booted", async (t) => {
  const launch = "exp+shop://expo-development-client/?url=http%3A%2F%2Flocalhost%3A{port:mobile}";
  const p = mobile(t, "ios", { apps: [WEB_API.apps[1], MOBILE({ dev: DEV_SERVER, launch_url: launch })] });
  const s = p.start("Show the cart total"), udid = DEVICES.ios.udid;
  let r = await p.apps(s, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { apps, device } = p.recorded(s);
  const [streamed, sent] = split(p.d.calls("xcrun"), (c) => c[3] === "log");
  assert.deepEqual(sent, [
    ["simctl", "list", "devices", "-j"], ["simctl", "boot", udid], ["simctl", "bootstatus", udid],
    ["simctl", "ui", udid, "appearance"], ["simctl", "ui", udid, "content_size"],
    ["simctl", "install", udid, path.join(s.worktree, "mobile/build/Shop.app")],
    ["simctl", "openurl", udid, launch.replace("{port:mobile}", apps.mobile.port)],
    ["simctl", "spawn", udid, "launchctl", "list"],
  ]);
  assert.deepEqual(streamed, [["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--predicate", 'process == "Shop"']]);
  assert.deepEqual([p.d.calls("adb"), p.d.calls("emulator")], [[], []], "one platform per run");
  assert.deepEqual([device.platform, device.id, device.booted, device.settings], ["ios", udid, true, { appearance: "light", text_size: "large" }]);
  assert.equal(apps.mobile.ok, true);
  assert.match(r.stdout, new RegExp(`^run-apps up: profile=default api=${apps.api.url} mobile=up$`, "m"));
  assert.equal((await get(`http://localhost:${apps.mobile.port}/`)).cwd, path.join(s.worktree, "mobile"), "the dev server runs on {port:mobile}");
  assert.match(fs.readFileSync(apps.mobile.log, "utf8"), /^log stream /m, "the device's log streams to the app's log");
  assert.ok(alive(apps.mobile.stream));
  assert.equal((await p.apps(s, "status")).stdout.trim().split("\n").at(-1), "mobile up");

  r = await p.apps(s, "shot", "cart");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const shot = path.join(s.run_dir, "captures/cart.png");
  assert.equal(r.stdout.trim(), shot);
  assert.deepEqual(p.d.calls("sips"), [["--resampleWidth", "393", shot]], "1179 px at 3x is 393 points");
  assert.equal(fs.readFileSync(shot).readUInt32BE(16), 393);

  p.d.change("ios", { appearance: "dark", content_size: "accessibility-extra-extra-extra-large" });  // a capture's, say
  r = await p.apps(s, "down");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(p.d.calls("xcrun").slice(-3), [["simctl", "ui", udid, "appearance", "light"], ["simctl", "ui", udid, "content_size", "large"], ["simctl", "shutdown", udid]]);
  const after = p.d.state().ios;
  assert.deepEqual([after.booted, after.appearance, after.content_size], [false, "light", "large"], "the simulator is left as it was");
  assert.ok(!alive(apps.mobile.stream), "the log stream went down");
  assert.equal(p.recorded(s).device, undefined);
  assert.ok(!fs.existsSync(p.d.lock), "the device lock is released");
});

test("an Android app on an emulator already running: up keeps it running, sets its dp size at density 160, installs on every up, reverses every recorded port and launches by app id; down gives back the developer's own settings", async (t) => {
  const p = mobile(t, "android", { apps: [WEB_API.apps[1], MOBILE({ dev: DEV_SERVER })] },
    { device: { android: { booted: true, override_size: "900x2000", override_density: "300" } } });
  const s = p.start("Show the cart total"), S = ["-s", DEVICES.android.serial], before = p.d.state().android;
  let r = await p.apps(s, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { apps, device } = p.recorded(s);
  const [streamed, sent] = split(p.d.calls("adb"), (c) => c[2] === "logcat");
  assert.deepEqual(sent, [
    ["devices"], [...S, "emu", "avd", "name"],
    [...S, "shell", "wm", "size"], [...S, "shell", "wm", "density"], [...S, "shell", "cmd", "uimode", "night"], [...S, "shell", "settings", "get", "system", "font_scale"],
    [...S, "shell", "wm", "size", "480x1067"], [...S, "shell", "wm", "density", "160"],
    [...S, "install", "-r", path.join(s.worktree, "mobile/build/shop.apk")],
    [...S, "reverse", `tcp:${apps.api.port}`, `tcp:${apps.api.port}`], [...S, "reverse", `tcp:${apps.mobile.port}`, `tcp:${apps.mobile.port}`],
    [...S, "shell", "cmd", "package", "list", "packages", "-U", "'com.example.shop'"],
    [...S, "shell", "monkey", "-p", "'com.example.shop'", "-c", "android.intent.category.LAUNCHER", "1"],
    [...S, "shell", "dumpsys", "activity", "activities"],
  ]);
  assert.deepEqual(streamed, [[...S, "logcat", "-v", "threadtime", "-T", "1", "--uid=10123"]], "the app's own log, from now on");
  assert.deepEqual([p.d.calls("emulator"), p.d.calls("xcrun")], [[], []], "a running emulator is never booted again");
  assert.deepEqual([device.platform, device.booted, device.settings], ["android", false, { appearance: "no", text_size: "1.0", density: "300", size: "900x2000" }]);
  r = await p.apps(s, "shot", "cart");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(s.run_dir, "captures/cart.png")).readUInt32BE(16), 480, "already 1x at density 160");
  assert.deepEqual(p.d.calls("sips"), []);

  assert.equal((await p.apps(s, "up")).status, 0);
  assert.equal(p.d.calls("adb").filter((c) => c[2] === "install").length, 2, "built and installed on every up");
  const { stream } = p.recorded(s).apps.mobile;
  p.d.change("android", { night: "yes", font_scale: "1.3" });
  r = await p.apps(s, "down");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = p.d.state().android;
  for (const k of ["booted", "override_size", "override_density", "night", "font_scale", "reversed"]) assert.deepEqual(after[k], before[k], k);
  assert.ok(!p.d.calls("adb").some((c) => c.includes("kill")), "an emulator up didn't boot keeps running");
  assert.ok(!alive(stream));
});

test("an emulator up had to boot runs headless, and down resets its size and density and kills it", async (t) => {
  const p = mobile(t, "android", { apps: [MOBILE()] });
  const s = p.start("Show the cart total"), serial = DEVICES.android.serial;
  let r = await p.apps(s, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { device } = p.recorded(s), adb = () => p.d.calls("adb").map((c) => c.join(" "));
  assert.deepEqual(p.d.calls("emulator"), [["-avd", "Pixel_9", "-no-window"]]);
  for (const c of ["wait-for-device", "shell getprop sys.boot_completed", "shell wm size 411x914", "shell wm density 160"]) assert.ok(adb().includes(`-s ${serial} ${c}`), c);
  assert.deepEqual([device.booted, device.settings], [true, { appearance: "no", text_size: "1.0", density: null, size: null }]);
  assert.ok(alive(device.pid));
  r = await p.apps(s, "down");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(adb().slice(-5), ["shell wm size reset", "shell wm density reset", "shell cmd uimode night no", "shell settings put system font_scale 1.0", "emu kill"].map((c) => `-s ${serial} ${c}`));
  await until(() => !alive(device.pid));
  assert.deepEqual([p.d.state().android.booted, p.d.state().android.override_density], [false, null]);
});

test("look sets the device's scheme and text size for a capture, the largest text being the platform's own, and down puts back the developer's", async (t) => {
  const ios = mobile(t, "ios", { apps: [MOBILE()] }), a = ios.start("Show the cart total"), udid = DEVICES.ios.udid;
  let r = await ios.apps(a, "look", "dark", "largest");
  assert.deepEqual([r.status, r.stderr.trim()], [1, "run-apps: no device is up: run-apps up first"]);
  assert.equal((await ios.apps(a, "up")).status, 0);
  r = await ios.apps(a, "look", "dark", "largest");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(ios.d.calls("xcrun").slice(-2), [["simctl", "ui", udid, "appearance", "dark"], ["simctl", "ui", udid, "content_size", "accessibility-extra-extra-extra-large"]]);
  assert.equal((await ios.apps(a, "look", "light", "default")).status, 0);
  assert.deepEqual([ios.d.state().ios.appearance, ios.d.state().ios.content_size], ["light", "large"], "the default text size, not the developer's");
  assert.equal((await ios.apps(a, "look", "dusk", "default")).status, 2);

  for (const [sdk, largest] of [["35", "2.0"], ["33", "1.3"]]) {
    const droid = mobile(t, "android", { apps: [MOBILE()] }, { device: { android: { booted: true, sdk, night: "yes", font_scale: "1.15" } } }), b = droid.start("Show the cart total");
    assert.equal((await droid.apps(b, "up")).status, 0);
    assert.equal((await droid.apps(b, "look", "dark", "largest")).status, 0);
    assert.deepEqual([droid.d.state().android.night, droid.d.state().android.font_scale], ["yes", largest], `Android ${sdk}'s largest font scale`);
    assert.equal((await droid.apps(b, "look", "light", "default")).status, 0);
    assert.deepEqual([droid.d.state().android.night, droid.d.state().android.font_scale], ["no", "1.0"]);
    assert.equal((await droid.apps(b, "down")).status, 0);
    assert.deepEqual([droid.d.state().android.night, droid.d.state().android.font_scale], ["yes", "1.15"], "the developer's own look is back");
  }
});

test("every simulator and emulator is behind one machine-wide lock from up to down, which a holder that died with the device's settings unrestored keeps", async (t) => {
  const d = fakeDevice(t, { ios: { booted: true } });
  const two = () => stack(t, { apps: [MOBILE()] }, { env: { FACTORY_IOS_DEVICE: DEVICES.ios.udid }, files: { "mobile/.keep": "" }, cli: d.env });
  const [p, q] = [two(), two()];
  const [a, b] = [p.start("Show the cart total"), q.start("Show the cart total")];
  assert.equal(a.id, b.id, "two projects' runs can share an id");
  let r = await p.apps(a, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { up: waiting } = await waits(q, b);
  assert.equal((await p.apps(a, "down")).status, 0);
  r = await waiting;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.split("\n").includes(`run-apps: waiting for the device lock, held by run ${a.id} (${path.join(a.run_dir, "apps.json")})`), r.stdout);
  // b's processes die without a down, as in a crash, leaving the simulator's look recorded but not restored.
  const { stream } = q.recorded(b).apps.mobile;
  process.kill(-stream, "SIGKILL");
  await until(() => !alive(stream));
  const { up: again } = await waits(p, a);
  assert.equal((await q.apps(b, "down")).status, 0, "b's down, or its reconcile, restores it and releases the lock");
  assert.equal((await again).status, 0);
  assert.equal((await p.apps(a, "down")).status, 0);
  assert.ok(!fs.existsSync(d.lock));
});

test("a mobile build runs under the device lock, and one that fails fails up with its digest before the device is touched", async (t) => {
  const p = mobile(t, "ios", { apps: [MOBILE({ build: "echo 'error: no such module ExpoModulesCore'; exit 65" })] });
  const s = p.start("Show the cart total"), log = path.join(s.run_dir, "logs/mobile.build.log");
  fs.writeFileSync(p.d.lock, JSON.stringify({ run: "other", apps: "/elsewhere/apps.json", pids: [process.pid] }));  // another run's qa, say
  const { up } = await waits(p, s, 700);
  assert.ok(!fs.existsSync(log), "no build while another run holds the device");
  fs.rmSync(p.d.lock);
  const r = await up;
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`^--- mobile build exited 65\nerror: no such module ExpoModulesCore\nrun-apps: mobile build exited 65\nfull output: ${log}$`, "m"));
  assert.deepEqual([p.d.calls("xcrun"), p.recorded(s).apps.mobile.ok], [[], false]);
  assert.equal((await p.apps(s, "down")).status, 0);
  assert.ok(!fs.existsSync(p.d.lock), "down releases it");
});

test("a mobile app with no device in .factory/env.local is skipped, and a project without a mobile app never touches a device", async (t) => {
  const d = fakeDevice(t);
  const p = stack(t, { apps: [WEB_API.apps[1], MOBILE()] }, { files: { "mobile/.keep": "" }, cli: d.env });
  const s = p.start("Show the cart total");
  let r = await p.apps(s, "up");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^run-apps up: profile=default api=\S+ mobile=skip$/m);
  assert.match(r.stdout, /^run-apps: mobile skipped: no device in \.factory\/env\.local \(FACTORY_IOS_DEVICE or FACTORY_ANDROID_DEVICE\)$/m);
  r = await p.apps(s, "shot", "cart");
  assert.deepEqual([r.status, r.stderr.trim()], [1, "run-apps: no device is up: run-apps up first"]);
  assert.equal((await p.apps(s, "down")).status, 0);
  const w = stack(t, WEB_API, { files: { "web/.keep": "" }, cli: d.env }), ws = w.start("Add a CSV export");
  for (const cmd of ["up", "status", "down"]) assert.equal((await w.apps(ws, cmd)).status, 0, cmd);
  for (const cli of ["xcrun", "adb", "emulator", "maestro", "sips"]) assert.deepEqual(d.calls(cli), [], cli);
  assert.ok(!fs.existsSync(d.lock), "no device lock");
  assert.ok(!("device" in w.recorded(ws)));
});
