// synthesize.test.mjs — synthesize.mjs spawned as a process over a run's lens files on a throwaway project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { project, script, startRun, write } from "./harness.mjs";

// One finding block in the lenses' schema; a key left undefined is left out.
const block = (f) => [`- id: ${f.id}`, ...["severity", "action", "location", "claim", "evidence", "fix", "cwe", "status", "note"]
  .filter((k) => f[k] !== undefined).map((k) => `  ${k}: ${f[k]}`)].join("\n");
const lensFile = (title, findings, { first = "", verdict = "needs-fixes" } = {}) =>
  `${first ? `${first}\n\n` : ""}# ${title}\n\n${findings.map(block).join("\n")}\n\nverdict: ${verdict}\n`;
const closed = (id, note = "the fix diff handles it") => ({ id, status: "closed", note });
const SPEC = (surface = "operate") => `---\nsurface: ${surface}\n---\n\n# Orders\n\n## Anti-goals\n- An order that is charged but never saved.\n`;

function run(files) {
  const p = project();
  const r = startRun(p);
  write(r.run_dir, { "spec.md": SPEC(), ...files });
  const synth = () => {
    const s = script("synthesize.mjs", p.dir, ["--run", r.id]);
    assert.equal(s.status, 0, s.stderr + s.stdout);
    const read = (f) => fs.existsSync(path.join(r.run_dir, f)) ? fs.readFileSync(path.join(r.run_dir, f), "utf8") : null;
    return { ...s, out: JSON.parse(read("findings.json")), deferred: read("deferred.md") };
  };
  return { ...r, synth, write: (f) => write(r.run_dir, f) };
}
const rows = (out) => out.findings.map((f) => [f.members.join("+"), f.severity, f.action, f.status]);

test("design fix 3: findings merge only at the same file within 5 lines whose claims overlap or share a CWE, at the highest severity, and any ask makes the group an ask, a lens's a judgment call (#81)", () => {
  const r = run({
    "review-code.md": lensFile("Code review", [
      { id: "code-01", severity: "P2", action: "fix", location: "src/api/orders.ts:40", claim: "The orders endpoint accepts a request body of any size, so one large upload can exhaust the server memory", fix: "Cap the body." },
      { id: "code-02", severity: "P2", action: "ask", location: "src/api/orders.ts:42", claim: "The new orderNotes helper is not needed for the intent of this change", fix: "Drop it?" },
      { id: "code-03", severity: "P2", action: "fix", location: "src/db/query.ts:10", claim: "Customer names are spliced into the statement", cwe: "CWE-89" },
      { id: "code-04", severity: "P2", location: "src/app.py:7", claim: "A setting is read twice" },
      { id: "code-05", action: "fix", location: "src/app.py:30", claim: "The retry loop never ends" },
    ]),
    "review-security.md": lensFile("Security review", [
      { id: "security-01", severity: "P1", action: "fix", location: "src/api/orders.ts:41", claim: "The orders endpoint reads a request body with no size limit, so a large upload exhausts memory", cwe: "CWE-770" },
      { id: "security-02", severity: "P1", action: "ask", location: "src/db/query.ts:13", claim: "Input reaches SQL unescaped", cwe: "CWE-89" },
      { id: "security-03", severity: "P1", action: "fix", location: "src/db/query.ts:30", claim: "Input reaches SQL unescaped", cwe: "CWE-89" },
      { id: "security-04", severity: "P2", action: "fix", location: "src/api/orders.ts:46", claim: "With no request body limit, a large upload exhausts the server's memory" },
    ]),
  });
  const { out, stdout } = r.synth();
  assert.deepEqual(rows(out), [
    ["code-01+security-01+security-04", "P1", "fix", "open"],
    ["code-02", "P2", "ask", "pr"],
    ["code-03+security-02", "P1", "ask", "open"],
    ["code-04", "P2", "ask", "pr"],
    ["code-05", "P1", "fix", "open"],
    ["security-03", "P1", "fix", "open"],
  ], "a neighbouring ask with another claim never demotes the P1 fix; within 5 lines of any member joins the group; the same CWE merges other "
    + "words; 17 lines apart never merges; a missing action is an ask and a missing severity a P1");
  const merged = out.findings[0];
  assert.deepEqual([merged.lens, merged.location, merged.cwe], [["code", "security"], "src/api/orders.ts:41", "CWE-770"], "the group is told by its most severe member");
  assert.equal(out.disposition, "fix", "a lens's ask is the fix round's call, a P2 one listed on the PR");
  assert.match(stdout, /^synthesize: disposition=fix /m);
  assert.match(stdout, new RegExp(`findings\\.json: ${path.join(r.run_dir, "findings.json").replace(/[.\\]/g, "\\$&")}`));
});

