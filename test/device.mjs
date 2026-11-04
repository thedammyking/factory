// device.mjs — a fake iOS simulator and Android emulator for run-apps, verify, capture-states and setup: fake xcrun,
// adb, emulator, maestro and sips on PATH, and xcodebuild, java and avdmanager for setup's probes. Each call appends
// its argv to calls(name) and acts on one state file, so a test asserts both the commands sent and what the device was
// left as.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The developer's own devices, as setup found them: neither running, each with its own look. app_id is the id of the
// app a test's build makes, which a launch by URL brings to the front. Beside the simulator (none with udid null),
// simctl lists `others` ({udid, name, runtime, state}, never bootable) and the `runtimes` installed; the emulator lists
// `avds`, and boots only `avd`.
export const DEVICES = {
  ios: { udid: "5D2E7A0C-1111-4C3B-9E77-0A1B2C3D4E5F", name: "iPhone 16", runtime: "iOS-18-2", booted: false, appearance: "light", content_size: "large", width: 1179, scale: 3,
    app_id: "com.example.shop", installed: null, running: null, others: [], runtimes: [] },
  android: { avd: "Pixel_9", avds: ["Pixel_9"], serial: "emulator-5554", booted: false, accel: true, size: "1080x2400", density: "420", override_size: null, override_density: null,
    night: "no", font_scale: "1.0", sdk: "35", app_id: "com.example.shop", reversed: [], installed: null, foreground: null },
};

