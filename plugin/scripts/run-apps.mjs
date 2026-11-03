#!/usr/bin/env node
// run-apps.mjs up [--profile <name>] | down [--drop] | status — starts the run worktree's apps on ports of its own, with
// a database of its own when the recipe can make one, without touching a sibling worktree or the developer's shell.
// Takes --run <id>, or derives the run from the run worktree it runs in.
//   - up starts each app in .factory/setup.json that has a `dev` command, under bash in its path, in a process group of
//     its own. Its env is lib's runEnv, then the `default` profile's env for it, then the named profile's; a profile
//     that sets the app to null leaves it stopped. Each app gets a port the OS picks, and {port:<app>} in a dev command,
//     a health URL or an env value is that port; {db} is the worktree's database. An app is healthy once its health URL
//     answers, within 2 minutes; one without a health URL fails. Its output is saved to logs/<app>.up.log, and a failing
//     one prints lib's digest of it.
//   - An app whose dev command and env take no {port:<app>} keeps its health URL's port; up refuses it while another
//     process holds that port.
//   - With the recipe's db.create and db.drop, the worktree's database is factory_<run>, given to them as {name}: up
//     creates it once, under the per-project lock so creates run one at a time, and `down --drop` drops it, as the run's
//     snapshot does before it removes the worktree. A `db` without the pair is one database every worktree's apps
//     share, so they hold the per-project lock from up to down; so do apps that include one keeping its own port. up
//     waits up to 10 minutes for the lock, and takes over one whose holder's processes are all gone.
//   - down kills each app's process group, then whatever still listens on a port it recorded (listeners only: a browser
//     connected to it is never killed), and releases the lock.
//   - apps.json in the run dir holds the profile, the database and each app's port, url, pid and ok (true, false or
//     "skip"), never an env value: it's snapshotted into the repo. status prints each app in it as up, down or skip.
// up exits 0 when every app it started is healthy, 1 when one isn't or the database or the lock failed it; down exits 1
// when the drop failed; both exit 2 on bad usage.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readJson, arg, worktreesDir, runContext, runEnv, digest, fill } from "./lib.mjs";

const cmd = process.argv[2];
if (!["up", "down", "status"].includes(cmd)) {
  console.error("run-apps: usage: run-apps.mjs up [--profile <name>] | down [--drop] | status [--run <id>]"); process.exit(2);
}
const ctx = runContext();
let recipe; try { recipe = JSON.parse(fs.readFileSync(path.join(ctx.worktree, ".factory/setup.json"), "utf8")); } catch (e) {
  console.error(`run-apps: no recipe at ${path.join(ctx.worktree, ".factory/setup.json")} (${e.message})`); process.exit(2);
}
const FILE = path.join(ctx.runDir, "apps.json"), logs = path.join(ctx.runDir, "logs"), LOCK = path.join(worktreesDir(ctx.MAIN), ".apps.lock");
const pair = recipe.db?.create && recipe.db?.drop;
const record = readJson(FILE, { apps: {} });  // apps.json
const save = () => fs.writeFileSync(FILE, JSON.stringify(record, null, 2) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const answers = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => { r.body?.cancel(); return true; }, () => false);
// n ports the OS picks, each held until the last is picked, so no two are the same.
// ponytail: a port is free when picked, not reserved; another bind can take it before the app does. Hand the app a
// listening socket if that ever bites.
async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const s = net.createServer().on("error", reject).listen(0, () => resolve(s));
  })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}
const portOf = (url) => { try { const u = new URL(url); return Number(u.port) || (u.protocol === "https:" ? 443 : 80); } catch { return null; } };
const inUse = (port) => new Promise((resolve) => {
  const s = net.connect(port, "localhost").on("connect", () => { s.destroy(); resolve(true); }).on("error", () => resolve(false));
});