test("design fix 16: every round is read in name order, the unsuffixed file last and never by mtime, and a closed block with no claim is a resolution", () => {
  const r = run({
    "review-code.round1.md": lensFile("Code review", [
      { id: "code-01", severity: "P1", action: "fix", location: "src/a.ts:5", claim: "The total ignores the quantity" },
      { id: "code-02", severity: "P1", action: "fix", location: "src/b.ts:9", claim: "The error is swallowed" },
      { id: "code-03", severity: "P1", action: "fix", location: "src/c.ts:2", claim: "The cache never expires" },
    ]),
    "review-code.round2.md": lensFile("Code review", [closed("code-01"),
      { id: "code-02", severity: "P1", action: "fix", location: "src/b.ts:9", claim: "The error is still swallowed on retry" },
      { id: "code-04", severity: "P3", action: "note", location: "src/c.ts:40", claim: "A name could be clearer" }]),
    "review-code.round10.md": lensFile("Code review", [closed("code-02")]),
    // cut off before its verdict, so it counts for nothing
    "review-code.round11.md": "# Code review\n\n- id: code-02\n  severity: P0\n  action: fix\n  location: src/b.ts:9\n  claim: The error is",
    "review-code.md": lensFile("Code review", [closed("code-03"), { id: "code-05", severity: "P2", action: "fix", location: "src/d.ts:3", claim: "A log line repeats" }], { verdict: "approve" }),
  });
  // The newest file by mtime is round 1, the oldest the unsuffixed one: only the names may order them, round 10 after
  // round 2, and a finding's newest block wins.
  ["review-code.md", "review-code.round11.md", "review-code.round10.md", "review-code.round2.md", "review-code.round1.md"]
    .forEach((f, i) => fs.utimesSync(path.join(r.run_dir, f), 1_000_000 + i * 1000, 1_000_000 + i * 1000));
  const { out, deferred } = r.synth();
  assert.deepEqual(rows(out), [
    ["code-01", "P1", "fix", "resolved"],
    ["code-02", "P1", "fix", "resolved"],
    ["code-03", "P1", "fix", "resolved"],
    ["code-04", "P3", "note", "deferred"],
    ["code-05", "P2", "fix", "pr"],
  ]);
  assert.equal(out.findings[1].claim, "The error is still swallowed on retry");
  assert.equal(out.counts.resolved, 3);
  assert.equal(out.disposition, "ship");
  assert.match(deferred, /^- code-04 \(code\) `src\/c\.ts:40`: A name could be clearer$/m, "P3s go to deferred.md");
  assert.doesNotMatch(deferred, /code-0[1235]/);
});

