// pr.test.mjs — the PR stage's scripts spawned as processes on a run of a throwaway project whose origin is a local bare
// remote (a GitHub URL rewritten to it), with a fake `gh` on PATH that records each REST call and answers from fixtures:
// merge-decision, pr-render, pr-open and run-state approve migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { project, script, startRun, fakeClis, githubOrigin, sh, write } from "./harness.mjs";

// run-state measures spend from transcripts under CLAUDE_CONFIG_DIR, so no test reads the real ~/.claude.
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")) };
delete ENV.CLAUDE_CODE_SESSION_ID;

const TOUCHES = ["auth", "data", "migrations", "network", "files", "crypto", "config", "deps", "native", "api_contract", "ui", "tests"];
const RECIPE = { apps: [{ name: "app", type: "web", path: ".", dev: "npm run dev -- --port {port:app}", health: "http://localhost:{port:app}/", checks: { test: "true" } }], pinned: ["e2e"], setup: "npm ci" };
const SPEC = `---
surface: operate
---

# Signup

## Goal
A visitor can make an account from the signup page.

## Non-goals
- Social sign-in.

## Anti-goals
- A signup that silently drops the visitor's marketing choice.
- Any page that shows a password in clear text.

## Success criteria
- **SC-001** (profile: default, live-safe: yes): \`/signup\`, submit a new email and a password, the page shows "Welcome" and the account exists.
- **SC-002** (profile: default, live-safe: no): From \`/\`, choosing Sign up posts one event to https://analytics.invalid/collect with the route | name.

## Out of scope
- Password reset.
`;
const IMPL = (n, { recommendation = "merge", confident = "true", reason = "every criterion passed and the change is small" } = {}) => `# Ticket ${n}

- abc1234 Add the signup form: the plan's task 1

status: DONE
blocked_cause: none
assumptions:
- The plan left the button's label open: I chose "Sign up".
concerns:
- none
denied:
- none
assessment:
  recommendation: ${recommendation}
  confident: ${confident}
  reason: ${reason}
`;

