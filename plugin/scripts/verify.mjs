#!/usr/bin/env node
// verify.mjs --fast | --full [--reuse <evidence.json>] | --pinned <path> — runs every check in the run worktree's recipe (.factory/setup.json) for
// every app, never stopping at the first failure, and writes the evidence to the run dir: evidence.json for --full,
// evidence-fast.json for --fast (typecheck, lint and test only), so a fast pass never stands in for a full one. Takes
// --run <id>, or derives the run from the run worktree it runs in. Run in a ticket's worktree, it checks that worktree
// instead, and writes to tickets/<NN>/ in the run dir.
//   - --full also runs each pinned test: a file qa named <run>-<NN>-<slug>.test.mjs (node:test) or .spec.ts (Playwright,
//     the project's own) in one of the recipe's `pinned` directories. Each is a check of its own, marked pinned, run in
//     the app whose path holds it while the apps are up, with that app's URL as BASE_URL. The apps go up once for all
//     of a profile's tests and down before the next profile's, a mobile app only when one of them is its own, so an
//     API test never builds it or takes the device. A test named
//     <run>-<NN>-<slug>.<profile>.<ext> runs with the apps up in that profile, FACTORY_PROFILE in its env (design fix 4);
//     a pinned test that passed in the last green --full here (or --reuse's), on a commit that differs from HEAD only in
//     other pinned tests, keeps that pass with reused_from and doesn't run again (#81);
//     a profile the recipe lacks skips it with up's reason. --pinned <path> runs only that test, in the worktree holding
//     it, wherever it's called from, into evidence-pinned.json.
//   - A mobile app's pinned directory holds Maestro flows. Once qa has pinned one there (<run>-<NN>-<slug>-SC-###.yaml),
//     --full runs the directory as one check, marked pinned, with the apps up (run-apps up takes the device's
//     machine-wide lock, down gives the device back): `maestro test --format junit` with MAESTRO_CLI_NO_ANALYTICS=1, its
//     report at logs/maestro-<app>.xml, and a red's digest that report's failures. --pinned <flow> runs that flow alone.
//     With no device in .factory/env.local, or no maestro, it's skipped, never run. maestro_version is in the evidence,
//     and so is platform, ios or android (lib's device: one platform per run), or null when no check of a mobile app
//     ran on a device.
//   - pinned_only marks a red where something failed and every check that didn't pass is pinned, on a clean and
//     trusted tree: qa rules on it.
//   - A check is "<command>" or { cmd, env: [names it needs] }. It runs under bash in its app's path with lib's runEnv,
//     its full output saved to logs/<app>-<check>.log in the run dir (.fast.log or .pinned.log); a failing one carries
//     lib's digest of that output.
//   - A check needing a name .factory/env.local doesn't hold is skipped, never run. An app without a test check fails it.
//   - A check its app lists in needs_apps runs between run-apps up and down in the worktree it checks, with {port:<app>}
//     and {db} filled in its command and env from that worktree's apps.json. When up fails the check is skipped with
//     up's output, since apps that won't come up are the environment's. --full runs run-apps down first, so a stack left
//     up never holds a port an e2e suite's own servers need (design fix 15).
//   - The evidence is pinned to HEAD. It's dirty when the tree is unclean outside .factory/ (the recipe included) or HEAD
//     moved, trusted when the recipe equals HEAD's, and green when every check passed and it's clean and trusted.
//   - red_cause says why it isn't green: inherited when every failing check fails at the base commit too (rerun there in
//     a temp worktree after the recipe's setup), introduced when one doesn't, incomplete when nothing failed on a dirty
//     or untrusted tree, and environment when only skips stand in the way.
// Prints a status line and the digest of each check that didn't pass; exits 0 only when green.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, worktreesDir, runContext, runEnv, digest, fill, device, NO_DEVICE, installOf } from "./lib.mjs";