test("design fix 6: a UI fix, rebuild or recapture on a persuade or operate surface is an open P1 until the latest UI round says ship", () => {
  const ui = (d) => lensFile("UI review", [], { first: `disposition: ${d}`, verdict: d === "ship" ? "approve" : "needs-fixes" });
  const r = run({ "review-ui.round1.md": ui("fix"), "review-ui.round2.md": ui("ship"), "review-ui.md": ui("fix") });
  let { out } = r.synth();
  assert.deepEqual(rows(out), [["ui-disposition", "P1", "fix", "open"]], "round 2's ship never closes the newer round's fix");
  assert.deepEqual([out.ui_disposition, out.disposition, out.findings[0].lens], ["fix", "fix", ["ui"]]);
  for (const d of ["rebuild", "recapture"]) {
    r.write({ "review-ui.md": ui(d) });
    assert.deepEqual(rows(r.synth().out), [["ui-disposition", "P1", "fix", "open"]], d);
  }
  r.write({ "review-ui.md": ui("ship") });
  ({ out } = r.synth());
  assert.deepEqual(rows(out), [["ui-disposition", "P1", "fix", "resolved"]], "a UI re-review that says ship closes it");
  assert.equal(out.disposition, "ship");
  r.write({ "spec.md": SPEC("read"), "review-ui.md": ui("fix") });
  assert.deepEqual(r.synth().out.findings, [], "on a read surface the UI disposition is no finding");
});

test("a oneshot, which has no spec.md, is held to the operate surface's UI rule", () => {
  const ui = (d) => lensFile("UI review", [], { first: `disposition: ${d}`, verdict: d === "ship" ? "approve" : "needs-fixes" });
  const r = run({ "spec.md": null, "triage.md": "```json\n" + JSON.stringify({ type: "bug", route: "oneshot", acceptance_check: "`/cart`, add two, the total doubles." }) + "\n```\n",
    "review-ui.round1.md": ui("fix") });
  const rs = script("run-state.mjs", r.worktree, ["set", "route", "oneshot", "--run", r.id]);
  assert.equal(rs.status, 0, rs.stderr);
  let { out } = r.synth();
  assert.deepEqual(rows(out), [["ui-disposition", "P1", "fix", "open"]]);
  assert.deepEqual([out.surface, out.disposition], ["operate", "fix"]);
  r.write({ "review-ui.md": ui("ship") });
  ({ out } = r.synth());
  assert.deepEqual([rows(out), out.disposition], [[["ui-disposition", "P1", "fix", "resolved"]], "ship"]);
});

test("a finding that breaks an anti-goal is at least P1, an open P0 goes to a fix round, only a person's question asks, and P2 and P3 never block", () => {
  const r = run({
    "review-code.md": lensFile("Code review", [
      { id: "code-01", severity: "P2", action: "fix", location: "src/checkout.ts:12", claim: "The anti-goal is broken: the card is charged when the order write fails", fix: "Save the order first." },
      { id: "code-02", severity: "P3", action: "fix", location: "src/x.ts:1", claim: "Spacing" },
    ]),
  });
  let { out } = r.synth();
  assert.deepEqual(rows(out), [["code-01", "P1", "fix", "open"], ["code-02", "P3", "fix", "deferred"]]);
  assert.deepEqual(out.findings[0].rules, ["anti-goal => at least P1"]);
  assert.equal(out.disposition, "fix");
  r.write({ "review-security.md": lensFile("Security review", [{ id: "security-01", severity: "P0", action: "fix", location: "src/db.ts:3", claim: "SQL injection", cwe: "CWE-89" }], { verdict: "block" }) });
  ({ out } = r.synth());
  assert.equal(out.disposition, "fix", "an open P0 goes to a fix round (#81)");
  assert.deepEqual([out.counts.P0, out.counts.P1, out.counts.open_blocking, out.counts.open_asks], [1, 1, 2, 0]);
  r.write({ "review-human.md": lensFile("Human review", [{ id: "human-01", severity: "P1", action: "ask", location: "src/x.ts:9", claim: "Why a modal here?" }]) });
  ({ out } = r.synth());
  assert.deepEqual([out.disposition, out.counts.open_asks], ["ask", 1], "a person's question on the PR waits for them");
  r.write({ "review-human.md": null });
  r.write({ "review-code.md": null, "review-security.md": lensFile("Security review", [{ id: "security-01", severity: "P2", action: "note", location: "src/db.ts:3", claim: "Fine" }], { verdict: "approve" }) });
  ({ out } = r.synth());
  assert.deepEqual([rows(out), out.disposition], [[["security-01", "P2", "note", "pr"]], "ship"]);
});
