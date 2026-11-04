#!/usr/bin/env node
// security-scan.mjs [--offline] — writes the run's security.json: each capability met by whichever tool is there, over
// lib's run diff. Takes --run <id>, or derives the run from the run worktree it runs in.
//   secrets          gitleaks over the run's commits, else secretlint (through npx) over the lines the diff adds
//   vulnerabilities  the package manager's audit (npm or pnpm, by lockfile): high and critical advisories; osv-scanner
//                    beside it when installed, listed and never blocking
//   sast             semgrep with the project rules in .factory/semgrep/, always, then the registry packs when they're
//                    reachable: their ERROR hits fail, the rest stay in the log
// A capability is pass, fail (a security item), partial (sast whose packs didn't run) or missing: no tool ran to the end,
// which is never a pass. Items are baselined to the merge base: gitleaks reads only the run's commits, secretlint only the
// added lines, semgrep runs with --baseline-commit in a temp worktree at HEAD (a clean checkout it may reset to the base
// and back, under the run's live files), and an advisory the audit also reports at the base is inherited. An item whose
// fingerprint the base branch's .factory/security-accepted.json holds ({ "<fingerprint>": "<why>" }) is accepted, not
// counted, and a run that changes .factory/semgrep/ gets no project rules: neither can be waved through by the run.
// new_dependencies reports each dependency that no package.json at the base declares (a version bump isn't one), with
// its install scripts, maintainer count and licence from `npm view`.
// --offline makes no network call: it skips the audit and npx (their capability is then missing), osv-scanner, the
// registry packs (sast is then partial) and the dependency lookups.
// Each tool's full output goes to logs/security-<name>.log in the run dir. Prints a status line, then the digest of each
// run that failed or errored and why any was skipped; exits 0 only when every capability is pass or partial.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { readJson, git, worktreesDir, runContext, runEnv, runDiff, digest } from "./lib.mjs";

