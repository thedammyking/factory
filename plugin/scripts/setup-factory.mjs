#!/usr/bin/env node
// setup-factory.mjs — what /setup-factory runs. Nothing is written in the project before apply.
//   setup-factory.mjs detect [--mcp <a,b>]   -> checks the prerequisites (a package.json, a GitHub remote, a signed-in gh)
//                                              and exits 1 with the fix for each one missing; otherwise prints the proposal
//                                              as one JSON object and keeps it in the git dir for the next commands. --mcp
//                                              names the MCP servers (linear, notion, figma, mobbin) visible in the setup
//                                              session's own tool list. On a re-run the existing .factory/ values are kept,
//                                              detection fills only what's missing, and each field it disagrees with is listed.
//   setup-factory.mjs prove [<app>.<name> ...] -> runs every check and dev command in the proposal once (or only those named),
//                                              in the recipe's environment, each dev command on a free port until its health
//                                              URL answers, and the checks that need apps while they're up; records each
//                                              one's wall-clock seconds in the proposal; exits 1 when any failed
//   setup-factory.mjs set <field> [<value>]  -> sets one field of the proposal to the value, or to stdin without one;
//                                              null drops the field
//   setup-factory.mjs apply [--tracker <t>] [--dry-run] -> --dry-run prints the proposal: every detected value with its
//                                              source, guesses marked, and each file's diff. Without it, refuses a command
//                                              that wasn't proven, then writes .factory/, the .gitignore entries and the
//                                              CLAUDE.md block, installs Playwright and axe for a web app lacking them, and
//                                              prints the closing notes. Writing an applied proposal again changes nothing.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, runEnv } from "./lib.mjs";

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !["--mcp", "--tracker"].includes(all[i - 1]));
const exists = (...p) => fs.existsSync(path.join(...p));
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: "utf8", timeout: 30_000, ...opts });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function die(msg) { console.error(`setup-factory: ${msg}`); process.exit(2); }

