#!/usr/bin/env node
// run-apps.mjs up [--profile <name>] [--skip <app,…>] | down [--drop] | status | shot <name> | look <light|dark> <default|largest> —
// starts the run worktree's apps on ports of its own, with a database of its own when the recipe can make one, without
// touching a sibling worktree or the developer's shell, and leaves the developer's device as it found it.
// Takes --run <id>, or derives the run from the run worktree it runs in. Run in a ticket's worktree, it starts that
// worktree's apps instead, and keeps its apps.json, logs and captures in tickets/<NN>/ in the run dir (lib's out).
//   - up starts each app in .factory/setup.json that has a `dev` command, under bash in its path, in a process group of
//     its own. Its env is lib's runEnv, then the `default` profile's env for it, then the named profile's; a profile
//     that sets the app to null leaves it stopped, as does --skip naming it (verify's, for a mobile app no pinned test
//     of its needs, which then never builds or takes the device). Each app gets a port the OS picks, and {port:<app>}
//     in a dev command, a health URL or an env value is that port; {db} is the worktree's database. An app is healthy
//     once its health URL answers, within 2 minutes; one without a health URL fails. Its output is saved to
//     logs/<app>.up.log, and a failing one prints lib's digest of it.
//   - An app whose dev command and env take no {port:<app>} keeps its health URL's port; up refuses it while another
//     process holds that port.
//   - With the recipe's db.create and db.drop, the worktree's database is factory_<run>, or factory_<run>_<NN> in a
//     ticket's, given to them as {name}: up creates it once, under the per-project lock so creates run one at a time,
//     and `down --drop` drops it, as a ticket's merge and the run's snapshot do before they remove a worktree. A `db`
//     without the pair is one database every worktree's apps share, so they hold the per-project lock from up to down;
//     so do apps that include one keeping its own port. up waits up to 10 minutes for the lock, and takes over one
//     whose holder's processes are all gone.
//   - A mobile app (type mobile) goes on the one device lib's device() picks from .factory/env.local, behind one lock in
//     the OS's temp dir that every simulator and emulator on the machine shares, held from up to down and waited for up
//     to 30 minutes, so one worktree at a time has the device; with no device recorded it's "skip". Its optional dev
//     server starts like any app's. Once the other apps are up, up takes the lock and runs its `build` in its path, with
//     FACTORY_PLATFORM ios or android (its dev server gets it too): the build's last line is the .app or .apk it made,
//     its output saved to logs/<app>.build.log. The last build of each app and platform is kept beside the worktrees and
//     installed in place of another while nothing it's made from has changed (buildKey), so a verify that brings the
//     app up for one flow doesn't rebuild it. up then boots the device only if it isn't running (simctl boot;
//     emulator -no-window), and records its appearance and text size, and on Android its density and size, in apps.json
//     before it changes anything. Android then gets wm size at the screen's size in dp and wm density 160, so its
//     screencap is 1x, and adb reverse for every recorded port. up installs the app over what's there, streams the
//     device's log for it to logs/<app>.device.log, and launches it by its launch_url, else its app_id: it's healthy
//     once in the foreground, within 2 minutes.
//   - down kills each app's process group, then whatever still listens on a port it recorded (listeners only: a browser
//     connected to it is never killed), and releases the lock. It puts back every device setting up recorded and
//     shuts down only a device up booted; a step that fails keeps the record and the device lock for the next down
//     or the run's reconcile. A device lock whose holder died is taken over only once that holder's device is restored.
//   - shot <name> writes captures/<name>.png in out at 1x and prints its path: simctl io's image resampled by sips to
//     the point width on iOS, screencap's as it comes at density 160 on Android.
//   - look <scheme> <text> sets the device up holds to light or dark and to the default or the largest text size, for
//     capture-states; down puts back what up recorded.
//   - apps.json in out holds the profile, the database, each app's port, url, pid and ok (true, false or "skip"), and
//     the device's id and settings, never another env value: it's snapshotted into the repo. status prints each app in
//     it as up, down or skip. Each worktree reads and writes only its own, so down stops only what its up started.
// up exits 0 when every app it started is healthy, 1 when one isn't or the database or a lock failed it; down exits 1
// when the drop failed or the device isn't restored; shot and look exit 1 without a device up; all exit 2 on bad usage.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readJson, arg, git, worktreesDir, runContext, runEnv, digest, fill, device, cli, NO_DEVICE } from "./lib.mjs";