const FAKE = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const name = path.basename(__filename), argv = process.argv.slice(2), STATE = path.join(__dirname, "device.json");
fs.appendFileSync(__filename + ".calls", JSON.stringify(argv) + "\\n");
const read = fs.readFileSync(STATE, "utf8"), s = JSON.parse(read), { ios, android } = s;
// written back only when changed, so a call that only reads never undoes a concurrent one's change
const save = () => { if (JSON.stringify(s) !== JSON.stringify(JSON.parse(read))) fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
const out = (t) => process.stdout.write(t + "\\n");
const fail = (t) => { process.stderr.write("fake " + name + ": " + t + "\\n"); process.exit(1); };
// a PNG's signature and IHDR, enough for its width to be read
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
// a process that lives until it's killed, or until the device goes down or the test's ALIVE file does
const live = (up) => setInterval(() => { const now = JSON.parse(fs.readFileSync(STATE, "utf8")); if (!fs.existsSync(s.alive) || !up(now)) process.exit(); }, 50);
const j = argv.join(" ");
// a tool that's there but fails, as macOS's xcodebuild does with only the Command Line Tools
if ((s.broken || []).includes(name)) fail("requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance");
if (name === "xcrun") {
  const [, cmd, id, ...rest] = argv, r = rest.join(" ");
  if (argv[0] !== "simctl") fail("no " + argv[0]);
  if (j === "simctl help") out("usage: simctl [--set <path>] [--profiles <path>] <subcommand> ...");
  else if (j === "simctl list devices -j") {
    const devices = {};
    for (const d of [...(ios.udid ? [{ udid: ios.udid, name: ios.name, state: ios.booted ? "Booted" : "Shutdown", runtime: ios.runtime }] : []), ...ios.others]) {
      (devices["com.apple.CoreSimulator.SimRuntime." + d.runtime] ||= []).push({ udid: d.udid, name: d.name, state: d.state, isAvailable: true });
    }
    out(JSON.stringify({ devices }));
  }
  else if (j === "simctl list runtimes -j") out(JSON.stringify({ runtimes: ios.runtimes }));
  else if (cmd === "create") { Object.assign(ios, { udid: "FAC70000-0000-4000-8000-000000000001", name: id, runtime: rest[1].split(".").pop(), booted: false }); out(ios.udid); }
  else if (id !== ios.udid) fail("no device " + id);
  else if (cmd === "boot") { if (ios.booted) fail("Unable to boot device in current state: Booted"); ios.booted = true; }
  else if (!ios.booted) fail("Unable to lookup in current state: Shutdown");
  else if (cmd === "bootstatus") out("Device already booted");
  else if (cmd === "shutdown") Object.assign(ios, { booted: false, running: null });
  else if (cmd === "ui" && rest.length === 1) out(ios[rest[0]]);
  else if (cmd === "ui") ios[rest[0]] = rest[1];
  else if (cmd === "install") { if (!fs.existsSync(rest[0])) fail("no app at " + rest[0]); ios.installed = path.basename(rest[0]); }
  else if (cmd === "launch") { ios.running = rest[0]; out(rest[0] + ": 4242"); }
  else if (cmd === "openurl") ios.running = ios.installed && ios.app_id;
  else if (cmd === "spawn" && r === "launchctl list") out("PID\\tStatus\\tLabel\\n" + (ios.running ? "4242\\t0\\tUIKitApplication:" + ios.running + "[1a2b][rb-legacy]" : "-\\t0\\tcom.apple.other"));
  else if (cmd === "spawn" && rest[0] === "log") { out("log stream " + r); live((now) => now.ios.booted); }
  else if (cmd === "io") fs.writeFileSync(rest[1], png(ios.width, ios.width * 2));
  else if (cmd === "getenv" && rest[0] === "SIMULATOR_MAINSCREEN_SCALE") out(ios.scale.toFixed(6));
  else fail("no canned reply for " + JSON.stringify(argv));
} else if (name === "adb") {
  const serial = argv[0] === "-s" ? argv[1] : null, a = serial ? argv.slice(2) : argv, c = a.join(" "), sh = a[0] === "shell" ? a.slice(1).join(" ") : null;
  const runs = android.booted;
  if (c === "devices") out("List of devices attached\\n" + (runs ? android.serial + "\\tdevice\\n" : ""));
  else if (c === "version") out("Android Debug Bridge version 1.0.41\\nVersion 35.0.2-12147458");
  else if (serial !== android.serial || !runs) fail("device '" + serial + "' not found");
  else if (c === "emu avd name") out(android.avd + "\\nOK");
  else if (c === "emu kill") Object.assign(android, { booted: false, foreground: null, reversed: [] });
  else if (c === "wait-for-device") {}
  else if (a[0] === "install") { if (!fs.existsSync(a.at(-1))) fail("no apk at " + a.at(-1)); android.installed = path.basename(a.at(-1)); }
  else if (a[0] === "reverse" && a[1] === "--remove") android.reversed = android.reversed.filter((p) => p !== a[2]);
  else if (a[0] === "reverse") android.reversed.push(a[1]);
  else if (a[0] === "logcat") { out("logcat " + a.slice(1).join(" ")); live((now) => now.android.booted); }
  else if (c === "exec-out screencap -p") process.stdout.write(png(...(android.override_size || android.size).split("x").map(Number)));
  else if (sh === "getprop sys.boot_completed") out("1");
  else if (sh === "getprop ro.build.version.sdk") out(android.sdk);
  else if (sh === "wm size") out("Physical size: " + android.size + (android.override_size ? "\\nOverride size: " + android.override_size : ""));
  else if (sh === "wm density") out("Physical density: " + android.density + (android.override_density ? "\\nOverride density: " + android.override_density : ""));
  else if (/^wm (size|density) /.test(sh)) { const [, k, v] = sh.split(" "); android["override_" + k] = v === "reset" ? null : v; }
  else if (/^cmd uimode night ?/.test(sh)) { const v = sh.split(" ")[3]; if (v) android.night = v; out("Night mode: " + android.night); }
  else if (sh === "settings get system font_scale") out(android.font_scale ?? "null");
  else if (sh.startsWith("settings put system font_scale ")) android.font_scale = sh.split(" ")[4];
  else if (sh === "settings delete system font_scale") android.font_scale = null;
  else if (/^cmd package list packages -U '[^']+'$/.test(sh)) out("package:" + sh.split("'")[1] + " uid:10123");
  else if (/^monkey -p '[^']+' -c android.intent.category.LAUNCHER 1$/.test(sh)) android.foreground = sh.split("'")[1];
  else if (/^am start -a android.intent.action.VIEW -d '.+'$/.test(sh)) android.foreground = android.installed && android.app_id;
  else if (sh === "dumpsys activity activities") out(android.foreground ? "    topResumedActivity=ActivityRecord{f6e358d u0 " + android.foreground + "/.MainActivity t8}" : "    topResumedActivity=ActivityRecord{1 u0 com.android.launcher3/.Launcher t1}");
  else fail("no canned reply for " + JSON.stringify(argv));
} else if (name === "emulator") {
  if (j === "-accel-check") { out(android.accel ? "accel:\\n0\\nHypervisor.Framework OS X Version 15.0\\naccel" : "accel:\\n7\\nCPU doesn't support virtualization\\naccel"); process.exit(android.accel ? 0 : 1); }
  if (j === "-list-avds") { out(android.avds.join("\\n")); process.exit(); }
  if (j !== "-avd " + android.avd + " -no-window") fail("no canned reply for " + JSON.stringify(argv));
  if (android.booted) fail("Running multiple emulators with the same AVD is an experimental feature.");
  android.booted = true;
  out("INFO | Boot completed");
  live((now) => now.android.booted);
} else if (name === "maestro") {
  if (j === "--version") { out(s.maestro); process.exit(); }
  out("MAESTRO_CLI_NO_ANALYTICS=" + process.env.MAESTRO_CLI_NO_ANALYTICS);
  // one flow, as capture-states runs it: kept in s.flows with the device's look then, failing where it holds s.failing
  if (argv[0] === "test" && argv.length === 2) {
    if (!(ios.booted && ios.running) && !(android.booted && android.foreground)) fail("no app is running on any device");
    const flow = fs.readFileSync(argv[1], "utf8");
    (s.flows ||= []).push({ flow, look: ios.booted ? ios.appearance + "/" + ios.content_size : android.night + "/" + android.font_scale });
    if (s.failing && flow.includes(s.failing)) { out("Assertion is false: " + s.failing + " is visible"); process.exitCode = 1; }
    save(); process.exit();
  }
  const [, , , , output, flows] = argv;
  if (argv.slice(0, 4).join(" ") !== "test --format junit --output" || !fs.existsSync(flows)) fail("no canned reply for " + JSON.stringify(argv));
  if (!(ios.booted && ios.running) && !(android.booted && android.foreground)) fail("no app is running on any device");
  fs.writeFileSync(output, s.junit);
  process.exitCode = s.junit.includes("<failure") ? 1 : 0;
} else if (name === "sips") {
  const [flag, width, file] = argv;
  if (flag !== "--resampleWidth") fail("no canned reply for " + JSON.stringify(argv));
  fs.writeFileSync(file, png(Number(width), Number(width) * 2));
} else if (name === "xcodebuild") {
  if (j !== "-version") fail("no canned reply for " + JSON.stringify(argv));
  out("Xcode 16.2\\nBuild version 16C5032a");
} else if (name === "java") {
  if (j !== "-version") fail("no canned reply for " + JSON.stringify(argv));
  process.stderr.write('openjdk version "' + s.java + '" 2026-07-15 LTS\\nOpenJDK Runtime Environment Zulu (build ' + s.java + ')\\n');
} else if (name === "avdmanager") {
  const [, , n, avd, k, image] = argv;
  if (argv.slice(0, 2).join(" ") !== "create avd" || n !== "-n" || k !== "-k") fail("no canned reply for " + JSON.stringify(argv));
  Object.assign(android, { avd, avds: [...android.avds, avd], image });
}
save();
`;

const PASSING = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="Test Suite" tests="1" failures="0">\n'
  + '    <testcase id="r1-01-total-SC-001" name="[r1] SC-001: the total shows" classname="r1-01-total-SC-001" status="SUCCESS"/>\n  </testsuite>\n</testsuites>\n';

// The fake device, in a dir of its own that is also the TMPDIR its env gives, so the machine-wide device lock of one
// test is never another's. `ios` and `android` override fields of DEVICES; `junit` is the report maestro test writes,
// `maestro` what --version prints, and `failing` text that fails a single flow holding it. Setup's probes also find
// xcodebuild, java (`java` the version it prints) and avdmanager here; each tool `broken` names fails, as an Xcode-only
// one does without Xcode. After the test, pass or fail, every process the fakes started ends once its ALIVE file goes,
// as it does when its device shuts down.
export function fakeDevice(t, { ios = {}, android = {}, junit = PASSING, maestro = "2.12.1", failing = null, java = "17.0.12", broken = [] } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-device-"))), alive = path.join(dir, ".alive");
  fs.writeFileSync(alive, "");
  const state = path.join(dir, "device.json");
  fs.writeFileSync(state, JSON.stringify({ alive, junit, maestro, failing, java, broken, ios: { ...DEVICES.ios, ...ios }, android: { ...DEVICES.android, ...android } }));
  for (const name of ["xcrun", "adb", "emulator", "maestro", "sips", "xcodebuild", "java", "avdmanager"]) fs.writeFileSync(path.join(dir, name), FAKE, { mode: 0o755 });
  t.after(() => fs.rmSync(alive, { force: true }));
  const calls = (name) => { const log = path.join(dir, `${name}.calls`); return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  const read = () => JSON.parse(fs.readFileSync(state, "utf8"));
  // what a developer or a flow does to the device meanwhile
  const change = (platform, fields) => { const s = read(); Object.assign(s[platform], fields); fs.writeFileSync(state, JSON.stringify(s)); };
  return { dir, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, TMPDIR: dir }, calls, state: read, change, lock: path.join(dir, "factory-device.lock") };
}