const MCPS = ["linear", "notion", "figma", "mobbin"];
const LOCKS = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
// Workspace indicators, first match wins: a config file in the app's dir or a dependency. A dependency that many kinds of
// package use is only a guess.
const INDICATORS = [
  { type: "mobile", deps: ["expo", "react-native"] },
  { type: "web", files: /^(next|nuxt|astro|svelte|vite)\.config\.[cm]?[jt]s$/, deps: ["next", "nuxt", "astro", "@sveltejs/kit", "@remix-run/dev", "@react-router/dev"] },
  { type: "backend", files: /^nest-cli\.json$/, deps: ["@nestjs/core"] },
  { type: "backend", deps: ["express", "fastify", "hono", "koa"], guess: true },
];
// check name -> the package.json scripts that provide it, first present wins
const CHECKS = {
  typecheck: ["typecheck", "type-check", "check-types", "tsc"], lint: ["lint"], test: ["test"], build: ["build"],
  e2e: ["e2e", "test:e2e"], integration: ["integration", "test:integration"],
};
const NEEDS_APPS = ["e2e", "integration"];
const AUTH = [
  [/^(next-auth|@auth\/)/, "Auth.js"], [/^@clerk\//, "Clerk"], [/^@supabase\/(ssr|auth-)/, "Supabase Auth"],
  [/^@supabase\/supabase-js$/, "Supabase Auth", true], [/^@react-native-firebase\/auth$/, "Firebase Auth"],
  [/^firebase(-admin)?$/, "Firebase Auth", true], [/^better-auth$/, "Better Auth"], [/^lucia$/, "Lucia"],
  [/^@auth0\//, "Auth0"], [/^@kinde-oss\//, "Kinde"], [/^@workos-inc\/authkit/, "WorkOS AuthKit"], [/^(@nestjs\/)?passport$/, "Passport"],
];
// config.security name -> the binary that makes it installed; audit is the package manager's and always on
const SCANNERS = [["gitleaks", "gitleaks"], ["audit", null], ["osv", "osv-scanner"], ["semgrep", "semgrep"]];
const PREFIXES = { feature: "feature/", bugfix: "bugfix/", hotfix: "hotfix/" };
const TRACKERS = ["github", "linear", "local"];
const PLAYWRIGHT = ["@playwright/test", "@axe-core/playwright"];
const ADD = { npm: ["install", "-D"], pnpm: ["add", "-D"], yarn: ["add", "-D"], bun: ["add", "-d"] };
const EXEC = { npm: ["npx"], pnpm: ["pnpm", "exec"], yarn: ["yarn"], bun: ["bunx"] };
const GITIGNORE = [".factory/runs/", ".factory/worktrees/", ".factory/env.local"];

const onPath = (bin) => (process.env.PATH || "").split(path.delimiter).some((d) => {
  try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; }
});
const ghJson = (endpoint) => { const r = run("gh", ["api", endpoint]); try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };

// owner/repo of the first GitHub remote, origin first, with the remote's name
function githubRepo(root) {
  let remotes; try { remotes = git(root, "remote").split("\n").filter(Boolean); } catch { return null; }
  for (const r of [...remotes.filter((x) => x === "origin"), ...remotes.filter((x) => x !== "origin")]) {
    const m = git(root, "remote", "get-url", r).match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (m) return { slug: `${m[1]}/${m[2]}`, remote: r };
  }
  return null;
}

function prerequisites(root, repo) {
  const missing = [];
  if (!exists(root, "package.json")) missing.push(`no package.json in ${root}\n  fix: \`npm init -y\` (or your package manager's init), then run /setup-factory again`);
  if (!repo) missing.push("no GitHub remote\n  fix: `git remote add origin git@github.com:<owner>/<repo>.git` (or `gh repo create --source . --push`), then run /setup-factory again");
  const auth = run("gh", ["auth", "status"]);
  if (auth.status !== 0) missing.push(`gh isn't signed in${auth.error ? " (gh isn't installed: https://cli.github.com)" : ""}\n  fix: \`gh auth login\`, then run /setup-factory again`);
  return missing;
}

// The workspace packages' dirs, relative to root, from package.json workspaces or pnpm-workspace.yaml; ["."] without any.
function workspaceDirs(root, pkg) {
  let patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  if (exists(root, "pnpm-workspace.yaml")) {
    let inPackages = false;
    patterns = [];
    for (const line of fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
      if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line);
      else if (inPackages) { const m = line.match(/^\s+-\s*["']?([^"'#\s]+)["']?/); if (m) patterns.push(m[1]); }
    }
  }
  if (!patterns.length) return ["."];
  const subdirs = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")).map((e) => path.posix.join(dir, e.name));
  const expand = (dir, segs) => {
    if (!segs.length) return [dir];
    const [s, ...rest] = segs;
    if (s === "**") return [...expand(dir, rest), ...subdirs(dir).flatMap((d) => expand(d, segs))];
    const re = new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);
    return exists(root, dir) ? subdirs(dir).filter((d) => re.test(path.posix.basename(d))).flatMap((d) => expand(d, rest)) : [];
  };
  const match = (p) => expand(".", p.replace(/^\.\//, "").replace(/\/+$/, "").split("/")).filter((d) => exists(root, d, "package.json"));
  const out = new Set(patterns.filter((p) => !p.startsWith("!")).flatMap(match));
  for (const p of patterns.filter((p) => p.startsWith("!"))) for (const d of match(p.slice(1))) out.delete(d);
  return [...out].sort();
}

const serves = (app) => app.type === "web" || app.type === "backend";  // what has a dev server and a preview

// One app of the recipe, or null for a package with no indicator and no checks. `add` records each value's source, and
// found.pinned and found.auth collect the app's pinned directory and auth library.
function detectApp(root, dir, name, pm, add, found) {
  const pkg = readJson(path.join(root, dir, "package.json"), {});
  const scripts = pkg.scripts || {}, deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const at = (f) => path.posix.join(dir, f);
  const files = fs.readdirSync(path.join(root, dir));
  const app = { name, type: "other", path: dir };
  let typeSource = ["no workspace indicator", false];
  for (const ind of INDICATORS) {
    const file = ind.files && files.find((f) => ind.files.test(f)), dep = ind.deps.find((d) => deps[d]);
    if (file || dep) { app.type = ind.type; typeSource = file ? [at(file), false] : [`${at("package.json")} dependency ${dep}`, !!ind.guess]; break; }
  }
  const checks = {};
  for (const [check, names] of Object.entries(CHECKS)) {
    const script = names.find((s) => scripts[s] && !/no test specified/.test(scripts[s]));
    if (script) checks[check] = [`${pm} run ${script}`, `${at("package.json")} scripts.${script}`];
  }
  if (app.type === "other" && !Object.keys(checks).length) return null;
  add(`apps.${name}.type`, app.type, ...typeSource);
  const devScript = ["dev", "start:dev", "start"].find((s) => scripts[s]);
  if (devScript && serves(app)) {
    // a web framework takes --port; a server reads PORT
    app.dev = app.type === "web" ? `${pm} run ${devScript}${pm === "npm" ? " --" : ""} --port {port:${name}}` : `PORT={port:${name}} ${pm} run ${devScript}`;
    app.health = `http://localhost:{port:${name}}/`;
    add(`apps.${name}.dev`, app.dev, `${at("package.json")} scripts.${devScript}, ${app.type === "web" ? "the framework's --port flag" : "PORT"}`);
    add(`apps.${name}.health`, app.health, "the app's URL answering");
  }
  app.checks = Object.fromEntries(Object.entries(checks).map(([c, [command, src]]) => { add(`apps.${name}.checks.${c}`, command, src); return [c, command]; }));
  if (!checks.test) add(`apps.${name}.checks.test`, null, "no test script, and verify fails an app without one");
  const needsApps = Object.keys(checks).filter((c) => NEEDS_APPS.includes(c));
  if (needsApps.length) { app.needs_apps = needsApps; add(`apps.${name}.needs_apps`, needsApps, "checks named e2e or integration"); }
  // the app's pinned directory, where qa's tests live: Playwright's for a web app, an API's node:test files, Maestro's flows
  if (app.type !== "other") {
    const config = files.find((f) => /^playwright\.config\.[cm]?[jt]s$/.test(f));
    const testDir = app.type === "web" && config && fs.readFileSync(path.join(root, dir, config), "utf8").match(/testDir\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    const pinned = app.type === "mobile" ? ".maestro" : testDir || "e2e";
    found.pinned[name] = path.posix.normalize(at(pinned)).replace(/\/+$/, "");
    add("pinned", found.pinned[name], testDir ? `${at(config)} testDir` : files.includes(pinned) ? `${at(pinned)}/` : `default for a ${app.type} app`);
  }
  const lib = Object.keys(deps).map((d) => [d, AUTH.find(([re]) => re.test(d))]).find(([, rule]) => rule);
  if (lib) { found.auth[name] = lib[1][1]; add(`auth.${name}`, lib[1][1], `${at("package.json")} dependency ${lib[0]}`, !!lib[1][2]); }
  return app;
}

// Fresh detection over what's kept: a kept value always wins, a missing one is filled, and where both exist and differ the
// field goes on `disagree` (when one is given: plugin defaults are filled but never flagged). Inside a kept app nothing is
// filled (`fill` false): a command the human dropped stays dropped, and is flagged instead.
function merge(kept, fresh, at, disagree, fill = true) {
  if ((kept === undefined || kept === null) && (fill || fresh === undefined)) return fresh === undefined ? kept : fresh;
  if (isObj(kept) && isObj(fresh)) {
    const out = { ...kept };
    for (const k of Object.keys(fresh)) out[k] = merge(kept[k], fresh[k], at ? `${at}.${k}` : k, disagree, fill);
    return out;
  }
  if (kept === undefined) { disagree?.push({ field: at, kept: null, detected: fresh }); return kept; }
  if (disagree && fresh !== undefined && fresh !== null && JSON.stringify(kept) !== JSON.stringify(fresh)) disagree.push({ field: at, kept, detected: fresh });
  return kept;
}

function detect(root, repo, mcp) {
  const sources = [], disagreements = [], found = { auth: {}, pinned: {} };
  const add = (field, value, source, guess = false) => sources.push({ field, value, source, guess });
  const pkg = readJson(path.join(root, "package.json"), {});
  const lock = LOCKS.find(([f]) => exists(root, f)), declared = pkg.packageManager?.split("@")[0];
  const pm = lock?.[1] || (ADD[declared] ? declared : "npm");
  add("package_manager", pm, lock?.[0] || (ADD[declared] ? "package.json packageManager" : "default"));
  // an app is named for its directory (the package, at the root), or for its whole path when another directory shares the name
  const dirs = workspaceDirs(root, pkg), base = (d) => path.posix.basename(d);
  const nameOf = (d) => d === "." ? pkg.name?.split("/").pop() || path.basename(root)
    : dirs.filter((x) => base(x) === base(d)).length > 1 ? d.replaceAll("/", "-") : base(d);
  const apps = dirs.map((d) => detectApp(root, d, nameOf(d), pm, add, found)).filter(Boolean);
  const info = ghJson(`repos/${repo.slug}`);

  // previews: one read of recent deployments; an app named by a non-production environment is matched, and a web app no
  // environment names takes one left over, as a guess
  const deployments = ghJson(`repos/${repo.slug}/deployments?per_page=100`) || [];
  const envs = [...new Set(deployments.filter((d) => !d.production_environment && !/prod/i.test(d.environment)).map((d) => d.environment))];
  const preview = {}, unmatched = [];
  for (const a of apps.filter(serves)) {
    const env = envs.find((e) => e.toLowerCase().includes(a.name.toLowerCase()));
    if (env) { preview[a.name] = { mode: "github-deployment", environment: env }; add(`preview.${a.name}`, preview[a.name], `gh api deployments: environment "${env}"`); }
    else { preview[a.name] = { mode: "local" }; unmatched.push(a); }
  }
  const leftover = envs.filter((e) => !Object.values(preview).some((p) => p.environment === e));
  for (const a of unmatched) {
    const env = a.type === "web" && leftover.shift();
    if (env) preview[a.name] = { mode: "github-deployment", environment: env };
    add(`preview.${a.name}`, preview[a.name], env ? `gh api deployments: environment "${env}" names no app` : deployments.length ? "no deployment environment names it" : "no recent deployments", !!env);
  }

  const hasBranch = (b) => [`refs/heads/${b}`, `refs/remotes/${repo.remote}/${b}`].some((ref) => {
    try { git(root, "show-ref", "--verify", "--quiet", ref); return true; } catch { return false; }
  });
  const flow = hasBranch("develop"), defaultBranch = info?.default_branch || "main";
  const main = defaultBranch !== "develop" ? defaultBranch : ["main", "master"].find(hasBranch) || "main";
  const branching = { model: flow ? "git-flow" : "trunk", main, ...(flow && { develop: "develop" }), prefixes: PREFIXES };
  add("branching.model", branching.model, flow ? "branch develop exists" : "no develop branch");
  add("branching.main", main, info ? `gh api repos/${repo.slug} default_branch` : "default (repo unreadable)", !info);
  // the model's method if the repo allows it, else the first it allows
  const allows = (m) => info?.[m === "merge" ? "allow_merge_commit" : `allow_${m}_merge`] !== false;
  const mergeMethod = [flow ? "merge" : "squash", "merge", "squash", "rebase"].find(allows);
  add("merge_method", mergeMethod, info
    ? `gh api repos/${repo.slug} (allow_merge_commit ${info.allow_merge_commit}, allow_squash_merge ${info.allow_squash_merge}, allow_rebase_merge ${info.allow_rebase_merge})`
    : "the branching model's default (merge settings unreadable)", !info);

  const scanners = Object.fromEntries(SCANNERS.filter(([, bin]) => bin).map(([, bin]) => [bin, onPath(bin)]));
  const security = SCANNERS.filter(([, bin]) => !bin || scanners[bin]).map(([name]) => name);
  add("security", security, "scanners on PATH, audit always");
  for (const m of mcp) add(`mcp.${m}`, true, "this session's tool list");

  const keptRecipe = kept(root, ".factory/setup.json"), keptConfig = kept(root, ".factory/config.json");
  const keptApps = keptRecipe.apps || [], isNew = (x) => !keptApps.some((a) => a.name === x.name);
  const { apps: _, pinned: keptPinned, ...keptRest } = keptRecipe;
  // pinned is one list for the whole recipe: a kept list gains only the new apps' directories
  const pinnedOf = (list) => list.map((a) => found.pinned[a.name]).filter(Boolean);
  let pinned = pinnedOf(apps);
  if (keptPinned !== undefined) {
    const held = [].concat(keptPinned), detected = pinnedOf(apps.filter((x) => !isNew(x)));
    if (detected.some((d) => !held.includes(d))) disagreements.push({ field: "pinned", kept: held, detected });
    pinned = [...held, ...pinnedOf(apps.filter(isNew)).filter((d) => !held.includes(d))];
  }
  const recipe = {
    apps: [...keptApps.map((a) => merge(a, apps.find((x) => x.name === a.name), `apps.${a.name}`, disagreements, false)), ...apps.filter(isNew)],
    pinned,
    ...merge(keptRest, { preview }, "", disagreements),
  };
  const fresh = { merge_method: mergeMethod, branching, security };
  const template = readJson(path.join(TEMPLATES, "config.json"));
  const config = Object.fromEntries([...new Set([...Object.keys(template), ...Object.keys(keptConfig)])]
    .map((k) => [k, merge(keptConfig[k], fresh[k] ?? template[k], k, k in fresh ? disagreements : null)]));

  const tracker = keptConfig.tracker || (mcp.includes("linear") ? "linear" : "github");
  add("tracker", tracker, keptConfig.tracker ? ".factory/config.json" : mcp.includes("linear") ? "Linear MCP in this session" : "no Linear MCP in this session");

  const P = {
    root, repo: repo.slug, package_manager: pm, default_branch: defaultBranch, existing: exists(root, ".factory"), mcp, tracker,
    recipe, config, auth: found.auth, scanners, installs: installs(root, recipe, pm), sources, disagreements,
  };
  return { ...P, notes: closingNotes(P, tracker) };
}

function closingNotes(P, tracker) {
  return [
    "GitHub emails you about the factory's labels and comments only with \"Include your own updates\" on (https://github.com/settings/notifications): it acts as you.",
    `What waits on you: save the search \`is:open is:pr label:factory label:needs-human\` (https://github.com/${P.repo}/pulls?q=is%3Aopen+is%3Apr+label%3Afactory+label%3Aneeds-human).`,
    // GitHub's closing keywords only act on a PR into the default branch
    ...(tracker === "github" && P.config.branching.model === "git-flow" && P.default_branch !== P.config.branching.develop
      ? ["`develop` isn't the default branch, so GitHub won't close a request issue from a PR into it: make `develop` the default branch, or close request issues by hand."] : []),
    ...Object.entries(P.scanners).filter(([, on]) => !on).map(([bin]) => `${bin} isn't installed, so its scan is skipped: \`brew install ${bin}\`.`),
  ];
}

// a kept .factory/ file's values, {} when there is none; one that doesn't parse stops setup rather than be overwritten
function kept(root, file) {
  if (!exists(root, file)) return {};
  try { return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); } catch (e) { die(`${file} isn't valid JSON (${e.message}): fix it, then run /setup-factory again`); }
}

// Each web app missing Playwright or axe, in its package.json and the root's, gets both as dev dependencies, and Chromium.
function installs(root, recipe, pm) {
  const declared = (dir) => { const p = readJson(path.join(root, dir, "package.json"), {}); return { ...p.dependencies, ...p.devDependencies }; };
  return recipe.apps.filter((a) => a.type === "web").flatMap((a) => {
    const have = { ...declared("."), ...declared(a.path) }, missing = PLAYWRIGHT.filter((d) => !have[d]);
    return missing.length ? [{ app: a.name, path: a.path, commands: [[pm, ...ADD[pm], ...missing], [...EXEC[pm], "playwright", "install", "chromium"]] }] : [];
  });
}

// [key, command, app, name] for every check and dev command in the recipe, keyed as prove records them
const commands = (recipe) => recipe.apps.flatMap((a) => [...Object.entries(a.checks || {}), ...(a.dev ? [["dev", a.dev]] : [])]
  .map(([name, command]) => [`${a.name}.${name}`, command, a.name, name]));
const proven = (P, key, command) => P.proof?.[key]?.status === "pass" && P.proof[key].cmd === command;

// Every file apply manages, as [path, its content now (null when absent), its content after]. A kept value always wins;
// the memory files are written only when missing, and CLAUDE.md changes only inside its markers.
function plan(P, tracker) {
  const at = (f) => path.join(P.root, f), now = (f) => fs.existsSync(at(f)) ? fs.readFileSync(at(f), "utf8") : null;
  const template = (f) => fs.readFileSync(path.join(TEMPLATES, f), "utf8");
  const json = (o) => JSON.stringify(o, null, 2) + "\n";
  const budgets = {};
  for (const [key, command, app, name] of commands(P.recipe)) if (proven(P, key, command)) (budgets[app] ||= {})[name] = P.proof[key].seconds;
  const recipe = { ...P.recipe, budgets: merge(P.recipe.budgets, budgets, "budgets", null) };
  const keptRules = kept(P.root, ".factory/touch-rules.json"), rules = merge(keptRules, JSON.parse(template("touch-rules.json")), "", null);
  const pm = P.package_manager;
  const lines = recipe.apps.flatMap((a) => {
    // a check run as `<pm> run <its name>` goes without saying
    const cmds = Object.entries(a.checks || {}).filter(([n, c]) => c !== `${pm} run ${n}`).map(([, c]) => `\`${c}\``);
    return cmds.length ? [`- ${a.path === "." ? "At the root" : `In \`${a.path}\``}: ${cmds.join(", ")}.\n`] : [];
  });
  // replacements are functions, so a `$` in a command or in CLAUDE.md is never read as a pattern
  const block = template("claude-md.md").replace("{commands}\n", () => lines.join(""));
  const claude = now("CLAUDE.md"), marked = /<!-- factory:begin -->[\s\S]*?<!-- factory:end -->\n?/;
  const ignore = now(".gitignore") ?? "", ignored = new Set(ignore.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE.filter((l) => !ignored.has(l));
  return [
    [".factory/config.json", json({ ...P.config, tracker })],
    [".factory/setup.json", json(recipe)],
    [".factory/touch-rules.json", !Object.keys(keptRules).length ? template("touch-rules.json")
      : JSON.stringify(rules) === JSON.stringify(keptRules) ? now(".factory/touch-rules.json") : json(rules)],
    [".factory/index.md", now(".factory/index.md") ?? template("index.md").replace("{apps}", () => recipe.apps.map((a) => `- \`${a.name}\` (${a.type}): \`${a.path}\``).join("\n"))],
    [".factory/log.md", now(".factory/log.md") ?? "# Log\n"],
    [".factory/lessons.md", now(".factory/lessons.md") ?? "# Lessons\n"],
    [".gitignore", missing.length ? `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n` : ignore],
    ["CLAUDE.md", !claude ? block : marked.test(claude) ? claude.replace(marked, () => block) : `${claude}${claude.endsWith("\n") ? "" : "\n"}\n${block}`],
  ].map(([f, after]) => [f, now(f), after]);
}