// A run past its review with every merge fact holding, PR #7 open on o/r. Its files are pinned to the run head by pin(),
// which a test calls again after each commit; put(file, change) rewrites one with a change merged in. decide() runs
// merge-decision and returns decision.json.
function ready({ config = {}, recipe = RECIPE, base = {} } = {}) {
  const p = project({ recipe, config: { merge: "trial", merge_method: "merge", ...config } }), bare = githubOrigin(p);
  const s = startRun(p, base);
  if (Object.keys(base).length) p.git("push", "-q", "origin", "main");
  const rs = (...args) => { const r = script("run-state.mjs", p.dir, [...args, "--run", s.id], { env: ENV }); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  rs("set", "route", "build"); rs("set", "branch", "feature/signup"); rs("set", "target_branch", "main");
  s.commit({ "src/signup.js": "export const signup = () => 'Welcome';\n" }, "Add the signup form");
  const head = () => s.git("rev-parse", "HEAD");
  const gh = fakeClis({ gh: [
    { match: /^api repos\/o\/r\/pulls\/7$/, file: path.join(s.run_dir, "..", "pr7.json") },
    { match: /^api -X POST repos\/o\/r\/pulls .* -f base=develop /, file: path.join(s.run_dir, "..", "created8.json") },
    { match: /^api -X POST repos\/o\/r\/pulls /, file: path.join(s.run_dir, "..", "created.json") },
    { match: /^api -X (POST|PATCH|DELETE) repos\/o\/r\/(issues|pulls)\//, file: path.join(s.run_dir, "..", "ok.json") },
  ] });
  const json = (file, value) => write(s.run_dir, { [file]: JSON.stringify(value, null, 2) + "\n" });
  const read = (file) => JSON.parse(fs.readFileSync(path.join(s.run_dir, file), "utf8"));
  const put = (file, change) => json(file, { ...read(file), ...change });
  const touches = (hit = []) => Object.fromEntries(TOUCHES.map((t) => [t, { hit: hit.includes(t), paths: [], patterns: [] }]));
  const pin = () => {
    const h = head();
    write(s.run_dir, {
      "spec.md": SPEC, "triage.md": "```json\n" + JSON.stringify({ type: "feature", size: "s", route: "build" }) + "\n```\n",
      "tickets/01-signup.md": "# 01: Signup\n\nStatus: done\nBlocked by: none\n", "tickets/01/implementation.md": IMPL("01"),
      "../pr7.json": JSON.stringify({ number: 7, draft: false, html_url: "https://github.com/o/r/pull/7", base: { ref: "main" }, head: { ref: "feature/signup", sha: h } }),
      "../ok.json": "{}\n",
      "../created.json": JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7" }),
      "../created8.json": JSON.stringify({ number: 8, html_url: "https://github.com/o/r/pull/8" }),
    });
    json("tickets/01/qa.json", { ticket: "01-signup", status: "done", criteria: [{ id: "SC-001", status: "pass" }, { id: "SC-002", status: "pass" }], superseded: [], repaired: [], failed: [] });
    json("evidence.json", { mode: "full", sha: h, green: true, dirty: false, trusted: true, red_cause: null, checks: [{ app: "app", check: "test", status: "pass", seconds: 1.2 }] });
    json("ci.json", { sha: h, cause: "green" });
    json("findings.json", { disposition: "ship", counts: { P0: 0, P1: 0, P2: 0, P3: 0, open_blocking: 0, open_asks: 0, resolved: 0 }, findings: [] });
    json("security.json", { head: h, capabilities: { secrets: { status: "pass", runs: [{ tool: "gitleaks", status: "pass" }] },
      vulnerabilities: { status: "pass", runs: [{ tool: "npm audit", status: "pass" }] }, sast: { status: "partial", runs: [{ tool: "semgrep project rules", status: "pass" }] } },
      items: [], accepted: [], new_dependencies: [] });
    json("touches.json", { head: h, files_changed: 1, touches: touches(), new_env: [] });
    json("pr.json", { repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head: "feature/signup", base: "main", draft: false, labels: ["factory"], comments: [] });
  };
  pin();
  const decide = () => {
    const r = script("merge-decision.mjs", p.dir, ["--run", s.id], { env: gh.env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return { ...read("decision.json"), stdout: r.stdout };
  };
  return { p, s, bare, gh, rs, head, json, read, put, touches, pin, decide };
}
const failing = (d) => d.facts.filter((f) => !f.ok).map((f) => f.name);

test("with every fact holding, merge-decision writes a trial merge at HEAD, each fact with what it read", () => {
  const r = ready(), d = r.decide();
  assert.equal(d.decision, "merge", d.reasons.join("\n"));
  assert.equal(d.mode, "trial");
  assert.equal(d.head, r.head());
  assert.deepEqual(d.reasons, []);
  for (const name of ["evidence_green_at_head", "ci_green_at_head", "criteria_pass", "findings_ship", "security_clear", "captures_if_ui",
    "no_protected_paths", "files_within_limit", "no_migrations_unless_approved", "size_not_l", "not_behind_base", "implementer_confident",
    "under_dispatch_cap", "no_cap_overrides", "previews_ready", "pr_targets_target",
    "no_auth_or_crypto", "no_new_env", "no_new_dependency", "no_pinned_test_changed", "not_git_flow_main"]) {
    const f = d.facts.find((f) => f.name === name);
    assert.ok(f, `fact ${name}`);
    assert.equal(f.ok, true, `${name}: ${f.detail}`);
    assert.ok(f.detail, `${name} says what it read`);
  }
  assert.match(d.stdout, /^DECISION merge \(trial\)/m);
  assert.deepEqual(r.gh.calls("gh"), [["api", "repos/o/r/pulls/7"]], "the PR is read over REST, once");
});

test("each fact from #15 alone makes the decision needs-human, naming it with its evidence", () => {
  const r = ready();
  const cases = [
    ["no_auth_or_crypto", () => r.put("touches.json", { touches: r.touches(["auth"]) })],
    ["no_auth_or_crypto", () => r.put("touches.json", { touches: r.touches(["crypto"]) })],
    ["no_new_env", () => r.put("touches.json", { new_env: ["STRIPE_KEY"] })],
    ["no_new_dependency", () => r.put("security.json", { new_dependencies: [{ name: "left-pad", spec: "^1.3.0", package: "package.json" }] })],
    ["not_git_flow_main", () => write(r.p.dir, { ".factory/config.json": JSON.stringify({ merge: "trial", branching: { model: "git-flow", main: "main", develop: "develop" } }) })],
  ];
  for (const [name, change] of cases) {
    r.pin(); write(r.p.dir, { ".factory/config.json": JSON.stringify({ merge: "trial", merge_method: "merge" }) });
    change();
    const d = r.decide();
    assert.equal(d.decision, "needs-human", name);
    assert.deepEqual(failing(d), [name]);
    assert.match(d.reasons[0], new RegExp(`^${name}: `));
    assert.ok(d.facts.find((f) => f.name === name).evidence.length, `${name} names its evidence`);
  }
});

test("a pinned test that existed at the merge base, modified or deleted, makes it needs-human; a new pinned test doesn't", () => {
  const r = ready({ base: { "e2e/old-01-signup.spec.ts": "test('old');\n", "e2e/gone-01-x.spec.ts": "test('gone');\n" } });
  r.s.commit({ "e2e/r1-01-signup.spec.ts": "test('new');\n" }, "qa: pin SC-001"); r.pin();
  assert.equal(r.decide().decision, "merge", "a new pinned test is fine");
  r.s.commit({ "e2e/old-01-signup.spec.ts": "test('old, superseded');\n" }, "qa: supersede"); r.pin();
  let d = r.decide();
  assert.deepEqual(failing(d), ["no_pinned_test_changed"]);
  assert.match(d.reasons[0], /e2e\/old-01-signup\.spec\.ts modified/);
  r.s.git("rm", "-q", "e2e/gone-01-x.spec.ts"); r.s.git("commit", "-qm", "qa: delete"); r.pin();
  d = r.decide();
  assert.match(d.reasons[0], /e2e\/gone-01-x\.spec\.ts deleted/);
});

test("each base fact failing alone makes the decision needs-human and is listed with what it read", () => {
  const r = ready();
  const cases = [
    ["evidence_green_at_head", () => r.put("evidence.json", { sha: "0".repeat(40) })],
    ["evidence_green_at_head", () => r.put("evidence.json", { green: false, checks: [{ app: "app", check: "test", status: "fail", seconds: 1 }] })],
    ["ci_green_at_head", () => fs.rmSync(path.join(r.s.run_dir, "ci.json"))],
    ["ci_green_at_head", () => r.put("ci.json", { cause: "ours" })],
    ["criteria_pass", () => r.put("tickets/01/qa.json", { criteria: [{ id: "SC-001", status: "pass" }, { id: "SC-002", status: "fail" }] })],
    ["criteria_pass", () => r.put("tickets/01/qa.json", { criteria: [{ id: "SC-001", status: "pass" }] })],
    ["findings_ship", () => fs.rmSync(path.join(r.s.run_dir, "findings.json"))],
    ["findings_ship", () => r.put("findings.json", { disposition: "ask", findings: [{ id: "code-01", severity: "P2", action: "ask", status: "open", location: "src/signup.js:1", claim: "Should it?" }] })],
    ["security_clear", () => r.put("security.json", { items: [{ capability: "vulnerabilities", tool: "npm audit", rule: "GHSA-1", severity: "critical", location: "lodash" }] })],
    ["security_clear", () => r.put("security.json", { capabilities: { ...r.read("security.json").capabilities, secrets: { status: "missing", runs: [] } } })],
    ["captures_if_ui", () => r.put("touches.json", { touches: r.touches(["ui"]) })],
    ["no_migrations_unless_approved", () => r.put("touches.json", { touches: r.touches(["migrations"]) })],
    ["size_not_l", () => write(r.s.run_dir, { "triage.md": "```json\n" + JSON.stringify({ type: "feature", size: "l" }) + "\n```\n" })],
    ["implementer_confident", () => write(r.s.run_dir, { "tickets/01/implementation.md": IMPL("01", { confident: "false" }) })],
    ["implementer_confident", () => write(r.s.run_dir, { "tickets/01/implementation.md": IMPL("01", { reason: "" }) })],
    ["implementer_confident", () => write(r.s.run_dir, { "review-fix.md": IMPL("review fix", { recommendation: "needs-human" }) })],
    ["previews_ready", () => fs.writeFileSync(path.join(r.s.worktree, ".factory/setup.json"), JSON.stringify({ ...RECIPE, preview: { app: { mode: "github-deployment", environment: "Preview" } } }))],
    ["pr_targets_target", () => write(r.s.run_dir, { "../pr7.json": JSON.stringify({ number: 7, base: { ref: "develop" }, head: { sha: r.head() } }) })],
    ["pr_targets_target", () => fs.rmSync(path.join(r.s.run_dir, "pr.json"))],
    ["touches_at_head", () => r.put("touches.json", { head: "0".repeat(40) })],
  ];
  for (const [name, change] of cases) {
    r.pin(); fs.rmSync(path.join(r.s.run_dir, "review-fix.md"), { force: true }); r.s.git("checkout", "-q", "--", ".factory/setup.json");
    change();
    const d = r.decide();
    assert.equal(d.decision, "needs-human", name);
    if (name === "touches_at_head") {
      // a touches.json from another head can't vouch for any fact read from it
      assert.ok(["no_auth_or_crypto", "no_new_env", "captures_if_ui", "no_migrations_unless_approved"].every((f) => failing(d).includes(f)), failing(d).join());
      continue;
    }
    assert.deepEqual(failing(d), [name], `${name}: ${d.reasons.join("; ")}`);
  }
});

test("a touched app's github-deployment preview must reach success at HEAD, as preview.mjs reads it, for a merge; an untouched app's needn't", () => {
  const preview = { app: { mode: "github-deployment", environment: "Preview" }, docs: { mode: "github-deployment", environment: "Docs" } };
  const r = ready({ recipe: { ...RECIPE, apps: [...RECIPE.apps, { name: "docs", type: "web", path: "docs" }], preview } });
  const fixture = (name, value) => { const f = path.join(r.s.run_dir, "..", `${name}.json`); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  const gh = fakeClis({ gh: [
    { match: /^api repos\/o\/r\/pulls\/7$/, file: path.join(r.s.run_dir, "..", "pr7.json") },
    { match: /^api -X GET repos\/o\/r\/deployments -f sha=[0-9a-f]{40} -f environment=Preview /, file: fixture("deployments", [{ id: 5, environment: "Preview" }]) },
    { match: /^api repos\/o\/r\/deployments\/5\/statuses/, file: path.join(r.s.run_dir, "..", "statuses.json") },
  ] });
  const decide = (status) => {
    fixture("statuses", [status]);
    const p = script("preview.mjs", r.p.dir, ["--run", r.s.id, "--wait", "0"], { env: gh.env });
    assert.equal(p.status, 0, p.stderr);
    const d = script("merge-decision.mjs", r.p.dir, ["--run", r.s.id], { env: gh.env });
    assert.equal(d.status, 0, d.stderr);
    return r.read("decision.json");
  };
  let d = decide({ state: "success", environment_url: "https://app-git-feature-signup.vercel.app" });
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  assert.equal(d.facts.find((f) => f.name === "previews_ready").detail, "app ready", "docs isn't touched, so its preview isn't read");
  assert.equal(r.read("preview.json").apps.docs.status, "none");
  for (const status of [{ state: "in_progress" }, { state: "failure" }, { state: "success" }]) {
    d = decide(status);
    assert.deepEqual(failing(d), ["previews_ready"], JSON.stringify(status));
  }
  // a commit since the preview was read: the preview is of another head
  decide({ state: "success", environment_url: "https://app-git-feature-signup.vercel.app" });
  const before = r.head();
  r.s.commit({ "src/more.js": "x\n" }); r.pin();
  const m = script("merge-decision.mjs", r.p.dir, ["--run", r.s.id], { env: gh.env });
  assert.equal(m.status, 0, m.stderr);
  d = r.read("decision.json");
  assert.deepEqual(failing(d), ["previews_ready"]);
  assert.match(d.reasons[0], new RegExp(`app ready at ${before.slice(0, 7)}`));
});

test("fix 21: the protected-path fact diffs from the merge base with the live base, and not_behind_base names the sync step", () => {
  const r = ready();
  // the base gains a CI workflow on origin after the run branched
  r.p.git("checkout", "-q", "main");
  write(r.p.dir, { ".github/workflows/ci.yml": "on: push\n" }); r.p.git("add", "-A"); r.p.git("commit", "-qm", "ci"); r.p.git("push", "-q", "origin", "main");
  let d = r.decide();
  assert.deepEqual(failing(d), ["not_behind_base"]);
  assert.match(d.reasons[0], /1 commit.*sync-base\.mjs before-merge/);
  // a merge of the base (as a human or update-branch would make): base_sha stays where the run began
  r.s.git("merge", "-q", "--no-edit", "origin/main"); r.pin();
  d = r.decide();
  assert.equal(d.decision, "merge", `ci.yml came from the base, so it isn't the run's: ${d.reasons.join("; ")}`);
  // and through the sync step it names: the base moves again, and before-merge merges it in (locally, without pr.json)
  r.p.git("checkout", "-q", "main");
  write(r.p.dir, { "docs/next.md": "next\n" }); r.p.git("add", "-A"); r.p.git("commit", "-qm", "next"); r.p.git("push", "-q", "origin", "main");
  assert.deepEqual(failing(r.decide()), ["not_behind_base"]);
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  const sync = script("sync-base.mjs", r.p.dir, ["before-merge", "--run", r.s.id], { env: ENV });
  assert.equal(sync.status, 0, sync.stderr + sync.stdout);
  r.pin();
  d = r.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  // the run's own workflow change is protected
  r.s.commit({ ".github/workflows/ci.yml": "on: [push, pull_request]\n" }, "ci"); r.pin();
  d = r.decide();
  assert.deepEqual(failing(d), ["no_protected_paths"]);
  assert.match(d.reasons[0], /\.github\/workflows\/ci\.yml/);
});

test("fix 2: the factory's bookkeeping isn't product, and only a scaffold run may create the recipe", () => {
  const r = ready();
  r.s.commit({ ".factory/history/older/state.json": "{}\n", ".factory/log.md": "- run: older delivered\n" }, "bookkeeping"); r.pin();
  assert.equal(r.decide().decision, "merge", "history and log.md aren't the run's product");
  r.s.commit({ ".factory/touch-rules.json": "{}\n" }, "rules"); r.pin();
  assert.deepEqual(failing(r.decide()), ["no_protected_paths"]);

  // a project with no recipe yet, whose scaffold run creates it
  const q = ready();
  q.p.git("checkout", "-q", "main"); q.p.git("rm", "-q", ".factory/setup.json"); q.p.git("commit", "-qm", "no recipe"); q.p.git("push", "-q", "origin", "main");
  q.s.git("merge", "-q", "--no-edit", "origin/main");
  q.s.commit({ ".factory/setup.json": JSON.stringify(RECIPE) }, "scaffold the recipe"); q.pin();
  let d = q.decide();
  assert.deepEqual(failing(d), ["no_protected_paths"]);
  assert.match(d.reasons[0], /\.factory\/setup\.json/);
  q.rs("set", "scaffold", "true");
  d = q.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
});

test("more files than merge_limits.max_files, a cap override or the dispatch cap reached each make it needs-human", () => {
  const r = ready({ config: { merge_limits: { max_files: 2 } } });
  r.s.commit({ "src/b.js": "b\n", "src/c.js": "c\n" }); r.pin();
  let d = r.decide();
  assert.deepEqual(failing(d), ["files_within_limit"]);
  assert.match(d.reasons[0], /3 files.*limit 2/);

  const o = ready();
  o.rs("override", "minutes", "the grill ran long");
  assert.deepEqual(failing(o.decide()), ["no_cap_overrides"]);

  const c = ready({ config: { caps: { dispatches_per_run: 2 } } });
  c.rs("dispatch", "triage"); c.rs("dispatch", "research"); c.pin();  // a dispatch moves its stage's last file aside
  assert.deepEqual(failing(c.decide()), ["under_dispatch_cap"]);
});

// A oneshot (#59) has no spec: triage's acceptance check is its one criterion, walked by qa as `acceptance`. oneshot(r)
// pins the run's files, then makes it one, with touches.json from classify-diff over the touch rules setup copies.
const RULES = fs.readFileSync(new URL("../plugin/templates/touch-rules.json", import.meta.url), "utf8");
const CHECK = "`/signup`, submit a new email and a password, the page shows \"Welcome\".";
const oneshot = (r, { type = "bug" } = {}) => {
  r.pin();
  r.rs("set", "route", "oneshot");
  fs.rmSync(path.join(r.s.run_dir, "spec.md"));
  write(r.s.run_dir, { "triage.md": "```json\n" + JSON.stringify({ type, size: "s", route: "oneshot", acceptance_check: CHECK }) + "\n```\n" });
  r.put("tickets/01/qa.json", { criteria: [{ id: "acceptance", status: "pass" }] });
  const c = script("classify-diff.mjs", r.p.dir, ["--run", r.s.id], { env: ENV });
  assert.equal(c.status, 0, c.stderr);
};

test("oneshot_scope: a oneshot whose diff changes more than one product file is needs-human; its tests and the pinned directories don't count", () => {
  const r = ready({ recipe: { ...RECIPE, pinned: ["pinned"] }, base: { ".factory/touch-rules.json": RULES } });
  r.s.commit({ "src/signup.test.js": "test\n", "pinned/factory.fixture.ts": "export {};\n" }, "a test and qa's fixture"); oneshot(r);
  let d = r.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  assert.equal(d.facts.find((f) => f.name === "oneshot_scope").detail, "1 product file on a oneshot: src/signup.js");
  r.s.commit({ "src/form.js": "export const form = 1;\n" }, "a second file"); oneshot(r);
  d = r.decide();
  assert.deepEqual(failing(d), ["oneshot_scope"]);
  assert.equal(d.reasons[0], "oneshot_scope: 2 product files on a oneshot: src/form.js, src/signup.js");
  r.pin(); r.rs("set", "route", "build");
  assert.equal(r.decide().decision, "merge", "a build run isn't held to one file");
});

test("a oneshot's one criterion is its acceptance check, so a docs oneshot, which qa doesn't walk, is needs-human through criteria_pass alone", () => {
  const r = ready({ base: { ".factory/touch-rules.json": RULES } });
  oneshot(r);
  let d = r.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  assert.equal(d.facts.find((f) => f.name === "criteria_pass").detail, "1 criteria pass");
  oneshot(r, { type: "docs" });
  fs.rmSync(path.join(r.s.run_dir, "tickets/01/qa.json"));
  d = r.decide();
  assert.deepEqual(failing(d), ["criteria_pass"]);
  assert.equal(d.reasons[0], "criteria_pass: acceptance=not walked");
  assert.ok(d.facts.find((f) => f.name === "criteria_pass").evidence.includes(path.join(r.s.run_dir, "triage.md")));
});

test("on a oneshot, the criteria table and Verify in 2 minutes are rendered from the acceptance check", () => {
  const r = ready({ base: { ".factory/touch-rules.json": RULES } });
  oneshot(r);
  const { pr } = render(r);
  assert.ok(section(pr, "Success criteria").includes(`| acceptance | ${CHECK} | pass |`), section(pr, "Success criteria"));
  assert.match(section(pr, "Verify in 2 minutes"), new RegExp(`^1\\. acceptance: open \`/signup\`; ${CHECK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.doesNotMatch(pr, /SC-00/);
  assert.match(pr, new RegExp(`^Spec: \`\\.factory/history/${r.s.id}/triage\\.md\`$`, "m"), "its triage stands in for the spec");
});

test("a oneshot's PR is titled with its acceptance check and its Goal is triage's rationale, as a build's are the spec's title and Goal", () => {
  const r = ready({ base: { ".factory/touch-rules.json": RULES } });
  oneshot(r);
  write(r.s.run_dir, { "triage.md": "The signup page never says Welcome.\nOne product file, so a oneshot.\n\n```json\n"
    + JSON.stringify({ type: "bug", size: "s", route: "oneshot", acceptance_check: CHECK }) + "\n```\n" });
  const { pr } = render(r);
  assert.equal(pr.split("\n")[0], `# ${CHECK}`, "not the run id");
  assert.ok(pr.startsWith(`# ${CHECK}\n\nThe signup page never says Welcome.\nOne product file, so a oneshot.\n\nRun \``), pr.slice(0, 300));
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  assert.equal(open(r).status, 0);
  assert.equal(flag(posts(r, "POST repos/o/r/pulls$")[0], "-f")[0], `title=${CHECK}`);
});

test("migrations need a maintenance run and `run-state approve migrations`, which records who approved", () => {
  const r = ready();
  r.put("touches.json", { touches: r.touches(["migrations"]) });
  write(r.s.run_dir, { "triage.md": "```json\n" + JSON.stringify({ type: "maintenance", size: "s" }) + "\n```\n" });
  let d = r.decide();
  assert.deepEqual(failing(d), ["no_migrations_unless_approved"]);
  assert.match(d.reasons[0], /not approved/);
  const a = r.rs("approve", "migrations");
  assert.match(a.stdout, /migrations approved by t at [0-9a-f]{7}/);
  const st = JSON.parse(fs.readFileSync(path.join(r.s.run_dir, "state.json"), "utf8"));
  assert.deepEqual([st.approvals.migrations.by, st.approvals.migrations.sha], ["t", r.head()]);
  d = r.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  // an approval covers the head it was given at: a commit since may add a migration nobody approved
  const migrated = r.read("touches.json").touches;
  r.s.commit({ "db/002.sql": "alter table users add column x int;\n" }, "another migration"); r.pin();
  r.put("touches.json", { touches: migrated });
  write(r.s.run_dir, { "triage.md": "```json\n" + JSON.stringify({ type: "maintenance", size: "s" }) + "\n```\n" });
  d = r.decide();
  assert.deepEqual(failing(d), ["no_migrations_unless_approved"]);
  assert.match(d.reasons[0], /approved by t at [0-9a-f]{7}, not HEAD/);
  r.rs("approve", "migrations");
  assert.equal(r.decide().decision, "merge");
  // on a feature run, an approval doesn't let a migration through
  write(r.s.run_dir, { "triage.md": "```json\n" + JSON.stringify({ type: "feature", size: "s" }) + "\n```\n" });
  assert.deepEqual(failing(r.decide()), ["no_migrations_unless_approved"]);
});

const render = (r, args = []) => {
  const res = script("pr-render.mjs", r.p.dir, [...args, "--run", r.s.id], { env: r.gh.env });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const file = (f) => { try { return fs.readFileSync(path.join(r.s.run_dir, f), "utf8"); } catch { return null; } };
  return { stdout: res.stdout, pr: file("pr.md"), comment: file("comment.md"), file };
};
const section = (md, heading) => md.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |^Spec: |(?![\\s\\S]))`, "m"))?.[1] ?? null;

test("fix 10: pr-render writes pr.md from the run's files alone, every section the spec lists, with no agent", () => {
  const r = ready(), fake = fakeClis({ claude: [] });
  r.put("tickets/01/qa.json", {
    criteria: [{ id: "SC-001", status: "pass" }, { id: "SC-002", status: "blocked", reason: "environment" }],
    superseded: [{ test: "e2e/older-01-signup.spec.ts", was: "older SC-002", now: "SC-001", why: "the spec now says Welcome" }],
    repaired: [{ test: "e2e/older-02-login.spec.ts", change: "the button's locator", why: "the label changed" }],
  });
  r.put("findings.json", { disposition: "ask", findings: [
    { id: "code-01", lens: ["code"], severity: "P1", action: "ask", status: "open", location: "src/signup.js:1", claim: "Should signup send a welcome email?" },
    { id: "code-02", lens: ["code"], severity: "P2", action: "fix", status: "pr", location: "src/signup.js:3", claim: "The name could be clearer." },
    { id: "sec-01", lens: ["security"], severity: "P1", action: "fix", status: "resolved", location: "src/signup.js:2", claim: "The password was logged." },
  ] });
  r.json("captures/states.json", { captures: [...Array(8)].map((_, i) => ({ state: `s${i}`, width: 390, scheme: "light", file: `captures/s${i}-390-light.png` })) });
  const out = script("pr-render.mjs", r.p.dir, ["--run", r.s.id], { env: { ...r.gh.env, PATH: fake.bin + path.delimiter + r.gh.env.PATH } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(fake.calls("claude"), [], "no agent writes the PR");
  const md = fs.readFileSync(path.join(r.s.run_dir, "pr.md"), "utf8");
  assert.equal(md.split("\n")[0], "# Signup");
  assert.match(md, /A visitor can make an account from the signup page\./, "the summary is the spec's goal");
  // each criterion's full text, a pipe in it escaped, with its status
  const criteria = section(md, "Success criteria");
  assert.ok(criteria.includes('| SC-001 | `/signup`, submit a new email and a password, the page shows "Welcome" and the account exists. | pass |'), criteria);
  assert.ok(criteria.includes("with the route \\| name. | blocked (environment) |"), criteria);
  assert.match(section(md, "Evidence"), /\| Check \| Result \| Duration \| SHA \|\n\|.*\n\| app\/test \| pass \| 1\.2 s \| `[0-9a-f]{7}` \|/);
  assert.match(section(md, "Needs a decision"), /code-01 \(P1 ask\) `src\/signup\.js:1`: Should signup send a welcome email\?/);
  const findings = section(md, "Findings");
  assert.match(findings, /Open[\s\S]*code-02 \(P2 fix\)[\s\S]*Resolved[\s\S]*sec-01 \(P1 fix\)/);
  assert.match(section(md, "Security"), /- secrets: pass \(gitleaks\)\n- vulnerabilities: pass \(npm audit\)\n- sast: partial \(semgrep project rules\)/);
  const assumptions = section(md, "Assumptions and assessment");
  assert.ok(assumptions.includes('assumptions:\n- The plan left the button\'s label open: I chose "Sign up".\n'), "verbatim");
  assert.ok(assumptions.includes("assessment:\n  recommendation: merge\n  confident: true\n  reason: every criterion passed and the change is small"), "verbatim");
  const captures = section(md, "Captures");
  assert.equal(captures.match(/^- /gm).length, 6, "up to six");
  assert.ok(captures.includes(`.factory/history/${r.s.id}/captures/s0-390-light.png`));
  const tests = section(md, "Pinned tests changed");
  assert.match(tests, /`e2e\/older-01-signup\.spec\.ts`: superseded \(was older SC-002, now SC-001\): the spec now says Welcome/);
  assert.match(tests, /`e2e\/older-02-login\.spec\.ts`: repaired \(the button's locator\): the label changed/);
  assert.equal(section(md, "Anti-goals").trim(), "- A signup that silently drops the visitor's marketing choice.\n- Any page that shows a password in clear text.");
  assert.match(md, new RegExp(`^Spec: \`\\.factory/history/${r.s.id}/spec\\.md\`$`, "m"));
  // the Notion page, when the spec's frontmatter has one
  write(r.s.run_dir, { "spec.md": SPEC.replace("surface: operate\n", "surface: operate\nnotion: https://www.notion.so/Signup-abc123\n") });
  assert.match(render(r).pr, /^Spec: https:\/\/www\.notion\.so\/Signup-abc123$/m);
});