const OFFLINE = process.argv.includes("--offline");
const ctx = runContext(), wt = ctx.worktree, env = runEnv(ctx.MAIN);
const { base, files, added } = runDiff(ctx), head = git(wt, "rev-parse", "HEAD");
const logs = path.join(ctx.runDir, "logs");
fs.mkdirSync(logs, { recursive: true });
// Read from the base branch's tip, where the human commits it, so no commit of the run's can wave its own item through.
let ACCEPTED = {};
try { ACCEPTED = JSON.parse(git(wt, "show", `refs/heads/${readJson(ctx.state).base_branch}:.factory/security-accepted.json`)); } catch {}
const onPath = (bin) => (env.PATH || "").split(path.delimiter).some((d) => {
  try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; }
});
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// Runs one tool in the recipe's environment, its stdout then stderr saved to logs/security-<name>.log.
function invoke(name, bin, args, cwd = wt) {
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 1 << 28 });
  const log = path.join(logs, `security-${name}.log`), out = `${r.stdout || ""}${r.stderr || ""}${r.error ? `\n${r.error.message}\n` : ""}`;
  fs.writeFileSync(log, out);
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { rc: r.error ? null : r.status, json, out, log };
}
// A temp worktree at sha, under .factory/worktrees/ like every other, removed once fn has run in it.
function inTree(prefix, sha, fn) {
  const dir = fs.mkdtempSync(path.join(worktreesDir(ctx.MAIN), prefix));
  try { git(ctx.MAIN, "worktree", "add", "-q", "--detach", dir, sha); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  try { return fn(dir); } finally { git(ctx.MAIN, "worktree", "remove", "--force", dir); }
}

const caps = { secrets: [], vulnerabilities: [], sast: [] }, items = [], accepted = [];
const record = (cap, r) => (caps[cap].push(r), r);
// A tool that ran to the end and found `found`: the accepted ones are set aside, any other is an item and fails it.
function ran(cap, tool, x, found, detail) {
  const open = found.filter((i) => !Object.hasOwn(ACCEPTED, i.fingerprint));
  accepted.push(...found.filter((i) => !open.includes(i)).map((i) => ({ capability: cap, tool, ...i, reason: ACCEPTED[i.fingerprint] })));
  items.push(...open.map((i) => ({ capability: cap, tool, ...i })));
  const lines = open.map((i) => [i.rule, i.location, i.title].filter(Boolean).join(" "));
  return record(cap, { tool, status: open.length ? "fail" : "pass", detail, log: x.log, ...(open.length && { digest: digest(lines.join("\n"), x.log) }) });
}
const errored = (cap, tool, x, detail) => record(cap, { tool, status: "error", detail, log: x.log, digest: digest(x.out, x.log) });
const skipped = (cap, tool, detail, optional) => record(cap, { tool, status: "skipped", detail, ...(optional && { optional }) });

// --- secrets
if (onPath("gitleaks")) {
  const x = invoke("gitleaks", "gitleaks", ["git", "--no-banner", "--redact", "--report-format", "json", "--report-path", "-", `--log-opts=${base}..HEAD`, "."]);
  // A leak's Entropy is its secret's, so it tells two leaks of one rule in one file apart without holding the secret.
  if ([0, 1].includes(x.rc) && Array.isArray(x.json)) ran("secrets", "gitleaks", x, x.json.map((l) => ({
    rule: l.RuleID, severity: "high", location: `${l.File}:${l.StartLine}`, commit: String(l.Commit).slice(0, 7), fingerprint: `gitleaks:${l.RuleID}:${l.File}:${l.Entropy}`,
  })), `${x.json.length} leak(s) in the run's commits`);
  else errored("secrets", "gitleaks", x, `gitleaks exited ${x.rc} without a report`);
} else if (OFFLINE || !onPath("npx")) skipped("secrets", "secretlint", `gitleaks isn't installed, and ${OFFLINE ? "--offline rules out npx" : "npx isn't either"}: brew install gitleaks`);
else if (!Object.keys(added).length) record("secrets", { tool: "secretlint", status: "pass", detail: "the diff adds no lines" });
else {
  // Each changed file's added lines in a copy of its own under added/, so a secret already at the base never counts.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-secretlint-")));
  try {
    for (const [f, lines] of Object.entries(added)) {
      fs.mkdirSync(path.dirname(path.join(dir, "added", f)), { recursive: true });
      fs.writeFileSync(path.join(dir, "added", f), lines.join("\n") + "\n");
    }
    fs.writeFileSync(path.join(dir, "secretlintrc.json"), JSON.stringify({ rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }] }));
    const x = invoke("secretlint", "npx", ["--yes", "-p", "secretlint", "-p", "@secretlint/secretlint-rule-preset-recommend", "secretlint",
      "--secretlintrc", "secretlintrc.json", "--format", "json", ...Object.keys(added).map((f) => path.join("added", f))], dir);
    if ([0, 1].includes(x.rc) && Array.isArray(x.json)) {
      // the fingerprint hashes what the rule matched, so accepting one key in a file never accepts the next
      const found = x.json.flatMap((r) => (r.messages || []).map((m) => {
        const copy = path.resolve(dir, r.filePath), file = path.relative(path.join(dir, "added"), copy);
        let match = ""; try { match = fs.readFileSync(copy, "utf8").slice(...m.range); } catch {}
        return { rule: m.ruleId, severity: "high", location: file, fingerprint: `secretlint:${m.ruleId}:${file}:${hash(match)}` };
      }));
      ran("secrets", "secretlint", x, found, `${found.length} secret(s) in the added lines`);
    } else errored("secrets", "secretlint", x, `secretlint exited ${x.rc} without a report`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- vulnerabilities
// npm 7+: { vulnerabilities: { <pkg>: { via: [<advisory> | <name>] } } }; pnpm: { advisories: { <id>: <advisory> } }
const advisories = (j) => [...new Map([
  ...Object.values(j.vulnerabilities || {}).flatMap((v) => (v.via || []).filter((a) => typeof a === "object")
    .map((a) => ({ id: a.url?.split("/").pop() || String(a.source), package: a.name, severity: a.severity, title: a.title }))),
  ...Object.values(j.advisories || {}).map((a) => ({ id: a.github_advisory_id || String(a.id), package: a.module_name, severity: a.severity, title: a.title })),
].filter((a) => ["high", "critical"].includes(a.severity))
  .map((a) => [`audit:${a.id}:${a.package}`, { rule: a.id, severity: a.severity, location: a.package, title: a.title, fingerprint: `audit:${a.id}:${a.package}` }])).values()];
const AUDITS = [["pnpm-lock.yaml", "pnpm audit", "pnpm", (dir) => ["audit", "--prod", "--json", "--dir", dir]],
  ["package-lock.json", "npm audit", "npm", (dir) => ["audit", "--omit=dev", "--json", "--prefix", dir]]];
const audit = AUDITS.find(([lock]) => fs.existsSync(path.join(wt, lock)));
const audited = (x) => [0, 1].includes(x.rc) && x.json && !x.json.error;
// ponytail: npm's and pnpm's audits only; read yarn's and bun's once their JSON is proven on a real project.
const other = ["yarn.lock", "bun.lock", "bun.lockb"].find((f) => fs.existsSync(path.join(wt, f)));
if (!audit) skipped("vulnerabilities", "audit", other ? `${other} has no audit read here, only npm's and pnpm's` : "no npm or pnpm lockfile to audit");
else if (OFFLINE) skipped("vulnerabilities", audit[1], "--offline: the audit needs the registry");
else {
  const [, tool, bin, args] = audit, name = bin + "-audit";
  const x = invoke(name, bin, args(wt));
  if (!audited(x)) errored("vulnerabilities", tool, x, `${tool} exited ${x.rc} without a report`);
  else {
    let found = advisories(x.json), inherited = 0;
    // An advisory the base has too was there before the run: only an audit at the base tells.
    if (found.length) inTree(".audit-base-", base, (dir) => {
      const old = invoke(`${name}.base`, bin, args(dir), dir);
      if (!audited(old)) return;
      const before = new Set(advisories(old.json).map((i) => i.fingerprint));
      inherited = found.filter((i) => before.has(i.fingerprint)).length;
      found = found.filter((i) => !before.has(i.fingerprint));
    });
    ran("vulnerabilities", tool, x, found, `high/critical advisories: ${found.length} the run brings, ${inherited} inherited from the base`);
  }
}
if (!onPath("osv-scanner")) skipped("vulnerabilities", "osv-scanner", "not installed: brew install osv-scanner", true);
else if (OFFLINE) skipped("vulnerabilities", "osv-scanner", "--offline", true);
else {
  const x = invoke("osv-scanner", "osv-scanner", ["scan", "source", "-r", "--format", "json", "."]);
  // results[].packages[].groups[].max_severity is a CVSS score; exit 1 is "found some", 128 "no packages"
  const high = (x.json?.results || []).flatMap((r) => (r.packages || []).flatMap((p) => (p.groups || []).filter((g) => Number(g.max_severity) >= 7)
    .map((g) => `${(g.ids || [])[0]} ${p.package?.name}@${p.package?.version}`)));
  record("vulnerabilities", { tool: "osv-scanner", optional: true, log: x.log, ...(x.json || x.rc === 128
    ? { status: high.length ? "fail" : "pass", detail: `${high.length} high/critical, which never block`, advisories: high }
    : { status: "error", detail: `osv-scanner exited ${x.rc} without a report`, digest: digest(x.out, x.log) }) });
}

// --- sast
const RULES = ".factory/semgrep", PACKS = ["p/owasp-top-ten", "p/typescript", "p/nodejs", "p/react"];
const semgrep = (name, tree, configs) => invoke(name, "semgrep", ["scan", ...configs.flatMap((c) => ["--config", c]), "--metrics=off",
  "--disable-version-check", "--baseline-commit", base, "--exclude", ".factory", "--quiet", "--json", "."], tree);
// A hit's fingerprint holds the code it matched, so it survives the lines around it moving. semgrep names a project rule
// after the directory it was loaded from, so that prefix comes off.
const hits = (tree, x) => x.json.results.map((h) => {
  let code = ""; try { code = fs.readFileSync(path.join(tree, h.path)).subarray(h.start.offset, h.end.offset).toString(); } catch {}
  const rule = h.check_id.replace(/^factory\.semgrep\./, "");
  return { rule, severity: h.extra?.severity === "ERROR" ? "high" : "medium", location: `${h.path}:${h.start.line}`,
    fingerprint: `semgrep:${rule}:${h.path}:${hash(code.replace(/\s+/g, " "))}` };
});
const finished = (x) => x.rc === 0 && Array.isArray(x.json?.results);
if (!onPath("semgrep")) {
  skipped("sast", "semgrep project rules", "semgrep isn't installed: brew install semgrep");
  skipped("sast", "semgrep registry packs", "semgrep isn't installed");
} else inTree(".sast-", head, (tree) => {
  if (!fs.existsSync(path.join(tree, RULES))) skipped("sast", "semgrep project rules", `no project rules in ${RULES}/: run /setup-factory`);
  else if (files.some((f) => f.startsWith(`${RULES}/`))) record("sast", { tool: "semgrep project rules", status: "error", detail: `the run changes ${RULES}/, so its rules aren't the project's` });
  else {
    const x = semgrep("semgrep-project", tree, [RULES]);
    if (finished(x)) { const h = hits(tree, x); ran("sast", "semgrep project rules", x, h, `${h.length} hit(s) the run brings`); }
    else errored("sast", "semgrep project rules", x, `semgrep exited ${x.rc} without results`);
  }
  if (OFFLINE) return skipped("sast", "semgrep registry packs", "--offline");
  const x = semgrep("semgrep-packs", tree, PACKS);
  if (!finished(x)) return errored("sast", "semgrep registry packs", x, `the registry packs didn't run (semgrep exited ${x.rc}): unreachable from here?`);
  // the packs are generic, so only their ERROR hits fail; the warnings are in the log for the security lens
  const h = hits(tree, x), errors = h.filter((i) => i.severity === "high");
  ran("sast", "semgrep registry packs", x, errors, `${errors.length} ERROR hit(s), ${h.length - errors.length} other(s) in the log (${PACKS.join(" ")})`);
});

// --- new dependencies
const DEPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const declared = (rev, f) => { let j; try { j = JSON.parse(git(wt, "show", `${rev}:${f}`)); } catch { return []; } return DEPS.flatMap((k) => Object.entries(j?.[k] || {})); };
const MANIFEST = /(^|\/)package\.json$/;
const atBase = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", base], { cwd: wt, encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")
  .filter((f) => MANIFEST.test(f) && !f.includes("node_modules/")).flatMap((f) => declared(base, f).map(([name]) => name)));