// TERM, then KILL what's left after 5 seconds; returns once every pid (a negative one is a process group) is gone, or
// 2 seconds after the KILL.
async function stop(pids) {
  for (const [sig, ms] of [["SIGTERM", 5000], ["SIGKILL", 2000]]) {
    for (const p of pids) try { process.kill(p, sig); } catch {}
    for (const end = Date.now() + ms; pids.some(alive) && Date.now() < end;) await sleep(50);
  }
}

// The per-project lock: a file naming the run that holds it and the pids keeping it (a negative one is a process
// group). A lock whose pids are all gone was left by a crash, and is taken over.
// ponytail: two worktrees taking over the same dead lock at once can both get it; compare-and-swap the takeover if that bites.
async function lock() {
  for (let said = false, end = Date.now() + 10 * 60_000; ; await sleep(250)) {
    try { fs.writeFileSync(LOCK, JSON.stringify({ run: ctx.id, pids: [process.pid] }), { flag: "wx" }); return; } catch (e) { if (e.code !== "EEXIST") throw e; }
    const held = readJson(LOCK);
    if (held && !held.pids.some(alive)) { fs.rmSync(LOCK, { force: true }); continue; }
    if (Date.now() > end) { console.log(`run-apps: run ${held?.run} still holds the per-project lock after 10 minutes`); process.exit(1); }
    if (!said) { console.log(`run-apps: waiting for the per-project lock, held by run ${held?.run}`); said = true; }
  }
}
const unlock = () => { if (readJson(LOCK)?.run === ctx.id) fs.rmSync(LOCK, { force: true }); };

// Runs db.create or db.drop at the worktree's root for its database, the output saved to logs/db-<step>.log.
function db(step, name) {
  fs.mkdirSync(logs, { recursive: true });
  const log = path.join(logs, `db-${step}.log`), fd = fs.openSync(log, "w");
  const r = spawnSync("bash", ["-c", recipe.db[step].replaceAll("{name}", name)], { cwd: ctx.worktree, env: runEnv(ctx.MAIN), stdio: ["ignore", fd, fd], timeout: 10 * 60_000 });
  fs.closeSync(fd);
  if (r.status !== 0) console.log(`--- db.${step} failed\n${digest(fs.readFileSync(log, "utf8"), log)}`);
  return r.status === 0;
}