test("fix 26: Verify in 2 minutes gives each criterion a bare-path route, never the path half of a URL, and the local commands", () => {
  const r = ready(), { pr } = render(r);
  const verify = section(pr, "Verify in 2 minutes");
  assert.ok(verify.includes("git fetch origin feature/signup && git checkout feature/signup\nnpm ci\nnpm run dev -- --port <port>"), verify);
  assert.match(verify, /^1\. SC-001: open `\/signup`; /m);
  assert.match(verify, /^2\. SC-002: open `\/`; /m);
  assert.doesNotMatch(verify, /open `\/\/|open `\/collect/);
});

test("Verify in 2 minutes names each ready preview of the head, before the local commands; a stale, unready or missing one is never named", () => {
  const recipe = { ...RECIPE, apps: [...RECIPE.apps, { name: "api", type: "backend", path: "." }, { name: "docs", type: "web", path: "." }] };
  const r = ready({ recipe }), app = (status, more = {}) => ({ mode: "github-deployment", touched: true, status, sha: r.head(), ...more });
  const verify = () => section(render(r).pr, "Verify in 2 minutes");
  assert.match(verify(), /^Locally:\n/, "no preview.json: nothing about a preview");
  r.json("preview.json", { run: r.s.id, sha: r.head(), apps: {
    app: app("ready", { url: "https://signup-git-feature.vercel.app", deployment: 5 }), api: app("ready", { mode: "fixed", url: "https://api.staging.test" }),
    docs: app("timeout", { reason: "no deployment" }),
  } });
  assert.ok(verify().startsWith(`On the preview of \`${r.head().slice(0, 7)}\`:\n- app: https://signup-git-feature.vercel.app\n- api: https://api.staging.test\n\nLocally:\n`), verify());
  assert.match(verify(), /^1\. SC-001: open `\/signup`; /m, "the steps keep their bare routes, for either");
  r.s.commit({ "src/more.js": "x\n" }, "a commit since the preview was read");
  assert.match(verify(), /^Locally:\n/, "a preview of another head isn't this PR's");
  assert.doesNotMatch(verify(), /vercel\.app|staging\.test/);
});

