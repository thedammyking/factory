#!/usr/bin/env node
// security-scan.mjs <base_sha> [--run <id>] -> <run>/security.json
// Capabilities, each satisfied by whichever tool is available; a required capability with no tool is `missing`, never a pass.
//   secrets              gitleaks on the branch's commits, else secretlint (npx) on the changed files
//   vulnerabilities      pnpm/npm audit for a pnpm or npm lockfile, else osv-scanner (every ecosystem's lockfiles), else
//                        missing (pass only when the repo has no dependency manifest at all)
//   vulnerabilities-2nd-source  osv-scanner beside a JS audit (optional)
//   sast-project-rules   semgrep with .factory/semgrep/project.yaml (pass while the project has no rules yet)
//   sast-registry-packs  semgrep registry packs for the changed languages: ERROR hits fail, warnings are listed (partial
//                        when the registry is unreachable)
// High and critical items from every tool are listed in `findings`, which merge-decision's no_high_security reads.
// Plus two checks no scanner does: client-exposed env names and new npm dependencies.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { runContext } from "./lib.mjs";

const { ROOT, RUN } = runContext();
const BASE = process.argv[2];
if (!/^(?!-)[\w./-]+$/.test(BASE || "")) { console.error("usage: security-scan.mjs <base_sha> [--run <id>]"); process.exit(2); }
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const has = (bin) => !spawnSync(bin, ["--version"], { stdio: "ignore" }).error;
const run = (bin, args, seconds = 600) => {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", timeout: seconds * 1000, maxBuffer: 256 * 1024 * 1024 });
  return { rc: r.error ? -1 : r.status, stdout: r.stdout || "", out: (r.stdout || "") + (r.stderr || "") + (r.error ? String(r.error.message) : "") };
};
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const caps = [], findings = [];
const rec = (capability, tool, status, detail) => caps.push({ capability, tool, status, detail: String(detail).slice(-600) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-sec-"));
const changed = git("diff", "--name-only", `${BASE}..HEAD`, "--", ".", ":(exclude).factory").split("\n").filter(Boolean);
const LOCKS = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/;

// --- secrets
if (has("gitleaks")) {
  const report = path.join(tmp, "gitleaks.json");
  const r = run("gitleaks", ["git", "--no-banner", "--redact", "--report-format", "json", "--report-path", report, `--log-opts=${BASE}..HEAD`, "."]);
  const leaks = parse(fs.existsSync(report) ? fs.readFileSync(report, "utf8") : "") || [];
  for (const l of leaks) findings.push({ tool: "gitleaks", severity: "high", id: l.RuleID, location: `${l.File}:${l.StartLine}`, commit: (l.Commit || "").slice(0, 7) });
  rec("secrets", "gitleaks", r.rc === 0 ? "pass" : "fail", r.rc === 0 ? "no leaks in the branch's commits" : leaks.length ? `${leaks.length} leak(s)` : r.out);
} else {
  const files = changed.filter(f => !LOCKS.test(f) && exists(f));
  if (!files.length) rec("secrets", "secretlint", "pass", "no changed files");
  else {
    const rc = path.join(tmp, "secretlintrc.json");
    fs.writeFileSync(rc, JSON.stringify({ rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }] }));
    const r = run("npx", ["-y", "-p", "secretlint", "-p", "@secretlint/secretlint-rule-preset-recommend", "secretlint", "--secretlintrc", rc, ...files], 300);
    if (r.rc !== 0) findings.push({ tool: "secretlint", severity: "high", id: "secret", location: "see detail" });
    rec("secrets", "secretlint", r.rc === 0 ? "pass" : "fail", r.out);
  }
}

