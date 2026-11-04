#!/usr/bin/env node
// setup-factory.mjs — what /setup-factory runs. Nothing but the untracked .factory/env.local is written in the project
// before apply, and no env value is ever printed or kept in the proposal.
//   setup-factory.mjs detect [--mcp <a,b>]   -> checks the prerequisites (a GitHub remote, a signed-in gh)
//                                              and exits 1 with the fix for each one missing; otherwise prints the proposal
//                                              as one JSON object and keeps it in the git dir for the next commands. --mcp
//                                              names the MCP servers (linear, notion, figma, mobbin) visible in the setup
//                                              session's own tool list. On a re-run the existing .factory/ values are kept,
//                                              detection fills only what's missing, and each field it disagrees with is listed.
//                                              The recipe's env names each variable the env files do, with its purpose. A repo
//                                              with no package.json is empty: its package manager is pnpm, its recipe no apps.
//   setup-factory.mjs env                    -> section C: copies each of those variables' values from the developer's env
//                                              files into .factory/env.local, keeping every line already there, and prints
//                                              one line per variable: copied, kept or a gap, never its value.
//   setup-factory.mjs probe                  -> section C's login wall: the latest deployment of the branch auto would merge
//                                              into (develop under git flow, else main), as GitHub has it for that
//                                              branch's tip, gets lib's loginWall GET with the recipe's smoke.headers.
//                                              Prints a line per deployed URL, `wall` or `no wall`, its status and a
//                                              redirect's host, and the headers by name only; exits 1 on a wall.
//   setup-factory.mjs prove [<app>.<name> ...] -> runs every check and dev command in the proposal once (or only those named),
//                                              in the recipe's environment, each dev command on a free port until its health
//                                              URL answers, and the checks that need apps while they're up; records each
//                                              one's wall-clock seconds in the proposal; exits 1 when any failed. A check
//                                              { cmd, env: [names] } needing a name .factory/env.local lacks is skipped.
//                                              With semgrep on, it proves the project rules too, as `semgrep`.
//   setup-factory.mjs mobile                 -> for a recipe with a mobile app: probes iOS's and Android's tools, printing
//                                              the fix for each that fails, then picks one device (iOS's where available),
//                                              boots it once unless it runs, and records it in .factory/env.local; exits 1
//                                              when no platform is available. apply then registers the Maestro MCP server.
//   setup-factory.mjs set <field> [<value>]  -> sets one field of the proposal to the value, or to stdin without one;
//                                              null drops the field. notion_parent takes a Notion page's URL and keeps its
//                                              ID, setting docs notion, or null for docs repo. tracker_doc takes the other
//                                              tracker's run operations, which apply writes into .factory/tracker.md.
//                                              grill takes one or all, how the grill asks
//   setup-factory.mjs apply [--tracker <t>] [--dry-run] -> --dry-run prints the proposal: every detected value with its
//                                              source, guesses marked, and each file's diff. Without it, refuses a command
//                                              that wasn't proven, then writes .factory/, the .gitignore entries and the
//                                              CLAUDE.md block, installs Playwright and axe for a web app lacking them, and
//                                              prints the closing notes. Writing an applied proposal again changes nothing.
//                                              In an empty repo it runs `pnpm init` first, and exits 1 if that fails.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, runEnv, envLines, device, cli, PLATFORM_NAMES, watchEnv, smokeHeaders, loginWall } from "./lib.mjs";

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
const TRACKERS = ["github", "linear", "local", "other"];
// other's tracker doc: the run operations the human described, under the heading a run follows
const TRACKER_DOC = (ops) => "# Tracker\n\nThis project's own tracker, as described at setup. A run started from one of its issues follows **Run operations**, "
  + "as the factory skill's `references/tracker.md` says; an operation not described here is skipped.\n\n## Run operations\n\n" + ops.trim() + "\n";
const PLAYWRIGHT = ["@playwright/test", "@axe-core/playwright"];
const ADD = { npm: ["install", "-D"], pnpm: ["add", "-D"], yarn: ["add", "-D"], bun: ["add", "-d"] };
const EXEC = { npm: ["npx"], pnpm: ["pnpm", "exec"], yarn: ["yarn"], bun: ["bunx"] };
const GITIGNORE = [".factory/runs/", ".factory/worktrees/", ".factory/env.local"];
const EXAMPLES = [".env.example", ".env.sample", ".env.template"];
const VALUE_FILES = [".env.local", ".env.development", ".env"];
const DEV_SCRIPTS = ["dev", "start:dev", "start"];
// the dev server's port when nothing sets one, by dependency
const DEV_PORTS = [["next", 3000], ["nuxt", 3000], ["astro", 4321], ["vite", 5173], ["@sveltejs/kit", 5173], ["@nestjs/core", 3000]];
// With semgrep on, the starter project rules are written to SEMGREP, and proven to find something in PLANTED.
const SEMGREP = ".factory/semgrep/project.yaml";
const PLANTED = 'app.post("/users", async (req, res) => res.json(await prisma.user.create({ data: req.body })));\napp.set("trust proxy", true);\n';
const semgrepOn = (P) => !!P.config.security?.includes("semgrep");

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
  const devScript = DEV_SCRIPTS.find((s) => scripts[s]);
  if (devScript && serves(app)) {
    // a web framework takes --port; a server reads PORT
    app.dev = app.type === "web" ? `${pm} run ${devScript}${pm === "npm" ? " --" : ""} --port {port:${name}}` : `PORT={port:${name}} ${pm} run ${devScript}`;
    app.health = `http://localhost:{port:${name}}/`;
    add(`apps.${name}.dev`, app.dev, `${at("package.json")} scripts.${devScript}, ${app.type === "web" ? "the framework's --port flag" : "PORT"}`);
    add(`apps.${name}.health`, app.health, "the app's URL answering");
  }
  if (app.type === "mobile") Object.assign(app, mobileFields(root, dir, name, deps, pm, add));
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

