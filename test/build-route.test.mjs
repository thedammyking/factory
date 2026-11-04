// build-route.test.mjs — run-state.mjs on the build route up to the spec gate: the lane, the grill answers and approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh } from "./harness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts/run-state.mjs");
const git = (cwd, ...args) => sh(cwd, "git", args);
const rs = (cwd, args, input = "", env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, ...env } });
const init = (p, request = "Add a CSV export to the reports page", env) => {
  const r = rs(p.dir, ["init"], request + "\n", env);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const state = (p, s) => JSON.parse(rs(p.dir, ["get", "--run", s.id]).stdout);
// triage.md as the triager writes it: a rationale, then the json block.
const triaged = (p, s, fields, route = "build") => {
  fs.writeFileSync(path.join(s.run_dir, "triage.md"), "It adds an export.\n\n```json\n"
    + JSON.stringify({ type: "feature", in_production: false, branch: "feature/csv-export", route, ...fields }) + "\n```\n");
  assert.equal(rs(p.dir, ["set", "route", route, "--run", s.id]).status, 0);
};
const lane = (p, s) => rs(p.dir, ["lane", "--run", s.id]);
const GIT_FLOW = { branching: { model: "git-flow", main: "main", develop: "develop", prefixes: { feature: "feature/", bugfix: "bugfix/", hotfix: "hotfix/" } } };

test("under git flow a feature and a bug branch from develop and a bug in production from main, at the base's tip, which is recorded", () => {
  const p = project({ config: GIT_FLOW });
  p.git("switch", "-q", "-c", "develop");
  p.git("commit", "-q", "--allow-empty", "-m", "develop moves ahead");
  p.git("switch", "-q", "main");
  for (const [fields, branch, base] of [
    [{ type: "feature", branch: "feature/csv-export" }, "feature/csv-export", "develop"],
    [{ type: "bug", branch: "bugfix/login-crash" }, "bugfix/login-crash", "develop"],
    [{ type: "bug", in_production: true, branch: "bugfix/checkout-total" }, "hotfix/checkout-total", "main"],
  ]) {
    const s = init(p);
    triaged(p, s, fields);
    p.git("commit", "-q", "--allow-empty", "-m", `${base} moves after the run started`);  // on main, the checkout's branch
    if (base === "develop") p.git("update-ref", "refs/heads/develop", p.git("commit-tree", "develop^{tree}", "-p", "develop", "-m", "develop moves"));
    fs.writeFileSync(path.join(s.run_dir, "research.md"), "live state\n");
    const r = lane(p, s);
    assert.equal(r.status, 0, r.stderr);
    const st = state(p, s);
    assert.equal(git(s.worktree, "branch", "--show-current"), branch, fields.type);
    assert.deepEqual([st.branch, st.base_branch, st.target_branch], [branch, base, base]);
    assert.equal(st.base_sha, p.git("rev-parse", base), "the base's tip when the lane is made");
    assert.equal(git(s.worktree, "rev-parse", "HEAD"), st.base_sha);
    assert.equal(fs.readFileSync(path.join(s.run_dir, "research.md"), "utf8"), "live state\n", "fix 1: the switch keeps the run's live files");
    assert.equal(git(s.worktree, "status", "--porcelain"), "");
  }
});

test("on trunk everything branches from main with the feature prefix", () => {
  const p = project();
  const s = init(p, "Fix the login crash");
  triaged(p, s, { type: "bug", in_production: true, branch: "hotfix/login-crash" });
  assert.equal(lane(p, s).status, 0);
  const st = state(p, s);
  assert.deepEqual([st.branch, st.base_branch, st.target_branch, st.base_sha], ["feature/login-crash", "main", "main", p.git("rev-parse", "main")]);
});

test("the branch carries the request issue's key, and the run id only when its name is taken", () => {
  const p = project();
  p.git("update-ref", "refs/remotes/origin/feature/csv-export", "HEAD");  // someone else's branch, fetched
  p.git("branch", "feature/csv-export-2");
  const keyed = init(p);
  rs(p.dir, ["set", "request_issue", '{"key":"ENG-123"}', "--run", keyed.id]);
  triaged(p, keyed, {});
  assert.equal(lane(p, keyed).status, 0);
  const plain = init(p);
  triaged(p, plain, {});
  assert.equal(lane(p, plain).status, 0);
  const named = init(p);
  rs(p.dir, ["set", "request_issue", '{"key":"#12"}', "--run", named.id]);
  triaged(p, named, { branch: "feature/12-csv-export" });
  assert.equal(lane(p, named).status, 0);
  assert.equal(state(p, keyed).branch, "feature/eng-123-csv-export");
  assert.equal(state(p, plain).branch, `feature/csv-export-${plain.id}`);
  assert.equal(state(p, named).branch, "feature/12-csv-export", "a key triage already wrote isn't doubled");
  for (const s of [keyed, named]) assert.ok(!state(p, s).branch.includes(s.id));
  const again = init(p);
  triaged(p, again, {});
  p.git("branch", `feature/csv-export-${again.id}`);
  const r = lane(p, again);
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`can't make feature/csv-export-${again.id}: the name is taken`));
});