// a unified diff of one planned file, made by git from two temp copies
function diff(file, before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-diff-"));
  for (const [side, text] of [["a", before], ["b", after]]) if (text !== null) {
    fs.mkdirSync(path.dirname(path.join(dir, side, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, side, file), text);
  }
  const r = run("git", ["diff", "--no-index", "--no-color", "--no-prefix", "--", before === null ? "/dev/null" : `a/${file}`, `b/${file}`], { cwd: dir });
  fs.rmSync(dir, { recursive: true });
  return r.stdout;
}

// The proposal, section E: every detected value with its source and marked guesses, what kept values detection disagrees
// with, the installs, and each file's diff.
function printProposal(P, tracker, files) {
  const cell = (v) => String(v).replaceAll("|", "\\|");
  console.log("## Detected\n\n| Field | Value | Source |\n|---|---|---|");
  for (const s of P.sources) {
    const [value, source] = s.field === "tracker" && tracker !== s.value ? [tracker, "your answer"] : [s.value, s.source];
    const shown = value === null ? "none" : `\`${cell(typeof value === "string" ? value : JSON.stringify(value))}\``;
    console.log(`| \`${s.field}\` | ${shown} | ${cell(source)}${s.guess ? " (guess)" : ""} |`);
  }
  if (P.disagreements.length) {
    console.log("\n## Kept, though detection disagrees\n");
    for (const d of P.disagreements) console.log(`- \`${d.field}\`: kept ${d.kept === null ? "none" : `\`${JSON.stringify(d.kept)}\``}, detected \`${JSON.stringify(d.detected)}\``);
  }
  const planned = installs(P.root, P.recipe, P.package_manager);
  if (planned.length) {
    console.log("\n## Installs\n");
    for (const i of planned) console.log(`- In \`${i.path}\`: ${i.commands.map((c) => `\`${c.join(" ")}\``).join(", then ")}`);
  }
  const changed = files.filter(([, before, after]) => before !== after);
  console.log(`\n## Files\n${changed.length ? "" : "\nNothing changes."}`);
  for (const [f, before, after] of changed) console.log(`\n\`\`\`diff\n${diff(f, before, after).trimEnd()}\n\`\`\``);
}

