// mobile-pr.test.mjs — merge-decision and pr-render spawned as processes on a run of a throwaway project with a mobile
// app beside a web one, past its review with every merge fact holding and PR #7 open on o/r: what one platform per run
// leaves unverified (#17).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { project, script, startRun, fakeClis, githubOrigin, write } from "./harness.mjs";

const ENV = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")) };
delete ENV.CLAUDE_CODE_SESSION_ID;
const TOUCHES = ["auth", "data", "migrations", "network", "files", "crypto", "config", "deps", "native", "api_contract", "ui", "tests"];
const RECIPE = { apps: [
  { name: "web", type: "web", path: "web", checks: { test: "true" } },
  { name: "mobile", type: "mobile", path: "apps/mobile", build: "echo build/Shop.app", app_id: "com.example.shop", checks: { test: "true" } },
], pinned: ["web/e2e", "apps/mobile/.maestro"] };
const SPEC = "# Cart\n\n## Goal\nA shopper sees the cart's total.\n\n## Success criteria\n- **SC-001**: The cart screen shows the total.\n- **SC-002**: The web cart page shows the total.\n";
const IMPL = "status: DONE\nassessment:\n  recommendation: merge\n  confident: true\n  reason: every criterion passed\n";
const NATIVE = { "apps/mobile/ios/Podfile": "platform :ios\n", "apps/mobile/android/app/build.gradle": "android {}\n" };

