// capture-states.test.mjs — capture-states.mjs spawned as a process against a run on a throwaway project whose
// node_modules hold a fake playwright: it records every call the script makes in calls.jsonl beside it, writes each
// screenshot as a stub file, and serves the pages its site.json describes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { project, script, startRun, write } from "./harness.mjs";

// site.json: { launch?: <error chromium.launch throws>, pages: { <path>: { scrollWidth?, missing?: [selectors],
// console?: [errors the page logs on load] } } }. A selector a page lists as missing makes the action on it time out, as
// Playwright's does.
const FAKE_PLAYWRIGHT = `const fs = require("node:fs"), path = require("node:path");
const record = (call, fields) => fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ call, ...fields }) + "\\n");
const site = JSON.parse(fs.readFileSync(path.join(__dirname, "site.json"), "utf8"));
let contexts = 0;
const browserType = (browser) => ({ async launch(options = {}) {
  record("launch", { browser, options });
  if (site.launch) throw new Error(site.launch);
  return { close: async () => record("browser.close", {}), async newContext(options) {
    const ctx = ++contexts;
    record("newContext", { ctx, options });
    let at = null, onConsole = () => {};
    const act = (call, sel, fields = {}) => {
      record(call, { ctx, sel, ...fields });
      if (site.pages?.[at]?.missing?.includes(sel)) throw new Error(\`page.\${call}: Timeout 30000ms exceeded.\\nCall log:\\n  - waiting for locator('\${sel}')\`);
    };
    const page = {
      on(event, fn) { if (event === "console") onConsole = fn; },
      async route(pattern, handler) {
        record("route", { ctx, pattern });
        handler({ abort: async () => record("route.abort", { ctx, pattern }), continue: async () => record("route.continue", { ctx, pattern }) });
      },
      async goto(url) {
        record("goto", { ctx, url }); at = new URL(url).pathname;
        for (const text of site.pages?.[at]?.console || []) onConsole({ type: () => "error", text: () => text });
      },
      async reload() { record("reload", { ctx }); },
      async evaluate(fn, arg) {
        const width = options.viewport.width, content = site.pages?.[at]?.scrollWidth || 0;
        const document = { documentElement: { scrollWidth: Math.max(width, content), clientWidth: width } };
        const localStorage = { setItem: (key, value) => record("localStorage.setItem", { ctx, key, value }) };
        return new Function("document", "localStorage", "return (" + fn + ")")(document, localStorage)(arg);
      },
      fill: async (sel, text) => act("fill", sel, { text }),
      click: async (sel) => act("click", sel),
      hover: async (sel) => act("hover", sel),
      focus: async (sel) => act("focus", sel),
      waitForSelector: async (sel) => act("waitForSelector", sel),
      keyboard: { press: async (key) => record("press", { ctx, key }) },
      waitForTimeout: async (ms) => record("waitForTimeout", { ctx, ms }),
      async screenshot(o) { record("screenshot", { ctx, options: o }); fs.writeFileSync(o.path, "png"); },
    };
    return { newPage: async () => page, close: async () => record("context.close", { ctx }) };
  } };
} });
module.exports = { chromium: browserType("chromium"), firefox: browserType("firefox"), webkit: browserType("webkit") };
`;
// A fake @axe-core/playwright that finds one violation on every page.
const FAKE_AXE = `class AxeBuilder {
  constructor({ page }) { this.page = page; }
  async analyze() { return { violations: [{ id: "image-alt", impact: "critical", nodes: [{}, {}], help: "Images must have alternate text" }] }; }
}
module.exports = AxeBuilder;
module.exports.default = AxeBuilder;
`;

