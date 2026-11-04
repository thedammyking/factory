// tickets.test.mjs — run-state.mjs past the spec gate: the ticket gate, ticket statuses and the frontier.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project } from "./harness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts/run-state.mjs");
// Spend is read from Claude Code's transcripts under CLAUDE_CONFIG_DIR, so no test reads the real ~/.claude.
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")) };
const rs = (cwd, args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input, encoding: "utf8", env: ENV });

// The planner's tickets: `edges` maps each ticket's file name to its Blocked by line.
const cut = (s, edges) => {
  const dir = path.join(s.run_dir, "tickets");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, blockedBy] of Object.entries(edges)) {
    fs.writeFileSync(path.join(dir, `${name}.md`), `# ${name.slice(3)}\n\nStatus: ready-for-agent\nBlocked by: ${blockedBy}\n\n## Goal\nOne slice of the export.\n`);
  }
};
const read = (s, name) => fs.readFileSync(path.join(s.run_dir, "tickets", `${name}.md`), "utf8");
// A build run past the spec gate, with nothing dispatched since.
function specApproved() {
  const p = project();
  const s = JSON.parse(rs(p.dir, ["init"], "Add a CSV export to the reports page\n").stdout);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id]);
  fs.writeFileSync(path.join(s.run_dir, "triage.md"), "```json\n" + JSON.stringify({ type: "feature", in_production: false, branch: "feature/csv-export" }) + "\n```\n");
  run("set", "route", "build");
  assert.equal(run("lane").status, 0);
  for (const [stage, file] of [["research", "research.md"], ["spec", "spec.md"], ["builder-check", "builder-check.md"]]) {
    run("dispatch", stage);
    fs.writeFileSync(path.join(s.run_dir, file), `# ${stage}\n`);
    run("done", stage);
  }
  assert.equal(run("approve", "spec", "approved").status, 0);
  return { p, s, run };
}
// The ticket gate: the tickets cut and the stage done.
function atTicketGate(edges) {
  const r = specApproved();
  r.run("dispatch", "tickets");
  cut(r.s, edges);
  r.run("done", "tickets");
  return r;
}

test("nothing past the tickets dispatches, and no status changes, until the human approves them at the ticket gate", () => {
  const { s, run } = specApproved();
  assert.equal(run("approve", "tickets", "approved").status, 2, "no tickets yet");
  assert.equal(run("dispatch", "tickets").status, 0, "the approved spec is cut into tickets");
  assert.equal(run("approve", "tickets", "approved").status, 2, "the planner is still cutting them");
  cut(s, { "01-export-endpoint": "none", "02-export-button": "01" });
  run("done", "tickets");
  const refused = run("dispatch", "plan:01");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`tickets of ${s.id} aren't approved: /factory approve ${s.id} approved`));
  assert.equal(run("ticket", "01", "in-progress").status, 2, "before the gate the tickets are the planner's");
  assert.equal(run("next-ticket").status, 2, "and they have no frontier");
  assert.match(run("approve", "tickets", "maybe").stderr, /approved \| revise/);
  const spec = path.join(s.run_dir, "spec.md");
  fs.appendFileSync(spec, "- an edit after the approval\n");
  assert.match(run("approve", "tickets", "approved").stderr, new RegExp(`the spec of ${s.id} changed after its approval`));
  fs.writeFileSync(spec, "# spec\n");
  const ok = run("approve", "tickets", "approved");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "tickets approved");
  assert.equal(run("dispatch", "plan:01").status, 0);
  assert.equal(run("approve", "tickets", "revise").status, 2, "past the gate the tickets are frozen");
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), new RegExp(`run: ${s.id} tickets approved`));
});

test("only ticket's status changes keep the approval, any other edit needs approving again, and a revise cuts the tickets again beside the old ones", () => {
  const kept = atTicketGate({ "01-export-endpoint": "none", "02-export-button": "01" });
  assert.equal(kept.run("approve", "tickets", "approved").status, 0);
  assert.equal(kept.run("ticket", "01", "in-progress").status, 0);
  assert.equal(kept.run("dispatch", "plan:01").status, 0, "run-state changed the status");
  fs.writeFileSync(path.join(kept.s.run_dir, "tickets", "02-export-button.md"), read(kept.s, "02-export-button").replace("Status: ready-for-agent", "Status: done"));
  assert.equal(kept.run("next-ticket").status, 2, "a Status line written by anything else");
  assert.equal(kept.run("dispatch", "plan:02").status, 2);

  const { s, run } = atTicketGate({ "01-export-endpoint": "none", "02-export-button": "01" });
  assert.equal(run("approve", "tickets", "approved").status, 0);
  fs.writeFileSync(path.join(s.run_dir, "tickets", "02-export-button.md"), read(s, "02-export-button").replace("Blocked by: 01", "Blocked by: none"));
  assert.equal(run("dispatch", "plan:01").status, 2, "the approval covers the cut and the edges as the human read them");
  assert.equal(run("approve", "tickets", "revise").status, 0);
  assert.equal(run("dispatch", "tickets").status, 0, "the planner cuts them again");
  assert.ok(!fs.existsSync(path.join(s.run_dir, "tickets")), "a dispatch with no output yet is working");
  assert.match(fs.readFileSync(path.join(s.run_dir, "tickets.round1", "02-export-button.md"), "utf8"), /Blocked by: none/);
  cut(s, { "01-export": "none" });
  run("done", "tickets");
  assert.equal(run("dispatch", "plan:01").status, 2, "a revise clears the approval");
  assert.equal(run("approve", "tickets", "approved").status, 0);
  assert.equal(run("dispatch", "plan:01").status, 0);
  fs.mkdirSync(path.join(s.run_dir, "tickets", "01"));
  fs.writeFileSync(path.join(s.run_dir, "tickets", "01", "plan.md"), "---\nstatus: open_questions\n---\n");
  assert.equal(run("dispatch", "plan:01").status, 0, "a ticket planned again once its questions are answered");
  assert.ok(!fs.existsSync(path.join(s.run_dir, "tickets", "01", "plan.md")));
  assert.match(fs.readFileSync(path.join(s.run_dir, "tickets", "01", "plan.round1.md"), "utf8"), /open_questions/);
  assert.match(run("spend").stdout, /^tokens \d+\/1400000$/m, "the cap scales with the one ticket, not the ones set aside");
});

