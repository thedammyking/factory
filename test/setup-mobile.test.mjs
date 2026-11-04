// setup-mobile.test.mjs — setup-factory.mjs's mobile section, spawned as a process against throwaway projects holding a
// mobile app, with a fake gh and claude and the fake device's tools (test/device.mjs) on PATH (#17).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, fakeClis, write } from "./harness.mjs";
import { fakeDevice, DEVICES } from "./device.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts/setup-factory.mjs");
const scratch = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// node, npm and git from the real PATH, and nothing else from it but /usr/bin:/bin, so no tool on this machine is probed
const TOOLS = scratch("factory-tools-");
for (const t of ["node", "npm", "git"]) fs.symlinkSync(process.env.PATH.split(path.delimiter).map((d) => path.join(d, t)).find((f) => fs.existsSync(f)), path.join(TOOLS, t));
const CANNED = scratch("factory-canned-");
const canned = (name, body) => { const f = path.join(CANNED, name); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };
const json = (o) => JSON.stringify(o, null, 2) + "\n";

const EXPO = {
  "package.json": json({ name: "shop", scripts: { test: "node -e 0" }, dependencies: { expo: "52.0.0", "react-native": "0.76.0" } }),
  "app.json": json({ expo: { name: "Shop App", slug: "shop", ios: { bundleIdentifier: "com.example.shop" }, android: { package: "com.example.shop" } } }),
};
const UDID = DEVICES.ios.udid;