const cmd = process.argv[2];
if (!["up", "down", "status", "shot", "look"].includes(cmd) || (cmd === "shot" && !/^[\w-]+$/.test(process.argv[3] ?? ""))
  || (cmd === "look" && !(["light", "dark"].includes(process.argv[3]) && ["default", "largest"].includes(process.argv[4])))) {
  console.error("run-apps: usage: run-apps.mjs up [--profile <name>] [--skip <app,…>] | down [--drop] | status | shot <name> | look <light|dark> <default|largest> [--run <id>]"); process.exit(2);
}
const ctx = runContext();
let recipe; try { recipe = JSON.parse(fs.readFileSync(path.join(ctx.tree, ".factory/setup.json"), "utf8")); } catch (e) {
  console.error(`run-apps: no recipe at ${path.join(ctx.tree, ".factory/setup.json")} (${e.message})`); process.exit(2);
}
const FILE = path.join(ctx.out, "apps.json"), logs = path.join(ctx.out, "logs"), LOCK = path.join(worktreesDir(ctx.MAIN), ".apps.lock");
// ponytail: the OS's temp dir is per user and per TMPDIR, so a session whose TMPDIR differs takes a lock of its own;
// put it under the home dir if two such sessions ever share a device.
const DEVICE_LOCK = path.join(os.tmpdir(), "factory-device.lock");
const pair = recipe.db?.create && recipe.db?.drop;
const record = readJson(FILE, { apps: {} });  // apps.json
const save = () => fs.writeFileSync(FILE, JSON.stringify(record, null, 2) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const answers = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => { r.body?.cancel(); return true; }, () => false);
const logOf = (a, kind) => path.join(logs, `${a.name.replace(/[^\w.-]/g, "_")}.${kind}.log`);  // logs/<app>.<kind>.log
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

// The per-project lock, and the device's: a file naming the run that holds it, its apps.json, which no other run's
// shares on the machine, and the pids keeping it (a negative one is a process group). A lock whose pids are all gone
// was left by a crash, and is taken over, unless it's the device's and the settings its holder recorded wait there.
// ponytail: two worktrees taking over the same dead lock at once can both get it; compare-and-swap the takeover if that bites.
async function lock(file = LOCK, what = "per-project", minutes = 10) {
  for (let said = false, end = Date.now() + minutes * 60_000; ; await sleep(250)) {
    try { fs.writeFileSync(file, JSON.stringify({ run: ctx.id, apps: FILE, pids: [process.pid] }), { flag: "wx" }); return; } catch (e) { if (e.code !== "EEXIST") throw e; }
    const held = readJson(file);
    if (held && !held.pids.some(alive) && !(file === DEVICE_LOCK && readJson(held.apps)?.device)) { fs.rmSync(file, { force: true }); continue; }
    // the device's holder may be another project's run, so it's named by its apps.json too
    const by = `run ${held?.run}${file === DEVICE_LOCK ? ` (${held?.apps})` : ""}`;
    if (Date.now() > end) { console.log(`run-apps: ${by} still holds the ${what} lock after ${minutes} minutes`); process.exit(1); }
    if (!said) { console.log(`run-apps: waiting for the ${what} lock, held by ${by}`); said = true; }
  }
}
const unlock = (file = LOCK) => { if (readJson(file)?.apps === FILE) fs.rmSync(file, { force: true }); };