// A run on a project with `recipe` whose worktree holds the fakes: the fake playwright at `playwright` (a module dir
// under the worktree, or null for none) and the fake axe at node_modules/@axe-core/playwright when axe is true, with
// apps.json recording the web app on port 4321. capture(states) writes the state list and runs capture-states.mjs on it
// from the main checkout; calls() is what the fake playwright was asked, in order.
function setup({ site = {}, axe = false, playwright = "node_modules/playwright", recipe } = {}) {
  const p = project(recipe && { recipe }), run = startRun(p), fake = path.join(run.worktree, playwright || "none");
  write(run.worktree, {
    ...(playwright && { [`${playwright}/index.js`]: FAKE_PLAYWRIGHT, [`${playwright}/site.json`]: JSON.stringify(site) }),
    ...(axe && { "node_modules/@axe-core/playwright/index.js": FAKE_AXE }),
  });
  write(run.run_dir, { "apps.json": JSON.stringify({ profile: "default", apps: { web: { port: 4321, url: "http://localhost:4321/", ok: true } } }) });
  const capture = (states) => {
    const file = path.join(run.run_dir, "ui-states.json");
    fs.writeFileSync(file, JSON.stringify({ states }));
    return script("capture-states.mjs", p.dir, [file, "--run", run.id]);
  };
  const calls = () => fs.existsSync(path.join(fake, "calls.jsonl"))
    ? fs.readFileSync(path.join(fake, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const read = (f) => JSON.parse(fs.readFileSync(path.join(run.run_dir, f), "utf8"));
  return { ...run, capture, calls, read };
}
const contexts = (calls) => calls.filter((c) => c.call === "newContext");
const of = (calls, ctx) => calls.filter((c) => c.ctx === ctx);
const SIGNUP = "http://localhost:{port:web}/signup";
const MATRIX = ["390-light", "390-dark", "768-light", "768-dark", "1440-light", "1440-dark"];  // each state's captures, in order

test("design fix 11: every state the plan names is captured at 390, 768 and 1440 px in light and dark, in Chromium, with the clipboard granted and animations settled", () => {
  const run = setup();
  const names = ["empty", "loading", "error", "focus", "hover", "disabled", "returning-visit"];
  const r = run.capture(names.map((name) => ({ name, url: SIGNUP })));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = run.calls();
  assert.deepEqual(calls.filter((c) => c.call === "launch").map((c) => c.browser), ["chromium"], "one browser, Chromium only");
  const shots = contexts(calls).map((c) => `${c.options.viewport.width}-${c.options.colorScheme}`);
  assert.deepEqual(shots, names.flatMap(() => MATRIX), "each state at every width in both schemes");
  const files = names.flatMap((n) => MATRIX.map((x) => `captures/${n}-${x}.png`));
  for (const f of files) assert.ok(fs.existsSync(path.join(run.run_dir, f)), `${f} was written`);
  assert.deepEqual(run.read("captures/states.json").captures.map((c) => c.file), files);
  for (const c of contexts(calls)) {
    assert.deepEqual([...c.options.permissions].sort(), ["clipboard-read", "clipboard-write"], "a Copied state is real");
    const steps = of(calls, c.ctx);
    assert.deepEqual(steps.find((s) => s.call === "goto").url, "http://localhost:4321/signup", "the port comes from apps.json");
    const shot = steps.findIndex((s) => s.call === "screenshot");
    assert.equal(steps[shot].options.animations, "disabled");
    assert.equal(steps[shot - 1].call, "waitForTimeout", "the page settles before its picture");
    assert.ok(steps[shot - 1].ms > 0);
    assert.equal(steps.at(-1).call, "context.close", "a fresh context per capture");
  }
});

test("design fix 11: a state is reached as the plan says: a held request for loading, a blocked one for an error, stored data for a returning visit, then its actions in order", () => {
  const run = setup();
  const names = ["loading", "error", "returning-visit", "disabled"];
  const r = run.capture([
    { name: "loading", url: SIGNUP, setup: { hold: ["**/api/plans"] } },
    { name: "error", url: SIGNUP, setup: { block: ["**/api/**"] } },
    { name: "returning-visit", url: SIGNUP, setup: { localStorage: { "signup.email": "a@b.co" } } },
    { name: "disabled", url: SIGNUP, actions: [{ fill: ["#email", "not an email"] }, { press: "Tab" }, { focus: "#submit" },
      { hover: "#submit" }, { click: "#terms" }, { waitFor: "#submit[disabled]" }, { wait: 200 }] },
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = run.calls();
  // what the first capture of a state did before its settle and its picture
  const steps = (name) => of(calls, contexts(calls)[names.indexOf(name) * 6].ctx)
    .filter((s) => !["newContext", "screenshot", "context.close"].includes(s.call)).slice(0, -1)
    .map(({ call, pattern, url, key, value, sel, text, ms }) => [call, pattern ?? url ?? key ?? sel ?? ms, value ?? text].filter((x) => x !== undefined).join(" "));
  assert.deepEqual(steps("loading"), ["route **/api/plans", "goto http://localhost:4321/signup"], "held, never answered, so the loading view is pictured");
  assert.deepEqual(steps("error"), ["route **/api/**", "route.abort **/api/**", "goto http://localhost:4321/signup"]);
  assert.deepEqual(steps("returning-visit"), ["goto http://localhost:4321/signup", "localStorage.setItem signup.email a@b.co", "reload"]);
  assert.deepEqual(steps("disabled"), ["goto http://localhost:4321/signup", "fill #email not an email", "press Tab", "focus #submit",
    "hover #submit", "click #terms", "waitForSelector #submit[disabled]", "waitForTimeout 200"]);
});

test("design fix 23: the 390 px captures have touch, so (pointer: coarse) rules are pictured; 768 and 1440 px keep a fine pointer", () => {
  const run = setup();
  const r = run.capture([{ name: "empty", url: SIGNUP }, { name: "focus", url: SIGNUP, actions: [{ press: "Tab" }] }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const each = ["390 true", "390 true", "768 false", "768 false", "1440 false", "1440 false"];
  assert.deepEqual(contexts(run.calls()).map((c) => `${c.options.viewport.width} ${c.options.hasTouch}`), [...each, ...each]);
});

test("every capture is at deviceScaleFactor 1, so each picture is 1x at every width", () => {
  const run = setup();
  const r = run.capture([{ name: "empty", url: SIGNUP }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(contexts(run.calls()).map((c) => [c.options.viewport.width, c.options.deviceScaleFactor]),
    [[390, 1], [390, 1], [768, 1], [768, 1], [1440, 1], [1440, 1]]);
});

test("each capture records whether its page scrolls sideways, for the lens's 390 px check", () => {
  const run = setup({ site: { pages: { "/pricing": { scrollWidth: 520 } } } });
  const r = run.capture([{ name: "empty", url: SIGNUP }, { name: "plans", url: "http://localhost:{port:web}/pricing" }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(run.read("captures/states.json").captures.filter((c) => c.overflow).map((c) => c.file),
    ["captures/plans-390-light.png", "captures/plans-390-dark.png"], "520 px of content overflows 390 px only");
  assert.ok(run.read("captures/states.json").captures.every((c) => typeof c.overflow === "boolean"));
});

test('axe.json says axe: "missing" when the project has no @axe-core/playwright, and holds each capture\'s violations when it has', () => {
  const without = setup();
  assert.equal(without.capture([{ name: "empty", url: SIGNUP }]).status, 0);
  assert.deepEqual(without.read("captures/axe.json"), { axe: "missing" }, "never an empty list, which would read as a pass");
  const withAxe = setup({ axe: true });
  const r = withAxe.capture([{ name: "empty", url: SIGNUP }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { axe } = withAxe.read("captures/axe.json");
  assert.deepEqual(axe.map((a) => a.file), MATRIX.map((x) => `captures/empty-${x}.png`));
  for (const a of axe) assert.deepEqual(a.violations, [{ id: "image-alt", impact: "critical", nodes: 2 }]);
});

test("a state that couldn't be captured exits 1 with the rest still captured, its error in states.json and the full output saved, printing a digest", () => {
  const run = setup({ site: { pages: { "/signup": { missing: ["#coupon"], console: ["TypeError: coupons is undefined"] } } } });
  write(run.run_dir, { "captures/coupon-390-light.png": "an earlier run's picture" });
  const r = run.capture([{ name: "empty", url: SIGNUP }, { name: "coupon", url: SIGNUP, actions: [{ click: "#coupon" }] }]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const { captures } = run.read("captures/states.json");
  assert.equal(captures.filter((c) => c.file).length, 6, "the other state's captures are all taken");
  assert.deepEqual(captures.filter((c) => c.error).map((c) => `${c.state}-${c.width}-${c.scheme}: ${c.error}`),
    MATRIX.map((x) => `coupon-${x}: page.click: Timeout 30000ms exceeded.`));
  const log = path.join(run.run_dir, "logs/capture-states.log"), full = fs.readFileSync(log, "utf8");
  assert.match(full, /coupon-390-light\.png[^\n]*\n[^]*waiting for locator\('#coupon'\)/, "the full error, call log included");
  assert.match(full, /captures\/coupon-390-light\.png console error: TypeError: coupons is undefined/, "and what the page logged");
  assert.match(r.stdout, /page\.click: Timeout 30000ms exceeded\./, "the digest quotes the error word for word");
  assert.match(r.stdout, /console error: TypeError: coupons is undefined/);
  assert.equal(r.stdout.trim().split("\n").at(-1), `full output: ${log}`);
  assert.ok(!fs.existsSync(path.join(run.run_dir, "captures/coupon-390-light.png")), "no older picture stands in for it");
});

test("Playwright comes from the project: an app's own @playwright/test serves, and with none in the project it exits 2 and captures nothing", () => {
  const recipe = { apps: [{ name: "web", type: "web", path: "web", checks: { test: "true" } }] };
  const inApp = setup({ recipe, playwright: "web/node_modules/@playwright/test" });
  const r = inApp.capture([{ name: "empty", url: SIGNUP }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(contexts(inApp.calls()).length, 6);
  const none = setup({ playwright: null });
  const n = none.capture([{ name: "empty", url: SIGNUP }]);
  assert.equal(n.status, 2, n.stdout + n.stderr);
  assert.match(n.stderr, /no playwright or @playwright\/test in /);
  assert.ok(!fs.existsSync(path.join(none.run_dir, "captures")));
});

test("a state list it can't run as written exits 2 before Chromium starts: no name, a repeated name, an unknown action, or an app with no port in apps.json", () => {
  const run = setup();
  for (const states of [[{ url: SIGNUP }], [{ name: "empty", url: SIGNUP }, { name: "empty", url: SIGNUP }],
    [{ name: "typo", url: SIGNUP, actions: [{ clik: "#submit" }] }], [{ name: "admin", url: "http://localhost:{port:admin}/" }]]) {
    const r = run.capture(states);
    assert.equal(r.status, 2, `${JSON.stringify(states)}: ${r.stdout}${r.stderr}`);
  }
  assert.match(run.capture([{ name: "admin", url: "http://localhost:{port:admin}/" }]).stderr, /bring the apps up first \(run-apps up\)/);
  assert.deepEqual(run.calls(), [], "Chromium never started");
  assert.ok(!fs.existsSync(path.join(run.run_dir, "captures")));
});

test("a Chromium that won't launch exits 1 with its error in the saved output and the digest, and no captures", () => {
  const run = setup({ site: { launch: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1234/chrome" } });
  const r = run.capture([{ name: "empty", url: SIGNUP }]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Executable doesn't exist at \/ms-playwright\/chromium-1234\/chrome/);
  assert.equal(r.stdout.trim().split("\n").at(-1), `full output: ${path.join(run.run_dir, "logs/capture-states.log")}`);
  assert.deepEqual(run.read("captures/states.json").captures, [], "an old set never stands in for this one");
});
