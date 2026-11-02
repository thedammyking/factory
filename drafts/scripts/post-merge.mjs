#!/usr/bin/env node
// post-merge.mjs --sha <merged sha> --target <branch> [--run <id>] [--wait <seconds>] [--smoke "<command>"] [--no-revert]
// After a merge: watch the target branch's CI for the merged SHA, wait for the host's deployment of that branch (GitHub
// Deployments API, any host), run the pinned smoke set against the deployed URL, and write one line of evidence.
// The ONLY action it can take is to open a revert PR (never merge it) when CI is red at the merged SHA or the smoke fails.
// Prints: POST-MERGE <run> ci=<green|red|infra> deploy=<success|none|failed> smoke=<pass|fail|skipped> revert=<#n|none>
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const runId = arg("--run") || fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const sha = arg("--sha"); const target = arg("--target");
if (!sha || !target) { console.error("usage: post-merge.mjs --sha <merged sha> --target <branch>"); process.exit(2); }
const waitS = Number(arg("--wait", 3600));
const setup = JSON.parse(fs.readFileSync(path.join(ROOT, ".factory/setup.json"), "utf8"));
const sh = (c, cwd = ROOT) => { try { return execSync(c, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return ""; } };
const repo = (sh("git remote get-url origin").match(/github\.com[:/]([^/\s]+\/[^/.\s]+)/) || [])[1];
const gh = (p, extra = []) => { const r = spawnSync("gh", ["api", p, ...extra], { encoding: "utf8" }); return r.status === 0 ? JSON.parse(r.stdout || "null") : null; };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (l) => fs.appendFileSync(path.join(RUN, "run.log"), `- ${new Date().toISOString()} post-merge: ${l}\n`);
const deadline = Date.now() + waitS * 1000;

// 1. CI at the merged SHA on the target branch
let runs = [];
const poll = () => (gh(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`)?.workflow_runs || []).filter(r => r.head_branch === target || r.event === "push");
runs = poll();
while ((runs.length === 0 || runs.some(r => r.status !== "completed")) && Date.now() < deadline) { sleep(Math.min(20000, Math.max(2000, deadline - Date.now()))); runs = poll(); }
const ci = runs.length === 0 || runs.some(r => r.status !== "completed") ? "infra" : runs.every(r => r.conclusion === "success") ? "green"
  : runs.every(r => ["cancelled", "timed_out", "startup_failure"].includes(r.conclusion)) ? "infra" : "red";
const ciDetail = runs.map(r => `${r.name}=${r.conclusion || r.status}`).join(",");

// 2. Deployment of the target branch for this SHA (staging for develop, production for main): success | none | failed
let deploy = "none", url = null;
if (ci === "green") {
  // Which environment counts is the recipe's call (setup.preview.<target>.environment); without one, any deployment of the
  // SHA counts, because hosts name their environments differently ("Production", "production", "staging", "Preview – web").
  const envName = setup.preview?.[target]?.environment || null;
  const q = `repos/${repo}/deployments?sha=${sha}&per_page=10${envName ? `&environment=${encodeURIComponent(envName)}` : ""}`;
  const d2 = Math.min(deadline, Date.now() + 10 * 60 * 1000);
  while (deploy === "none" && Date.now() < d2) {
    for (const d of gh(q) || []) {
      const st = (gh(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`) || [])[0];
      if (st?.state === "success") { deploy = "success"; url = st.environment_url || st.target_url; break; }
      if (st && ["failure", "error"].includes(st.state)) deploy = "failed";
    }
    if (deploy === "none") { if (!(gh(q) || []).length) break; sleep(15000); }  // no host deploys this branch: don't wait
  }
}

// 3. Smoke set against the deployed URL (the run's pinned specs); skipped when nothing was deployed
let smoke = "skipped", smokeTail = "";
const smokeCmd = arg("--smoke") || setup.smoke?.command;  // e.g. "pnpm --filter web exec playwright test e2e/qa-pinned.spec.ts"
if (deploy === "success" && url && smokeCmd) {
  const r = spawnSync("bash", ["-lc", smokeCmd], { cwd: ROOT, encoding: "utf8", env: { ...process.env, BASE_URL: url, PLAYWRIGHT_BASE_URL: url }, timeout: 15 * 60 * 1000 });
  smoke = r.status === 0 ? "pass" : "fail"; smokeTail = ((r.stdout || "") + (r.stderr || "")).split("\n").slice(-30).join("\n");
}

// 4. The only action: a revert PR, labelled needs-human, never merged here
let revert = "none";
const shouldRevert = (ci === "red" || smoke === "fail") && !process.argv.includes("--no-revert");
if (shouldRevert) {
  const wt = fs.mkdtempSync("/tmp/factory-revert-"); fs.rmSync(wt, { recursive: true, force: true });
  const branch = `revert/${runId}-${sha.slice(0, 7)}`;
  try {
    sh(`git fetch -q origin ${target}`);
    sh(`git worktree add -q --detach "${wt}" origin/${target}`);
    sh(`git checkout -q -b ${branch}`, wt);
    const isMerge = sh(`git rev-list --parents -n 1 ${sha}`, wt).split(" ").length > 2;
    const rv = spawnSync("git", ["revert", "--no-edit", ...(isMerge ? ["-m", "1"] : []), sha], { cwd: wt, encoding: "utf8" });
    if (rv.status !== 0) throw new Error("revert conflicts: " + (rv.stderr || "").slice(0, 200));
    sh(`git commit -q --amend -F - <<'EOF'
Revert "${sh(`git log -1 --format=%s ${sha}`, wt)}"

Opened by the factory after merge: ci=${ci} (${ciDetail}) smoke=${smoke}. Run ${runId}.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012CTtGEFzuLvpjsh3zwUhSu
EOF`, wt);
    sh(`git push -q -u origin ${branch}`, wt);
    const body = `Automatic revert proposal — **not merged by the factory**.\n\nMerged \`${sha.slice(0, 7)}\` on \`${target}\` is red: CI ${ci} (${ciDetail})${smoke !== "skipped" ? `, smoke ${smoke}` : ""}.\n\n${smokeTail ? "```\n" + smokeTail + "\n```\n\n" : ""}Run \`${runId}\`. Close this PR if the red is a flake or already fixed forward.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_012CTtGEFzuLvpjsh3zwUhSu`;
    const num = gh(`repos/${repo}/pulls`, ["-X", "POST", "-f", `title=Revert ${sha.slice(0, 7)} on ${target} (factory: ${ci === "red" ? "CI red" : "smoke failed"})`, "-f", `head=${branch}`, "-f", `base=${target}`, "-f", `body=${body}`])?.number;
    if (num) { gh(`repos/${repo}/issues/${num}/labels`, ["-X", "POST", "-f", "labels[]=factory", "-f", "labels[]=needs-human"]); revert = `#${num}`; }
    else revert = "FAILED to open PR";
  } catch (e) { revert = `FAILED: ${String(e.message || e).slice(0, 160)}`; }
  finally { sh(`git worktree remove --force "${wt}"`); }
}
const line = `${runId} sha=${sha.slice(0, 7)} target=${target} ci=${ci} (${ciDetail}) deploy=${deploy}${url ? ` url=${url}` : ""} smoke=${smoke} revert=${revert}`;
log(line);
fs.writeFileSync(path.join(RUN, "post-merge.json"), JSON.stringify({ run: runId, sha, target, ci, ci_detail: ciDetail, deploy, url, smoke, revert, at: new Date().toISOString() }, null, 2) + "\n");
console.log(`POST-MERGE ${line}`);
process.exit(ci === "green" && smoke !== "fail" ? 0 : 1);