function lookup(name, spec) {
  if (OFFLINE) return { checked: false };
  // a registry range is looked up at that range, anything else (a URL, an alias) by name
  const r = spawnSync("npm", ["view", /[:/]/.test(spec) ? name : `${name}@${spec}`, "--json"], { cwd: wt, env, encoding: "utf8", timeout: 60_000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  if (Array.isArray(j)) j = j.at(-1);  // a range answers with every version in it, oldest first
  if (r.status !== 0 || !j || j.error) return { checked: false };
  return { checked: true, install_scripts: Object.fromEntries(Object.entries(j.scripts || {}).filter(([k]) => ["preinstall", "install", "postinstall"].includes(k))),
    maintainers: (j.maintainers || []).length, license: typeof j.license === "string" ? j.license : j.license?.type ?? null };
}
const new_dependencies = files.filter((f) => MANIFEST.test(f)).flatMap((f) => declared("HEAD", f)
  .filter(([name, spec]) => !atBase.has(name) && !/^(workspace|file|link|portal):/.test(spec))
  .map(([name, spec]) => ({ name, spec, package: f, ...lookup(name, spec) })));

// --- security.json
const outcome = (r) => ["pass", "fail"].includes(r?.status) ? r.status : "missing";
const required = (cap) => caps[cap].find((r) => !r.optional);
const [project, packs] = caps.sast;
const status = {
  secrets: outcome(required("secrets")),
  vulnerabilities: outcome(required("vulnerabilities")),
  sast: outcome(project) === "missing" ? "missing" : [project, packs].some((r) => r.status === "fail") ? "fail" : packs.status === "pass" ? "pass" : "partial",
};
const file = path.join(ctx.runDir, "security.json");
fs.writeFileSync(file, JSON.stringify({ base, head, offline: OFFLINE,
  capabilities: Object.fromEntries(Object.keys(caps).map((c) => [c, { status: status[c], runs: caps[c] }])),
  items, accepted, new_dependencies }, null, 2) + "\n");
console.log(`security: ${Object.keys(caps).map((c) => `${c}=${status[c]}(${required(c).tool})`).join(" ")} items=${items.length} `
  + `accepted=${accepted.length} new_dependencies=${new_dependencies.length}\nsecurity.json: ${file}`);
for (const [c, runs] of Object.entries(caps)) for (const r of runs.filter((r) => r.status !== "pass")) {
  console.log(`--- ${c}/${r.tool} ${r.status}${r.optional ? " (optional)" : ""}: ${r.detail}${r.digest ? `\n${r.digest}` : ""}`);
}
process.exit(Object.values(status).every((s) => ["pass", "partial"].includes(s)) ? 0 : 1);