const proposalFile = (dir) => path.join(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"), "factory-setup.json");
function loadProposal() {
  let file; try { file = proposalFile(process.cwd()); } catch { die("not a git repository: run it in the project's checkout"); }
  return readJson(file) || die("no proposal: run `setup-factory.mjs detect` first");
}
const save = (P) => fs.writeFileSync(P.file, JSON.stringify(P, null, 2) + "\n");

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLines = (text, n = 20) => text.trimEnd().split("\n").slice(-n).map((l) => `  ${l}`).join("\n");
const DEV_WAIT = 120_000, CHECK_WAIT = 10 * 60_000;
// Every command prove starts runs in its own process group, so the whole tree it started stops with it, however prove ends.
const groups = new Set();
const stopGroups = (sig) => { for (const pid of groups) try { process.kill(-pid, sig); } catch {} };
process.on("exit", () => stopGroups("SIGKILL"));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(1));

async function prove(P, only) {
  const want = (key) => !only.length || only.includes(key);
  const ports = {};
  for (const a of P.recipe.apps) if (a.dev) ports[a.name] = await freePort();
  const sub = (s) => s.replace(/\{port:([^}]+)\}/g, (m, name) => ports[name] ?? m);
  // the environment a run's commands get, with each app's port in place of its {port:<app>}
  const env = Object.fromEntries(Object.entries(runEnv(P.root)).map(([k, v]) => [k, v === undefined ? v : sub(v)]));
  P.proof ||= {};
  let failed = 0;
  const record = (key, cmd, ok, t0, why) => {
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    P.proof[key] = { cmd, status: ok ? "pass" : "fail", seconds };
    if (!ok) failed++;
    console.log(`${ok ? "pass" : "fail"}  ${key}  ${seconds}s  ${cmd}${ok ? "" : `\n${why}`}`);
  };
  const check = (a, name) => new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("bash", ["-c", sub(a.checks[name])], { cwd: path.join(P.root, a.path), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    groups.add(child.pid);
    let out = "";
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { out = (out + d).slice(-20_000); });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { out += `\nno exit in ${CHECK_WAIT / 1000}s`; kill(); }, CHECK_WAIT);
    child.on("exit", kill);  // what the check left running, which may hold its output open
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      groups.delete(child.pid);
      record(`${a.name}.${name}`, a.checks[name], code === 0, t0, lastLines(`${out}\nexited ${code ?? signal}`));
      resolve();
    });
  });
  const checks = P.recipe.apps.flatMap((a) => Object.keys(a.checks || {}).filter((n) => want(`${a.name}.${n}`)).map((n) => [a, n]));
  const later = checks.filter(([a, n]) => a.needs_apps?.includes(n));
  for (const c of checks) if (!later.includes(c)) await check(...c);
  // a check that needs apps runs with every app up
  const up = await Promise.all(P.recipe.apps.filter((a) => a.dev && (later.length || want(`${a.name}.dev`))).map(async (a) => {
    const log = path.join(os.tmpdir(), `factory-setup-${process.pid}-${a.name}.log`), fd = fs.openSync(log, "w");
    const child = spawn("bash", ["-c", sub(a.dev)], { cwd: path.join(P.root, a.path), env, detached: true, stdio: ["ignore", fd, fd] });
    groups.add(child.pid);
    fs.closeSync(fd);
    let exited = null;
    const exit = new Promise((resolve) => child.on("exit", (code) => resolve(exited = code ?? "on a signal")));
    const t0 = Date.now(), url = a.health && sub(a.health);
    let ok = false;
    while (url && exited === null && Date.now() - t0 < DEV_WAIT && !ok) {
      ok = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);  // any answer is healthy
      if (!ok) await sleep(250);
    }
    if (!ok) await sleep(100);  // an exit's output lands in the log
    record(`${a.name}.dev`, a.dev, ok, t0, lastLines(fs.readFileSync(log, "utf8") + (!url ? "\nno health URL"
      : exited !== null ? `\nexited ${exited}` : `\nno answer at ${url} in ${DEV_WAIT / 1000}s`)));
    fs.rmSync(log);
    return { child, exit };
  }));
  for (const [a, n] of later) await check(a, n);
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    stopGroups(sig);
    await Promise.race([Promise.all(up.map((u) => u.exit)), new Promise((r) => setTimeout(r, 5000).unref())]);
  }
  groups.clear();
  save(P);
  return failed;
}