// Runs db.create or db.drop at the worktree's root for its database, the output saved to logs/db-<step>.log.
function db(step, name) {
  fs.mkdirSync(logs, { recursive: true });
  const log = path.join(logs, `db-${step}.log`), fd = fs.openSync(log, "w");
  const r = spawnSync("bash", ["-c", recipe.db[step].replaceAll("{name}", name)], { cwd: ctx.tree, env: runEnv(ctx.MAIN), stdio: ["ignore", fd, fd], timeout: 10 * 60_000 });
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

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;  // for the device's shell, which adb shell's args reach as one line

// Each platform's device commands, on d, apps.json's device record: the platform, the id .factory/env.local names, and
// what up found (iOS: the udid; Android: the serial, and the emulator's pid when up booted it). record keeps the
// settings to give back in d.settings, saved before anything changes.
const sim = (...a) => cli("xcrun", "simctl", ...a);
const adb = (d, ...a) => cli("adb", "-s", d.serial, ...a), shell = (d, ...a) => adb(d, "shell", ...a);
const PLATFORMS = {
  ios: {
    find(d) {
      const found = Object.values(JSON.parse(sim("list", "devices", "-j")).devices).flat().find((x) => x.udid === d.id || x.name === d.id);
      if (!found) throw new Error(`no simulator ${d.id}: set FACTORY_IOS_DEVICE in .factory/env.local to one that \`xcrun simctl list devices\` shows`);
      return { udid: found.udid, running: found.state === "Booted" };
    },
    async boot(d) { sim("boot", d.udid); d.booted = true; save(); sim("bootstatus", d.udid); },
    record(d) {
      const appearance = sim("ui", d.udid, "appearance"), text_size = sim("ui", d.udid, "content_size");
      if (!appearance || !text_size) throw new Error(`can't read ${d.udid}'s appearance or content size`);
      d.settings = { appearance, text_size };
      save();
    },
    reverse() {},  // the simulator shares the Mac's localhost
    install: (d, built) => sim("install", d.udid, built),
    // ponytail: the app's process is named for its bundle, as Xcode names it; read CFBundleExecutable if one isn't.
    logs: (d, a, built) => ["xcrun", ["simctl", "spawn", d.udid, "log", "stream", "--style", "compact", "--predicate", `process == "${path.basename(built, ".app")}"`]],
    launch: (d, a, url) => url ? sim("openurl", d.udid, url) : sim("launch", d.udid, a.app_id),
    // ponytail: running stands for in front, as the app up just launched; read the frontmost app if a flow ever leaves it behind.
    front: (d, a) => sim("spawn", d.udid, "launchctl", "list").split("\n").some((l) => /^\d+\t/.test(l) && l.includes(`\tUIKitApplication:${a.app_id}[`)),
    restore(d) { if (d.settings) { sim("ui", d.udid, "appearance", d.settings.appearance); sim("ui", d.udid, "content_size", d.settings.text_size); } },
    // large is iOS's default size; the largest is the last of the accessibility sizes
    look(d, scheme, text) { sim("ui", d.udid, "appearance", scheme); sim("ui", d.udid, "content_size", text === "largest" ? "accessibility-extra-extra-extra-large" : "large"); },
    async shutdown(d) { sim("shutdown", d.udid); },
    shot(d, file) {
      sim("io", d.udid, "screenshot", file);
      const scale = Number(sim("getenv", d.udid, "SIMULATOR_MAINSCREEN_SCALE"));
      cli("sips", "--resampleWidth", String(Math.round(fs.readFileSync(file).readUInt32BE(16) / scale)), file);  // a PNG's width is at byte 16
    },
  },
  android: {
    find(d) {
      const serials = cli("adb", "devices").split("\n").map((l) => l.match(/^(emulator-\d+)\tdevice$/)?.[1]).filter(Boolean);
      const serial = serials.find((s) => cli("adb", "-s", s, "emu", "avd", "name").split("\n")[0].trim() === d.id);
      return { serial, running: !!serial };
    },
    async boot(d) {
      const log = path.join(logs, "emulator.log"), fd = fs.openSync(log, "w");
      const child = spawn("emulator", ["-avd", d.id, "-no-window"], { detached: true, stdio: ["ignore", fd, fd] });
      fs.closeSync(fd);
      let gone; child.on("error", (e) => { gone = e.message; }).on("exit", (code) => { gone ??= `exited ${code}`; });
      await sleep(0);
      if (!child.pid) throw new Error(`emulator -avd ${d.id}: ${gone}`);
      Object.assign(d, { booted: true, pid: child.pid }); save();
      for (const end = Date.now() + 5 * 60_000; !(d.serial = this.find(d).serial); await sleep(250)) {
        if (gone || Date.now() > end) throw new Error(`emulator -avd ${d.id} ${gone || "didn't reach adb devices in 5 minutes"}: see ${log}`);
      }
      adb(d, "wait-for-device");
      for (const end = Date.now() + 5 * 60_000; shell(d, "getprop", "sys.boot_completed") !== "1"; await sleep(1000)) {
        if (Date.now() > end) throw new Error(`${d.serial} didn't finish booting in 5 minutes: see ${log}`);
      }
    },
    // What's kept is each setting as the developer had it: their own wm override, else null for a reset. Then the
    // screen keeps its dp size at density 160 (docs/platform-facts.md, facts 15 and 16).
    record(d) {
      const size = shell(d, "wm", "size"), density = shell(d, "wm", "density");
      const night = shell(d, "cmd", "uimode", "night").match(/Night mode: (\S+)/)?.[1], font = shell(d, "settings", "get", "system", "font_scale");
      const over = (text, k) => text.match(new RegExp(`Override ${k}: (\\S+)`))?.[1] ?? null;
      const now = (text, k) => over(text, k) ?? text.match(new RegExp(`Physical ${k}: (\\S+)`))?.[1];
      // a setting it can't read back is one down couldn't give back, so nothing is changed
      if (!night || !font || !now(size, "size") || !now(density, "density")) throw new Error(`can't read ${d.serial}'s settings: ${[size, density, night, font].join("; ")}`);
      d.settings = { appearance: night, text_size: font === "null" ? null : font, density: over(density, "density"), size: over(size, "size") };
      save();
      const dpi = Number(now(density, "density"));
      shell(d, "wm", "size", now(size, "size").split("x").map((px) => Math.round(px * 160 / dpi)).join("x"));
      shell(d, "wm", "density", "160");
    },
    reverse(d, ports) { for (const p of ports) { adb(d, "reverse", `tcp:${p}`, `tcp:${p}`); (d.reversed ||= []).push(p); save(); } },
    install: (d, built) => adb(d, "install", "-r", built),
    logs(d, a) {
      const uid = shell(d, "cmd", "package", "list", "packages", "-U", quote(a.app_id)).split("\n").find((l) => l.startsWith(`package:${a.app_id} `))?.match(/uid:(\d+)/)?.[1];
      if (!uid) throw new Error(`${a.app_id} isn't installed on ${d.serial}: is app_id the build's package name?`);
      return ["adb", ["-s", d.serial, "logcat", "-v", "threadtime", "-T", "1", `--uid=${uid}`]];
    },
    launch: (d, a, url) => url ? shell(d, "am", "start", "-a", "android.intent.action.VIEW", "-d", quote(url))
      : shell(d, "monkey", "-p", quote(a.app_id), "-c", "android.intent.category.LAUNCHER", "1"),
    front: (d, a) => shell(d, "dumpsys", "activity", "activities").split("\n").some((l) => l.includes("ResumedActivity") && l.includes(` ${a.app_id}/`)),
    restore(d) {
      // a reversed port the emulator lost already is no reason to keep the record
      for (const p of d.reversed || []) spawnSync("adb", ["-s", d.serial, "reverse", "--remove", `tcp:${p}`]);
      const s = d.settings;
      if (!s) return;
      shell(d, "wm", "size", s.size ?? "reset");
      shell(d, "wm", "density", s.density ?? "reset");
      shell(d, "cmd", "uimode", "night", s.appearance);
      if (s.text_size === null) shell(d, "settings", "delete", "system", "font_scale"); else shell(d, "settings", "put", "system", "font_scale", s.text_size);
    },
    // the largest font scale Settings offers: 200% since Android 14 (API 34), 130% before
    look(d, scheme, text) {
      shell(d, "cmd", "uimode", "night", scheme === "dark" ? "yes" : "no");
      shell(d, "settings", "put", "system", "font_scale", text === "default" ? "1.0" : Number(shell(d, "getprop", "ro.build.version.sdk")) >= 34 ? "2.0" : "1.3");
    },
    async shutdown(d) { if (d.serial) adb(d, "emu", "kill"); await stop([-d.pid]); },
    shot(d, file) {
      const r = spawnSync("adb", ["-s", d.serial, "exec-out", "screencap", "-p"], { maxBuffer: 1 << 28 });
      if (r.status !== 0) throw new Error(`adb -s ${d.serial} exec-out screencap -p: ${String(r.error?.message || r.stderr).trim()}`);
      fs.writeFileSync(file, r.stdout);
    },
  },
};

// The device up used, given back: its reversed ports removed, the settings it recorded put back, shut down if up
// booted it, and its lock released. A step that fails keeps the record and the lock, and returns false.
// ponytail: a device the developer shut down mid-run can't be given its settings back until it runs again; boot it
// for the restore if that ever bites.
async function release() {
  const d = record.device;
  if (d) try {
    PLATFORMS[d.platform].restore(d);
    delete d.reversed;
    if (d.booted) await PLATFORMS[d.platform].shutdown(d);
    delete record.device;
  } catch (e) {
    console.log(`run-apps: ${d.id} isn't given back its settings yet: ${e.message}\nrun-apps down again once it runs`);
    return false;
  }
  unlock(DEVICE_LOCK);
  return true;
}

// A port is freed only while its app's group still lives: once the app is gone, the OS may have handed its port to a
// sibling worktree's app.
// ponytail: a recorded pid reused since (after a reboot) is killed, and a listener that outlived its app's whole group
// is left running; record start times if either ever bites.
async function down() {
  const started = Object.values(record.apps).filter((a) => a.pid), live = started.filter((a) => a.port && alive(-a.pid));
  const streams = Object.values(record.apps).filter((a) => a.stream).map((a) => -a.stream);  // device logs
  await stop([...started.map((a) => -a.pid), ...streams]);
  await stop(live.flatMap((a) => listeners(a.port)));
  record.apps = {};
  delete record.profile;
  unlock();
  const given = await release();
  if (fs.existsSync(FILE)) save();
  return given;
}

// What a mobile build is made from (#81), as a key, or null when it can't be told: every file of HEAD but the other
// apps', the pinned tests' and .factory/'s, with the platform, the build command, the app's profile env and env.local.
// A worktree with uncommitted changes, or a build or env that takes a port or the database, always builds.
function buildKey(a, platform) {
  const prof = recipe.profiles || {}, env = { ...(record.profile !== "default" && prof.default?.[a.name]), ...prof[record.profile]?.[a.name] };
  if (/\{(port:[^}]+|db)\}/.test(JSON.stringify([a.build, env]))) return null;
  try {
    if (git(ctx.tree, "status", "--porcelain", "--untracked-files=no")) return null;
    const dir = (p) => `${p.replace(/\/+$/, "")}/`, own = dir(a.path || ".");
    const skip = [...(recipe.apps || []).filter((x) => x !== a && x.path && x.path !== "." && !own.startsWith(dir(x.path))).map((x) => dir(x.path)),
      ...(recipe.pinned || []).map(dir), ".factory/"];
    const files = git(ctx.tree, "ls-tree", "-r", "HEAD").split("\n").filter((l) => !skip.some((s) => (l.split("\t")[1] ?? "").startsWith(s)));
    let local = ""; try { local = fs.readFileSync(path.join(ctx.MAIN, ".factory", "env.local"), "utf8"); } catch {}
    return crypto.createHash("sha256").update([platform, a.build, JSON.stringify(env), local, ...files].join("\n")).digest("hex").slice(0, 16);
  } catch { return null; }
}
// The mobile branch, after the other apps are up, all under the device lock: each mobile app built, then the device
// booted if it isn't running, its settings recorded, each app installed, the recorded ports reversed, and each app's
// log streamed before it's launched, until it's in front. A step that fails fails every mobile app not up yet. The last
// build of each app and platform is kept beside the worktrees, shared by every run, and installed again in place of a
// build while its buildKey holds (#81): a native build is minutes a verify would spend on every ticket.
async function onDevice(mobiles, target, envFor, failed, exits) {
  await lock(DEVICE_LOCK, "device", 30);
  const built = {}, served = {};  // the .app or .apk each build made; each dev server's log
  for (const a of mobiles) {
    const app = record.apps[a.name], cwd = path.join(ctx.tree, a.path || ".");
    served[a.name] = app.log;
    if (!a.build) { failed[a.name] = "has no build in the recipe"; continue; }
    const log = logOf(a, "build"), key = buildKey(a, target.platform), cache = path.join(worktreesDir(ctx.MAIN), ".builds", `${a.name}-${target.platform}`);
    const kept = key && readJson(path.join(cache, "build.json"));
    if (kept?.key === key && fs.existsSync(kept.file)) {
      fs.writeFileSync(log, `reused the build of ${key}: ${kept.file}\n`);
      app.log = log; built[a.name] = kept.file;
      continue;
    }
    const fd = fs.openSync(log, "w");
    const r = spawnSync("bash", ["-c", fill(a.build, record)], { cwd, env: envFor(a), stdio: ["ignore", fd, fd], timeout: 30 * 60_000 });
    fs.closeSync(fd);
    app.log = log;
    const last = fs.readFileSync(log, "utf8").trim().split("\n").at(-1).trim(), file = last && path.resolve(cwd, last);
    if (r.status !== 0) failed[a.name] = `build ${r.error ? r.error.message : `exited ${r.status ?? r.signal}`}`;
    else if (!file || !fs.existsSync(file)) failed[a.name] = "build's last line is no .app or .apk it made";
    else {
      built[a.name] = file;
      if (key) try {
        fs.rmSync(cache, { recursive: true, force: true });
        const copy = path.join(cache, "artifact", path.basename(file));
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.cpSync(file, copy, { recursive: true });
        fs.writeFileSync(path.join(cache, "build.json"), JSON.stringify({ key, file: copy, at: new Date().toISOString() }) + "\n");
      } catch {}  // a build that can't be kept is made again next time
    }
  }
  const ready = mobiles.filter((a) => built[a.name]);
  if (!ready.length) return;
  const d = record.device = { platform: target.platform, id: target.id, booted: false }, P = PLATFORMS[d.platform];
  save();
  try {
    const { running, ...found } = P.find(d);
    Object.assign(d, found);
    if (!running) await P.boot(d);
    P.record(d);
    for (const a of ready) P.install(d, built[a.name]);
    P.reverse(d, [...new Set(Object.values(record.apps).map((a) => a.port).filter(Boolean))]);
    for (const a of ready) {
      const [bin, args] = P.logs(d, a, built[a.name]), log = logOf(a, "device"), fd = fs.openSync(log, "w");
      const stream = spawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] }).on("error", () => {});
      fs.closeSync(fd);
      Object.assign(record.apps[a.name], { stream: stream.pid, log });
      save();
      P.launch(d, a, a.launch_url && fill(a.launch_url, record));
    }
  } catch (e) { for (const a of ready) failed[a.name] = e.message; return; }
  // the device stays locked while its logs stream, or the emulator up booted runs
  const pids = [...ready.map((a) => record.apps[a.name].stream), d.pid].filter(Boolean).map((p) => -p);
  fs.writeFileSync(DEVICE_LOCK, JSON.stringify({ run: ctx.id, apps: FILE, pids }));
  for (const a of ready) {
    for (const end = Date.now() + 120_000; !(a.name in exits) && Date.now() < end; await sleep(500)) {
      try { if (P.front(d, a)) { record.apps[a.name].ok = true; break; } } catch (e) { failed[a.name] = e.message; break; }
    }
    if (record.apps[a.name].ok !== true) failed[a.name] ??= a.name in exits ? `dev server exited ${exits[a.name]}, its output in ${served[a.name]}` : "isn't in the foreground after 120s";
  }
}