test("only a build or oneshot run takes a lane, once; hold and answer make no branch", () => {
  const p = project();
  for (const route of ["hold", "answer"]) {
    const s = init(p, `A ${route} request`);
    triaged(p, s, {}, route);
    const r = lane(p, s);
    assert.equal(r.status, 2, route);
    assert.match(r.stderr, /build or oneshot/);
    assert.equal(git(s.worktree, "branch", "--show-current"), "", "still detached");
  }
  assert.equal(p.git("for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/main");
  const s = init(p);
  triaged(p, s, { acceptance_check: "`/reports`, Export, a CSV downloads." }, "oneshot");
  assert.equal(lane(p, s).status, 0);
  const again = lane(p, s);
  assert.equal(again.status, 0, "a second call, after a resume, is a no-op");
  assert.match(again.stdout, /feature\/csv-export/);
  assert.equal(p.git("for-each-ref", "--format=%(refname)", "refs/heads/feature"), "refs/heads/feature/csv-export");
  const broken = init(p, "No block");
  fs.writeFileSync(path.join(broken.run_dir, "triage.md"), "No json block here.\n");
  rs(p.dir, ["set", "route", "build", "--run", broken.id]);
  assert.equal(lane(p, broken).status, 2);
});

test("an unattended run takes its grill answers from FACTORY_GRILL_ANSWERS, copied into the run dir; a missing file starts no run", () => {
  const p = project();
  fs.writeFileSync(path.join(p.dir, "answers.md"), "- Q: Which columns? → A: date, amount, status\n");
  const s = init(p, "Add a CSV export", { FACTORY_GRILL_ANSWERS: "answers.md" });
  assert.equal(fs.readFileSync(path.join(s.run_dir, "grill-answers.md"), "utf8"), "- Q: Which columns? → A: date, amount, status\n");
  assert.ok(!fs.existsSync(path.join(init(p, "Add a PDF export").run_dir, "grill-answers.md")), "an attended run has none");
  const r = rs(p.dir, ["init"], "Add an XLS export\n", { FACTORY_GRILL_ANSWERS: "nope.md" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope\.md/);
  assert.equal(p.git("worktree", "list").split("\n").length, 3, "no worktree for the run that didn't start");
});

// A build run with its spec written and builder-checked: the spec gate.
const atGate = (p) => {
  const s = init(p);
  triaged(p, s, {});
  const run = (...args) => rs(p.dir, [...args, "--run", s.id]);
  assert.equal(lane(p, s).status, 0);
  for (const [stage, file] of [["research", "research.md"], ["spec", "spec.md"], ["builder-check", "builder-check.md"]]) {
    assert.equal(run("dispatch", stage).status, 0, stage);
    fs.writeFileSync(path.join(s.run_dir, file), `# ${stage}\n\n- **SC-001** (profile: default, live-safe: yes): /reports, Export, a CSV downloads.\n`);
    run("done", stage);
  }
  return [s, run];
};

test("nothing past the spec gate dispatches until the human approves the spec", () => {
  const p = project();
  const s = init(p);
  triaged(p, s, {});
  const run = (...args) => rs(p.dir, [...args, "--run", s.id]);
  lane(p, s);
  run("dispatch", "research");
  fs.writeFileSync(path.join(s.run_dir, "research.md"), "Status: ok\n");
  run("done", "research");
  assert.equal(run("approve", "spec", "approved").status, 2, "no spec yet");
  run("dispatch", "spec");
  fs.writeFileSync(path.join(s.run_dir, "spec.md"), "# CSV export\n");
  run("done", "spec");
  assert.equal(run("approve", "spec", "approved").status, 2, "the builder check hasn't run");
  run("dispatch", "builder-check");
  assert.equal(run("approve", "spec", "approved").status, 2, "the builder check is still running");
  run("done", "builder-check");
  const refused = run("dispatch", "tickets");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`/factory approve ${s.id} approved`));
  assert.match(run("approve", "spec", "maybe").stderr, /approved \| revise/);
  const ok = run("approve", "spec", "approved");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(run("dispatch", "tickets").status, 0);
  assert.equal(run("approve", "spec", "revise").status, 2, "past the gate the spec is frozen");
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), new RegExp(`run: ${s.id} spec approved`));
});