test("the decision comment: Would merge (trial), Merged at <sha>, or the attention item, which merge-decision's failing facts fill", () => {
  const r = ready();
  assert.equal(render(r).comment, null, "no decision yet, and the run goes on: nothing to say");
  r.decide();
  let out = render(r);
  assert.match(out.comment, /^\*\*Would merge \(trial\)\.\*\* Every fact holds at `[0-9a-f]{7}`/);
  assert.match(section(out.pr, "Needs a decision"), /nothing/);
  out = render(r, ["--merged", "f".repeat(40)]);
  assert.match(out.comment, new RegExp(`^\\*\\*Merged at \`${"f".repeat(40)}\`\\.\\*\\*`));

  r.put("ci.json", { cause: "ours" }); r.put("touches.json", { new_env: ["STRIPE_KEY"] });
  r.decide();
  out = render(r);
  const item = out.file("attention-merge.md");
  assert.equal(out.comment, item, "the comment is the attention item");
  assert.match(item, /^# .*needs-human.*\n\nRun `.+`, stage `merge-decision`\.\n\n## What happened\n/);
  assert.match(item, /- `ci_green_at_head`: CI ours/);
  assert.match(item, /- `no_new_env`: the diff reads STRIPE_KEY/);
  assert.match(item, /## Evidence\n(- `.+`\n)+/);
  assert.match(item, new RegExp(`- \`\\.factory/history/${r.s.id}/ci\\.json\``));
  assert.match(item, /## Recommendation\n.+\n\n## Options\n/);
  assert.match(item, /repos\/o\/r\/pulls\/7\/merge/, "merge it yourself");
  assert.match(item, new RegExp(`/factory resume ${r.s.id}`), "push a fix and resume");
  assert.match(item, /pulls\/7 -f state=closed/, "or close");
  assert.match(section(out.pr, "Needs a decision"), /ci_green_at_head: CI ours/);
});

test("a stopped run's comment is its newest attention item", () => {
  const r = ready();
  write(r.s.run_dir, { "attention-review.md": "# The review asks the human\n\nRun `x`, stage `review`.\n" });
  r.rs("set", "stage", "needs-human");
  assert.equal(render(r).comment, "# The review asks the human\n\nRun `x`, stage `review`.\n");
});

const open = (r) => script("pr-open.mjs", r.p.dir, ["--run", r.s.id], { env: r.gh.env });
const flag = (argv, name) => argv.filter((a, i) => argv[i - 1] === name);
const posts = (r, what) => r.gh.calls("gh").filter((a) => a[1] === "-X" && new RegExp(what).test(a.slice(2, 4).join(" ")));

test("pr-open opens the PR ready at the PR stage, over REST only: the branch pushed, pr.json written, labelled factory", () => {
  const r = ready();
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  render(r);
  const res = open(r);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(sh(r.bare, "git", ["rev-parse", "refs/heads/feature/signup"]), r.head(), "the run branch is on origin");
  const [create] = posts(r, "POST repos/o/r/pulls$");
  assert.deepEqual(flag(create, "-F"), ["draft=false"], "ready, so REST can merge it");
  const fields = flag(create, "-f");
  assert.deepEqual(fields.slice(0, 3), ["title=Signup", "head=feature/signup", "base=main"]);
  assert.equal(fields[3], `body=${fs.readFileSync(path.join(r.s.run_dir, "pr.md"), "utf8").split("\n").slice(1).join("\n").trim()}`);
  assert.deepEqual(flag(posts(r, "POST repos/o/r/issues/7/labels")[0], "-f"), ["labels[]=factory"], "no decision yet");
  assert.deepEqual(posts(r, "comments"), [], "nothing to say yet");
  assert.ok(r.gh.calls("gh").every((a) => a[0] === "api"), "never gh pr, which is GraphQL");
  const pr = r.read("pr.json");
  assert.deepEqual([pr.repo, pr.number, pr.url, pr.head, pr.base, pr.draft, pr.labels], ["o/r", 7, "https://github.com/o/r/pull/7", "feature/signup", "main", false, ["factory"]]);
});

test("pr-open opens a stopped run's PR as a draft carrying its attention item, labelled needs-human", () => {
  const r = ready();
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  write(r.s.run_dir, { "attention-review.md": "# The review asks the human\n" });
  r.rs("set", "stage", "needs-human");
  render(r);
  const res = open(r);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.deepEqual(flag(posts(r, "POST repos/o/r/pulls$")[0], "-F"), ["draft=true"]);
  assert.deepEqual(flag(posts(r, "labels")[0], "-f"), ["labels[]=factory", "labels[]=needs-human"]);
  const [comment] = posts(r, "POST repos/o/r/issues/7/comments");
  assert.deepEqual(flag(comment, "-f"), ["body=# The review asks the human\n\n<!-- factory -->"], "the first comment, marked");
  assert.equal(r.read("pr.json").draft, true);
});

test("the PR stage: open, decide, then one decision label and one marked comment; the run ends delivered and snapshots", () => {
  const r = ready();
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  render(r); assert.equal(open(r).status, 0);
  assert.equal(r.decide().decision, "merge");
  render(r);
  let res = open(r);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const [update] = posts(r, "PATCH repos/o/r/pulls/7");
  assert.match(flag(update, "-f")[1], /^body=A visitor can make/, "the body is rendered again with the decision");
  assert.deepEqual(flag(posts(r, "labels").at(-1), "-f"), ["labels[]=factory-merge"]);
  const [comment] = posts(r, "comments");
  assert.match(flag(comment, "-f")[0], /^body=\*\*Would merge \(trial\)\.\*\*[\s\S]*\n\n<!-- factory -->$/);
  // running it again posts nothing twice
  res = open(r);
  assert.equal(posts(r, "comments").length, 1);
  assert.equal(posts(r, "labels").length, 2);

  r.rs("set", "stage", "delivered");
  const snap = r.rs("snapshot");
  assert.match(snap.stdout, /worktree removed/);
  const record = (f) => r.p.git("show", `main:.factory/history/${r.s.id}/${f}`);
  assert.equal(JSON.parse(record("state.json")).stage, "delivered");
  assert.equal(JSON.parse(record("decision.json")).decision, "merge");
  assert.equal(JSON.parse(record("pr.json")).number, 7);
});

test("a needs-human decision labels the PR needs-human, taking factory-merge off, posts the attention item and keeps the run", () => {
  const r = ready();
  r.put("pr.json", { labels: ["factory", "factory-merge"] });
  r.put("ci.json", { cause: "inherited" });
  assert.equal(r.decide().decision, "needs-human");
  render(r);
  const res = open(r);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.deepEqual(flag(posts(r, "POST repos/o/r/issues/7/labels")[0], "-f"), ["labels[]=needs-human"]);
  assert.equal(posts(r, "DELETE repos/o/r/issues/7/labels/factory-merge").length, 1);
  assert.match(flag(posts(r, "comments")[0], "-f")[0], /^body=# Merge decision: needs-human/);
  assert.deepEqual(r.read("pr.json").labels, ["factory", "needs-human"]);
  r.rs("set", "stage", "needs-human");
  assert.match(r.rs("snapshot").stdout, /worktree kept \(needs-human\)/);
});

test("a hotfix lane under git flow also opens the back-merge PR into develop, once, always a human's", () => {
  const r = ready();
  write(r.p.dir, { ".factory/config.json": JSON.stringify({ merge: "trial", branching: { model: "git-flow", main: "main", develop: "develop" } }) });
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  render(r);
  assert.equal(open(r).status, 0);
  const [back] = posts(r, "POST repos/o/r/pulls$").filter((a) => a.includes("base=develop"));
  assert.ok(back, "the back-merge PR");
  assert.deepEqual(flag(back, "-f").slice(1, 3), ["head=feature/signup", "base=develop"]);
  assert.deepEqual(flag(back, "-F"), ["draft=false"]);
  assert.match(flag(back, "-f")[3], /#7/, "it names the PR to main");
  assert.deepEqual(flag(posts(r, "POST repos/o/r/issues/8/labels")[0], "-f"), ["labels[]=factory", "labels[]=needs-human"]);
  assert.deepEqual(r.read("pr.json").back_merge, { number: 8, url: "https://github.com/o/r/pull/8" });
  open(r);
  assert.equal(posts(r, "POST repos/o/r/pulls$").length, 2, "opened once");
});

test("the PR and a hotfix's back-merge PR end with the PR lines the session recorded", () => {
  const r = ready();
  write(r.p.dir, { ".factory/config.json": JSON.stringify({ merge: "trial", branching: { model: "git-flow", main: "main", develop: "develop" } }) });
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  r.rs("set", "attribution", JSON.stringify({ commit: "Co-Authored-By: A <a@a>", pr: "Made with [A](https://a.example)" }));
  render(r);
  const res = open(r);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const made = posts(r, "POST repos/o/r/pulls$");
  assert.equal(made.length, 2);
  for (const c of made) assert.match(flag(c, "-f").find((f) => f.startsWith("body=")), /\S\n\nMade with \[A\]\(https:\/\/a\.example\)$/);
});

test("pr-open stops, quoting GitHub, when it refuses the PR, and needs a GitHub origin", () => {
  const r = ready();
  fs.rmSync(path.join(r.s.run_dir, "pr.json"));
  render(r);
  const refused = path.join(r.s.run_dir, "..", "refused.json");
  fs.writeFileSync(refused, JSON.stringify({ message: "Validation Failed", errors: [{ message: "A pull request already exists for o:feature/signup." }] }));
  const gh = fakeClis({ gh: [{ match: /POST repos\/o\/r\/pulls/, file: refused, status: 1 }] });
  const res = script("pr-open.mjs", r.p.dir, ["--run", r.s.id], { env: gh.env });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Validation Failed.*A pull request already exists/);
  assert.equal(fs.existsSync(path.join(r.s.run_dir, "pr.json")), false);

  r.p.git("config", "remote.origin.url", "https://gitlab.com/o/r.git");
  const other = open(r);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /GitHub/);
});

// #60, auto: a fake gh answering ready()'s PR read, the open PRs (the one query for a factory revert PR), update-branch and
// the merge, its answers shaped as docs/platform-facts.md (facts 18 and 19) reads GitHub's: open is the open PRs, or the
// message GitHub refuses that query with, and merge and update are [body, gh's exit]. decide() returns decision.json, if
// any, and what merge-decision printed.
const MERGED = "c0ffee".padEnd(40, "0");
function auto(r, { open = [], merge = [{ sha: MERGED, merged: true, message: "Pull Request successfully merged" }, 0], update = [{ message: "Updating pull request branch." }, 0] } = {}) {
  write(r.p.dir, { ".factory/config.json": JSON.stringify({ merge: "auto", merge_method: "squash" }) });
  const fixture = (name, value) => { const f = path.join(r.s.run_dir, "..", `${name}.json`); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  const gh = fakeClis({ gh: [
    { match: /^api repos\/o\/r\/pulls\/7$/, file: path.join(r.s.run_dir, "..", "pr7.json") },
    { match: /^api repos\/o\/r\/pulls\?state=open&per_page=100$/, file: fixture("open", typeof open === "string" ? { message: open } : open), status: typeof open === "string" ? 1 : 0 },
    { match: /^api -X PUT repos\/o\/r\/pulls\/7\/merge /, file: fixture("merge", merge[0]), status: merge[1] },
    { match: /^api -X PUT repos\/o\/r\/pulls\/7\/update-branch /, file: fixture("update", update[0]), status: update[1] },
    { match: /^api -X (POST|PATCH|DELETE) repos\/o\/r\/(issues|pulls)\//, file: path.join(r.s.run_dir, "..", "ok.json") },
  ] });
  const decide = () => {
    const res = script("merge-decision.mjs", r.p.dir, ["--run", r.s.id], { env: gh.env });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    return { ...(fs.existsSync(path.join(r.s.run_dir, "decision.json")) && r.read("decision.json")), stdout: res.stdout };
  };
  const merges = () => gh.calls("gh").filter((c) => c.includes("repos/o/r/pulls/7/merge"));
  return { gh, decide, merges };
}

test("auto: a merge decision merges over REST at the evaluated head by the configured method, never --admin, and says Merged at", () => {
  const r = ready(), a = auto(r), d = a.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  assert.equal(d.mode, "auto");
  assert.deepEqual(a.merges(), [["api", "-X", "PUT", "repos/o/r/pulls/7/merge", "-f", `sha=${r.head()}`, "-f", "merge_method=squash"]]);
  assert.ok(a.gh.calls("gh").every((c) => c[0] === "api" && !c.includes("--admin")), "REST only, and never past branch protection");
  assert.equal(d.merged, MERGED);
  assert.match(d.stdout, new RegExp(`^MERGED ${MERGED}`, "m"));
  assert.match(render({ ...r, gh: a.gh }).comment, new RegExp(`^\\*\\*Merged at \`${MERGED}\`\\.\\*\\*`), "from decision.json");
  // the record: label and comment, and no push, which would bring back a branch GitHub deleted on merge
  sh(r.bare, "git", ["update-ref", "-d", "refs/heads/feature/signup"]);
  const res = open({ ...r, gh: a.gh });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.throws(() => sh(r.bare, "git", ["rev-parse", "--verify", "refs/heads/feature/signup"]), "the merged branch isn't pushed again");
  assert.deepEqual(flag(posts({ gh: a.gh }, "POST repos/o/r/issues/7/labels")[0], "-f"), ["labels[]=factory-merge"]);
  assert.match(flag(posts({ gh: a.gh }, "comments")[0], "-f")[0], /^body=\*\*Merged at /);
  // a resume that decides again keeps the merge, and never merges twice
  const again = a.decide();
  assert.deepEqual([again.decision, again.merged, again.decided_at], ["merge", MERGED, d.decided_at]);
  assert.match(again.stdout, new RegExp(`^MERGED ${MERGED}`, "m"));
  assert.equal(a.merges().length, 1);
});

test("auto: any merge GitHub refuses (a draft, a missing review, a moved head) makes the decision needs-human, quoting GitHub's message", () => {
  const r = ready();
  // stand-ins, since GitHub's docs give the status (405, or 409 for a moved head) but not the words (platform facts 18, 19)
  for (const [status, why] of [["405", "Stand-in for the 405 on a draft PR"], ["405", "Stand-in for the 405 on a missing required review"], ["409", "Stand-in for the 409 on a moved head"]]) {
    const a = auto(r, { merge: [{ message: why, documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request", status }, 1] });
    const d = a.decide();
    assert.equal(d.decision, "needs-human", why);
    assert.deepEqual(failing(d), ["merged"]);
    assert.equal(d.reasons[0], `merged: GitHub refused to merge PR #7 at ${r.head().slice(0, 7)}: "${why}"`);
    assert.equal(d.merged, undefined);
    assert.doesNotMatch(d.stdout, /^MERGED/m);
    assert.equal(a.merges().length, 1, "tried once");
    const item = render({ ...r, gh: a.gh }).file("attention-merge.md");
    assert.ok(item.includes(why), "the attention item quotes GitHub");
    assert.match(item, /repos\/o\/r\/pulls\/7\/merge -f sha=/, "merge it yourself, once it's settled");
  }
});

test("auto acts as trial while a factory revert PR is open in the repo, read in one REST query, and merges again once none is", () => {
  const r = ready();
  const pull = (number, ref, labels) => ({ number, html_url: `https://github.com/o/r/pull/${number}`, head: { ref }, labels: labels.map((name) => ({ name })) });
  const others = [pull(9, "revert/not-ours", ["needs-human"]), pull(10, "feature/other", ["factory", "needs-human"])];
  let a = auto(r, { open: [...others, pull(12, "revert/r0-abc1234", ["factory", "needs-human"])] }), d = a.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  assert.equal(d.mode, "trial");
  assert.equal(d.paused, "revert PR #12 is open");
  assert.match(d.stdout, /^DECISION merge \(trial\)/m);
  assert.match(d.stdout, /auto acts as trial: revert PR #12 is open/);
  assert.deepEqual(a.merges(), [], "nothing merges onto a target a revert is mending");
  assert.deepEqual(a.gh.calls("gh").filter((c) => c[1].startsWith("repos/o/r/pulls?")), [["api", "repos/o/r/pulls?state=open&per_page=100"]], "one query");
  assert.match(render({ ...r, gh: a.gh }).comment, /^\*\*Would merge \(trial\)\.\*\*.*Auto acts as trial: revert PR #12 is open\./s);

  // GitHub refusing the query can't vouch that none is open
  a = auto(r, { open: "Bad credentials" }); d = a.decide();
  assert.equal(d.mode, "trial");
  assert.deepEqual(a.merges(), []);
  assert.equal(d.paused, "the open PRs couldn't be read: Bad credentials");

  // a revert PR that isn't the factory's, or a factory PR that isn't a revert, doesn't pause it
  a = auto(r, { open: others }); d = a.decide();
  assert.equal(d.mode, "auto");
  assert.equal(d.paused, undefined);
  assert.equal(a.merges().length, 1);
});

// The base moves on origin by a commit adding `file`.
const baseMoves = (r, file) => { r.p.git("checkout", "-q", "main"); write(r.p.dir, { [file]: `${file}\n` }); r.p.git("add", "-A"); r.p.git("commit", "-qm", file); r.p.git("push", "-q", "origin", "main"); };
// The catch-up as references/pr.md runs it: GitHub's side of a 202 (the base merged into the PR's branch on the server),
// sync-base before-merge taking it, then verify --full at the new head, the run's other files pinned there, and steps 1
// and 2 again, which say nothing on the PR: there's no decision until the one after the catch-up.
function catchUp(r, a) {
  const server = `${r.bare}-clone`;
  fs.rmSync(server, { recursive: true, force: true });
  sh(path.dirname(r.bare), "git", ["clone", "-q", "-b", "feature/signup", r.bare, server]);
  sh(server, "git", ["-c", "user.name=gh", "-c", "user.email=gh@gh", "merge", "-q", "--no-edit", "origin/main"]);
  sh(server, "git", ["push", "-q", "origin", "feature/signup"]);
  const sync = script("sync-base.mjs", r.p.dir, ["before-merge", "--run", r.s.id], { env: a.gh.env });
  assert.equal(sync.status, 0, sync.stderr + sync.stdout);
  assert.equal(r.head(), sh(server, "git", ["rev-parse", "HEAD"]), "the run branch is GitHub's merge");
  const verify = script("verify.mjs", r.p.dir, ["--full", "--run", r.s.id], { env: ENV });
  assert.equal(verify.status, 0, verify.stderr + verify.stdout);
  const ev = r.read("evidence.json");
  assert.deepEqual([ev.sha, ev.green], [r.head(), true], "re-verified at the new head");
  r.pin(); r.json("evidence.json", ev);
  assert.equal(render({ ...r, gh: a.gh }).comment, null);
  assert.equal(open({ ...r, gh: a.gh }).status, 0);
  assert.deepEqual([posts({ gh: a.gh }, "labels"), posts({ gh: a.gh }, "comments")], [[], []], "no label or comment mid catch-up");
}

test("auto: a run behind its base and nothing else gets one catch-up, update-branch then verify --full, and merges at the one decision after it; trial reports it", () => {
  const r = ready();
  r.s.git("push", "-q", "origin", "HEAD:refs/heads/feature/signup");
  baseMoves(r, "docs/next.md");
  let d = r.decide();
  assert.deepEqual(failing(d), ["not_behind_base"], "trial: reported, as every failing fact is");
  assert.doesNotMatch(d.stdout, /CATCH-UP/);
  assert.equal(d.catch_up, undefined);
  assert.deepEqual(r.gh.calls("gh"), [["api", "repos/o/r/pulls/7"]], "no update-branch in trial");

  const a = auto(r), was = r.head();
  d = a.decide();
  assert.equal(d.stdout, "CATCH-UP 1 commit on refs/remotes/origin/main not in HEAD: sync-base.mjs before-merge, verify --full, then decide again\n");
  assert.equal(d.decision, undefined, "no decision yet, so the PR stage says nothing on the PR");
  assert.deepEqual(r.read("catch-up.json"), { head: was, base: r.p.git("rev-parse", "main") });
  assert.deepEqual(a.merges(), []);
  catchUp(r, a);
  assert.equal(a.gh.calls("gh").filter((c) => c.includes("repos/o/r/pulls/7/update-branch")).length, 1, "one update-branch");
  d = a.decide();
  assert.equal(d.decision, "merge", d.reasons.join("; "));
  assert.doesNotMatch(d.stdout, /CATCH-UP/);
  assert.deepEqual(a.merges().map((c) => c[5]), [`sha=${r.head()}`], "merged at the caught-up head");
});

test("auto: the catch-up is asked once, so a base that moves again before the decision after it is reported, and nothing else failing asks none", () => {
  const r = ready();
  r.s.git("push", "-q", "origin", "HEAD:refs/heads/feature/signup");
  baseMoves(r, "docs/next.md");
  const a = auto(r);
  assert.match(a.decide().stdout, /^CATCH-UP/m);
  catchUp(r, a);
  baseMoves(r, "docs/again.md");
  let d = a.decide();
  assert.deepEqual(failing(d), ["not_behind_base"]);
  assert.doesNotMatch(d.stdout, /CATCH-UP/, "never twice");
  assert.equal(a.gh.calls("gh").filter((c) => c.includes("repos/o/r/pulls/7/update-branch")).length, 1);
  assert.deepEqual(a.merges(), []);

  // behind and another fact failing: a catch-up can't make it merge, so it's reported
  const o = ready();
  o.s.git("push", "-q", "origin", "HEAD:refs/heads/feature/signup");
  baseMoves(o, "docs/next.md");
  o.put("ci.json", { cause: "ours" });
  d = auto(o).decide();
  assert.deepEqual(failing(d), ["ci_green_at_head", "not_behind_base"]);
  assert.doesNotMatch(d.stdout, /CATCH-UP/);
});

test("auto: a catch-up GitHub refuses stops the run, and the PR's comment is sync-base's attention item", () => {
  const r = ready();
  baseMoves(r, "docs/next.md");
  const a = auto(r, { update: [{ message: "merge conflict between base and head" }, 1] });
  assert.match(a.decide().stdout, /^CATCH-UP/m);
  const sync = script("sync-base.mjs", r.p.dir, ["before-merge", "--run", r.s.id], { env: a.gh.env });
  assert.equal(sync.status, 1, sync.stderr + sync.stdout);
  const out = render({ ...r, gh: a.gh });
  assert.equal(out.comment, out.file("attention-sync.md"));
  assert.match(out.comment, /merge conflict between base and head/);
});

// A project with ended runs' records committed under .factory/history/, as snapshots leave them, and a fake gh answering each one's
// PR and the workflow runs at its merge commit. run(n, decision, pr, ci) adds run h<n>, decided in that order: pr is how
// GitHub has PR #n now ({ state, merged, head } with head "same" for the head decided), ci the merge commit's workflow
// runs as [status, conclusion].
function record() {
  const p = project({ config: { merge: "trial", merge_method: "merge" } }), rules = [];
  const sha = (n, tag = "a") => `${tag}${String(n).padStart(2, "0")}`.padEnd(40, "0");
  const fixture = (name, value) => { const f = path.join(p.dir, ".factory/runs", `${name}.json`); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  let n = 0;
  const run = (decision, { state = "closed", merged = true, head = "same" } = {}, ci = [["completed", "success"]]) => {
    n++;
    write(p.dir, {
      [`.factory/history/h${n}/decision.json`]: JSON.stringify({ run: `h${n}`, head: sha(n), mode: "trial", decision: "merge", ...decision, decided_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString() }),
      [`.factory/history/h${n}/pr.json`]: JSON.stringify({ repo: "o/r", number: n }),
    });
    p.git("add", "-A"); p.git("commit", "-qm", `factory(run): h${n} snapshot`);
    rules.push({ match: new RegExp(`^api repos/o/r/pulls/${n}$`), file: fixture(`pr${n}`, { number: n, state, merged, head: { sha: head === "same" ? sha(n) : head }, merge_commit_sha: merged ? sha(n, "b") : null }) });
    rules.push({ match: new RegExp(`^api repos/o/r/actions/runs\\?head_sha=${sha(n, "b")}&per_page=100$`), file: fixture(`ci${n}`, { workflow_runs: ci.map(([status, conclusion], i) => ({ id: i, name: `CI ${i}`, status, conclusion })) }) });
  };
  const tally = () => {
    const gh = fakeClis({ gh: rules }), before = p.git("status", "--porcelain"), config = fs.readFileSync(path.join(p.dir, ".factory/config.json"), "utf8");
    const res = script("merge-decision.mjs", p.dir, ["--record"], { env: gh.env });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(p.git("status", "--porcelain"), before, "--record writes nothing");
    assert.equal(fs.readFileSync(path.join(p.dir, ".factory/config.json"), "utf8"), config, "nothing switches the mode");
    return { lines: res.stdout.trim().split("\n"), calls: gh.calls("gh") };
  };
  return { p, run, tally, sha };
}

test("--record: a trial merge decision agrees when its PR merged at the head decided and CI is green at the merge commit, else disagrees; open PRs and needs-human decisions don't count", () => {
  const r = record();
  r.run();                                                          // h1 agrees
  r.run({}, { head: "f".repeat(40) });                              // h2: the human added commits
  r.run({}, { merged: false });                                     // h3: closed unmerged
  r.run({}, {}, [["completed", "success"], ["completed", "failure"]]); // h4: CI red at the merge commit
  r.run({}, { state: "open", merged: false });                      // h5: open, not yet
  r.run({ decision: "needs-human" });                               // h6: never counted
  r.run({ mode: "auto" });                                          // h7: the factory's own merge, not a trial one
  r.run({}, {}, [["in_progress", null]]);                           // h8: CI at the merge commit still running
  const { lines, calls } = r.tally();
  assert.deepEqual(lines, [
    `h1 PR #1: agrees: merged at ${r.sha(1).slice(0, 7)}, and CI is green at ${r.sha(1, "b").slice(0, 7)}`,
    `h2 PR #2: disagrees: merged at fffffff, not ${r.sha(2).slice(0, 7)} as decided: the human added commits`,
    "h3 PR #3: disagrees: closed unmerged",
    `h4 PR #4: disagrees: CI is red at ${r.sha(4, "b").slice(0, 7)}: CI 1`,
    "h5 PR #5: not counted: open",
    `h8 PR #8: not counted: CI at ${r.sha(8, "b").slice(0, 7)} hasn't finished`,
    "RECORD 1 of the last 4 counted agree (1 agree, 3 disagree, 2 not counted)",
  ]);
  assert.ok(!calls.some((c) => /pulls\/[67]$/.test(c.at(-1))), "needs-human and auto decisions aren't read");
  assert.ok(calls.every((c) => c[0] === "api" && c.length === 2), "GET over REST only");
});

test("--record: ten agreeing trial merges after a disagreeing one are the last 10 agreeing, which only the human turns into merge: auto", () => {
  const r = record();
  r.run({}, { merged: false });
  // git flow: these ten snapshots are on develop, which the main checkout doesn't have out
  r.p.git("checkout", "-qb", "develop");
  for (let i = 0; i < 10; i++) r.run();
  r.p.git("checkout", "-q", "main");
  const { lines } = r.tally();
  assert.equal(lines.at(-1), "RECORD 10 of the last 10 counted agree (10 agree, 1 disagree, 0 not counted)");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.p.dir, ".factory/config.json"), "utf8")).merge, "trial");
});