// The pids listening on a port: lsof's, else ss's where lsof is missing (Linux).
function listeners(port) {
  const lsof = spawnSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (!lsof.error) return lsof.stdout.split("\n").filter(Boolean).map(Number);
  const ss = spawnSync("ss", ["-Hltnp", "sport", "=", `:${port}`], { encoding: "utf8" });
  return [...(ss.stdout || "").matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
}

// A port is freed only while its app's group still lives: once the app is gone, the OS may have handed its port to a
// sibling worktree's app.
// ponytail: a recorded pid reused since (after a reboot) is killed, and a listener that outlived its app's whole group
// is left running; record start times if either ever bites.
async function down() {
  const started = Object.values(record.apps).filter((a) => a.pid), live = started.filter((a) => a.port && alive(-a.pid));
  await stop(started.map((a) => -a.pid));
  await stop(live.flatMap((a) => listeners(a.port)));
  record.apps = {};
  delete record.profile;
  unlock();
  if (fs.existsSync(FILE)) save();
}

async function up(profile) {
  const profiles = recipe.profiles || {};
  if (profile !== "default" && !Object.hasOwn(profiles, profile)) { console.error(`run-apps: no profile ${profile} in the recipe`); process.exit(2); }
  await down();
  fs.mkdirSync(logs, { recursive: true });
  const envOf = (a) => ({ ...(profile !== "default" && profiles.default?.[a.name]), ...profiles[profile]?.[a.name] });
  const all = (recipe.apps || []).filter((a) => a.dev);
  const fixed = all.filter((a) => !JSON.stringify([a.dev, envOf(a)]).includes(`{port:${a.name}}`));
  const ports = await freePorts(all.length - fixed.length);
  for (const a of all) record.apps[a.name] = { port: fixed.includes(a) ? portOf(a.health) : ports.pop() };
  const apps = all.filter((a) => profiles[profile]?.[a.name] !== null);
  for (const a of all) if (!apps.includes(a)) record.apps[a.name].ok = "skip";
  record.profile = profile;
  const holdLock = apps.length > 0 && ((recipe.db && !pair) || apps.some((a) => fixed.includes(a)));
  if (holdLock || (pair && !record.db)) await lock();
  if (pair && !record.db) {
    const name = `factory_${ctx.id.replaceAll("-", "_")}`;
    if (!db("create", name)) { unlock(); process.exit(1); }
    record.db = name;
  }
  if (!holdLock) unlock();
  const failed = {}, exits = {};
  for (const a of apps) {
    const app = Object.assign(record.apps[a.name], { url: a.health ? fill(a.health, record) : null, ok: false });
    if (fixed.includes(a) && app.port && await inUse(app.port)) { failed[a.name] = `port ${app.port} is already in use`; continue; }
    const log = path.join(logs, `${a.name.replace(/[^\w.-]/g, "_")}.up.log`), fd = fs.openSync(log, "w");
    const env = Object.fromEntries(Object.entries(runEnv(ctx.MAIN, envOf(a))).filter(([, v]) => v != null).map(([k, v]) => [k, fill(String(v), record)]));
    const child = spawn("bash", ["-c", fill(a.dev, record)], { cwd: path.join(ctx.worktree, a.path || "."), env, detached: true, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
    child.on("exit", (code, signal) => { exits[a.name] = code ?? signal; });
    Object.assign(app, { pid: child.pid, log });
  }
  save();  // the pids first, so a crash mid-wait can still be brought down
  const started = apps.map((a) => record.apps[a.name]).filter((a) => a.pid);
  if (holdLock) fs.writeFileSync(LOCK, JSON.stringify({ run: ctx.id, pids: [process.pid, ...started.map((a) => -a.pid)] }));
  await Promise.all(apps.filter((a) => record.apps[a.name].pid).map(async (a) => {
    const app = record.apps[a.name];
    for (const end = Date.now() + 120_000; app.url && !(a.name in exits) && Date.now() < end; await sleep(200)) {
      if (await answers(app.url)) { app.ok = true; return; }
    }
    failed[a.name] = !app.url ? "has no health URL in the recipe" : a.name in exits ? `exited ${exits[a.name]}` : `didn't answer at ${app.url} in 120s`;
  }));
  save();
  console.log(`run-apps up: profile=${profile} ${Object.entries(record.apps).map(([n, a]) => `${n}=${a.ok === true ? a.url : a.ok || "failed"}`).join(" ")}`);
  for (const [name, reason] of Object.entries(failed)) {
    const { log } = record.apps[name];
    if (log) fs.appendFileSync(log, `run-apps: ${name} ${reason}\n`);
    console.log(`--- ${name} ${reason}${log ? `\n${digest(fs.readFileSync(log, "utf8"), log)}` : ""}`);
  }
  process.exit(Object.keys(failed).length ? 1 : 0);
}

if (cmd === "up") await up(arg("--profile", "default"));
else if (cmd === "down") {
  await down();
  if (process.argv.includes("--drop") && record.db) {
    if (!recipe.db?.drop) { console.log(`run-apps: no db.drop in the recipe, so ${record.db} is kept`); process.exit(1); }
    if (!db("drop", record.db)) process.exit(1);
    delete record.db;
    save();
  }
  console.log("run-apps down");
}
else {
  const apps = Object.entries(record.apps);
  if (!apps.length) console.log("no apps up");
  for (const [name, a] of apps) console.log(`${name} ${a.ok === "skip" ? "skip" : a.url && await answers(a.url) ? "up" : "down"}${a.url ? ` ${a.url}` : ""}`);
}
