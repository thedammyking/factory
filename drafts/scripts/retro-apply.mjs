#!/usr/bin/env node
// retro-apply.mjs --accept 1,3 | --all [--run <id>] [--dry]
// Applies the retro's accepted proposals to the base branch, through a temp worktree (never a checkout in the live clone):
//   mechanical rule  -> the fenced ```yaml block appended under `rules:` in .factory/semgrep/project.yaml
//   judgement call   -> the backticked `exact line` appended to .factory/lessons.md (skipped if already present)
// Human-gated: the orchestrator calls this only with the ids the human accepted; in headless mode nothing is applied.
// Prints: RETRO applied=<n> skipped=<n> commit=<sha|none>
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const runId = arg("--run") || fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const state = JSON.parse(fs.readFileSync(path.join(RUN, "state.json"), "utf8"));
const retro = fs.readFileSync(path.join(RUN, "retro.md"), "utf8");
const dry = process.argv.includes("--dry");
const sh = (c, cwd = ROOT) => execSync(c, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
const wt = fs.mkdtempSync("/tmp/factory-retro-");
fs.rmSync(wt, { recursive: true, force: true });
sh(`git worktree add -q "${wt}" ${base}`);
let applied = 0, skipped = 0; const notes = [];
try {
  for (const p of sections) {
    if (!accept.includes(p.n)) { skipped++; continue; }
    const file = path.join(wt, p.target);
    fs.mkdirSync(path.dirname(file), { recursive: true });  // the target may not exist on the base yet (first rule, first lesson)
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (p.kind.startsWith("mechanical") && p.yaml) {
      const id = (p.yaml.match(/- id:\s*([^\n]+)/) || [])[1]?.trim();
      if (id && cur.includes(`id: ${id}`)) { skipped++; notes.push(`${p.n}: rule ${id} already present`); continue; }
      const block = p.yaml.replace(/\s+$/, "") + "\n";
      const next = /^rules:\s*$/m.test(cur) ? cur.replace(/\s*$/, "\n") + block : cur + (cur ? "\n" : "") + "rules:\n" + block;
      if (!dry) fs.writeFileSync(file, next);
      applied++; notes.push(`${p.n}: rule ${id} -> ${p.target}`);
    } else if (p.line) {
      if (cur.includes(p.line)) { skipped++; notes.push(`${p.n}: line already present`); continue; }
      if (!dry) fs.writeFileSync(file, cur.replace(/\s*$/, "\n") + `- ${p.line}\n`);
      applied++; notes.push(`${p.n}: line -> ${p.target}`);
    } else { skipped++; notes.push(`${p.n}: nothing applicable parsed`); }
  }
  let commit = "none";
  if (applied && !dry) {
    // Validate the rules file offline when the scanner is installed: its --validate fetches rule lints from the registry
    // (often unreachable), so compile the rules by scanning an empty directory with metrics and version checks off instead.
    if (notes.some(n => n.includes("semgrep")) && sh("command -v semgrep || true")) {
      const empty = fs.mkdtempSync("/tmp/factory-rules-empty-");
      try { sh(`SEMGREP_SEND_METRICS=off semgrep scan --metrics=off --disable-version-check --quiet --config .factory/semgrep/project.yaml "${empty}"`, wt); }
      finally { fs.rmSync(empty, { recursive: true, force: true }); }
    }
    sh(`git add .factory/lessons.md .factory/semgrep/project.yaml`, wt);
    sh(`git -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -F - <<'EOF'
factory: apply retro ${runId} (${accept.join(",")})

${notes.filter(n => !n.includes("already")).join("\n")}

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012CTtGEFzuLvpjsh3zwUhSu
EOF`, wt);
    commit = sh("git rev-parse --short HEAD", wt);
  }
  fs.appendFileSync(path.join(RUN, "run.log"), `- ${new Date().toISOString()} retro-apply: accepted=${accept.join(",")} applied=${applied} commit=${commit}\n`);
  console.log(`RETRO applied=${applied} skipped=${skipped} commit=${commit}${dry ? " (dry)" : ""}\n  ${notes.join("\n  ")}`);
} finally { sh(`git worktree remove --force "${wt}"`); }
