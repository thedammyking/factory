#!/usr/bin/env node
// retro-apply.mjs --accept 1,3 | --all [--run <id>] [--dry]
// Applies the retro's accepted proposals to the base branch, through a temp worktree (never a checkout in the live clone):
//   mechanical rule  -> the fenced ```yaml block appended under `rules:` in .factory/semgrep/project.yaml
//   judgement call   -> the backticked `exact line` appended to .factory/lessons.md (skipped if already present)
// Human-gated: the orchestrator calls this only with the ids the human accepted; in headless mode nothing is applied.
// Prints: RETRO applied=<n> skipped=<n> commit=<sha|none>
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const runId = arg("--run") || fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const state = JSON.parse(fs.readFileSync(path.join(RUN, "state.json"), "utf8"));
const retro = fs.readFileSync(path.join(RUN, "retro.md"), "utf8");
const dry = process.argv.includes("--dry");
// git/semgrep with argument lists: the base branch, run id and proposal targets never pass through a shell.
const run = (cmd, args, cwd = ROOT, input) => execFileSync(cmd, args, { cwd, input, encoding: "utf8", stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }).trim();

// ---- parse proposals: "## <n>. <title>" sections with "- kind:", "- target file: `...`", a ```yaml block or "exact line ... `...`"
const sections = [...retro.matchAll(/^## (\d+)\. ([^\n]+)\n([\s\S]*?)(?=^## |\n*$(?![\s\S]))/gm)].map(m => {
  const body = m[3];
  const kind = (body.match(/- kind:\s*([^\n]+)/) || [])[1]?.trim();
  const target = (body.match(/- target file:\s*`([^`]+)`/) || [])[1];
  const yaml = (body.match(/```yaml\n([\s\S]*?)```/) || [])[1];
  const line = (body.match(/exact line[^\n]*\n\s*`([^`]+)`/) || [])[1];
  return { n: Number(m[1]), title: m[2].trim(), kind, target, yaml, line };
}).filter(p => p.kind && p.target);
const accept = process.argv.includes("--all") ? sections.map(p => p.n) : (arg("--accept") || "").split(",").map(Number).filter(Boolean);
if (!accept.length) { console.log(`RETRO applied=0 skipped=${sections.length} commit=none (no proposals accepted; ${sections.length} parsed)`); process.exit(0); }

// ---- apply in a temp worktree on the base branch
const base = state.base_branch || "develop";
if (!/^(?!-)[\w./-]+$/.test(base)) { console.error(`base branch '${base}' is not a branch name`); process.exit(2); }
if (!dry && process.env.FACTORY_COMMIT_TRAILER === undefined) { console.error("export FACTORY_COMMIT_TRAILER (the session's commit attribution lines; empty if none)"); process.exit(2); }
const wt = fs.mkdtempSync("/tmp/factory-retro-");
fs.rmSync(wt, { recursive: true, force: true });
run("git", ["worktree", "add", "-q", wt, base]);
let applied = 0, skipped = 0; const notes = []; const touched = new Set(), ruleFiles = new Set();
try {
  for (const p of sections) {
    if (!accept.includes(p.n)) { skipped++; continue; }
    const file = path.join(wt, p.target);
    if (!file.startsWith(wt + path.sep)) { skipped++; notes.push(`${p.n}: target ${p.target} is outside the repo, refused`); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });  // the target may not exist on the base yet (first rule, first lesson)
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (p.kind.startsWith("mechanical") && p.yaml) {
      const id = (p.yaml.match(/- id:\s*([^\n]+)/) || [])[1]?.trim();
      if (id && cur.includes(`id: ${id}`)) { skipped++; notes.push(`${p.n}: rule ${id} already present`); continue; }
      const block = p.yaml.replace(/\s+$/, "") + "\n";
      const next = /^rules:\s*$/m.test(cur) ? cur.replace(/\s*$/, "\n") + block : cur + (cur ? "\n" : "") + "rules:\n" + block;
      if (!dry) fs.writeFileSync(file, next);
      applied++; notes.push(`${p.n}: rule ${id} -> ${p.target}`); touched.add(p.target); ruleFiles.add(p.target);
    } else if (p.line) {
      if (cur.includes(p.line)) { skipped++; notes.push(`${p.n}: line already present`); continue; }
      if (!dry) fs.writeFileSync(file, cur.replace(/\s*$/, "\n") + `- ${p.line}\n`);
      applied++; notes.push(`${p.n}: line -> ${p.target}`); touched.add(p.target);
    } else { skipped++; notes.push(`${p.n}: nothing applicable parsed`); }
  }
  let commit = "none";
  if (applied && !dry) {
    // Validate the rules file offline when the scanner is installed: its --validate fetches rule lints from the registry
    // (often unreachable), so compile the rules by scanning an empty directory with metrics and version checks off instead.
    const hasSemgrep = (() => { try { run("semgrep", ["--version"]); return true; } catch { return false; } })();
    for (const rf of hasSemgrep ? ruleFiles : []) {
      const empty = fs.mkdtempSync("/tmp/factory-rules-empty-");
      try { run("semgrep", ["scan", "--metrics=off", "--disable-version-check", "--quiet", "--config", rf, empty], wt); }
      finally { fs.rmSync(empty, { recursive: true, force: true }); }
    }
    run("git", ["add", "--", ...touched], wt);  // exactly the files the accepted proposals changed
    run("git", ["commit", "-q", "-F", "-"], wt, `factory: apply retro ${runId} (${accept.join(",")})\n\n${notes.filter(n => !n.includes("already")).join("\n")}\n\n${process.env.FACTORY_COMMIT_TRAILER}\n`);
    commit = run("git", ["rev-parse", "--short", "HEAD"], wt);
  }
  fs.appendFileSync(path.join(RUN, "run.log"), `- ${new Date().toISOString()} retro-apply: accepted=${accept.join(",")} applied=${applied} commit=${commit}\n`);
  console.log(`RETRO applied=${applied} skipped=${skipped} commit=${commit}${dry ? " (dry)" : ""}\n  ${notes.join("\n  ")}`);
} finally { run("git", ["worktree", "remove", "--force", wt]); }