// A throwaway project holding `files`, with a GitHub origin. setup(...args) runs the script in it, with a signed-in fake
// gh, a fake claude answering `mcp add` with `mcp` (its stdout and exit status), and the fake device's tools (`device`
// its options), whose AVDs live in an ANDROID_AVD_HOME and system images in an ANDROID_HOME of the test's own.
function shop(t, { files = EXPO, device = {}, mcp = ["Added stdio MCP server maestro with command: maestro mcp to local config\n", 0], avds = {}, images = [] } = {}) {
  const p = project();
  p.git("rm", "-rq", ".factory", ".gitignore");
  write(p.dir, files);
  p.git("add", "-A"); p.git("commit", "-qm", "shop");
  p.git("remote", "add", "origin", "https://github.com/acme/shop.git");
  const d = fakeDevice(t, device), avdHome = scratch("factory-avd-"), sdk = scratch("factory-sdk-");
  for (const [name, api] of Object.entries(avds)) fs.writeFileSync(path.join(avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${avdHome}/${name}.avd\ntarget=android-${api}\n`);
  for (const image of images) fs.mkdirSync(path.join(sdk, "system-images", image), { recursive: true });
  const f = fakeClis({
    gh: [{ match: /^auth status/, file: canned("empty", "") }, { match: /^api repos\/acme\/shop$/, file: canned("repo", { default_branch: "main" }) },
      { match: /^api repos\/acme\/shop\/deployments/, file: canned("deployments", []) }],
    claude: [{ match: /^mcp add /, file: canned(`mcp-${mcp[1]}`, mcp[0]), status: mcp[1] }],
  });
  const env = { PATH: [f.bin, d.dir, TOOLS, "/usr/bin", "/bin"].join(path.delimiter), HOME: process.env.HOME, TMPDIR: d.dir, ANDROID_AVD_HOME: avdHome, ANDROID_HOME: sdk };
  const setup = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: p.dir, encoding: "utf8", env });
  const envLocal = () => fs.readFileSync(path.join(p.dir, ".factory/env.local"), "utf8");
  return { ...p, d, f, setup, envLocal };
}
// detect, then env, as sections A to C leave the proposal
const ready = (s) => { for (const c of ["detect", "env"]) assert.equal(s.setup(c).status, 0, c); return s; };
const DEVICE_TOOLS = ["xcrun", "adb", "emulator", "maestro", "xcodebuild", "java", "avdmanager"];

test("detect gives a mobile app its recipe fields from app.json: the app id, and a Release build that prints the .app or .apk it made", (t) => {
  // native projects an earlier local build made, which the project ignores, are in no run's worktree
  const s = shop(t, { files: { ...EXPO, ".gitignore": "/ios\n/android\n", "ios/ShopApp.xcworkspace/contents.xcworkspacedata": "<Workspace/>\n", "android/build.gradle": "\n" } });
  const r = s.setup("detect");
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout), app = d.recipe.apps[0];
  assert.deepEqual([app.type, app.app_id, d.recipe.pinned], ["mobile", "com.example.shop", [".maestro"]]);
  assert.equal(app.build, 'if [ "$FACTORY_PLATFORM" = ios ]; then npx expo prebuild -p ios && xcodebuild -workspace ios/ShopApp.xcworkspace -scheme ShopApp '
    + "-configuration Release -sdk iphonesimulator -derivedDataPath ios/build && echo ios/build/Build/Products/Release-iphonesimulator/ShopApp.app; "
    + "else npx expo prebuild -p android && (cd android && ./gradlew assembleRelease) && echo android/app/build/outputs/apk/release/app-release.apk; fi");
  assert.ok(!("dev" in app) && !("launch_url" in app), "a Release build carries its JavaScript: no dev server, and nothing a cleared state loses");
  const source = (field) => d.sources.find((x) => x.field === field);
  assert.deepEqual([source("apps.shop.app_id").source, source("apps.shop.app_id").guess], ["app.json expo.ios.bundleIdentifier", false]);
  assert.equal(source("apps.shop.build").guess, true, "a build no proof runs is a guess the human confirms");
  for (const cli of DEVICE_TOOLS) assert.deepEqual(s.d.calls(cli), [], `detect probes nothing: ${cli}`);

  // React Native's own native projects are built as they are, and two ids that differ are a guess
  const bare = shop(t, { files: { "package.json": json({ name: "shop", dependencies: { "react-native": "0.76.0" } }), "app.json": json({ name: "Shop", displayName: "Shop" }),
    "ios/Shop.xcworkspace/contents.xcworkspacedata": "<Workspace/>\n", "ios/Shop/Info.plist": "<plist/>\n", "android/app/build.gradle": 'android { namespace "com.shop" }\n' } });
  const b = JSON.parse(bare.setup("detect").stdout), bapp = b.recipe.apps[0];
  assert.match(bapp.build, /^if \[ "\$FACTORY_PLATFORM" = ios \]; then xcodebuild -workspace ios\/Shop\.xcworkspace -scheme Shop .*; else \(cd android && \.\/gradlew assembleRelease\) && echo /);
  assert.equal(bapp.app_id, undefined);
  assert.equal(b.sources.find((x) => x.field === "apps.shop.app_id").source, "app.json names no ios.bundleIdentifier or android.package");
  const two = shop(t, { files: { ...EXPO, "app.json": json({ expo: { name: "Shop", ios: { bundleIdentifier: "com.example.shop" }, android: { package: "com.example.shop.android" } } }) } });
  const id = JSON.parse(two.setup("detect").stdout).sources.find((x) => x.field === "apps.shop.app_id");
  assert.deepEqual([id.value, id.source, id.guess], ["com.example.shop", "app.json expo.ios.bundleIdentifier; expo.android.package is com.example.shop.android", true]);
});

test("each failed probe makes its platform unavailable and prints its fix, iOS first where it's available, and with neither the section exits 1, recording nothing", (t) => {
  const xcode = process.platform === "darwin" ? "install Xcode from the App Store, open it once, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`"
    : "none here: iOS simulators run on macOS only";
  const cases = [
    [{ broken: ["xcodebuild"] }, `fail  full Xcode (iOS)\n  fix: ${xcode}`, "FACTORY_ANDROID_DEVICE=Pixel_9"],
    [{ broken: ["adb"] }, "fail  adb (Android)\n  fix: install the SDK Platform-Tools in Android Studio's SDK Manager, and put `$ANDROID_HOME/platform-tools` on PATH", `FACTORY_IOS_DEVICE=${UDID}`],
    [{ gone: "emulator" }, "fail  an Android emulator (Android)\n  fix: install the Android Emulator in Android Studio's SDK Manager, and put `$ANDROID_HOME/emulator` on PATH", `FACTORY_IOS_DEVICE=${UDID}`],
    [{ android: { accel: false } }, "fail  hardware acceleration (Android)\n  fix: turn on the CPU's virtualization (on Linux, KVM), as `emulator -accel-check` says", `FACTORY_IOS_DEVICE=${UDID}`],
    [{ java: "11.0.22" }, "fail  Java 17 or newer (iOS and Android)\n  fix: install a JDK 17 or newer (`brew install --cask zulu@17`), and put its `java` on PATH", null],
    [{ java: "1.8.0_392" }, "fail  Java 17 or newer (iOS and Android)", null],
    [{ broken: ["maestro"] }, "fail  Maestro (iOS and Android)\n  fix: `curl -fsSL \"https://get.maestro.mobile.dev\" | bash`, and put `~/.maestro/bin` on PATH", null],
  ];
  for (const [{ gone, ...device }, line, recorded] of cases) {
    const s = ready(shop(t, { device: { ...device, ios: { booted: true }, android: { booted: true, ...device.android } } }));
    if (gone) fs.rmSync(path.join(s.d.dir, gone));
    const before = s.envLocal(), r = s.setup("mobile");
    assert.ok(r.stdout.includes(line), `${line}\n---\n${r.stdout}`);
    if (recorded) {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(s.envLocal(), new RegExp(`^${recorded}$`, "m"));
      assert.equal(s.envLocal().match(/^FACTORY_(IOS|ANDROID)_DEVICE=/gm).length, 1, "one platform per run");
    } else {
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /^no platform is available: each mobile criterion will be blocked \(environment\), each Maestro check skipped, and each run with a mobile app needs a human$/m);
      assert.equal(s.envLocal(), before, "nothing recorded");
    }
  }
  const passing = ready(shop(t, { device: { ios: { booted: true } } })).setup("mobile").stdout;
  assert.ok(passing.startsWith("pass  full Xcode (iOS)\npass  adb (Android)\npass  an Android emulator (Android)\npass  hardware acceleration (Android)\npass  Java 17 or newer (iOS and Android): 17.0.12\npass  Maestro (iOS and Android): 2.12.1\n"), passing);
});

