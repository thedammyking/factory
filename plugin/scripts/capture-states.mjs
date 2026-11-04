#!/usr/bin/env node
// capture-states.mjs <states.json> — pictures each UI state a ticket's plan names, for the UI lens. Takes --run <id>, or
// derives the run from the worktree it runs in. That worktree's apps must be up already (run-apps up there).
//   - <states.json> is {states: [{name, url, setup?, actions?}]}, one per state in the plan's ## UI states, each name
//     unique, lowercase words joined by `-`. {port:<app>} in a url is filled from the worktree's apps.json. A state is
//     reached by its setup, then its actions in order:
//       setup: block [url pattern] (aborted, for an error state), hold [url pattern] (never answered, for a loading
//         state), localStorage {key: value} (stored, then the page reloads, for a returning visit);
//       actions: {fill: [selector, text]}, {click: selector}, {hover}, {focus}, {press: key}, {waitFor: selector}, {wait: ms}.
//   - Each state is captured at 390, 768 and 1440 px wide, in light and dark, by Chromium from the project's own
//     playwright or @playwright/test, each in a fresh context: at deviceScaleFactor 1, since every image an agent reads
//     is 1x; with touch at 390 px, so (pointer: coarse) rules are pictured (design fix 23); with the clipboard granted,
//     so a Copied state is real; and with animations settled before the shot (design fix 11).
//   - Writes captures/<state>-<width>-<scheme>.png in lib's out, the run dir in the run worktree; captures/states.json,
//     each capture's file and overflow (its page scrolls sideways), or its error; and captures/axe.json, each capture's
//     axe violations, or {"axe": "missing"} when the project has no @axe-core/playwright, which the lens never reads as
//     a pass ({"axe": "no web state"} when no state is a page).
//   - A mobile state is {name, app, flow} instead: app a mobile app of the recipe, up on the device run-apps up holds,
//     and flow the Maestro commands that reach the state, as JSON. In light and dark, at the default and the largest text
//     size, each set by run-apps look, it's reached by `maestro test` of a flow that launches the app with its state
//     cleared, runs those commands and waits for animations to end, then pictured at 1x by run-apps shot, as
//     captures/<state>-<scheme>-<default|largest>.png; states.json has each one's platform.
//   - Its full output, each capture's line or error after the errors its page logged (and each flow's Maestro output),
//     goes to logs/capture-states.log in out as it runs. A failure prints lib's digest of the failed captures.
// Exits 0 when every capture was taken, 1 when one wasn't, 2 on bad usage, a url whose app has no port in apps.json, a
// mobile state whose app isn't up on a device, or no Playwright in a project with a page to capture.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, runContext, runEnv, digest, fill } from "./lib.mjs";

const WIDTHS = { 390: 844, 768: 1024, 1440: 900 }, SCHEMES = ["light", "dark"];  // each width's viewport height
const TEXT = ["default", "largest"], RUN_APPS = fileURLToPath(new URL("run-apps.mjs", import.meta.url));
// ponytail: a fixed wait for entry transitions and JS-driven animations; wait on document.getAnimations() if a longer
// one is ever pictured mid-way.
const SETTLE = 450;
const ACTIONS = ["fill", "click", "hover", "focus", "press", "waitFor", "wait"];
const input = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--run");
const states = (input && readJson(input))?.states;
const valid = (s) => typeof s?.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(s.name) && (typeof s.url === "string"
  ? Array.isArray(s.actions ?? []) && (s.actions ?? []).every((a) => ACTIONS.some((k) => k in Object(a)))
  : typeof s.app === "string" && Array.isArray(s.flow));
