#!/usr/bin/env node
// capture-states.mjs <states.json> — capture named UI states (not only per-SC before/after) with the playwright library.
// A state: { name, url, width, height?, scheme: light|dark, setup?: { localStorage?: {k:v}, block?: [urlPattern], delay?: {pattern, ms} },
//            actions?: [ {fill:[selector,text]} | {click:selector} | {press:key} | {focus:selector} | {wait:ms} | {waitFor:selector} ], axe?: true,
//            touch?: boolean (default: width <= 600 -> coarse pointer) }
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { runContext } from "./lib.mjs";

const { ROOT, RUN } = runContext();
// Playwright from the project first (the recipe's e2e dependency: `playwright`, or `@playwright/test`, which re-exports the
// browsers and is the one pnpm leaves resolvable from an app), then PLAYWRIGHT_PKG, then a global install.
const load = (dir) => { for (const m of ["playwright", "@playwright/test"]) { try { return createRequire(path.join(dir, "_.js"))(m); } catch {} } return null; };
const setup = JSON.parse(fs.readFileSync(path.join(ROOT, ".factory/setup.json"), "utf8"));
const globalRoot = () => { try { return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); } catch { return null; } };
const pw = [ROOT, ...(setup.apps || []).map(a => path.join(ROOT, a.path || "."))].map(load).find(Boolean)
  || (process.env.PLAYWRIGHT_PKG && createRequire(import.meta.url)(process.env.PLAYWRIGHT_PKG)) || (globalRoot() && load(globalRoot()));
if (!pw) { console.error("capture-states: no playwright in the project, PLAYWRIGHT_PKG or the global modules"); process.exit(2); }
const { chromium } = pw;
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const outDir = path.join(RUN, "captures"); fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const results = [];
for (const st of spec.states) {
  // Mobile widths default to a touch context so `(pointer: coarse)` rules are pictured (Chromium: hasTouch is enough);
  // a state can force either with `touch: true|false`. Without this, 390px captures showed the fine-pointer rendering.
  const touch = st.touch ?? ((st.width || 390) <= 600);
  const ctx = await browser.newContext({ viewport: { width: st.width || 390, height: st.height || 844 }, colorScheme: st.scheme || "light",
    hasTouch: touch, permissions: st.permissions || ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120)); });
  try {
    if (st.setup?.block) for (const p of st.setup.block) await page.route(p, r => r.abort());
    if (st.setup?.delay) await page.route(st.setup.delay.pattern, async r => { await new Promise(res => setTimeout(res, st.setup.delay.ms)); await r.continue(); });
    if (st.setup?.localStorage) { await page.goto(st.url); await page.evaluate(ls => { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); }, st.setup.localStorage); }
    await page.goto(st.url);
    for (const a of st.actions || []) {
      if (a.fill) await page.fill(a.fill[0], a.fill[1]);
      else if (a.click) await page.click(a.click);
      else if (a.press) await page.keyboard.press(a.press);
      else if (a.focus) await page.focus(a.focus);
      else if (a.wait) await page.waitForTimeout(a.wait);
      else if (a.waitFor) await page.waitForSelector(a.waitFor, { timeout: 8000 });
      else if (a.reload) await page.reload();
    }
    const file = path.join(outDir, `${st.name}.png`);
    await page.waitForTimeout(st.settle ?? 450);  // let entry transitions finish
    await page.screenshot({ path: file, fullPage: false, animations: "disabled" });
    const size = fs.statSync(file).size;
    results.push({ name: st.name, file: path.relative(ROOT, file), bytes: size, blank: size < 3000, console_errors: consoleErrors });
    console.log(`captured ${st.name} (${st.width || 390}px ${st.scheme || "light"}) ${size}b${consoleErrors.length ? " console-errors=" + consoleErrors.length : ""}`);
  } catch (e) {
    results.push({ name: st.name, error: String(e.message).slice(0, 160) });
    console.log(`FAILED ${st.name}: ${String(e.message).slice(0, 120)}`);
  }
  await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(RUN, "captures", "states.json"), JSON.stringify({ captured_at: new Date().toISOString(), results }, null, 2) + "\n");
process.exit(results.some(r => r.error) ? 1 : 0);  // a state that could not be pictured is a recapture, not a pass
