#!/usr/bin/env node
// run-apps.mjs up [--profile <name>] | down | status   [--run <id>]
// Starts every app in .factory/setup.json with `preview.local.<app>.command`, from the project root, and waits for its `url`
// (wait_seconds, default 60). An app's environment is the recipe's (PATH/HOME/TMPDIR plus .factory/env.local), then the
// `default` profile, then the named one; PORT is the url's port unless a profile sets it; `{run}` in a value is the run
// directory; a profile that sets an app to null leaves it stopped.
// Each app runs in its own process group, so `down` stops the whole tree (pnpm -> node -> vite) and then frees each app's port
// for anything that escaped the group (lsof, or fuser where lsof is missing). Listening sockets only: a browser connected
// to the port is never killed.
// Writes <run>/apps.json { profile, apps: { <name>: { url, ok, pid, profile_env } }, logs, started_at }. env.local values are
// never written there: apps.json is snapshotted into the repo.
// Prints: APPS profile=<p> <app>=<true|false|skip> ...   exit 1 when an app that should be up is not.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runContext, runEnv, arg, readJson } from "./lib.mjs";

const { ROOT, MAIN, RUN } = runContext();
const setup = JSON.parse(fs.readFileSync(path.join(ROOT, ".factory/setup.json"), "utf8"));
const local = setup.preview?.local || {};
const appsFile = path.join(RUN, "apps.json");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isUp = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const portOf = (url) => { try { const u = new URL(url); return Number(u.port) || (u.protocol === "https:" ? 443 : 80); } catch { return null; } };
const listeners = (port) => {
  const r = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (r.error) { spawnSync("fuser", ["-k", "-TERM", `${port}/tcp`], { stdio: "ignore" }); return []; }  // no lsof: fuser kills itself
  return (r.stdout || "").split("\n").filter(Boolean).map(Number);
};
const kill = (pid, sig) => { try { process.kill(pid, sig); } catch {} };

async function down() {
  const groups = Object.values(readJson(appsFile, {}).apps || {}).map(a => a.pid).filter(Boolean);
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    for (const pgid of groups) kill(-pgid, sig);
    for (const app of Object.values(local)) { const p = portOf(app.url); if (p) for (const pid of listeners(p)) kill(pid, sig); }
    await sleep(500);
  }
}

async function up(profile) {
  const profiles = setup.profiles || {};
  if (profile !== "default" && !(profile in profiles)) { console.log(`APPS error: unknown profile ${profile}`); process.exit(3); }
  await down();
  const logs = path.join(RUN, "app-logs");
  fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(path.join(RUN, "profile-data"), { recursive: true });
  const out = { profile, apps: {}, logs, started_at: new Date().toISOString() };
  for (const app of setup.apps || []) {
    const l = local[app.name];
    const over = profile === "default" ? {} : profiles[profile]?.[app.name];
    if (!l?.command || over === null) { out.apps[app.name] = { url: l?.url || null, ok: "skip" }; continue; }
    const profileEnv = Object.fromEntries(Object.entries({ ...(profiles.default?.[app.name] || {}), ...(over || {}) })
      .map(([k, v]) => [k, String(v).replaceAll("{run}", RUN)]));
    const fd = fs.openSync(path.join(logs, `${app.name}.log`), "w");
    const child = spawn("bash", ["-c", l.command], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
      env: runEnv(MAIN, { NODE_ENV: "development", PORT: String(portOf(l.url) || ""), ...profileEnv }) });
    child.unref(); fs.closeSync(fd);
    out.apps[app.name] = { url: l.url, ok: false, pid: child.pid, profile_env: profileEnv, wait: (l.wait_seconds || 60) * 1000 };
  }
  fs.writeFileSync(appsFile, JSON.stringify(out, null, 2) + "\n");  // pids first, so a crash mid-wait can still be brought down
  await Promise.all(Object.values(out.apps).filter(a => a.pid).map(async (a) => {
    for (const end = Date.now() + a.wait; Date.now() < end; await sleep(500)) if (await isUp(a.url)) { a.ok = true; return; }
  }));
  for (const a of Object.values(out.apps)) delete a.wait;
  fs.writeFileSync(appsFile, JSON.stringify(out, null, 2) + "\n");
  console.log(`APPS profile=${profile} ` + Object.entries(out.apps).map(([k, a]) => `${k}=${a.ok}`).join(" "));
  process.exit(Object.values(out.apps).some(a => a.ok === false) ? 1 : 0);
}

const cmd = process.argv[2] || "status";
if (cmd === "up") await up(arg("--profile", "default"));
else if (cmd === "down") { await down(); console.log("APPS down"); }
else if (cmd === "status") for (const [name, l] of Object.entries(local)) console.log(`${name} ${(await isUp(l.url)) ? "up" : "down"}`);
else { console.error("usage: run-apps.mjs up [--profile <name>] | down | status [--run <id>]"); process.exit(2); }