if (!Array.isArray(states) || !states.length || !states.every(valid) || new Set(states.map((s) => s.name)).size < states.length) {
  console.error(`capture-states: usage: capture-states.mjs <states.json> [--run <id>], the file {states: [{name, url, setup?, actions?} | {name, app, flow}]}, each name unique, each action one of ${ACTIONS.join(", ")}`);
  process.exit(2);
}
const web = states.filter((s) => typeof s.url === "string"), mobile = states.filter((s) => !web.includes(s));
const ctx = runContext(), apps = readJson(path.join(ctx.out, "apps.json"));
const unfilled = web.find((s) => /\{port:[^}]+\}/.test(fill(s.url, apps)));
if (unfilled) { console.error(`capture-states: no port for ${unfilled.url} in apps.json: bring the apps up first (run-apps up)`); process.exit(2); }
const recipe = readJson(path.join(ctx.tree, ".factory/setup.json"), {});
const notMobile = mobile.find((s) => !recipe.apps?.some((a) => a.name === s.app && a.type === "mobile" && a.app_id));
if (notMobile) { console.error(`capture-states: ${notMobile.app} isn't a mobile app with an app_id in the recipe`); process.exit(2); }
const away = mobile.find((s) => !apps?.device?.settings || apps.apps?.[s.app]?.ok !== true);
if (away) { console.error(`capture-states: no device is up for ${away.app}: bring the apps up first (run-apps up)`); process.exit(2); }
// Playwright resolves from the worktree's root or one of its apps, as the project's own code would.
const dirs = [ctx.tree, ...(recipe.apps || []).map((a) => path.join(ctx.tree, a.path || "."))];
const load = (names) => { for (const d of dirs) for (const m of names) try { return createRequire(path.join(d, "_.js"))(m); } catch {} return null; };
const pw = web.length ? load(["playwright", "@playwright/test"]) : null;
if (web.length && !pw) { console.error(`capture-states: no playwright or @playwright/test in ${ctx.tree} or its apps`); process.exit(2); }
const axe = pw && load(["@axe-core/playwright"]), AxeBuilder = axe?.default ?? axe;

const out = path.join(ctx.out, "captures"), LOG = path.join(ctx.out, "logs", "capture-states.log");
for (const d of [out, path.dirname(LOG)]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(LOG, "");
const log = (text) => fs.appendFileSync(LOG, text + "\n");
const captures = [], found = [], failures = [];  // found: each capture's axe violations
let browser;

// One capture of a state in a fresh context, the errors its page logs pushed to `logged`; returns whether it overflows.
async function capture(st, width, height, scheme, file, logged) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: width === 390,
    colorScheme: scheme, permissions: ["clipboard-read", "clipboard-write"] });
  try {
    const page = await context.newPage(), setup = st.setup || {};
    page.on("console", (m) => { if (m.type() === "error") logged.push(`${file} console error: ${m.text()}`); });
    page.on("pageerror", (e) => logged.push(`${file} page error: ${e.message}`));
    for (const p of setup.block || []) await page.route(p, (r) => r.abort());
    for (const p of setup.hold || []) await page.route(p, () => {});
    await page.goto(fill(st.url, apps));
    if (setup.localStorage) {
      await page.evaluate((items) => { for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); }, setup.localStorage);
      await page.reload();
    }
    for (const a of st.actions || []) {
      if (a.fill) await page.fill(...a.fill);
      else if (a.click) await page.click(a.click);
      else if (a.hover) await page.hover(a.hover);
      else if (a.focus) await page.focus(a.focus);
      else if (a.press) await page.keyboard.press(a.press);
      else if (a.waitFor) await page.waitForSelector(a.waitFor);
      else await page.waitForTimeout(a.wait);
    }
    await page.waitForTimeout(SETTLE);
    await page.screenshot({ path: path.join(ctx.out, file), animations: "disabled" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (AxeBuilder) {
      const { violations } = await new AxeBuilder({ page }).analyze();
      found.push({ file, violations: violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })) });
    }
    return overflow;
  } finally { await context.close(); }
}