test("the iOS device: the booted simulator, else the newest runtime's, booted once to prove it and shut down again, else a `factory` iPhone made from the newest runtime", (t) => {
  const booted = ready(shop(t, { device: { ios: { booted: true, runtime: "iOS-17-5", others: [{ udid: "NEWER-1", name: "iPhone 16 Pro", runtime: "iOS-18-2", state: "Shutdown" }] } } }));
  let r = booted.setup("mobile");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(booted.envLocal(), new RegExp(`^# The simulator every run's mobile app goes on, chosen by setup\\.\nFACTORY_IOS_DEVICE=${UDID}\n$`, "m"));
  assert.match(r.stdout, /^device  iOS: iPhone 16, iOS 17\.5, running, recorded as FACTORY_IOS_DEVICE in \.factory\/env\.local$/m);
  assert.ok(!booted.d.calls("xcrun").some((c) => ["boot", "shutdown"].includes(c[1])), "a running simulator is left as it is");

  const newest = ready(shop(t, { device: { ios: { others: [{ udid: "OLDER-1", name: "iPhone 15", runtime: "iOS-17-5", state: "Shutdown" }] } } }));
  r = newest.setup("mobile");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(newest.envLocal(), new RegExp(`^FACTORY_IOS_DEVICE=${UDID}$`, "m"));
  assert.deepEqual(newest.d.calls("xcrun").filter((c) => ["boot", "bootstatus", "shutdown"].includes(c[1])), [["simctl", "boot", UDID], ["simctl", "bootstatus", UDID], ["simctl", "shutdown", UDID]]);
  assert.equal(newest.d.state().ios.booted, false, "shut down again, as it was");
  assert.match(r.stdout, /^device  iOS: iPhone 16, iOS 18\.2, booted once to prove it and shut down again, recorded as FACTORY_IOS_DEVICE/m);

  const RT = (v, ...types) => ({ identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${v.replace(".", "-")}`, version: v, isAvailable: true,
    supportedDeviceTypes: types.map(([id, name, family = "iPhone"]) => ({ identifier: `com.apple.CoreSimulator.SimDeviceType.${id}`, name, productFamily: family })) });
  const none = ready(shop(t, { device: { ios: { udid: null, runtimes: [RT("17.5", ["iPhone-15", "iPhone 15"]), RT("18.2", ["iPhone-16", "iPhone 16"], ["iPhone-16-Pro", "iPhone 16 Pro"], ["iPad-Air-11-inch-M2", "iPad Air 11-inch (M2)", "iPad"])] } } }));
  r = none.setup("mobile");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(none.d.calls("xcrun").find((c) => c[1] === "create"), ["simctl", "create", "factory", "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro", "com.apple.CoreSimulator.SimRuntime.iOS-18-2"]);
  const made = none.d.state().ios;
  assert.match(none.envLocal(), new RegExp(`^FACTORY_IOS_DEVICE=${made.udid}$`, "m"));
  assert.equal(made.booted, false, "booted once, then shut down");
  assert.match(r.stdout, /^device  iOS: factory \(iPhone 16 Pro, iOS 18\.2\), made now, booted once to prove it and shut down again/m);
});

test("the Android device, where iOS isn't available: the running emulator, else the newest AVD, booted headless once and killed, else a `factory` AVD made from the newest system image", async (t) => {
  const noXcode = { broken: ["xcodebuild"] };
  const running = ready(shop(t, { device: { ...noXcode, android: { booted: true } } }));
  let r = running.setup("mobile");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(running.envLocal(), /^FACTORY_ANDROID_DEVICE=Pixel_9$/m);
  assert.deepEqual(running.d.calls("emulator").filter((c) => c[0] === "-avd"), [], "a running emulator isn't booted again");
  assert.ok(running.d.state().android.booted, "and keeps running");

  const newest = ready(shop(t, { device: { ...noXcode, android: { avds: ["Old_Phone", "Pixel_9", "Tablet"] } }, avds: { Old_Phone: 30, Pixel_9: 35, Tablet: 33 } }));
  r = newest.setup("mobile");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(newest.envLocal(), /^FACTORY_ANDROID_DEVICE=Pixel_9$/m);
  assert.deepEqual(newest.d.calls("emulator").filter((c) => c[0] === "-avd"), [["-avd", "Pixel_9", "-no-window"]]);
  assert.deepEqual(newest.d.calls("adb").at(-1), ["-s", "emulator-5554", "emu", "kill"]);
  assert.equal(newest.d.state().android.booted, false, "killed, as it was");
  assert.match(r.stdout, /^device  Android: Pixel_9, API 35, booted once to prove it and shut down again, recorded as FACTORY_ANDROID_DEVICE/m);

  const abi = os.arch() === "arm64" ? "arm64-v8a" : "x86_64";
  const none = ready(shop(t, { device: { ...noXcode, android: { avds: [], avd: null } }, images: [`android-34/google_apis/${abi}`, `android-35/google_apis/${abi}`, `android-35/google_apis_playstore/${abi}`, "android-36/google_apis/riscv64"] }));
  r = none.setup("mobile");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(none.d.calls("avdmanager"), [["create", "avd", "-n", "factory", "-k", `system-images;android-35;google_apis;${abi}`]]);
  assert.match(none.envLocal(), /^FACTORY_ANDROID_DEVICE=factory$/m);
  assert.deepEqual(none.d.calls("emulator").filter((c) => c[0] === "-avd"), [["-avd", "factory", "-no-window"]]);
  assert.equal(none.d.state().android.booted, false);
});

test("a device .factory/env.local already names is kept, and a recipe without a mobile app probes nothing", (t) => {
  const s = ready(shop(t, { device: { ios: { booted: true } } }));
  fs.appendFileSync(path.join(s.dir, ".factory/env.local"), "FACTORY_ANDROID_DEVICE=My_Phone\n");
  const r = s.setup("mobile");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^device  kept FACTORY_ANDROID_DEVICE in \.factory\/env\.local$/m);
  assert.doesNotMatch(s.envLocal(), /FACTORY_IOS_DEVICE/);
  assert.deepEqual(s.d.calls("xcrun").filter((c) => c[1] !== "help"), [], "no device chosen");
  // a kept device whose platform's probes fail is no platform to verify on, and so no Maestro server
  const gone = ready(shop(t, { device: { broken: ["xcodebuild"], android: { booted: true } } }));
  fs.appendFileSync(path.join(gone.dir, ".factory/env.local"), `FACTORY_IOS_DEVICE=${UDID}\n`);
  const g = gone.setup("mobile");
  assert.equal(g.status, 1, g.stdout);
  assert.match(g.stdout, /^device  kept FACTORY_IOS_DEVICE in \.factory\/env\.local, though iOS isn't available$/m);
  assert.doesNotMatch(gone.envLocal(), /FACTORY_ANDROID_DEVICE/, "the human's choice stands");

  const web = ready(shop(t, { files: { "package.json": json({ name: "site", scripts: { test: "node -e 0" }, dependencies: { next: "15.0.0" } }), "next.config.mjs": "export default {};\n" } }));
  const w = web.setup("mobile");
  assert.deepEqual([w.status, w.stdout.trim()], [0, "no mobile app in the recipe: nothing to probe"]);
  for (const cli of DEVICE_TOOLS) assert.deepEqual(web.d.calls(cli), [], cli);
});

test("apply registers the Maestro MCP server at local scope once a platform is available, shows it in the proposal, keeps one already there, and registers none without a platform", (t) => {
  const s = ready(shop(t, { device: { ios: { booted: true } } }));
  for (const c of ["mobile", "prove"]) assert.equal(s.setup(c).status, 0, c);
  assert.match(s.setup("apply", "--dry-run").stdout, /^## MCP\n\n- `claude mcp add --scope local maestro -e MAESTRO_CLI_NO_ANALYTICS=1 -- maestro mcp`: /m);
  assert.deepEqual(s.f.calls("claude"), [], "the dry run registers nothing");
  let r = s.setup("apply");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // the name before -e: claude's -e takes every value up to the next option, so `-e … maestro` would read maestro as one
  assert.deepEqual(s.f.calls("claude"), [["mcp", "add", "--scope", "local", "maestro", "-e", "MAESTRO_CLI_NO_ANALYTICS=1", "--", "maestro", "mcp"]]);
  assert.match(r.stdout, /^registered the maestro MCP server at local scope$/m);

  const again = ready(shop(t, { device: { ios: { booted: true } }, mcp: ["MCP server maestro already exists in local config\n", 1] }));
  for (const c of ["mobile", "prove"]) assert.equal(again.setup(c).status, 0, c);
  r = again.setup("apply");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^kept the maestro MCP server already registered$/m);

  const none = ready(shop(t, { device: { java: "11.0.22" } }));
  assert.equal(none.setup("mobile").status, 1);
  assert.equal(none.setup("prove").status, 0);
  assert.equal(none.setup("apply").status, 0);
  assert.deepEqual(none.f.calls("claude"), [], "no platform, no Maestro server");
});