const mode = ["fast", "full", "pinned"].find((m) => process.argv.includes(`--${m}`));
if (!mode) { console.error("verify: usage: verify.mjs --fast | --full | --pinned <path> [--run <id>]"); process.exit(2); }
const onlyTest = mode === "pinned" && path.resolve(arg("--pinned") ?? "");  // --pinned's file, else false
if (onlyTest && !fs.statSync(onlyTest, { throwIfNoEntry: false })?.isFile()) { console.error(`verify: no pinned test at ${onlyTest}`); process.exit(2); }
if (onlyTest) process.chdir(path.dirname(onlyTest));
const ctx = runContext(), s = readJson(ctx.state), tree = ctx.tree, out = ctx.out;
const RECIPE = ".factory/setup.json", FAST = ["typecheck", "lint", "test"];
let text, recipe; try { text = fs.readFileSync(path.join(tree, RECIPE), "utf8"); recipe = JSON.parse(text); } catch (e) {
  console.error(`verify: no recipe at ${path.join(tree, RECIPE)} (${e.message})`); process.exit(2);
}
let committed = null; try { committed = git(tree, "show", `HEAD:${RECIPE}`); } catch {}
const trusted = committed === text.trim();
// {base} reaches a command only as a quoted reference to the base branch, never as text spliced into it.
const env = runEnv(ctx.MAIN, { FACTORY_BASE: s.base_branch });
const logs = path.join(out, "logs");
fs.mkdirSync(logs, { recursive: true });
const appDir = (root, name) => path.join(root, recipe.apps.find((a) => a.name === name).path || ".");
const mobiles = (recipe.apps || []).filter((a) => a.type === "mobile").map((a) => a.name);
const NOT_RUN = { exit: null, seconds: 0, log: null };
const logOf = (name) => path.join(logs, `${name.replace(/[^\w.-]/g, "_")}${mode === "full" ? "" : `.${mode}`}.log`);
const RUN_APPS = fileURLToPath(new URL("run-apps.mjs", import.meta.url));
const apps = (...args) => spawnSync(process.execPath, [RUN_APPS, ...args, "--run", ctx.id], { encoding: "utf8" });

// Executes one command, its stdout and stderr interleaved into logs/<name>.log.
function execute(cwd, cmd, name, cmdEnv = env) {
  const log = logOf(name);
  const fd = fs.openSync(log, "w"), t0 = Date.now();
  const r = spawnSync("bash", ["-c", cmd.replaceAll("{base}", '"$FACTORY_BASE"')], { cwd, env: cmdEnv, stdio: ["ignore", fd, fd], timeout: 10 * 60_000 });
  if (r.error) fs.writeSync(fd, `\nverify: ${r.error.message}\n`);
  fs.closeSync(fd);
  const status = r.status === 0 ? "pass" : "fail";
  return { status, exit: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10, log,
    digest: status === "fail" ? digest(fs.readFileSync(log, "utf8"), log) : null };
}

// Each failing check's result at the commit the run branched from, the base's merge-base with HEAD, as c.at_base.
// Nothing is recorded when there's no merge-base, its worktree can't be made, or its install fails there: a check that
// can't run at the base proves nothing about it.
// ponytail: reruns the failing checks at the base on every red, --fast too; cache by base commit if it shows in the minutes.
function atBase(failing) {
  let sha; try { sha = git(tree, "merge-base", "HEAD", `refs/heads/${s.base_branch}`); } catch { return; }
  const wt = fs.mkdtempSync(path.join(worktreesDir(ctx.MAIN), ".at-base-"));
  try { git(ctx.MAIN, "worktree", "add", "-q", "--detach", wt, sha); } catch { fs.rmSync(wt, { recursive: true, force: true }); return; }
  try {
    const install = installOf(recipe);
    if (install && execute(wt, install, "setup.at-base").status === "fail") return;
    for (const c of failing) c.at_base = execute(appDir(wt, c.app), c.cmd, `${c.app}-${c.check}.at-base`);
  } finally { git(ctx.MAIN, "worktree", "remove", "--force", wt); }
}

// Brings the apps up in `profile`, hands up's result to run, and brings them down after. A mobile app none of
// `holders`, the apps whose checks run, is left stopped, so it's never built and never takes the device.
// ponytail: every other app goes up, since a web test reaches the API behind it; name each test's apps in the recipe
// if starting one a test doesn't need ever shows in the minutes.
function upFor(profile, holders, run) {
  const skip = mobiles.filter((m) => !holders.includes(m));
  const up = apps("up", "--profile", profile, ...(skip.length ? ["--skip", skip.join(",")] : []));
  try { return run(up); } finally {
    // a down that fails leaves the developer's device unrestored, which the human sees here
    const down = apps("down");
    if (down.status) console.log(`run-apps down failed\n${down.stdout}${down.stderr}`.trim());
  }
}