test("ticket <NN> <status> rewrites only that ticket's Status line, bold or not, and logs it; an unknown ticket or status is refused", () => {
  const { s, run } = atTicketGate({ "01-export-endpoint": "none" });
  fs.writeFileSync(path.join(s.run_dir, "tickets", "02-export-button.md"), "# export-button\n\n**Status:** ready-for-agent\n**Blocked by:** 01\n\nStatus: a line in the body\n");
  assert.equal(run("approve", "tickets", "approved").status, 0, "the bold form is a ticket too");
  const before = read(s, "01-export-endpoint");
  const r = run("ticket", "01", "in-progress");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "ticket 01-export-endpoint in-progress");
  assert.equal(read(s, "01-export-endpoint"), before.replace("Status: ready-for-agent", "Status: in-progress"));
  assert.equal(run("ticket", "02-export-button", "blocked").status, 0, "the full name works too");
  assert.equal(read(s, "02-export-button"), "# export-button\n\n**Status:** blocked\n**Blocked by:** 01\n\nStatus: a line in the body\n");
  assert.match(run("ticket", "07", "done").stderr, /no ticket 07/);
  const bad = run("ticket", "01", "finished");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /ready-for-agent \| in-progress \| done \| blocked/);
  assert.match(read(s, "01-export-endpoint"), /^Status: in-progress$/m, "a refusal writes nothing");
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), new RegExp(`run: ${s.id} ticket 01-export-endpoint ready-for-agent -> in-progress\\n`));
});

test("next-ticket prints the takeable tickets, in-progress first, then DONE once all are done, else BLOCKED with what each open one waits on", () => {
  const { run } = atTicketGate({ "01-export-endpoint": "none", "02-export-button": "01", "03-file-name": "none", "04-empty-state": "2, #3" });
  assert.equal(run("approve", "tickets", "approved").status, 0);
  const next = () => { const r = run("next-ticket"); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  assert.equal(next(), "NEXT 01-export-endpoint\nNEXT 03-file-name", "every ready ticket with nothing open before it");
  run("ticket", "03", "in-progress");
  assert.equal(next(), "NEXT 03-file-name\nNEXT 01-export-endpoint", "a ticket already started comes first");
  run("ticket", "01", "done");
  run("ticket", "03", "done");
  assert.equal(next(), "NEXT 02-export-button", "04 still waits on 2, which is 02");
  run("ticket", "02", "blocked");
  assert.equal(next(), "BLOCKED 02-export-button: blocked\nBLOCKED 04-empty-state: waits on 02");
  run("ticket", "02", "done");
  assert.equal(next(), "NEXT 04-empty-state");
  run("ticket", "04", "done");
  assert.equal(next(), "DONE");
});

test("the ticket gate refuses tickets the frontier can't order: a missing Status or Blocked by line, a shared number, or a wait on a later ticket", () => {
  for (const [why, write, problem] of [
    ["a later blocker", (s) => cut(s, { "01-endpoint": "none", "02-button": "03", "03-name": "none" }), /02-button waits on 03/],
    ["a missing blocker", (s) => cut(s, { "01-endpoint": "none", "02-button": "05" }), /02-button waits on 05/],
    ["a shared number", (s) => cut(s, { "01-endpoint": "none", "01-button": "none" }), /01-button shares its number/],
    ["no Blocked by line", (s) => { cut(s, { "01-endpoint": "none" }); fs.writeFileSync(path.join(s.run_dir, "tickets", "02-button.md"), "# button\n\nStatus: ready-for-agent\n"); }, /02-button has no `Blocked by:` line/],
    ["a status other than ready", (s) => { cut(s, { "01-endpoint": "none" }); fs.writeFileSync(path.join(s.run_dir, "tickets", "02-button.md"), "# button\n\nStatus: done\nBlocked by: 01\n"); }, /02-button isn't `Status: ready-for-agent`/],
  ]) {
    const { s, run } = specApproved();
    run("dispatch", "tickets");
    write(s);
    run("done", "tickets");
    const r = run("approve", "tickets", "approved");
    assert.equal(r.status, 2, why);
    assert.match(r.stderr, problem, why);
    assert.equal(run("approve", "tickets", "revise").status, 0, `${why}: the human can still send them back`);
  }
});
