// retro.test.mjs — retro-apply.mjs spawned as a process on throwaway projects: the retro's accepted proposals committed on
// the base through commitToBase, with a fake semgrep on PATH, or none (CI has no real one). The last case uses the real
// semgrep where it's installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { project, script, write, fakeClis } from "./harness.mjs";

const scratch = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// git from the real PATH and nothing else from it, so an installed semgrep never reaches the script
const TOOLS = scratch("factory-tools-");
fs.symlinkSync(process.env.PATH.split(path.delimiter).map((d) => path.join(d, "git")).find((f) => fs.existsSync(f)), path.join(TOOLS, "git"));
const NO_SEMGREP = { ...process.env, PATH: [TOOLS, "/usr/bin", "/bin"].join(path.delimiter) };
const CANNED = scratch("factory-canned-");
const canned = (name, text) => { const f = path.join(CANNED, name); fs.writeFileSync(f, text); return f; };

const FILE = ".factory/runs/retro/retro.md";
// retro.md as the retro agent writes it, with these proposals
const retro = (...proposals) => "# Retro\n\n## Trial record\n\nRECORD 2 of the last 2 counted agree (2 agree, 0 disagree, 0 not counted)\n"
  + "Recommendation: none\n\n## Watch\n\n- nothing blocked\n\n" + proposals.map(([title, kind, block, file], i) => `## ${i + 1}. ${title}\n\n- kind: ${kind}\n`
    + (file ? `- file: \`${file}\`\n` : "") + "- evidence: `.factory/history/r1/run.log`: the same failure in rounds 1 and 2\n- why: it would have saved a round.\n\n"
    + `\`\`\`${kind === "semgrep" ? "yaml" : "text"}\n${block}\n\`\`\`\n`).join("\n");
const RULE = "- id: no-raw-sql\n  languages: [javascript]\n  severity: ERROR\n  message: Build SQL with the query builder.\n  pattern: db.raw($X)";
const LESSON = "Keep money in integer cents through src/money.js; never round floats (r1)";
const apply = (p, accept, env = NO_SEMGREP) => script("retro-apply.mjs", p.dir, [path.join(p.dir, FILE), "--accept", accept], { env });
const on = (p, branch, f) => p.git("show", `${branch}:${f}`);
const tip = (p, branch) => p.git("rev-parse", branch);
const worktrees = (p) => p.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

test("design fix 25: on a base with no .factory/semgrep/, the accepted proposals are committed, the rule compiled offline by a scan of an empty directory with metrics off, and a second run is a no-op", () => {
  const p = project({ config: { branching: { model: "git-flow", main: "main", develop: "develop" } } });
  write(p.dir, { ".factory/lessons.md": `# Lessons\n\n- ${LESSON}\n` });
  p.git("add", "-A"); p.git("commit", "-qm", "lessons");
  p.git("branch", "develop");
  p.git("reset", "-q", "--hard", "HEAD~1");  // the checkout stays on main, which lacks them: develop is checked out nowhere
  const lesson = "Run the migrations before the API tests (r2)";
  write(p.dir, { [FILE]: retro(["Ban raw SQL", "semgrep", RULE], ["Migrate first", "lesson", lesson], ["Integer cents", "lesson", LESSON]) });
  const f = fakeClis({ semgrep: [{ match: /^scan /, file: canned("quiet", "") }] }), before = tip(p, "develop");

  let r = apply(p, "1,2,3", f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 semgrep: rule no-raw-sql added to \.factory\/semgrep\/project\.yaml, compiled$/m);
  assert.match(r.stdout, /^2 lesson: added to \.factory\/lessons\.md$/m);
  assert.match(r.stdout, /^3 lesson: already in \.factory\/lessons\.md$/m);
  assert.match(r.stdout, /^RETRO [0-9a-f]{7} on develop$/m);
  assert.equal(p.git("rev-parse", "develop~1"), before, "one commit on develop");
  assert.equal(on(p, "develop", ".factory/semgrep/project.yaml"), `rules:\n${RULE.replace(/^/gm, "  ")}`, "the file and its directory made");
  assert.equal(on(p, "develop", ".factory/lessons.md"), `# Lessons\n\n- ${LESSON}\n- ${lesson}`, "the line already there isn't added again");
  const calls = f.calls("semgrep");
  assert.equal(calls.length, 1);
  const [args] = calls, target = args.at(-1);
  assert.deepEqual(args.slice(0, -1), ["scan", "--config", ".factory/semgrep/project.yaml", "--metrics=off", "--disable-version-check", "--quiet"]);
  assert.ok(path.isAbsolute(target) && !target.startsWith(p.dir) && !fs.existsSync(target), `${target}: an empty directory of its own, removed after`);
  assert.ok(!fs.existsSync(path.join(p.dir, ".factory/semgrep")), "nothing is written in the checkout");
  assert.equal(worktrees(p), 1, "the temp worktree is removed");

  const after = tip(p, "develop");
  r = apply(p, "1,2,3", f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 semgrep: rule no-raw-sql already in \.factory\/semgrep\/project\.yaml$/m);
  assert.match(r.stdout, /^2 lesson: already in \.factory\/lessons\.md$/m);
  assert.match(r.stdout, /^RETRO unchanged on develop$/m);
  assert.equal(tip(p, "develop"), after);
  assert.equal(f.calls("semgrep").length, 1, "nothing to compile");
});