test("a revise, or a spec that changed after its approval, needs approving again; a oneshot has no spec gate", () => {
  const p = project();
  const [s, run] = atGate(p);
  assert.equal(run("approve", "spec", "approved").status, 0);
  fs.appendFileSync(path.join(s.run_dir, "spec.md"), "- **SC-002**: an edit after the approval\n");
  assert.equal(run("dispatch", "tickets").status, 2, "the approval covers the spec as it was");
  assert.equal(run("approve", "spec", "revise").status, 0);
  assert.equal(run("dispatch", "spec").status, 0, "the planner revises the spec");
  assert.equal(run("approve", "spec", "approved").status, 2, "the revised spec isn't written yet");
  fs.writeFileSync(path.join(s.run_dir, "spec.md"), "# CSV export, revised\n");
  run("done", "spec");
  assert.equal(run("dispatch", "tickets").status, 2, "a revise clears the approval");
  assert.equal(run("approve", "spec", "approved").status, 0, "the revised spec goes back to the gate without a second builder check");
  assert.equal(run("dispatch", "tickets").status, 0);
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), new RegExp(`spec approved\\n.*spec revise\\n.*spec approved\\n`));
  const one = init(p, "Fix the cart total");
  triaged(p, one, { type: "bug" }, "oneshot");
  assert.equal(rs(p.dir, ["dispatch", "plan", "--run", one.id]).status, 0);
});

// The Notion push (#64): run-state says what to push and records the page; the MCP call itself is the orchestrator's.
const NOTION = { docs: "notion", notion_parent: "01234567-89ab-cdef-0123-456789abcdef" };
const SPEC = "---\nsurface: operate\n---\n\n# CSV export\n\n- **SC-001** (profile: default, live-safe: yes): /reports, Export, a CSV downloads.\n";
const NOTICE = (id) => `Copy of \`spec.md\` from run \`${id}\`. Edits and comments here are not read by the factory.`;

test("only an approved spec is pushed: a child page of notion_parent titled with the spec's title and the run id, opening with the copy notice", () => {
  const p = project({ config: NOTION });
  const [s, run] = atGate(p);
  fs.writeFileSync(path.join(s.run_dir, "spec.md"), SPEC);
  const early = run("notion");
  assert.equal(early.status, 2, "nothing is pushed before the approval");
  assert.match(early.stderr, /isn't approved/);
  assert.equal(run("approve", "spec", "approved").status, 0);
  const r = run("notion");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    parent: NOTION.notion_parent, page: null, title: `CSV export (${s.id})`,
    content: `${NOTICE(s.id)}\n\n# CSV export\n\n- **SC-001** (profile: default, live-safe: yes): /reports, Export, a CSV downloads.\n`,
  });
});

test("the page leaves out the factory's <frozen-after-approval> tags and keeps the intent between them", () => {
  const p = project({ config: NOTION });
  const [s, run] = atGate(p);
  fs.writeFileSync(path.join(s.run_dir, "spec.md"), "---\nsurface: operate\n---\n\n# CSV export\n\n<frozen-after-approval>\nExport the report as a CSV.\n</frozen-after-approval>\n\n## Goal\nA CSV.\n");
  assert.equal(run("approve", "spec", "approved").status, 0);
  assert.equal(JSON.parse(run("notion").stdout).content, `${NOTICE(s.id)}\n\n# CSV export\n\nExport the report as a CSV.\n\n## Goal\nA CSV.\n`);
});