async function up(profile, skip) {
  const profiles = recipe.profiles || {};
  if (profile !== "default" && !Object.hasOwn(profiles, profile)) { console.error(`run-apps: no profile ${profile} in the recipe`); process.exit(2); }
  const unknown = skip.filter((n) => !recipe.apps?.some((a) => a.name === n));
  if (unknown.length) { console.error(`run-apps: no app ${unknown.join(", ")} in the recipe`); process.exit(2); }
  if (!await down()) process.exit(1);  // a device's settings are never recorded over ones not given back yet
  fs.mkdirSync(logs, { recursive: true });
  const envOf = (a) => ({ ...(profile !== "default" && profiles.default?.[a.name]), ...profiles[profile]?.[a.name] });
  const mobile = (a) => a.type === "mobile";
  const all = (recipe.apps || []).filter((a) => a.dev || mobile(a));
  const fixed = all.filter((a) => a.dev && !JSON.stringify([a.dev, envOf(a)]).includes(`{port:${a.name}}`));
  const ports = await freePorts(all.filter((a) => a.dev).length - fixed.length);
  for (const a of all) record.apps[a.name] = { port: !a.dev ? null : fixed.includes(a) ? portOf(a.health) : ports.pop() };
  const wanted = all.filter((a) => profiles[profile]?.[a.name] !== null && !skip.includes(a.name));
  const target = wanted.some(mobile) ? device(runEnv(ctx.MAIN)) : null;
  for (const a of wanted.filter(mobile)) if (!target) console.log(`run-apps: ${a.name} skipped: ${NO_DEVICE}`);
  const envFor = (a) => Object.fromEntries(Object.entries(runEnv(ctx.MAIN, { ...envOf(a), ...(mobile(a) && { FACTORY_PLATFORM: target.platform }) }))
    .filter(([, v]) => v != null).map(([k, v]) => [k, fill(String(v), record)]));
  const apps = wanted.filter((a) => !mobile(a) || target);
  for (const a of all) if (!apps.includes(a)) record.apps[a.name].ok = "skip";
  record.profile = profile;
  const holdLock = apps.length > 0 && ((recipe.db && !pair) || apps.some((a) => fixed.includes(a)));
  if (holdLock || (pair && !record.db)) await lock();
  if (pair && !record.db) {
    const name = `factory_${path.basename(ctx.tree).replaceAll("-", "_")}`;
    if (!db("create", name)) { unlock(); process.exit(1); }
    record.db = name;
  }
  if (!holdLock) unlock();
  const failed = {}, exits = {};
  for (const a of apps) {
    const app = Object.assign(record.apps[a.name], { url: a.health ? fill(a.health, record) : null, ok: false });
    if (!a.dev) continue;
    if (fixed.includes(a) && app.port && await inUse(app.port)) { failed[a.name] = `port ${app.port} is already in use`; continue; }
    const log = logOf(a, "up"), fd = fs.openSync(log, "w");
    const child = spawn("bash", ["-c", fill(a.dev, record)], { cwd: path.join(ctx.tree, a.path || "."), env: envFor(a), detached: true, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
    child.on("exit", (code, signal) => { exits[a.name] = code ?? signal; });
    Object.assign(app, { pid: child.pid, log });
  }
  save();  // the pids first, so a crash mid-wait can still be brought down
  const started = apps.map((a) => record.apps[a.name]).filter((a) => a.pid);
  if (holdLock) fs.writeFileSync(LOCK, JSON.stringify({ run: ctx.id, apps: FILE, pids: [process.pid, ...started.map((a) => -a.pid)] }));
  await Promise.all(apps.filter((a) => record.apps[a.name].pid && !mobile(a)).map(async (a) => {
    const app = record.apps[a.name];
    for (const end = Date.now() + 120_000; app.url && !(a.name in exits) && Date.now() < end; await sleep(200)) {
      if (await answers(app.url)) { app.ok = true; return; }
    }
    failed[a.name] = !app.url ? "has no health URL in the recipe" : a.name in exits ? `exited ${exits[a.name]}` : `didn't answer at ${app.url} in 120s`;
  }));
  if (target) await onDevice(apps.filter((a) => mobile(a) && !failed[a.name]), target, envFor, failed, exits);
  save();
  console.log(`run-apps up: profile=${profile} ${Object.entries(record.apps).map(([n, a]) => `${n}=${a.ok === true ? a.url ?? "up" : a.ok || "failed"}`).join(" ")}`);
  for (const [name, reason] of Object.entries(failed)) {
    const { log } = record.apps[name];
    if (log) fs.appendFileSync(log, `run-apps: ${name} ${reason}\n`);
    console.log(`--- ${name} ${reason}${log ? `\n${digest(fs.readFileSync(log, "utf8"), log)}` : ""}`);
  }
  process.exit(Object.keys(failed).length ? 1 : 0);
}

if (cmd === "up") await up(arg("--profile", "default"), (arg("--skip") ?? "").split(",").filter(Boolean));
else if (cmd === "down") {
  const given = await down();
  if (process.argv.includes("--drop") && record.db) {
    if (!recipe.db?.drop) { console.log(`run-apps: no db.drop in the recipe, so ${record.db} is kept`); process.exit(1); }
    if (!db("drop", record.db)) process.exit(1);
    delete record.db;
    save();
  }
  console.log("run-apps down");
  if (!given) process.exit(1);
}
else if (cmd === "shot" || cmd === "look") {
  const d = record.device, [, , , a, b] = process.argv, file = path.join(ctx.out, "captures", `${a}.png`);
  if (!d?.settings) { console.error("run-apps: no device is up: run-apps up first"); process.exit(1); }
  try {
    if (cmd === "look") { PLATFORMS[d.platform].look(d, a, b); console.log(`run-apps look: ${a}, ${b} text size`); }
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); PLATFORMS[d.platform].shot(d, file); console.log(file); }
  } catch (e) { console.error(`run-apps: ${e.message}`); process.exit(1); }
}
else {
  const apps = Object.entries(record.apps), d = record.device;
  if (!apps.length) console.log("no apps up");
  // a mobile app is up while it's in front on the device
  const isUp = async (name, a) => {
    const m = recipe.apps?.find((x) => x.name === name);
    if (m?.type !== "mobile") return !!a.url && await answers(a.url);
    try { return !!d && PLATFORMS[d.platform].front(d, m); } catch { return false; }
  };
  for (const [name, a] of apps) console.log(`${name} ${a.ok === "skip" ? "skip" : await isUp(name, a) ? "up" : "down"}${a.url ? ` ${a.url}` : ""}`);
}