test("an accepted index line and ADR stub are committed on the base, the ADR under .factory/knowledge/ made on first use and named in index.md; a declined one isn't, and a second run is a no-op", () => {
  const p = project();
  write(p.dir, { ".factory/lessons.md": "# Lessons\n", ".factory/index.md": "# Index\n\n## Memory\n\n- `.factory/log.md`: the log.\n" });
  p.git("add", "-A"); p.git("commit", "-qm", "memory");
  const line = "`src/money.js`: every price, in integer cents", adr = "# Prices are integer cents\n\nRun r1 lost two rounds to float rounding. Every price is kept in integer cents.";
  write(p.dir, { [FILE]: retro(["Integer cents", "lesson", LESSON], ["Where prices live", "index", line], ["Prices are cents", "adr", adr, ".factory/knowledge/prices-in-cents.md"]) });

  let r = apply(p, "2,3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^2 index: added to \.factory\/index\.md$/m);
  assert.match(r.stdout, /^3 adr: added to \.factory\/knowledge\/prices-in-cents\.md$/m);
  assert.doesNotMatch(r.stdout, /^1 /m);
  assert.match(r.stdout, /^RETRO [0-9a-f]{7} on main$/m);
  assert.equal(on(p, "main", ".factory/lessons.md"), "# Lessons", "the declined lesson isn't applied");
  assert.equal(on(p, "main", ".factory/index.md"), `# Index\n\n## Memory\n\n- \`.factory/log.md\`: the log.\n- ${line}\n- \`.factory/knowledge/prices-in-cents.md\`: Prices are cents`);
  assert.equal(on(p, "main", ".factory/knowledge/prices-in-cents.md"), adr);
  assert.equal(fs.readFileSync(path.join(p.dir, ".factory/knowledge/prices-in-cents.md"), "utf8"), `${adr}\n`, "the checkout holding main moves with it");

  const after = tip(p, "main");
  r = apply(p, "2,3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^2 index: already in \.factory\/index\.md$/m);
  assert.match(r.stdout, /^3 adr: already in \.factory\/knowledge\/prices-in-cents\.md$/m);
  assert.match(r.stdout, /^RETRO unchanged on main$/m);
  assert.equal(tip(p, "main"), after);
});

test("a rule joins the project's rules at their indent, uncompiled and saying so without semgrep; one semgrep rejects commits nothing", () => {
  const p = project();
  const starter = "# the starter\nrules:\n    - id: existing\n      languages: [javascript]\n      severity: ERROR\n      message: no\n      pattern: eval($X)\n";
  write(p.dir, { ".factory/semgrep/project.yaml": starter, [FILE]: retro(["Ban raw SQL", "semgrep", RULE]) });
  p.git("add", "-A"); p.git("commit", "-qm", "rules");
  const before = tip(p, "main");

  const f = fakeClis({ semgrep: [{ match: /^scan /, file: canned("broken", "[ERROR] Invalid rule schema: no-raw-sql: 'languages' is required\n"), status: 7 }] });
  let r = apply(p, "1", f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rule no-raw-sql doesn't compile, so nothing was committed: .*Invalid rule schema/s);
  assert.equal(tip(p, "main"), before);
  assert.equal(worktrees(p), 1);

  r = apply(p, "1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 semgrep: rule no-raw-sql added to \.factory\/semgrep\/project\.yaml, not compiled: semgrep isn't installed$/m);
  assert.equal(on(p, "main", ".factory/semgrep/project.yaml"), `${starter}${RULE.replace(/^/gm, "    ")}`);

  write(p.dir, { ".factory/semgrep/project.yaml": "rules: []\n" });
  p.git("commit", "-qam", "no rules");
  r = apply(p, "1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(on(p, "main", ".factory/semgrep/project.yaml"), `rules:\n${RULE.replace(/^/gm, "  ")}`, "an empty flow list becomes a block list");

  write(p.dir, { ".factory/semgrep/project.yaml": "# no rules yet" });
  p.git("commit", "-qam", "no list");
  r = apply(p, "1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(on(p, "main", ".factory/semgrep/project.yaml"), `# no rules yet\nrules:\n${RULE.replace(/^/gm, "  ")}`, "a file without the key gets it");
});

test("a proposal that can't be applied as accepted stops them all, before anything is written", () => {
  const p = project();
  const before = tip(p, "main");
  const refused = (proposals, accept, why) => {
    write(p.dir, { [FILE]: retro(["Integer cents", "lesson", LESSON], ...proposals) });
    const r = apply(p, accept);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, why);
    assert.equal(tip(p, "main"), before);
  };
  refused([], "1,2", /^retro-apply: no proposal 2 in /m);
  refused([["Two lines", "lesson", "one\ntwo"]], "1,2", /^retro-apply: proposal 2: a lesson is one line$/m);
  refused([["Elsewhere", "adr", "# A", ".factory/config.json"]], "1,2", /^retro-apply: proposal 2: an adr's file is \.factory\/knowledge\/<slug>\.md$/m);
  refused([["Escape", "adr", "# A", ".factory/knowledge/../../x.md"]], "1,2", /proposal 2: an adr's file is/);
  refused([["Unnamed", "semgrep", "rules:\n  - id: x"]], "1,2", /^retro-apply: proposal 2: a rule starts `- id: <id>`$/m);
  refused([["A test", "eval", "evals/x"]], "1,2", /^retro-apply: proposal 2: its kind eval isn't lesson, index, adr or semgrep$/m);
  refused([["Inherited", "constructor", "x"]], "1,2", /^retro-apply: proposal 2: its kind constructor isn't lesson, index, adr or semgrep$/m);
  refused([], "", /usage: retro-apply\.mjs <retro\.md> --accept <n,n>/);
  // an ADR whose file another stub already holds is no repeat of it
  write(p.dir, { ".factory/knowledge/prices.md": "# Something else\n" });
  p.git("add", "-A"); p.git("commit", "-qm", "adr");
  write(p.dir, { [FILE]: retro(["Prices", "adr", "# Prices are cents", ".factory/knowledge/prices.md"]) });
  const r = apply(p, "1");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /proposal 1: \.factory\/knowledge\/prices\.md already holds another record on main/);
});

const installed = process.env.PATH.split(path.delimiter).some((d) => fs.existsSync(path.join(d, "semgrep")));
test("with the real semgrep, a rule whose pattern doesn't parse is refused, and a sound one compiles", { skip: !installed && "semgrep isn't installed" }, () => {
  const p = project();
  write(p.dir, { [FILE]: retro(["Broken", "semgrep", '- id: broken\n  languages: [javascript]\n  severity: ERROR\n  message: no\n  pattern: "} } } ((( ="'], ["Ban raw SQL", "semgrep", RULE]) });
  const before = tip(p, "main");
  let r = apply(p, "1", process.env);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /rule broken doesn't compile/);
  assert.equal(tip(p, "main"), before);
  r = apply(p, "2", process.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^2 semgrep: rule no-raw-sql added to \.factory\/semgrep\/project\.yaml, compiled$/m);
});