// The mobile branch: in each look, set through run-apps, each mobile state is reached by its flow from a fresh launch
// (maestro test), then pictured at 1x by run-apps shot.
function onDevice() {
  const said = (r) => `${r.stdout || ""}${r.stderr || ""}`.trim();
  const runApps = (...a) => spawnSync(process.execPath, [RUN_APPS, ...a, "--run", ctx.id], { encoding: "utf8" });
  for (const scheme of SCHEMES) for (const text of TEXT) {
    const look = runApps("look", scheme, text);
    for (const st of mobile) {
      const at = { state: st.name, platform: apps.device.platform, scheme, text }, name = `${st.name}-${scheme}-${text}`;
      const file = `captures/${name}.png`, flow = path.join(ctx.out, "logs", `capture-${st.name}.yaml`);
      const steps = [{ launchApp: { clearState: true } }, ...st.flow, { waitForAnimationToEnd: { timeout: 5000 } }];
      let error = null, detail = null;  // states.json's one line, and the full output for the log and the digest
      if (look.status) error = detail = `run-apps look ${scheme} ${text}: ${said(look)}`;
      else {
        // YAML takes each step as JSON, so a step's text never needs YAML's quoting
        fs.writeFileSync(flow, `appId: ${JSON.stringify(recipe.apps.find((a) => a.name === st.app).app_id)}\n---\n${steps.map((s) => `- ${JSON.stringify(s)}\n`).join("")}`);
        const m = spawnSync("maestro", ["test", flow], { env: runEnv(ctx.MAIN, { MAESTRO_CLI_NO_ANALYTICS: "1" }), encoding: "utf8", timeout: 600_000 });
        log(`maestro test ${flow}\n${said(m)}`);
        if (m.status !== 0) { error = `maestro test ${m.error ? m.error.message : `exited ${m.status}`}`; detail = `${error}\n${said(m)}`; }
        else { const shot = runApps("shot", name); if (shot.status) error = detail = said(shot); }
      }
      if (!error) { captures.push({ ...at, file }); log(`captured ${file}`); continue; }
      fs.rmSync(path.join(ctx.out, file), { force: true });  // no older picture stands for this state
      captures.push({ ...at, error });
      failures.push(`FAILED ${file}: ${detail}`);
      log(failures.at(-1));
    }
  }
}

try {
  if (web.length) browser = await pw.chromium.launch();
  for (const st of web) for (const [w, height] of Object.entries(WIDTHS)) for (const scheme of SCHEMES) {
    const width = Number(w), at = { state: st.name, width, scheme }, file = `captures/${st.name}-${width}-${scheme}.png`, logged = [];
    try {
      const overflow = await capture(st, width, height, scheme, file, logged);
      captures.push({ ...at, file, overflow });
      log([...logged, `captured ${file}${overflow ? " (overflow)" : ""}`].join("\n"));
    } catch (e) {
      fs.rmSync(path.join(ctx.out, file), { force: true });  // no picture, not even an older one, stands for this state
      captures.push({ ...at, error: e.message.split("\n")[0] });
      failures.push([...logged, `FAILED ${file}: ${e.stack || e.message}`].join("\n"));
      log(failures.at(-1));
    }
  }
} catch (e) { failures.push(`FAILED to launch Chromium: ${e.stack || e.message}`); log(failures.at(-1)); }
await browser?.close();
if (mobile.length) onDevice();

const save = (f, data) => fs.writeFileSync(path.join(out, f), JSON.stringify(data, null, 2) + "\n");
save("states.json", { captured_at: new Date().toISOString(), captures });
const axed = !web.length ? "no web state" : AxeBuilder ? "ran" : "missing";
save("axe.json", { axe: axed === "ran" ? found : axed });
const taken = captures.filter((c) => c.file), overflowing = taken.filter((c) => c.overflow).length;
console.log(`capture-states: ${taken.length} of ${(web.length * Object.keys(WIDTHS).length + mobile.length * TEXT.length) * SCHEMES.length} captures in ${out}`
  + `${overflowing ? `, ${overflowing} overflowing` : ""}, axe ${axed}`);
if (failures.length) console.log(digest(failures.join("\n"), LOG));
process.exit(failures.length ? 1 : 0);