// Runs a check that needs apps once upFor's `up` brought them up, skipped with up's output when that failed. A pinned
// test gets its path, from its app's, as $FACTORY_PINNED, never spliced into the command, its app's URL as BASE_URL,
// and its profile, the one the apps are up in, as FACTORY_PROFILE.
function withApps(up, app, check, cmd, pinnedPath, extra = {}) {
  if (up.status !== 0) {
    const log = logOf(`${app}-${check}`), output = `run-apps up failed\n${up.stdout}${up.stderr}`;
    fs.writeFileSync(log, output);
    return { status: "skipped", ...NOT_RUN, log, digest: digest(output, log) };
  }
  const recorded = readJson(path.join(out, "apps.json"));
  const filled = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? fill(v, recorded) : v]));
  const url = recorded?.apps?.[app]?.url;
  if (pinnedPath) Object.assign(filled, { FACTORY_PINNED: pinnedPath, FACTORY_PROFILE: profileOf(pinnedPath) }, url && { BASE_URL: new URL(url).origin }, extra);
  return execute(appDir(tree, app), fill(cmd, recorded), `${app}-${check}`, filled);
}

// A Maestro check of the flows at `flows` (from its app's path), as withApps runs one; a red's digest is its JUnit
// report's failures, when it wrote one. maestroSkip says why one is skipped as the environment's, never brought up for:
// no device, or no maestro.
const maestroSkip = (rel) => isMaestro(rel) && (!device(env) ? NO_DEVICE : !maestroVersion ? "maestro --version failed: is Maestro installed?" : null);
function maestro(up, app, check, cmd, flows) {
  const junit = logOf(`maestro-${app}`).replace(/\.log$/, ".xml");
  const c = withApps(up, app, check, cmd, flows, { FACTORY_JUNIT: junit, MAESTRO_CLI_NO_ANALYTICS: "1" });
  const failures = c.status === "fail" ? junitFailures(junit) : [];
  return failures.length ? { ...c, digest: digest(failures.join("\n"), c.log) } : c;
}
// Each failed testcase of a JUnit report as `<name>: <message>`, word for word; [] without a report. An attribute's
// value may hold a `>`, which XML needn't escape there.
// ponytail: named and numeric entities only; read CDATA too if Maestro's report ever uses it.
const XML = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const unxml = (s = "") => s.replace(/&(lt|gt|quot|apos|amp|#x?[0-9a-f]+);/gi, (_, e) => e[0] !== "#" ? XML[e] : String.fromCodePoint(Number(e[1] === "x" ? `0${e.slice(1)}` : e.slice(1))));
function junitFailures(file) {
  let xml; try { xml = fs.readFileSync(file, "utf8"); } catch { return []; }
  return [...xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].flatMap(([, attrs, body = ""]) => {
    const f = body.match(/<(failure|error)\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    return f ? [`${unxml(attrs.match(/\bname="([^"]*)"/)?.[1])}: ${unxml(f[2].match(/\bmessage="([^"]*)"/)?.[1] ?? f[3]).trim()}`] : [];
  });
}

// Pinned tests by file type, each found by qa's naming in a pinned directory, and the app whose path holds one, deepest first.
const RUNNERS = { ".test.mjs": 'node --test "$FACTORY_PINNED"', ".spec.ts": 'npx --no playwright test "$FACTORY_PINNED"' };
const QA_NAMED = /^[a-z0-9][a-z0-9-]*-\d{2}-[a-z0-9-]+\./;  // <run>-<NN>-<slug>.
const runner = (rel) => Object.entries(RUNNERS).find(([ext]) => rel.endsWith(ext))?.[1];
// A test's profile is the name between its slug and its runner's extension (<run>-<NN>-<slug>.<profile>.spec.ts), else
// default, as is every Maestro flow's.
const profileOf = (rel) => {
  const ext = Object.keys(RUNNERS).find((e) => rel.endsWith(e)), stem = ext ? path.basename(rel).slice(0, -ext.length) : "";
  return stem.includes(".") ? stem.slice(stem.indexOf(".") + 1) : "default";
};
const pinnedDirs = [].concat(recipe.pinned ?? []).map((d) => path.normalize(String(d)).replace(/\/+$/, ""));
const holder = (rel) => (recipe.apps || []).map((a) => [a, path.normalize(a.path || ".")])
  .filter(([, p]) => p === "." || rel.startsWith(p + path.sep)).sort(([, a], [, b]) => b.length - a.length)[0]?.[0];
const pinnedTests = onlyTest ? [path.relative(tree, fs.realpathSync(onlyTest))] : mode === "fast" ? [] : pinnedDirs.flatMap((d) => fs.existsSync(path.join(tree, d))
  ? fs.readdirSync(path.join(tree, d)).filter((f) => QA_NAMED.test(f) && runner(f)).sort().map((f) => path.join(d, f)) : []);
// A mobile app's pinned directory holding a flow qa pinned is one Maestro check, run whole as Maestro runs a directory;
// --pinned may name one flow.
const MAESTRO = 'maestro test --format junit --output "$FACTORY_JUNIT" "$FACTORY_PINNED"';
const FLOW = /^[a-z0-9][a-z0-9-]*-\d{2}-[a-z0-9-]+-SC-\d{3}\.yaml$/;  // <run>-<NN>-<slug>-SC-###.yaml
const flowDirs = mode !== "full" ? [] : pinnedDirs.filter((d) => holder(d)?.type === "mobile" && fs.existsSync(path.join(tree, d)) && fs.readdirSync(path.join(tree, d)).some((f) => FLOW.test(f)));
const isMaestro = (rel) => flowDirs.includes(rel) || (FLOW.test(path.basename(rel)) && holder(rel)?.type === "mobile");
if (onlyTest && !(pinnedDirs.some((d) => pinnedTests[0].startsWith(d + path.sep)) && (runner(pinnedTests[0]) || isMaestro(pinnedTests[0])) && holder(pinnedTests[0]))) {
  console.error(`verify: ${pinnedTests[0]} isn't a ${Object.keys(RUNNERS).join(" or ")} in an app's pinned directory (${pinnedDirs.join(", ") || "the recipe has none"}), nor a <run>-<NN>-<slug>-SC-###.yaml flow in a mobile app's`); process.exit(2);
}
pinnedTests.push(...flowDirs);
// A pinned test that passed on this product keeps its pass (#81): when the last green full verify here, or the one
// --reuse names (the ticket's, on its merge), is of a commit that differs from HEAD only in pinned tests, each pinned
// test none of those changes touched is taken from it, with reused_from, and only the rest run. Every other check runs.
const reused = (() => {
  if (mode !== "full" || onlyTest) return {};
  for (const f of [arg("--reuse"), path.join(out, "evidence.json")].filter(Boolean)) {
    const e = readJson(f);
    if (e?.mode !== "full" || !e.green) continue;
    let changed; try { changed = execFileSync("git", ["diff", "--name-only", e.sha, "HEAD"], { cwd: tree, encoding: "utf8" }).split("\n").filter(Boolean); } catch { continue; }
    if (!changed.every((c) => pinnedDirs.some((d) => c.startsWith(d + "/")))) continue;
    const touched = (rel) => changed.some((c) => c === rel || c.startsWith(rel + "/"));
    return Object.fromEntries(e.checks.filter((c) => c.pinned && c.status === "pass" && pinnedTests.includes(c.check) && !touched(c.check))
      .map((c) => [c.check, { ...c, reused_from: c.reused_from ?? e.sha }]));
  }
  return {};
})();

// undefined without a Maestro check, null when maestro --version fails
const maestroVersion = !pinnedTests.some(isMaestro) ? undefined : (() => {
  const r = spawnSync("maestro", ["--version"], { env: { ...env, MAESTRO_CLI_NO_ANALYTICS: "1" }, encoding: "utf8", timeout: 60_000 });
  return r.status === 0 ? r.stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? r.stdout.trim() : null;
})();
if (mode === "full") apps("down");
const before = git(tree, "rev-parse", "HEAD");
const checks = [];
for (const app of onlyTest ? [] : recipe.apps || []) {
  const defs = app.checks || {};
  for (const [check, def] of Object.entries(defs)) {
    if (mode === "fast" && !FAST.includes(check)) continue;
    const { cmd, env: needs = [] } = typeof def === "string" ? { cmd: def } : def;
    const unavailable = needs.filter((name) => !Object.hasOwn(env, name));
    const needsApps = !!app.needs_apps?.includes(check);
    checks.push({ app: app.name, check, cmd, ...(needsApps && { needs_apps: true }), ...(unavailable.length
      ? { status: "skipped", ...NOT_RUN, digest: `${unavailable.join(", ")} not available in .factory/env.local` }
      : needsApps ? upFor("default", [app.name], (up) => withApps(up, app.name, check, cmd)) : execute(appDir(tree, app.name), cmd, `${app.name}-${check}`)) });
  }
  if (!defs.test) checks.push({ app: app.name, check: "test", cmd: null, status: "fail", ...NOT_RUN,
    digest: "required check not in recipe: give the app a test script in its manifest (package.json's scripts.test, say), which the recipe's re-detect picks up" });
}
// A profile's pinned tests run with the apps up once for all of them, and down before the next profile's; the
// evidence keeps the tests' own order.
const ran = { ...reused }, byProfile = {};
for (const rel of pinnedTests.filter((rel) => holder(rel))) (byProfile[profileOf(rel)] ||= []).push(rel);
for (const [profile, rels] of Object.entries(byProfile)) {
  for (const rel of rels) if (!ran[rel] && maestroSkip(rel)) ran[rel] = { status: "skipped", ...NOT_RUN, digest: maestroSkip(rel) };
  const live = rels.filter((rel) => !ran[rel]);
  if (live.length) upFor(profile, live.map((rel) => holder(rel).name), (up) => {
    for (const rel of live) {
      const app = holder(rel), flows = path.relative(path.normalize(app.path || "."), rel);
      ran[rel] = isMaestro(rel) ? maestro(up, app.name, rel, MAESTRO, flows) : withApps(up, app.name, rel, runner(rel), flows);
    }
  });
}
for (const rel of pinnedTests) {
  const app = holder(rel), check = { check: rel, cmd: isMaestro(rel) ? MAESTRO : runner(rel), needs_apps: true, pinned: true };
  checks.push(app ? { app: app.name, ...check, ...ran[rel] } : { app: null, ...check, status: "fail", ...NOT_RUN, digest: "no app's path holds this pinned directory" });
}
// The run's bookkeeping under .factory/ isn't product, but the recipe is. Not lib's git(), whose trim would eat the
// first line's leading status column.
const sha = git(tree, "rev-parse", "HEAD");
const changed = [[".", ":(exclude).factory"], [RECIPE]]
  .flatMap((spec) => execFileSync("git", ["status", "--porcelain", "--", ...spec], { cwd: tree, encoding: "utf8" }).split("\n")).filter(Boolean);
const dirty = changed.length > 0 || sha !== before;
const green = checks.every((c) => c.status === "pass") && !dirty && trusted;
const failed = checks.filter((c) => c.status === "fail");
// ponytail: a check that needs apps isn't rerun at the base, so its red reads introduced; start the base's apps from
// the base worktree if that ever costs a round.
const rerun = failed.filter((c) => c.cmd && !c.needs_apps);
if (rerun.length) atBase(rerun);
// A check missing from the recipe was missing at the base too, for an app the base's recipe had: the guard keeps a run
// from writing the recipe. An app the run added (a re-detect, #78) is the run's to give its checks (#81).
const baseApps = (() => { try { return new Set(JSON.parse(git(tree, "show", `${git(tree, "merge-base", "HEAD", s.base_sha)}:${RECIPE}`)).apps.map((a) => a.name)); } catch { return new Set(); } })();
const red_cause = green ? null
  : failed.length ? (failed.every((c) => (!c.cmd && baseApps.has(c.app)) || c.at_base?.status === "fail") ? "inherited" : "introduced")
  : dirty || !trusted ? "incomplete" : "environment";
const pinned_only = !green && !dirty && trusted && failed.length > 0 && checks.every((c) => c.status === "pass" || c.pinned);
// A recipe with a mobile app records the one platform the run verified it on (lib's device): null unless a check of it
// ran with the apps up there.
const onDevice = checks.some((c) => mobiles.includes(c.app) && c.needs_apps && c.status !== "skipped");
const evidence = { mode, sha, green, dirty, trusted, red_cause, pinned_only, checks, dirty_detail: changed.slice(0, 20), generated_at: new Date().toISOString(),
  ...(maestroVersion !== undefined && { maestro_version: maestroVersion }),
  ...(mobiles.length && { platform: onDevice ? device(env)?.platform ?? null : null }) };
const file = path.join(out, mode === "full" ? "evidence.json" : `evidence-${mode}.json`);
fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");

console.log(`verify ${mode}: green=${green} dirty=${dirty} trusted=${trusted}${red_cause ? ` red_cause=${red_cause}` : ""} sha=${sha.slice(0, 7)} `
  + `${checks.map((c) => `${c.app}/${c.check}=${c.status}`).join(" ")}\nevidence: ${file}`);
for (const c of checks.filter((c) => c.status !== "pass")) console.log(`--- ${c.app}/${c.check} ${c.status}\n${c.digest}`);
process.exit(green ? 0 : 1);