test("the page's URL goes into the spec's frontmatter without undoing its approval, and a re-approval overwrites the same page", () => {
  const p = project({ config: NOTION });
  const [s, run] = atGate(p);
  const spec = path.join(s.run_dir, "spec.md"), PAGE = "https://www.notion.so/acme/CSV-export-fedcba9876543210fedcba9876543210";
  fs.writeFileSync(spec, SPEC);
  assert.equal(run("approve", "spec", "approved").status, 0);
  assert.equal(run("notion", "pushed", "https://www.notion.so/x\nsurface: persuade").status, 2, "a URL is one line");
  const r = run("notion", "pushed", PAGE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(spec, "utf8"), SPEC.replace("surface: operate\n", `surface: operate\nnotion: ${PAGE}\n`));
  assert.equal(JSON.parse(run("notion").stdout).page, PAGE);

  // revised at the gate and approved again: the planner's new spec has no frontmatter, and the same page is overwritten
  assert.equal(run("approve", "spec", "revise").status, 0);
  run("dispatch", "spec");
  fs.writeFileSync(spec, "# CSV export, revised\n");
  run("done", "spec");
  assert.equal(run("approve", "spec", "approved").status, 0);
  const again = JSON.parse(run("notion").stdout);
  assert.deepEqual([again.page, again.title], [PAGE, `CSV export, revised (${s.id})`]);
  assert.equal(run("notion", "pushed", PAGE).status, 0);
  assert.equal(fs.readFileSync(spec, "utf8"), `---\nnotion: ${PAGE}\n---\n\n# CSV export, revised\n`);
  assert.equal(run("dispatch", "tickets").status, 0, "the approval holds");
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), new RegExp(`run: ${s.id} spec copied to Notion: ${PAGE}\\n`));
});

test("a failed push is one line in the log and changes nothing else; docs in the repo, a route without a spec or a spec changed since its approval push nothing", () => {
  const p = project({ config: NOTION });
  const [s, run] = atGate(p);
  const spec = path.join(s.run_dir, "spec.md"), text = () => fs.readFileSync(spec, "utf8");
  assert.equal(run("approve", "spec", "approved").status, 0);
  const before = text();
  const failed = run("notion", "failed", "no Notion tool in this session");
  assert.equal(failed.status, 0, failed.stderr);
  const logged = fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8").split("\n").filter((l) => l.includes("Notion"));
  assert.deepEqual(logged.map((l) => l.replace(/^- \S+ /, "")), [`run: ${s.id} spec not copied to Notion: no Notion tool in this session`]);
  assert.equal(text(), before, "the frontmatter gets no URL");
  assert.equal(JSON.parse(run("notion").stdout).page, null);
  assert.equal(run("dispatch", "tickets").status, 0, "the run carries on");

  const [e, erun] = atGate(p);
  assert.equal(erun("approve", "spec", "approved").status, 0);
  fs.appendFileSync(path.join(e.run_dir, "spec.md"), "- **SC-002**: an edit after the approval\n");
  const edited = fs.readFileSync(path.join(e.run_dir, "spec.md"), "utf8");
  assert.equal(erun("notion", "pushed", "https://www.notion.so/0123456789abcdef0123456789abcdef").status, 2);
  assert.equal(fs.readFileSync(path.join(e.run_dir, "spec.md"), "utf8"), edited, "an unapproved change is never approved along with the URL");

  const answer = init(p, "How are reports exported?");
  triaged(p, answer, { type: "question" }, "answer");
  for (const args of [[], ["failed", "no spec"]]) {
    assert.equal(rs(p.dir, ["notion", ...args, "--run", answer.id]).status, 2, "a route with no spec never reaches Notion");
  }

  const repo = project();
  const [r, rrun] = atGate(repo);
  assert.equal(rrun("approve", "spec", "approved").status, 0);
  const skip = rrun("notion");
  assert.equal(skip.status, 0, skip.stderr);
  assert.match(skip.stdout, /^skip: /);
  assert.ok(!fs.readFileSync(path.join(r.run_dir, "run.log"), "utf8").includes("Notion"));
});