// --- vulnerabilities
// npm 7+: { vulnerabilities: { <pkg>: { severity, via } } }; pnpm: { advisories: { <id>: { module_name, severity, title } } }
const auditHigh = (j, tool) => [
  ...Object.values(j?.vulnerabilities || {}).map(v => ({ id: v.name, package: v.name, severity: v.severity, title: (v.via || []).find(x => typeof x === "object")?.title })),
  ...Object.values(j?.advisories || {}).map(a => ({ id: a.github_advisory_id || String(a.id), package: a.module_name, severity: a.severity, title: a.title })),
].filter(v => ["high", "critical"].includes(v.severity)).map(v => ({ tool, ...v }));
// osv: results[].packages[].groups[].max_severity is a CVSS score
const osvHigh = (j) => (j?.results || []).flatMap(r => (r.packages || []).flatMap(p => (p.groups || []).filter(g => Number(g.max_severity) >= 7)
  .map(g => ({ tool: "osv-scanner", id: (g.ids || [])[0], package: `${p.package?.name}@${p.package?.version}`, severity: Number(g.max_severity) >= 9 ? "critical" : "high", location: path.relative(ROOT, r.source?.path || "") }))));
const osv = () => {
  const r = run("osv-scanner", ["scan", "source", "-r", "--format", "json", "."]);
  const j = parse(r.stdout), high = osvHigh(j);
  findings.push(...high);
  // exit 128 = no packages found; anything else without JSON is a scanner failure
  return { high, status: j ? (high.length ? "fail" : "pass") : r.rc === 128 ? "pass" : "fail", detail: j ? `${high.length} high/critical` : r.rc === 128 ? "no packages found" : r.out };
};
const jsAudit = exists("pnpm-lock.yaml") ? ["pnpm-audit", "pnpm", ["audit", "--prod", "--json"]]
  : exists("package-lock.json") ? ["npm-audit", "npm", ["audit", "--omit=dev", "--json"]] : null;
if (jsAudit) {
  const r = run(jsAudit[1], jsAudit[2], 300);
  const j = parse(r.stdout), high = auditHigh(j, jsAudit[0]);
  findings.push(...high);
  rec("vulnerabilities", jsAudit[0], !j || j.error ? "fail" : high.length ? "fail" : "pass", !j || j.error ? r.out : `${high.length} high/critical advisories`);
  if (has("osv-scanner")) { const o = osv(); rec("vulnerabilities-2nd-source", "osv-scanner", o.status, o.detail); }
  else rec("vulnerabilities-2nd-source", "osv-scanner", "optional", "not installed (brew install osv-scanner)");
} else if (has("osv-scanner")) {
  const o = osv(); rec("vulnerabilities", "osv-scanner", o.status, o.detail);
} else {
  const manifests = git("ls-files").split("\n").filter(f => /(^|\/)(yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile\.lock|go\.mod|Cargo\.lock|Gemfile\.lock|composer\.lock|pom\.xml|build\.gradle(\.kts)?|pubspec\.lock|Package\.resolved|Podfile\.lock)$/.test(f));
  rec("vulnerabilities", "none", manifests.length ? "missing" : "pass", manifests.length ? `no scanner for ${manifests.slice(0, 3).join(", ")} (brew install osv-scanner)` : "no dependency manifests");
}

