// security-scan.test.mjs — security-scan.mjs spawned as a process against a run on a throwaway project, with fake
// scanners on PATH (CI has none of the real ones). The cases at the end use the real tools when they're installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, script, startRun, fakeClis } from "./harness.mjs";

const scratch = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// git from the real PATH and nothing else from it: an installed scanner never reaches the scan, which sees only git,
// the fakes and /usr/bin:/bin.
const TOOLS = scratch("factory-tools-");
const found = process.env.PATH.split(path.delimiter).map((d) => path.join(d, "git")).find((f) => fs.existsSync(f));
fs.symlinkSync(found, path.join(TOOLS, "git"));
const CANNED = scratch("factory-canned-");
let n = 0;
const canned = (body) => { const f = path.join(CANNED, `${n++}`); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };
const fakes = (rules) => { const f = fakeClis(rules); return { ...f, env: { PATH: [f.bin, TOOLS, "/usr/bin", "/bin"].join(path.delimiter), HOME: process.env.HOME, TMPDIR: os.tmpdir() } }; };

const json = (o) => JSON.stringify(o, null, 2) + "\n";
// A project with an npm lockfile and project semgrep rules on main.
const BASE = {
  "package.json": json({ name: "shop", dependencies: { express: "^4.19.0" } }),
  "package-lock.json": json({ lockfileVersion: 3 }),
  ".factory/semgrep/project.yaml": "rules: []\n",
};
const CLEAN = {
  gitleaks: [{ match: /^git /, file: canned([]) }],
  npm: [{ match: /^audit /, file: canned({ auditReportVersion: 2, vulnerabilities: {} }) }],
  semgrep: [{ match: /^scan /, file: canned({ results: [], errors: [] }) }],
  "osv-scanner": [{ match: /^scan source/, file: canned({ results: [] }) }],
};