switch (cmd) {
  case "detect": {
    let root; try { root = git(process.cwd(), "rev-parse", "--show-toplevel"); } catch { die("not a git repository: run it in the project's checkout"); }
    const repo = githubRepo(root);
    const missing = prerequisites(root, repo);
    if (missing.length) { for (const m of missing) console.error(`setup-factory: ${m}`); process.exit(1); }
    const mcp = (arg("--mcp", "", argv) || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => MCPS.includes(s));
    const proposal = detect(root, repo, mcp);
    proposal.file = proposalFile(root);
    save(proposal);
    console.log(JSON.stringify(proposal, null, 2));
    break;
  }
  case "prove": {
    if (await prove(loadProposal(), args)) process.exit(1);
    break;
  }
  case "set": {
    const [field, raw = fs.readFileSync(0, "utf8").trim()] = args;
    if (!field || !raw) die("set <field> <value>, or the value on stdin");
    const P = loadProposal(), keys = field.split(".");
    // a command such as `true` stays a string: only null, a list, an object or a quoted string is read as JSON
    let value = raw; if (/^(null$|[[{"])/.test(raw)) try { value = JSON.parse(raw); } catch {}
    // a field as the proposal's table names it: apps.<name>.…, pinned and preview.… are the recipe's, branching.… and the
    // like the config's
    if (keys[0] === "tracker") die("the tracker is apply's --tracker");
    if (!["apps", "pinned", "preview"].includes(keys[0]) && !(keys[0] in P.config)) die(`${field} isn't a field setup writes`);
    let node = keys[0] in P.config ? P.config : P.recipe;
    for (const [i, k] of keys.slice(0, -1).entries()) {
      node = Array.isArray(node) ? node.find((a) => a.name === k) : isObj(node[k]) || Array.isArray(node[k]) ? node[k] : (node[k] = {});
      if (!node) die(`no ${keys.slice(0, i + 1).join(".")} in the proposal`);
    }
    const last = keys.at(-1), at = Array.isArray(node) ? node.findIndex((a) => a.name === last) : last;
    if (at === -1) die(`no ${field} in the proposal`);
    if (value !== null) node[at] = value;
    else if (Array.isArray(node)) node.splice(at, 1);
    else delete node[at];
    save(P);
    console.log(`${value === null ? "dropped" : "set"} ${field}`);
    break;
  }
  case "apply": {
    const P = loadProposal(), tracker = arg("--tracker", P.tracker, argv);
    if (!TRACKERS.includes(tracker)) die(`--tracker is one of ${TRACKERS.join(" | ")}`);
    const files = plan(P, tracker);
    if (argv.includes("--dry-run")) { printProposal(P, tracker, files); break; }
    const unproven = commands(P.recipe).filter(([key, command]) => !proven(P, key, command));
    if (unproven.length) {
      console.error(`setup-factory: not proven: ${unproven.map(([key, command]) => `${key} (\`${command}\`)`).join(", ")}; run \`setup-factory.mjs prove\` first`);
      process.exit(1);
    }
    let changed = 0;
    for (const [f, before, after] of files) {
      if (before === after) continue;
      fs.mkdirSync(path.dirname(path.join(P.root, f)), { recursive: true });
      fs.writeFileSync(path.join(P.root, f), after);
      console.log(`wrote ${f}`);
      changed++;
    }
    let failed = false;
    for (const i of installs(P.root, P.recipe, P.package_manager)) for (const [bin, ...rest] of i.commands) {
      if (failed) break;
      console.log(`ran ${[bin, ...rest].join(" ")} in ${i.path}`);
      const r = run(bin, rest, { cwd: path.join(P.root, i.path), timeout: 10 * 60_000 });
      if (r.status !== 0) { failed = true; console.log(`${lastLines(`${r.stdout}${r.stderr}${r.error?.message ?? ""}`)}\nit failed: fix it, then run apply again`); }
      changed++;
    }
    if (!changed) console.log("nothing to write: the project already holds this proposal");
    console.log(`\n## Closing notes\n\n${closingNotes(P, tracker).map((n) => `- ${n}`).join("\n")}`);
    if (failed) process.exit(1);
    break;
  }
  default: die("usage: setup-factory.mjs detect [--mcp <a,b>] | prove [<app>.<name> ...] | set <field> [<value>] | apply [--tracker <t>] [--dry-run]");
}