// A mobile app's recipe fields from its app.json, Expo's or React Native's: app_id, the iOS bundle identifier, else the
// Android package; and build, a Release build for the platform in $FACTORY_PLATFORM that prints the .app or .apk it
// made last. A Release build carries its JavaScript, so it needs no dev server, and a flow's clearState loses nothing.
// Expo's prebuild makes a platform's native project first when the app has none. No proof runs the build, so it's a guess.
function mobileFields(root, dir, name, deps, pm, add) {
  const at = (f) => path.posix.join(dir, f), conf = readJson(path.join(root, dir, "app.json"), {}), expo = conf.expo ?? conf, key = conf.expo ? "expo." : "";
  const ids = [["ios.bundleIdentifier", expo.ios?.bundleIdentifier], ["android.package", expo.android?.package]].filter(([, v]) => v);
  const differ = ids.length > 1 && ids[0][1] !== ids[1][1];
  add(`apps.${name}.app_id`, ids[0]?.[1] ?? null, !ids.length ? `${at("app.json")} names no ios.bundleIdentifier or android.package`
    : `${at("app.json")} ${key}${ids[0][0]}${differ ? `; ${key}${ids[1][0]} is ${ids[1][1]}` : ""}`, differ);
  // A native project counts only when git tracks it: a run's worktree holds tracked files alone, so one prebuild made
  // and the project ignores is no build there. Its Xcode workspace is the one in ios/, else prebuild names it after the
  // app, letters and digits only.
  const tracked = (p) => git(root, "ls-files", "--", path.posix.join(dir, p)).split("\n").filter(Boolean).map((f) => path.posix.relative(path.posix.join(dir, p), f));
  const native = (p) => tracked(p).length > 0, ws = tracked("ios").map((f) => f.split("/")[0]).find((f) => /^[\w-]+\.xcworkspace$/.test(f));
  const scheme = ws ? ws.replace(/\.xcworkspace$/, "") : String(expo.name ?? name).normalize("NFD").replace(/[^A-Za-z0-9]/g, "") || "app";
  const prebuild = (p) => deps.expo && !native(p) ? `${EXEC[pm].join(" ")} expo prebuild -p ${p} && ` : "";
  const build = `if [ "$FACTORY_PLATFORM" = ios ]; then ${prebuild("ios")}xcodebuild -workspace ios/${scheme}.xcworkspace -scheme ${scheme} -configuration Release `
    + `-sdk iphonesimulator -derivedDataPath ios/build && echo ios/build/Build/Products/Release-iphonesimulator/${scheme}.app; `
    + `else ${prebuild("android")}(cd android && ./gradlew assembleRelease) && echo android/app/build/outputs/apk/release/app-release.apk; fi`;
  add(`apps.${name}.build`, build, `${ws ? at(`ios/${ws}`) : `${at("app.json")} ${key}name`}: a Release build, first proven by a run's up`, true);
  return { ...(ids.length && { app_id: ids[0][1] }), build };
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
  // the recipe's package manager leads on a re-run, as the kept tracker does, but an empty repo's is pnpm: it has no
  // package.json until apply's `pnpm init` makes one, and no apps until a run's scaffold ticket
  const held = kept(root, ".factory/setup.json").package_manager;
  const [pm, from] = [[!exists(root, "package.json") && "pnpm", "no package.json, so apply runs `pnpm init` first to make one"],
    [held, ".factory/setup.json"], [lock?.[1], lock?.[0]], [declared, "package.json packageManager"], ["npm", "default"]].find(([v]) => ADD[v]);
  add("package_manager", pm, from);
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
    ...merge(keptRest, { preview, package_manager: pm }, "", disagreements),
  };
  const names = envNames(root, recipe);
  for (const [name, { purpose, file }] of Object.entries(names)) add(`env.${name}`, purpose, file);
  recipe.env = merge(keptRest.env, Object.fromEntries(Object.entries(names).map(([n, v]) => [n, v.purpose])), "env", disagreements);
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