function run(files = BASE) {
  const p = project();
  const r = startRun(p, files);
  const scan = (f, args = []) => {
    const s = script("security-scan.mjs", p.dir, ["--run", r.id, ...args], { env: f.env });
    const file = path.join(r.run_dir, "security.json");
    return { ...s, sec: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
  };
  return { ...r, p, scan };
}
const statuses = (sec) => Object.fromEntries(Object.entries(sec.capabilities).map(([c, v]) => [c, v.status]));

test("design fix 8: with the tools there, secrets, vulnerabilities and SAST all pass on a clean branch, baselined to the merge base, leaving the run's tree as it was", () => {
  const r = run();
  r.commit({ "src/app.ts": "export const ok = true;\n" });
  const f = fakes(CLEAN);
  const { status, stdout, stderr, sec } = r.scan(f);
  assert.equal(status, 0, stdout + stderr);
  assert.deepEqual(statuses(sec), { secrets: "pass", vulnerabilities: "pass", sast: "pass" });
  assert.deepEqual([sec.base, sec.head], [r.base_sha, r.git("rev-parse", "HEAD")]);
  assert.deepEqual(sec.capabilities.secrets.runs.map((x) => [x.tool, x.status]), [["gitleaks", "pass"]]);
  assert.deepEqual(sec.capabilities.vulnerabilities.runs.map((x) => [x.tool, x.status, !!x.optional]), [["npm audit", "pass", false], ["osv-scanner", "pass", true]]);
  assert.deepEqual(sec.capabilities.sast.runs.map((x) => [x.tool, x.status]), [["semgrep project rules", "pass"], ["semgrep registry packs", "pass"]]);
  assert.deepEqual([sec.items, sec.accepted], [[], []]);
  assert.deepEqual(f.calls("gitleaks"), [["git", "--no-banner", "--redact", "--report-format", "json", "--report-path", "-", `--log-opts=${r.base_sha}..HEAD`, "."]]);
  const semgrep = f.calls("semgrep");
  assert.deepEqual(semgrep.map((a) => a.filter((x, i) => a[i - 1] === "--config")), [[".factory/semgrep"], ["p/owasp-top-ten", "p/typescript", "p/nodejs", "p/react"]]);
  for (const a of semgrep) {
    assert.equal(a[a.indexOf("--baseline-commit") + 1], r.base_sha);
    assert.ok(a.includes("--metrics=off") && a[a.indexOf("--exclude") + 1] === ".factory", a.join(" "));
  }
  assert.deepEqual(f.calls("npm"), [["audit", "--omit=dev", "--json", "--prefix", r.worktree]]);
  assert.match(fs.readFileSync(sec.capabilities.secrets.runs[0].log, "utf8"), /^\[\]/);
  assert.match(stdout, /^security: secrets=pass\(gitleaks\) vulnerabilities=pass\(npm audit\) sast=pass\(semgrep project rules\) items=0/m);
  assert.equal(r.git("status", "--porcelain"), "", "the scan never dirties the run's tree");
  assert.equal(r.p.git("worktree", "list").split("\n").length, 2, "semgrep's temp worktree is gone");
});

test("a capability with no tool that ran to the end is missing, never a pass; SAST whose registry packs didn't run is partial", () => {
  const r = run();
  r.commit({ "src/app.ts": "export const ok = true;\n" });

  // nothing installed, and offline: no gitleaks, no npx, no audit, no semgrep
  let s = r.scan(fakes({ npm: CLEAN.npm }), ["--offline"]);
  assert.equal(s.status, 1);
  assert.deepEqual(statuses(s.sec), { secrets: "missing", vulnerabilities: "missing", sast: "missing" });
  assert.match(s.stdout, /^--- secrets\/secretlint skipped: gitleaks isn't installed, and --offline rules out npx: brew install gitleaks$/m);
  assert.match(s.stdout, /^--- vulnerabilities\/npm audit skipped: --offline/m);
  assert.match(s.stdout, /^--- sast\/semgrep project rules skipped: semgrep isn't installed/m);

  // the registry is unreachable: semgrep fails to fetch the packs
  const unreachable = { ...CLEAN, semgrep: [{ match: /--config p\//, file: canned("Failed to download configuration from https://semgrep.dev/c/p/owasp-top-ten\n"), status: 2 }, ...CLEAN.semgrep] };
  let f = fakes(unreachable);
  s = r.scan(f);
  assert.equal(s.status, 0, s.stdout);
  assert.deepEqual(statuses(s.sec), { secrets: "pass", vulnerabilities: "pass", sast: "partial" });
  const packs = s.sec.capabilities.sast.runs[1];
  assert.equal(packs.status, "error");
  assert.match(packs.digest, /^Failed to download configuration.*\nfull output: .*security-semgrep-packs\.log$/);

  // --offline never asks the registry, nor osv
  f = fakes(CLEAN);
  s = r.scan(f, ["--offline"]);
  assert.deepEqual(statuses(s.sec), { secrets: "pass", vulnerabilities: "missing", sast: "partial" });
  assert.deepEqual(f.calls("semgrep").map((a) => a[a.indexOf("--config") + 1]), [".factory/semgrep"]);
  assert.deepEqual([f.calls("osv-scanner"), f.calls("npm")], [[], []]);

  // a scanner that crashes is no passing tool, and the packs alone are no SAST
  f = fakes({ ...CLEAN, gitleaks: [{ match: /^git /, file: canned("panic: runtime error\n"), status: 2 }] });
  const noRules = run({ ...BASE, ".factory/semgrep/project.yaml": null });
  noRules.commit({ "src/app.ts": "export const ok = true;\n" });
  s = noRules.scan(f);
  assert.equal(s.status, 1);
  assert.deepEqual(statuses(s.sec), { secrets: "missing", vulnerabilities: "pass", sast: "missing" });
  assert.match(s.stdout, /^--- secrets\/gitleaks error: gitleaks exited 2 without a report\npanic: runtime error\nfull output: /m);
  assert.match(s.stdout, /^--- sast\/semgrep project rules skipped: no project rules in \.factory\/semgrep\/: run \/setup-factory$/m);

  // a run that rewrites the project rules gets none: its own rules aren't the project's
  r.commit({ ".factory/semgrep/project.yaml": "rules: [] # nothing to see\n" });
  f = fakes(CLEAN);
  s = r.scan(f);
  assert.equal(s.sec.capabilities.sast.status, "missing");
  assert.match(s.stdout, /^--- sast\/semgrep project rules error: the run changes \.factory\/semgrep\/, so its rules aren't the project's$/m);
  assert.ok(!f.calls("semgrep").some((a) => a.includes(".factory/semgrep")));
});

const USERS = 'app.post("/users", async (req, res) => {\n  await prisma.user.create({ data: req.body });\n  app.set("trust proxy", true);\n});\n';
const hit = (rule, line, start, end, severity = "ERROR") => ({ check_id: rule, path: "src/users.ts", start: { line, offset: start }, end: { line, offset: end }, extra: { severity } });
const advisory = (id, name, severity) => ({ name, severity, via: [{ source: 1, name, title: `${name} is unsafe`, url: `https://github.com/advisories/${id}`, severity }] });

test("security items are the run's own: an advisory the base has is inherited, an accepted fingerprint is set aside, and each failure prints its digest", () => {
  const r = run();
  r.commit({ "src/users.ts": USERS, "src/keys.ts": 'export const key = "AKIA…";\n' });
  const f = fakes({
    gitleaks: [{ match: /^git /, file: canned([{ RuleID: "aws-access-token", File: "src/keys.ts", StartLine: 1, Commit: "0123456789abcdef", Entropy: 3.88, Secret: "REDACTED" }]), status: 1 }],
    npm: [
      { match: /^audit .*\.audit-base-/, file: canned({ vulnerabilities: { lodash: advisory("GHSA-aaaa", "lodash", "high") } }), status: 1 },
      { match: /^audit /, file: canned({ vulnerabilities: {
        lodash: advisory("GHSA-aaaa", "lodash", "high"), minimist: advisory("GHSA-bbbb", "minimist", "critical"), debug: advisory("GHSA-cccc", "debug", "moderate"),
      } }), status: 1 },
    ],
    semgrep: [
      { match: /--config \.factory\/semgrep/, file: canned({ results: [hit("factory-mass-assignment", 2, 49, 87), hit("factory-trust-proxy-all", 3, 91, 119, "WARNING")], errors: [] }) },
      ...CLEAN.semgrep,
    ],
    "osv-scanner": CLEAN["osv-scanner"],
  });
  let s = r.scan(f);
  assert.equal(s.status, 1);
  assert.deepEqual(statuses(s.sec), { secrets: "fail", vulnerabilities: "fail", sast: "fail" });
  assert.deepEqual(s.sec.items.map((x) => [x.capability, x.tool, x.rule, x.location]), [
    ["secrets", "gitleaks", "aws-access-token", "src/keys.ts:1"],
    ["vulnerabilities", "npm audit", "GHSA-bbbb", "minimist"],
    ["sast", "semgrep project rules", "factory-mass-assignment", "src/users.ts:2"],
    ["sast", "semgrep project rules", "factory-trust-proxy-all", "src/users.ts:3"],
  ], "lodash's advisory is the base's, and a moderate one never counts");
  assert.match(s.sec.capabilities.vulnerabilities.runs[0].detail, /^high\/critical advisories: 1 the run brings, 1 inherited from the base$/);
  assert.deepEqual(f.calls("npm").map((a) => /\.audit-base-/.test(a.at(-1))), [false, true], "the base is audited only once the head has advisories");
  assert.match(s.stdout, /^--- secrets\/gitleaks fail: 1 leak\(s\) in the run's commits\naws-access-token src\/keys\.ts:1\nfull output: \S+security-gitleaks\.log$/m);
  assert.match(s.stdout, /^--- vulnerabilities\/npm audit fail: .*\nGHSA-bbbb minimist minimist is unsafe\nfull output: /m);
  const [, , mass, proxy] = s.sec.items;
  assert.notEqual(mass.fingerprint, proxy.fingerprint);

  // the run waving its own finding through counts for nothing; the human's acceptance on the base does
  r.commit({ ".factory/security-accepted.json": JSON.stringify({ [mass.fingerprint]: "the run says so" }) });
  assert.equal(r.scan(f).sec.accepted.length, 0);
  fs.writeFileSync(path.join(r.p.dir, ".factory/security-accepted.json"), JSON.stringify({ [mass.fingerprint]: "an internal admin tool" }));
  r.p.git("add", "-A"); r.p.git("commit", "-qm", "accept");
  s = r.scan(f);
  assert.deepEqual(s.sec.items.filter((x) => x.capability === "sast").map((x) => x.rule), ["factory-trust-proxy-all"]);
  assert.deepEqual(s.sec.accepted.map((x) => [x.rule, x.reason, x.fingerprint]), [["factory-mass-assignment", "an internal admin tool", mass.fingerprint]]);
});

test("the new-dependency report lists each dependency no package.json at the base declares, with its install scripts, maintainers and licence", () => {
  const r = run({ ...BASE, "packages/ui/package.json": json({ name: "@shop/ui", dependencies: { react: "^18.3.0" } }) });
  r.commit({
    "package.json": json({ name: "shop", dependencies: { express: "^4.21.0", "@shop/ui": "workspace:*" }, devDependencies: { esbuild: "^0.24.0" } }),
    "apps/web/package.json": json({ name: "@shop/web", dependencies: { react: "^18.3.0", "left-pad": "1.3.0" } }),
  });
  const manifest = (version, scripts, license, maintainers) => ({ version, scripts, license, maintainers: Array.from({ length: maintainers }, (_, i) => `m${i}`) });
  let f = fakes({ ...CLEAN, npm: [
    ...CLEAN.npm,
    { match: /^view esbuild@\^0\.24\.0 --json$/, file: canned([manifest("0.24.0", {}, "MIT", 1), manifest("0.24.2", { postinstall: "node install.js", test: "make" }, "MIT", 2)]) },
    { match: /^view left-pad@1\.3\.0 --json$/, file: canned(manifest("1.3.0", { test: "node test" }, { type: "WTFPL" }, 3)) },
  ] });
  let s = r.scan(f);
  assert.equal(s.status, 0, s.stdout);
  assert.deepEqual(s.sec.new_dependencies, [
    { name: "left-pad", spec: "1.3.0", package: "apps/web/package.json", checked: true, install_scripts: {}, maintainers: 3, license: "WTFPL" },
    { name: "esbuild", spec: "^0.24.0", package: "package.json", checked: true, install_scripts: { postinstall: "node install.js" }, maintainers: 2, license: "MIT" },
  ], "express is a bump, react is declared elsewhere at the base, and @shop/ui is the workspace's own");
  assert.match(s.stdout, /new_dependencies=2/);

  f = fakes(CLEAN);
  s = r.scan(f, ["--offline"]);
  assert.deepEqual(s.sec.new_dependencies.map((d) => [d.name, d.checked]), [["left-pad", false], ["esbuild", false]]);
  assert.deepEqual(f.calls("npm"), [], "offline, nothing asks the registry");
});

test("without gitleaks, secretlint through npx reads only the lines the diff adds", () => {
  const r = run({ ...BASE, "src/keys.ts": 'export const old = "AKIA-at-the-base";\n' });
  r.commit({
    "src/keys.ts": 'export const old = "AKIA-at-the-base";\nexport const key = "AKIA-the-run-adds";\n',
    "src/my keys.ts": 'export const a = "AKIA-one";\nexport const b = "AKIA-two";\n',
    'src/q"uote.ts': 'export const q = "AKIA-quoted";\n',
  });
  const { gitleaks, ...rest } = CLEAN;
  const f = fakes(rest);
  // a fake npx that keeps a copy of every file it's given and, as secretlint does, reports each AWS key with its file's
  // absolute path and the key's range in it
  const seen = scratch("factory-seen-");
  fs.writeFileSync(path.join(f.bin, "npx"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), files = args.slice(args.indexOf("json") + 1);
fs.writeFileSync(${JSON.stringify(path.join(seen, "argv.json"))}, JSON.stringify(args));
for (const file of files) fs.cpSync(file, path.join(${JSON.stringify(seen)}, file));
process.stdout.write(JSON.stringify(files.map((file) => ({ filePath: path.resolve(file), messages: [...fs.readFileSync(file, "utf8").matchAll(/AKIA[^"]*/g)]
  .map((m) => ({ ruleId: "@secretlint/secretlint-rule-aws", messageId: "AWSAccessKeyID", range: [m.index, m.index + m[0].length] })) }))));
process.exitCode = 1;
`, { mode: 0o755 });
  const { status, stdout, sec } = r.scan(f);
  assert.equal(status, 1, stdout);
  assert.equal(sec.capabilities.secrets.status, "fail");
  const argv = JSON.parse(fs.readFileSync(path.join(seen, "argv.json"), "utf8"));
  assert.deepEqual(argv.slice(0, 6), ["--yes", "-p", "secretlint", "-p", "@secretlint/secretlint-rule-preset-recommend", "secretlint"]);
  assert.deepEqual(argv.slice(-3).sort(), ["added/src/keys.ts", "added/src/my keys.ts", 'added/src/q"uote.ts'], "a path with a space or a quote is the file's own");
  assert.equal(fs.readFileSync(path.join(seen, "added/src/keys.ts"), "utf8"), 'export const key = "AKIA-the-run-adds";\n', "the base's secret never reaches it");
  assert.deepEqual(sec.items.map((x) => x.location).sort(), ["src/keys.ts", "src/my keys.ts", "src/my keys.ts", 'src/q"uote.ts']);
  assert.ok(sec.items.every((x) => x.tool === "secretlint" && x.rule === "@secretlint/secretlint-rule-aws"));
  assert.equal(new Set(sec.items.map((x) => x.fingerprint)).size, 4, "two keys in one file are two fingerprints");
});

test("osv-scanner's advisories are listed beside the audit's and never block", () => {
  const r = run();
  r.commit({ "src/app.ts": "export const ok = true;\n" });
  const osv = { results: [{ source: { path: "package-lock.json" }, packages: [{ package: { name: "lodash", version: "4.17.20" }, groups: [{ ids: ["GHSA-aaaa"], max_severity: "9.8" }] }] }] };
  const { status, sec } = r.scan(fakes({ ...CLEAN, "osv-scanner": [{ match: /^scan source/, file: canned(osv), status: 1 }] }));
  assert.equal(status, 0);
  assert.equal(sec.capabilities.vulnerabilities.status, "pass");
  assert.deepEqual(sec.capabilities.vulnerabilities.runs[1], {
    tool: "osv-scanner", optional: true, log: sec.capabilities.vulnerabilities.runs[1].log, status: "fail",
    detail: "1 high/critical, which never block", advisories: ["GHSA-aaaa lodash@4.17.20"],
  });
  assert.deepEqual(sec.items, []);
});

// The real tools, where they're installed: CI has none, so there these are skipped.
const installed = (bin) => process.env.PATH.split(path.delimiter).some((d) => fs.existsSync(path.join(d, bin)));
const STARTER = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/templates/semgrep/starter.yaml"), "utf8");
const TARGET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/semgrep/starter.ts.txt");

test("the starter rules pass semgrep --test against their target", { skip: !installed("semgrep") && "semgrep isn't installed" }, () => {
  const dir = scratch("factory-starter-");
  fs.writeFileSync(path.join(dir, "starter.yaml"), STARTER);
  fs.copyFileSync(TARGET, path.join(dir, "starter.ts"));
  const r = spawnSync("semgrep", ["--test", "--metrics=off", "--disable-version-check", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^4\/4: ✓ All tests passed/m);
  assert.doesNotMatch(STARTER, /track\(/, "no analytics rule");
});

test("with the real gitleaks and semgrep, only what the run adds is found, and semgrep's baseline never touches the run's tree",
  { skip: !(installed("semgrep") && installed("gitleaks")) && "semgrep or gitleaks isn't installed" }, () => {
    const mass = (name) => `app.post("/${name}", async (req, res) => res.json(await prisma.${name}.create({ data: req.body })));\n`;
    const r = run({ "package.json": json({ name: "shop" }), ".factory/semgrep/project.yaml": STARTER, "src/old.ts": mass("old"), "local.env": "TOKEN=1\n" });
    // a file the base tracked that the run's tree now ignores, like a run file: checking the base out would take it
    r.commit({ "src/new.ts": mass("post"), "src/keys.ts": 'export const k = "AKIAZ7ZAXJ5L3R4RTQ2Y";\n', "local.env": null, ".gitignore": ".factory/runs/\n.factory/worktrees/\n.factory/env.local\nlocal.env\n" });
    fs.writeFileSync(path.join(r.worktree, "local.env"), "TOKEN=mine\n");
    const head = r.git("rev-parse", "HEAD");
    const { stdout, sec } = r.scan({ env: process.env }, ["--offline"]);
    assert.deepEqual(statuses(sec), { secrets: "fail", vulnerabilities: "missing", sast: "fail" }, stdout);
    assert.deepEqual(sec.items.map((x) => [x.tool, x.rule, x.location]), [
      ["gitleaks", "aws-access-token", "src/keys.ts:1"],
      ["semgrep project rules", "factory-mass-assignment", "src/new.ts:1"],
    ], "src/old.ts's hit is the base's");
    assert.equal(fs.readFileSync(path.join(r.worktree, "local.env"), "utf8"), "TOKEN=mine\n");
    assert.ok(fs.existsSync(path.join(r.run_dir, "state.json")));
    assert.deepEqual([r.git("rev-parse", "HEAD"), r.git("status", "--porcelain")], [head, ""]);
    assert.doesNotMatch(fs.readFileSync(sec.capabilities.secrets.runs[0].log, "utf8"), /AKIAZ7ZAXJ5L3R4RTQ2Y/, "gitleaks redacts the secret");
  });