// The run, its change to the mobile app's JavaScript committed, verified on `platform`; pin() writes every run file at
// the head, put(file, change) merges a change into one, decide() runs merge-decision and render() pr-render.
function ready({ platform = "ios" } = {}) {
  const p = project({ recipe: RECIPE, config: { merge: "trial" } });
  githubOrigin(p);
  const s = startRun(p, NATIVE);
  p.git("push", "-q", "origin", "main");
  const rs = (...a) => { const r = script("run-state.mjs", p.dir, [...a, "--run", s.id], { env: ENV }); assert.equal(r.status, 0, r.stderr + r.stdout); };
  rs("set", "route", "build"); rs("set", "branch", "feature/cart"); rs("set", "target_branch", "main");
  s.commit({ "apps/mobile/src/Cart.js": "export const total = 42;\n" }, "Show the cart total");
  const head = () => s.git("rev-parse", "HEAD");
  const gh = fakeClis({ gh: [{ match: /^api repos\/o\/r\/pulls\/7$/, file: path.join(s.run_dir, "..", "pr7.json") }] });
  const json = (f, v) => write(s.run_dir, { [f]: JSON.stringify(v, null, 2) + "\n" });
  const read = (f) => JSON.parse(fs.readFileSync(path.join(s.run_dir, f), "utf8"));
  const put = (f, change) => json(f, { ...read(f), ...change });
  const pin = () => {
    const h = head();
    write(s.run_dir, { "spec.md": SPEC, "triage.md": "```json\n" + JSON.stringify({ type: "feature", size: "s" }) + "\n```\n",
      "tickets/01-cart.md": "# 01: Cart\n\nStatus: done\nBlocked by: none\n", "tickets/01/implementation.md": IMPL,
      "../pr7.json": JSON.stringify({ number: 7, base: { ref: "main" }, head: { sha: h } }) });
    json("tickets/01/qa.json", { ticket: "01-cart", status: "done", criteria: [{ id: "SC-001", app: "mobile", status: "pass" }, { id: "SC-002", app: "web", status: "pass" }] });
    json("evidence.json", { mode: "full", sha: h, green: true, dirty: false, trusted: true, platform,
      checks: [{ app: "web", check: "test", status: "pass", seconds: 1 }, { app: "mobile", check: "test", status: "pass", seconds: 1 }, { app: "mobile", check: "apps/mobile/.maestro", status: "pass", seconds: 9, pinned: true }] });
    json("ci.json", { sha: h, cause: "green" });
    json("findings.json", { disposition: "ship", findings: [] });
    json("security.json", { head: h, capabilities: Object.fromEntries(["secrets", "vulnerabilities", "sast"].map((c) => [c, { status: "pass", runs: [] }])), items: [], new_dependencies: [] });
    json("touches.json", { head: h, touches: Object.fromEntries(TOUCHES.map((t) => [t, { hit: false, paths: [] }])), new_env: [] });
    json("pr.json", { repo: "o/r", number: 7 });
  };
  pin();
  const decide = () => {
    const r = script("merge-decision.mjs", p.dir, ["--run", s.id], { env: gh.env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return read("decision.json");
  };
  const render = () => {
    const r = script("pr-render.mjs", p.dir, ["--run", s.id], { env: gh.env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return fs.readFileSync(path.join(s.run_dir, "pr.md"), "utf8");
  };
  return { s, head, put, read, pin, decide, render };
}
const failing = (d) => d.facts.filter((f) => !f.ok).map((f) => f.name);
const fact = (d, name) => d.facts.find((f) => f.name === name);

test("with the mobile app verified on its one platform and no native change, every fact holds, the two mobile facts included", () => {
  const r = ready(), d = r.decide();
  assert.equal(d.decision, "merge", d.reasons.join("\n"));
  assert.deepEqual([fact(d, "mobile_verified").detail, fact(d, "no_unverified_native").detail], ["verified on iOS", "none"]);
  assert.doesNotMatch(r.render(), /Unverified on/);
});

test("a mobile criterion blocked for the environment, or a mobile check skipped, makes the decision needs-human on its own fact; a web criterion's environment block doesn't", () => {
  const r = ready();
  r.put("tickets/01/qa.json", { criteria: [{ id: "SC-001", app: "mobile", status: "blocked", reason: "environment", manual: "open shop://cart on a phone" }, { id: "SC-002", app: "web", status: "pass" }] });
  let d = r.decide();
  assert.deepEqual(failing(d), ["criteria_pass", "mobile_verified"]);
  assert.match(d.reasons.at(-1), /^mobile_verified: SC-001 blocked \(environment\)$/);

  r.pin();
  r.put("evidence.json", { green: false, red_cause: "environment", platform: null, checks: [{ app: "web", check: "test", status: "pass", seconds: 1 },
    { app: "mobile", check: "apps/mobile/.maestro", status: "skipped", seconds: 0, digest: "no device in .factory/env.local (FACTORY_IOS_DEVICE or FACTORY_ANDROID_DEVICE)" }] });
  d = r.decide();
  assert.deepEqual(failing(d), ["evidence_green_at_head", "mobile_verified"]);
  assert.equal(fact(d, "mobile_verified").detail, "mobile/apps/mobile/.maestro skipped: no device in .factory/env.local (FACTORY_IOS_DEVICE or FACTORY_ANDROID_DEVICE)");

  r.pin();
  r.put("tickets/01/qa.json", { criteria: [{ id: "SC-001", app: "mobile", status: "pass" }, { id: "SC-002", app: "web", status: "blocked", reason: "environment" }] });
  assert.deepEqual(failing(r.decide()), ["criteria_pass"], "a web criterion is no mobile fact");
});

test("a diff touching the native directory of the platform the run didn't verify is needs-human, and pr-render says it's unverified on that platform", () => {
  const r = ready();
  r.s.commit({ "apps/mobile/ios/Podfile": "platform :ios, '16.0'\n" }, "Raise the iOS target"); r.pin();
  assert.equal(r.decide().decision, "merge", "iOS was verified, so its native change was too");
  r.s.commit({ "apps/mobile/android/app/build.gradle": "android { compileSdk 35 }\n" }, "Raise compileSdk"); r.pin();
  const d = r.decide();
  assert.deepEqual(failing(d), ["no_unverified_native"]);
  assert.equal(d.reasons[0], "no_unverified_native: apps/mobile/android/app/build.gradle changes Android's native code, which the run didn't verify (it verified on iOS)");
  assert.match(r.render(), /^Unverified on Android: the run verified on iOS, and the diff changes `apps\/mobile\/android\/app\/build\.gradle`\.$/m);

  const none = ready({ platform: null });
  none.s.commit({ "apps/mobile/ios/Podfile": "platform :ios, '16.0'\n" }, "Raise the iOS target"); none.pin();
  assert.match(none.decide().reasons.join("\n"), /^no_unverified_native: apps\/mobile\/ios\/Podfile changes iOS's native code, which the run didn't verify \(it had no device\)$/m);
  assert.match(none.render(), /^Unverified on iOS: the run had no device, and the diff changes `apps\/mobile\/ios\/Podfile`\.$/m);
});