// --- SAST: semgrep project rules (always) + registry packs for the changed languages (when the registry is reachable).
// .factory/ is bookkeeping and plugin files, not product, as in every other product-diff step.
// semgrep's --baseline-commit checks the base out IN the tree it scans (git reset there and back): in the live checkout that
// deletes ignored files the base once tracked (it took a live run's state.json) and moves HEAD under running dev servers.
// So it scans a detached worktree at HEAD, removed at the end.
const rules = ".factory/semgrep/project.yaml";
let sast = null;
const semgrep = (configs) => {
  if (!sast) { sast = fs.mkdtempSync(path.join(os.tmpdir(), "factory-sast-")); git("worktree", "add", "-q", "--detach", sast, "HEAD"); }
  const args = ["scan", ...configs.flatMap(c => ["--config", c]), "--metrics=off", "--disable-version-check", "--error", "--baseline-commit", BASE, "--exclude", ".factory", "--quiet", "--json", "."];
  const r = spawnSync("semgrep", args, { cwd: sast, encoding: "utf8", timeout: 600_000, maxBuffer: 256 * 1024 * 1024 });
  return { rc: r.error ? -1 : r.status, stdout: r.stdout || "", out: (r.stdout || "") + (r.stderr || "") + (r.error ? String(r.error.message) : "") };
};
const semgrepFindings = (j) => (j?.results || []).map(x => ({ tool: "semgrep", id: x.check_id, severity: x.extra?.severity === "ERROR" ? "high" : "medium", location: `${x.path}:${x.start?.line}` }));
const hasSemgrep = has("semgrep");
if (!exists(rules)) rec("sast-project-rules", "none", "pass", `no project rules yet (${rules})`);
else if (!hasSemgrep) rec("sast-project-rules", "semgrep", "missing", "not installed (brew install semgrep)");
else {
  const r = semgrep([rules]); const j = parse(r.stdout);
  fs.writeFileSync(path.join(RUN, "semgrep-project.json"), r.stdout);
  findings.push(...semgrepFindings(j).filter(f => f.severity === "high"));
  rec("sast-project-rules", "semgrep", j && !j.results.length ? "pass" : "fail", j ? `findings=${j.results.length}` : r.out);
}
const exts = new Set(changed.map(f => path.extname(f)));
const packs = ["p/owasp-top-ten",
  ...([".ts", ".tsx", ".js", ".jsx", ".mjs"].some(e => exts.has(e)) ? ["p/typescript", "p/nodejs", "p/react"] : []),
  ...(exts.has(".py") ? ["p/python"] : []), ...(exts.has(".go") ? ["p/golang"] : []), ...(exts.has(".rb") ? ["p/ruby"] : []),
  ...([".java", ".kt"].some(e => exts.has(e)) ? ["p/java"] : []), ...(exts.has(".php") ? ["p/php"] : [])];
if (!hasSemgrep) rec("sast-registry-packs", "semgrep", "optional", "not installed");
else {
  const r = semgrep(packs); const j = parse(r.stdout);
  if (j?.results) {
    fs.writeFileSync(path.join(RUN, "semgrep-packs.json"), r.stdout);
    findings.push(...semgrepFindings(j).filter(f => f.severity === "high"));
    // registry packs are generic: only ERROR-severity hits fail; warnings stay visible in semgrep-packs.json for the security lens
    const errors = j.results.filter(x => x.extra?.severity === "ERROR").length;
    rec("sast-registry-packs", "semgrep", errors ? "fail" : "pass", `errors=${errors} warnings=${j.results.length - errors} (${packs.join(" ")})`);
  } else rec("sast-registry-packs", "semgrep", "partial", "semgrep.dev registry unreachable from this environment; project rules ran");
}

// --- two checks no scanner does
const added = git("diff", `${BASE}..HEAD`, "--", ".", ":(exclude).factory").split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).join("\n");
const pub = [...new Set(added.match(/\b(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_[A-Z0-9_]+/g) || [])].join(" ");
const pkgDiff = git("diff", `${BASE}..HEAD`, "--", ":(glob)**/package.json");
const newDeps = [...new Set([...pkgDiff.matchAll(/^\+\s+"([^"]+)":\s*"[~^0-9]/gm)].map(m => m[1]))].join(" ");

fs.rmSync(tmp, { recursive: true, force: true });
if (sast) git("worktree", "remove", "--force", sast);
const out = { base: BASE, head: git("rev-parse", "HEAD"), capabilities: caps, client_exposed_env: pub, new_dependencies: newDeps, findings };
fs.writeFileSync(path.join(RUN, "security.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`SECURITY ${caps.map(c => `${c.capability}=${c.status}(${c.tool})`).join(" ")} | high/critical: ${findings.filter(f => /high|critical/.test(f.severity)).length} | client env: ${pub || "none"} | new deps: ${newDeps.split(" ").filter(Boolean).length}`);