// Section C reads the env files in the root and in each app's directory, first directory first.
const envDirs = (recipe) => [...new Set([".", ...recipe.apps.map((a) => a.path)])];
const envFiles = (root, dir) => !exists(root, dir) ? [] : fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .filter((e) => e.isFile() && /^\.env(\.|$)/.test(e.name)).map((e) => e.name).sort();
// Each variable a directory's example file names, else its other .env* files, with where it was named and its purpose: the
// comment lines just above it in an example file. The developer's own files give none: a comment there may hold a value.
function envNames(root, recipe) {
  const names = {};
  for (const dir of envDirs(recipe)) {
    const files = envFiles(root, dir), example = EXAMPLES.find((f) => files.includes(f));
    for (const f of example ? [example] : files) {
      let note = [];
      for (const line of fs.readFileSync(path.join(root, dir, f), "utf8").split("\n")) {
        const [entry] = envLines(line), comment = !entry && line.match(/^\s*#\s*(.*?)\s*$/)?.[1];
        if (entry) names[entry[0]] ??= { purpose: (example && note.join(" ")) || null, file: path.posix.join(dir, f) };
        note = comment && !envLines(comment).length ? [...note, comment] : [];  // a commented-out NAME= is no purpose
      }
    }
  }
  return names;
}

// All of a value that is ever shown: a URL's host, and each app port it takes.
function hostAndPorts(v) {
  let host = null; try { if (/^[a-z][\w+.-]*:\/\//i.test(v)) host = new URL(v.replace(/\{port:[^}]+\}/g, "0")).hostname; } catch {}
  const at = v.match(/\{port:[^}]+\}/g);
  return [host && `host ${host}`, at && `at ${at.join(", ")}`].filter(Boolean);
}
const ENV_HEADER = "# Everything a factory run's commands see besides PATH, HOME and TMPDIR. Never commit it.\n"
  + "# Setup copied it from your .env files; {port:<app>} becomes that app's port in each run.\n";

// Section C: appends to .factory/env.local each variable of the recipe's env it doesn't name yet, set or commented out, so a
// value the human wrote there always stays. The value comes from .env.local, then .env.development, then .env, over the root
// and each app's directory, as written there; a live one (_live_) is passed over, and a loopback address at an app's local
// port, or a …PORT variable set to one, takes that app's {port:<app>}. A variable with no value goes in commented out, a gap
// for the human. Returns one line per variable, naming where its value came from and, for a URL, its host: never a value.
// ponytail: one flat file for every app, the first directory's value winning; per-app env files if two apps' values clash.
function copyEnv(P) {
  const file = path.join(P.root, ".factory", "env.local"), live = (v) => v.value.includes("_live_");
  const readOr = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const values = VALUE_FILES.flatMap((f) => envDirs(P.recipe).flatMap((dir) =>
    envLines(readOr(path.join(P.root, dir, f))).map(([name, value, raw]) => ({ from: path.posix.join(dir, f), dir, name, value, raw }))));
  // each app's port on the developer's machine: a port in its dev script, else PORT in its own env files, else its
  // framework's default; a port two apps claim follows neither
  const ports = {};
  for (const a of P.recipe.apps.filter((a) => a.dev)) {
    const pkg = readJson(path.join(P.root, a.path, "package.json"), {}), deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const m = (pkg.scripts?.[DEV_SCRIPTS.find((s) => pkg.scripts?.[s])] || "").match(/(?:--port|-p)[= ]?(\d+)|\bPORT=(\d+)/);
    const port = m?.[1] || m?.[2] || values.find((v) => v.dir === a.path && v.name === "PORT")?.value || DEV_PORTS.find(([d]) => deps[d])?.[1];
    if (port) ports[port] = port in ports ? null : a.name;
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const named = new Set(envLines((text ?? "").replace(/^[ \t]*#[ \t]*/gm, "")).map(([n]) => n));
  const names = Object.keys(P.recipe.env || {}), add = [], gaps = [], copied = {};
  for (const name of names.filter((n) => !named.has(n))) {
    const v = values.find((v) => v.name === name && !live(v));
    if (!v) { gaps.push(`# ${name}=`); continue; }
    add.push(`${name}=${/(^|_)PORT$/.test(name) && ports[v.value] ? `{port:${ports[v.value]}}`
      : v.raw.replace(/(?<![\w.-])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)(?!\d)/g, (m, host, port) => ports[port] ? `${host}:{port:${ports[port]}}` : m)}`);
    copied[name] = v.from;
  }
  if (gaps.length) add.push("# Not copied: fill each in, or leave it commented out if the factory can't have it (the checks needing it are then skipped).", ...gaps);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (text === null) fs.writeFileSync(file, ENV_HEADER + add.map((l) => `${l}\n`).join(""), { mode: 0o600 });
  else if (add.length) fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
  // until apply writes the .gitignore entry, the clone's own exclude file keeps env.local out of git
  if (run("git", ["check-ignore", "-q", ".factory/env.local"], { cwd: P.root }).status !== 0) {
    const exclude = path.join(path.dirname(P.file), "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, "\n.factory/env.local\n");
  }
  const set = Object.fromEntries(envLines(fs.readFileSync(file, "utf8")));
  return names.map((name) => {
    if (name in set) return `${copied[name] ? "copied" : "kept  "}  ${name}  ${[copied[name] ? `from ${copied[name]}` : "in .factory/env.local", ...hostAndPorts(set[name])].join(", ")}`;
    const found = values.filter((v) => v.name === name);
    return `gap     ${name}  ${found.some((v) => !live(v)) ? "commented out in .factory/env.local"
      : found.length ? `a live value in ${found[0].from} isn't copied` : "no value in .env.local, .env.development or .env"}`;
  });
}

function closingNotes(P, tracker) {
  return [
    "GitHub emails you about the factory's labels and comments only with \"Include your own updates\" on (https://github.com/settings/notifications): it acts as you.",
    `What waits on you: save the search \`is:open is:pr label:factory label:needs-human\` (https://github.com/${P.repo}/pulls?q=is%3Aopen+is%3Apr+label%3Afactory+label%3Aneeds-human).`,
    // GitHub's closing keywords only act on a PR into the default branch
    ...(tracker === "github" && P.config.branching.model === "git-flow" && P.default_branch !== P.config.branching.develop
      ? ["`develop` isn't the default branch, so GitHub won't close a request issue from a PR into it: make `develop` the default branch, or close request issues by hand."] : []),
    ...Object.entries(P.scanners).filter(([, on]) => !on).map(([bin]) => `${bin} isn't installed, so its scan is skipped: \`brew install ${bin}\`.`),
    ...(!P.recipe.apps.length ? ["The recipe has no apps yet: the first run's scaffold ticket fills it."] : []),
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

// a check is "<command>" or { cmd, env: [the names it needs] }
const cmdOf = (check) => check?.cmd ?? check;
// [key, command, app, name] for every check and dev command in the recipe, keyed as prove records them
const commands = (recipe) => recipe.apps.flatMap((a) => [...Object.entries(a.checks || {}), ...(a.dev ? [["dev", a.dev]] : [])]
  .map(([name, command]) => [`${a.name}.${name}`, cmdOf(command), a.name, name]));
// a check skipped for a name .factory/env.local doesn't hold, as verify skips it, counts until the file holds them all
const proven = (P, key, command) => P.proof?.[key]?.cmd === command && (P.proof[key].status === "pass"
  || (P.proof[key].status === "skipped" && P.proof[key].missing.some((n) => !Object.hasOwn(runEnv(P.root), n))));

// Every file apply manages, as [path, its content now (null when absent), its content after]. A kept value always wins;
// the memory files are written only when missing, and CLAUDE.md changes only inside its markers.
function plan(P, tracker) {
  const at = (f) => path.join(P.root, f), now = (f) => fs.existsSync(at(f)) ? fs.readFileSync(at(f), "utf8") : null;
  const template = (f) => fs.readFileSync(path.join(TEMPLATES, f), "utf8");
  const json = (o) => JSON.stringify(o, null, 2) + "\n";
  const budgets = {};
  for (const [key, command, app, name] of commands(P.recipe)) if (proven(P, key, command) && P.proof[key].status === "pass") (budgets[app] ||= {})[name] = P.proof[key].seconds;
  const recipe = { ...P.recipe, budgets: merge(P.recipe.budgets, budgets, "budgets", null) };
  const keptRules = kept(P.root, ".factory/touch-rules.json"), rules = merge(keptRules, JSON.parse(template("touch-rules.json")), "", null);
  const pm = P.package_manager;
  const lines = recipe.apps.flatMap((a) => {
    // a check run as `<pm> run <its name>` goes without saying
    const cmds = Object.entries(a.checks || {}).map(([n, c]) => [n, cmdOf(c)]).filter(([n, c]) => c !== `${pm} run ${n}`).map(([, c]) => `\`${c}\``);
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
    ...(semgrepOn(P) ? [[SEMGREP, now(SEMGREP) ?? template("semgrep/starter.yaml")]] : []),
    ...(tracker === "other" ? [[".factory/tracker.md", P.tracker_doc ? TRACKER_DOC(P.tracker_doc) : now(".factory/tracker.md")]] : []),
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
// with, what .factory/env.local sets, the installs, and each file's diff.
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
  // section C's result: what a run's commands will see, and the host each URL points at (a shared database shows here)
  const envFile = path.join(P.root, ".factory", "env.local");
  if (fs.existsSync(envFile)) {
    const set = Object.fromEntries(envLines(fs.readFileSync(envFile, "utf8"))), gone = Object.keys(P.recipe.env || {}).filter((n) => !(n in set));
    console.log("\n## Environment\n\n`.factory/env.local` sets, values never shown:\n");
    for (const [name, value] of Object.entries(set)) console.log(`- \`${name}\`${hostAndPorts(value).length ? `: ${hostAndPorts(value).join(", ")}` : ""}`);
    if (gone.length) console.log(`\nNot available, so the checks needing them are skipped: ${gone.map((n) => `\`${n}\``).join(", ")}.`);
  }
  const planned = installs(P.root, P.recipe, P.package_manager);
  if (planned.length) {
    console.log("\n## Installs\n");
    for (const i of planned) console.log(`- In \`${i.path}\`: ${i.commands.map((c) => `\`${c.join(" ")}\``).join(", then ")}`);
  }
  if (registersMaestro(P)) console.log(`\n## MCP\n\n- \`claude ${MAESTRO_MCP.join(" ")}\`: the Maestro server qa drives the ${KIND[P.mobile.platform].device} through, `
    + "at local scope, so it's this project's alone, on this machine alone");
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
  // a failure's output reaches the chat, so each env.local value in it (8 characters or more) shows as {env:<its name>}
  const secrets = Object.entries(env).filter(([k, v]) => !["PATH", "HOME", "TMPDIR"].includes(k) && v?.length >= 8).sort(([, a], [, b]) => b.length - a.length);
  const record = (key, cmd, ok, t0, why) => {
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    P.proof[key] = { cmd, status: ok ? "pass" : "fail", seconds };
    if (!ok) failed++;
    console.log(`${ok ? "pass" : "fail"}  ${key}  ${seconds}s  ${cmd}${ok ? "" : `\n${secrets.reduce((t, [k, v]) => t.replaceAll(v, `{env:${k}}`), why)}`}`);
  };
  const check = (a, name) => new Promise((resolve) => {
    const t0 = Date.now(), cmd = cmdOf(a.checks[name]), missing = (a.checks[name].env || []).filter((n) => !Object.hasOwn(env, n));
    if (missing.length) {
      P.proof[`${a.name}.${name}`] = { cmd, status: "skipped", seconds: 0, missing };
      console.log(`skipped  ${a.name}.${name}  0s  ${cmd}\n  ${missing.join(", ")} not available in .factory/env.local`);
      return resolve();
    }
    const child = spawn("bash", ["-c", sub(cmd)], { cwd: path.join(P.root, a.path), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    groups.add(child.pid);
    let out = "";
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { out = (out + d).slice(-20_000); });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { out += `\nno exit in ${CHECK_WAIT / 1000}s`; kill(); }, CHECK_WAIT);
    child.on("exit", kill);  // what the check left running, which may hold its output open
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      groups.delete(child.pid);
      record(`${a.name}.${name}`, cmd, code === 0, t0, lastLines(`${out}\nexited ${code ?? signal}`));
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
  // The project rules (kept ones, else the starter) are proven like a command: nothing found in the project's tree, and
  // something in a planted file.
  if (semgrepOn(P) && want("semgrep")) {
    const t0 = Date.now(), rules = exists(P.root, SEMGREP) ? path.join(P.root, SEMGREP) : path.join(TEMPLATES, "semgrep/starter.yaml");
    const planted = fs.mkdtempSync(path.join(os.tmpdir(), "factory-planted-"));
    fs.writeFileSync(path.join(planted, "planted.ts"), PLANTED);
    const scan = (cwd, target) => {
      const r = run("semgrep", ["scan", "--config", rules, "--metrics=off", "--disable-version-check", "--quiet", "--json", "--exclude", ".factory", target], { cwd, env, timeout: CHECK_WAIT });
      try { return { hits: JSON.parse(r.stdout).results, r }; } catch { return { r }; }
    };
    const tree = scan(P.root, "."), plant = scan(planted, path.join(planted, "planted.ts"));
    fs.rmSync(planted, { recursive: true });
    const broken = [tree, plant].find((s) => !s.hits);
    // semgrep names a rule after the directory it was loaded from; the id is the last part
    record("semgrep", `semgrep --config ${SEMGREP}`, !broken && !tree.hits.length && plant.hits.length > 0, t0, broken
      ? lastLines(`${broken.r.stdout}${broken.r.stderr}${broken.r.error?.message ?? ""}`)
      : tree.hits.length ? tree.hits.map((h) => `  ${h.check_id.split(".").pop()} ${h.path}:${h.start?.line}`).join("\n") : "  nothing found in the planted file");
  }
  groups.clear();
  save(P);
  return failed;
}

// The mobile section, for a recipe with a mobile app (#17). Each platform's probes, a failed one making its platform
// unavailable and printing the fix; then one device, iOS's where it's available, else Android's, as .factory/env.local
// names it for lib's device: a device env.local already names is kept, else the one running, else the newest runtime's
// (booted once to prove it, then shut down), else a `factory` one made from the newest runtime installed. Returns the
// exit code.
// the name before -e, whose values run up to the next option (docs/platform-facts.md, fact 22)
const MAESTRO_MCP = ["mcp", "add", "--scope", "local", "maestro", "-e", "MAESTRO_CLI_NO_ANALYTICS=1", "--", "maestro", "mcp"];
const KIND = { ios: { device: "simulator", key: "FACTORY_IOS_DEVICE" }, android: { device: "emulator", key: "FACTORY_ANDROID_DEVICE" } };
const registersMaestro = (P) => P.recipe.apps.some((a) => a.type === "mobile") && !!P.mobile?.platform;
const IOS = /SimRuntime\.iOS-(\d+)-(\d+)$/, newest = (a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1];
// Each platform's device: pick() finds or makes the one to record, and prove(d) boots one that isn't running and stops it.
const DEVICE = {
  ios: { pick() {
    const sims = Object.entries(JSON.parse(cli("xcrun", "simctl", "list", "devices", "-j")).devices).flatMap(([rt, list]) => !IOS.test(rt) ? []
      : list.filter((d) => d.isAvailable !== false).map((d) => ({ ...d, v: rt.match(IOS).slice(1).map(Number) }))).sort(newest);
    const d = sims.find((x) => x.state === "Booted") ?? sims.find((x) => /^iPhone/.test(x.name)) ?? sims[0];
    if (d) return { id: d.udid, name: `${d.name}, iOS ${d.v.join(".")}`, running: d.state === "Booted" };
    const rt = JSON.parse(cli("xcrun", "simctl", "list", "runtimes", "-j")).runtimes.filter((r) => r.isAvailable !== false && IOS.test(r.identifier))
      .map((r) => ({ ...r, v: r.identifier.match(IOS).slice(1).map(Number) })).sort(newest)[0];
    // ponytail: simctl lists a runtime's device types oldest model first, so the last iPhone is the newest; sort by
    // model if a runtime ever lists them otherwise
    const type = rt?.supportedDeviceTypes?.filter((x) => x.productFamily === "iPhone").at(-1);
    if (!type) throw new Error("no simulator, and no iOS runtime to make one from: add one in Xcode's Settings, under Components");
    return { id: cli("xcrun", "simctl", "create", "factory", type.identifier, rt.identifier), name: `factory (${type.name}, iOS ${rt.version}), made now`, running: false };
  },
  async prove(d) { cli("xcrun", "simctl", "boot", d.id); try { cli("xcrun", "simctl", "bootstatus", d.id); } finally { cli("xcrun", "simctl", "shutdown", d.id); } } },
  android: { pick() {
    const [found] = emulators();
    if (found) return { id: found[1], name: found[1], running: true };
    const home = process.env.ANDROID_AVD_HOME || path.join(process.env.ANDROID_USER_HOME || path.join(os.homedir(), ".android"), "avd");
    const api = (avd) => { try { return Number(fs.readFileSync(path.join(home, `${avd}.ini`), "utf8").match(/^target=android-(\d+)/m)?.[1] ?? 0); } catch { return 0; } };
    const avds = cli("emulator", "-list-avds").split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+$/.test(l)).sort((a, b) => api(b) - api(a));
    if (avds.length) return { id: avds[0], name: `${avds[0]}, API ${api(avds[0])}`, running: false };
    // ponytail: the newest API level's first tag for this machine's ABI; pick by tag (google_apis over playstore) if one ever matters
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT, images = sdk && path.join(sdk, "system-images"), abi = os.arch() === "arm64" ? "arm64-v8a" : "x86_64";
    const levels = images && fs.existsSync(images) ? fs.readdirSync(images).filter((l) => /^android-\d+$/.test(l)).sort((a, b) => b.slice(8) - a.slice(8)) : [];
    const image = levels.flatMap((l) => fs.readdirSync(path.join(images, l)).sort().filter((tag) => fs.existsSync(path.join(images, l, tag, abi)))
      .map((tag) => `system-images;${l};${tag};${abi}`))[0];
    if (!image) throw new Error(`no AVD, and no ${abi} system image to make one from: install one in Android Studio's SDK Manager`);
    const r = run("avdmanager", ["create", "avd", "-n", "factory", "-k", image], { input: "no\n", timeout: 300_000 });  // no custom hardware profile
    if (r.status !== 0) {
      throw new Error(`avdmanager create avd -n factory -k ${image}: ${(r.error?.message || r.stderr || r.stdout).trim()} (avdmanager is in the SDK's Command-line Tools)`);
    }
    return { id: "factory", name: `factory (${image}), made now`, running: false };
  },
  // headless, as run-apps boots one, until it has booted, then killed
  async prove(d) {
    const child = spawn("emulator", ["-avd", d.id, "-no-window"], { detached: true, stdio: "ignore" });
    groups.add(child.pid);
    let gone = null; child.on("error", (e) => { gone = e.message; }).on("exit", (code) => { gone ??= `exited ${code}`; });
    try {
      let serial;
      for (const end = Date.now() + 300_000; !(serial = emulators().find(([, avd]) => avd === d.id)?.[0]); await sleep(250)) {
        if (gone || Date.now() > end) throw new Error(`emulator -avd ${d.id} ${gone ?? "didn't reach adb devices in 5 minutes"}`);
      }
      for (const end = Date.now() + 300_000; run("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"]).stdout?.trim() !== "1"; await sleep(1000)) {
        if (Date.now() > end) throw new Error(`${d.id} didn't finish booting in 5 minutes`);
      }
      cli("adb", "-s", serial, "emu", "kill");
    } finally {
      for (const end = Date.now() + 10_000; !gone && Date.now() < end;) await sleep(100);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      groups.delete(child.pid);
    }
  } },
};
// [serial, AVD name] of each running emulator
const emulators = () => cli("adb", "devices").split("\n").map((l) => l.match(/^(emulator-\d+)\tdevice$/)?.[1]).filter(Boolean)
  .map((s) => [s, cli("adb", "-s", s, "emu", "avd", "name").split("\n")[0].trim()]);

async function mobile(P) {
  if (!P.recipe.apps.some((a) => a.type === "mobile")) { console.log("no mobile app in the recipe: nothing to probe"); return 0; }
  const file = path.join(P.root, ".factory", "env.local");
  if (!fs.existsSync(file)) die("no .factory/env.local yet: run `setup-factory env` first");
  // a probe's spawnSync result: a missing tool's has an error, a failing one's a status
  const probe = (bin, ...a) => run(bin, a, { timeout: 60_000, env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: "1" } });
  // java -version writes to stderr, as `version "17.0.12"`, or `version "1.8.0_392"` for Java 8
  const accel = probe("emulator", "-accel-check"), maestro = probe("maestro", "--version");
  const java = `${probe("java", "-version").stderr ?? ""}`.match(/version "((\d+)(?:\.(\d+))?[^"]*)"/), major = java && Number(java[2] === "1" ? java[3] : java[2]);
  const both = ["ios", "android"], probes = [  // [platforms, what, passed, fix, version]
    [["ios"], "full Xcode", probe("xcrun", "simctl", "help").status === 0 && probe("xcodebuild", "-version").status === 0, process.platform !== "darwin"
      ? "none here: iOS simulators run on macOS only" : "install Xcode from the App Store, open it once, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`"],
    [["android"], "adb", probe("adb", "version").status === 0, "install the SDK Platform-Tools in Android Studio's SDK Manager, and put `$ANDROID_HOME/platform-tools` on PATH"],
    [["android"], "an Android emulator", !accel.error, "install the Android Emulator in Android Studio's SDK Manager, and put `$ANDROID_HOME/emulator` on PATH"],
    ...(accel.error ? [] : [[["android"], "hardware acceleration", accel.status === 0, "turn on the CPU's virtualization (on Linux, KVM), as `emulator -accel-check` says"]]),
    [both, "Java 17 or newer", major >= 17, "install a JDK 17 or newer (`brew install --cask zulu@17`), and put its `java` on PATH", java?.[1]],
    [both, "Maestro", maestro.status === 0, "`curl -fsSL \"https://get.maestro.mobile.dev\" | bash`, and put `~/.maestro/bin` on PATH", maestro.stdout?.trim()],
  ];
  for (const [on, what, pass, fix, version] of probes) {
    console.log(`${pass ? "pass" : "fail"}  ${what} (${on.map((p) => PLATFORM_NAMES[p]).join(" and ")})${pass && version ? `: ${version}` : ""}${pass ? "" : `\n  fix: ${fix}`}`);
  }
  const available = both.filter((p) => probes.every(([on, , pass]) => pass || !on.includes(p)));
  // a device env.local names is the human's, kept; its platform counts only while its probes pass
  const kept = device(runEnv(P.root));
  P.mobile = { platform: available.includes(kept?.platform) ? kept.platform : null };
  if (kept) console.log(`device  kept ${KIND[kept.platform].key} in .factory/env.local${P.mobile.platform ? "" : `, though ${PLATFORM_NAMES[kept.platform]} isn't available`}`);
  for (const p of kept ? [] : available) {
    const { device: kind, key } = KIND[p];
    try {
      const d = DEVICE[p].pick();
      if (!d.running) await DEVICE[p].prove(d);
      const text = fs.readFileSync(file, "utf8");
      fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# The ${kind} every run's mobile app goes on, chosen by setup.\n${key}=${d.id}\n`);
      console.log(`device  ${PLATFORM_NAMES[p]}: ${d.name}, ${d.running ? "running" : "booted once to prove it and shut down again"}, recorded as ${key} in .factory/env.local`);
      P.mobile.platform = p;
      break;
    } catch (e) { console.log(`fail  the ${PLATFORM_NAMES[p]} ${kind}: ${e.message}`); }
  }
  save(P);
  if (P.mobile.platform) return 0;
  console.log("no platform is available: each mobile criterion will be blocked (environment), each Maestro check skipped, and each run with a mobile app needs a human");
  return 1;
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
  case "env": {
    for (const line of copyEnv(loadProposal())) console.log(line);
    break;
  }
  case "prove": {
    if (await prove(loadProposal(), args)) process.exit(1);
    break;
  }
  case "mobile": {
    process.exitCode = await mobile(loadProposal());
    break;
  }
  case "probe": {
    // The watch reads the deployment of what auto merged (#32); setup reads the newest it can, its target's tip's.
    const P = loadProposal(), b = P.config.branching || {}, branch = b.model === "git-flow" ? b.develop || "develop" : b.main || "main";
    const tip = ghJson(`repos/${P.repo}/commits/${branch}`)?.sha;
    const urls = new Set((tip && ghJson(`repos/${P.repo}/deployments?sha=${tip}&per_page=100`) || []).map((d) => ghJson(`repos/${P.repo}/deployments/${d.id}/statuses?per_page=1`)?.[0])
      .filter((st) => st?.state === "success" && /^https?:\/\/\S+$/.test(st.environment_url ?? "")).map((st) => st.environment_url));
    if (!urls.size) { console.log(`no wall: no ready deployment of ${branch}${tip ? ` at ${tip.slice(0, 7)}` : ""}`); break; }
    const headers = smokeHeaders(P.recipe, watchEnv(P.root)), names = Object.keys(headers).length ? `, with ${Object.keys(headers).join(", ")}` : "";
    let walls = 0;
    for (const url of urls) {
      const w = await loginWall(url, headers);
      walls += w.wall;
      console.log(`${w.wall ? "wall   " : "no wall"}  ${url}  ${w.why}${names}`);
    }
    if (walls) process.exit(1);
    break;
  }
  case "set": {
    const [field, raw = fs.readFileSync(0, "utf8").trim()] = args;
    if (!field || !raw) die("set <field> <value>, or the value on stdin");
    const P = loadProposal(), keys = field.split(".");
    // a command such as `true` stays a string: only null, a list, an object or a quoted string is read as JSON
    let value = raw; if (/^(null$|[[{"])/.test(raw)) try { value = JSON.parse(raw); } catch {}
    // a field as the proposal's table names it: apps.<name>.…, pinned, preview.… and env.… are the recipe's, branching.… and
    // the like the config's
    if (keys[0] === "tracker") die("the tracker is apply's --tracker");
    // A. Tracker: other's run operations, as the human described them, which apply writes into .factory/tracker.md
    if (field === "tracker_doc") { P.tracker_doc = raw; save(P); console.log("set tracker_doc"); break; }
    // B. Specs: a parent page's URL sends approved specs to Notion (docs notion) under that page's ID; null keeps them in
    // the repo alone (docs repo)
    if (field === "notion_parent") {
      const id = value && String(value).split(/[?#]/)[0].replaceAll("-", "").match(/[0-9a-f]{32}$/i)?.[0].toLowerCase();
      if (value !== null && !id) die(`${raw} names no Notion page: give the parent page's URL, or null`);
      if (id && !P.mcp.includes("notion")) die("no Notion MCP in this session's tool list, so specs stay in the repo");
      P.config.docs = id ? "notion" : "repo";
      if (id) P.config.notion_parent = id.replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
      else delete P.config.notion_parent;
      save(P);
      console.log(id ? `set docs notion, under page ${P.config.notion_parent}` : "set docs repo");
      break;
    }
    // B. Specs: the grill asks one question a call, or the whole frontier in as few calls as it can
    if (field === "grill" && !["one", "all"].includes(value)) die(`grill is one or all, not ${raw}`);
    if (!["apps", "pinned", "preview", "env", "smoke"].includes(keys[0]) && !(keys[0] in P.config)) die(`${field} isn't a field setup writes`);
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
    if (tracker === "other" && !P.tracker_doc && !exists(P.root, ".factory/tracker.md")) die("describe the tracker first: setup-factory.mjs set tracker_doc, its run operations on stdin");
    const files = plan(P, tracker);
    if (argv.includes("--dry-run")) { printProposal(P, tracker, files); break; }
    const unproven = commands(P.recipe).filter(([key, command]) => !proven(P, key, command));
    if (semgrepOn(P) && !proven(P, "semgrep", `semgrep --config ${SEMGREP}`)) unproven.push(["semgrep", `semgrep --config ${SEMGREP}`]);
    if (unproven.length) {
      console.error(`setup-factory: not proven: ${unproven.map(([key, command]) => `${key} (\`${command}\`)`).join(", ")}; run \`setup-factory.mjs prove\` first`);
      process.exit(1);
    }
    let changed = 0;
    // an empty repo's package.json comes first, so a missing pnpm stops apply with nothing written
    if (!exists(P.root, "package.json")) {
      const r = run("pnpm", ["init"], { cwd: P.root });
      if (r.status !== 0) {
        console.error(`setup-factory: pnpm init failed, so nothing was written:\n${lastLines(`${r.stdout}${r.stderr}${r.error?.message ?? ""}`)}\n`
          + "fix it (`corepack enable pnpm` installs a missing pnpm), then run apply again");
        process.exit(1);
      }
      console.log("ran pnpm init");
      changed++;
    }
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
    // the mobile section's Maestro server, once a platform is available; claude refuses a second one by the same name
    const mcp = !failed && registersMaestro(P) && run("claude", MAESTRO_MCP, { cwd: P.root }), said = mcp && `${mcp.stdout ?? ""}${mcp.stderr ?? ""}`;
    if (mcp?.status === 0) { console.log("registered the maestro MCP server at local scope"); changed++; }
    else if (/already exists/.test(said)) console.log("kept the maestro MCP server already registered");
    else if (mcp) { failed = true; console.log(`${lastLines(`${said}${mcp.error?.message ?? ""}`)}\nclaude ${MAESTRO_MCP.join(" ")} failed: fix it, then run apply again`); }
    if (!changed) console.log("nothing to write: the project already holds this proposal");
    console.log(`\n## Closing notes\n\n${closingNotes(P, tracker).map((n) => `- ${n}`).join("\n")}`);
    if (failed) process.exit(1);
    break;
  }
  default: die("usage: setup-factory.mjs detect [--mcp <a,b>] | env | probe | prove [<app>.<name> ...] | mobile | set <field> [<value>] | apply [--tracker <t>] [--dry-run]");
}
