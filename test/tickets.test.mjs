// tickets.test.mjs — run-state.mjs past the spec gate: the checks at done tickets, ticket statuses and the frontier.
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
function specApproved(config) {
  const p = project({ config });
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
// The tickets cut, and checked as the stage is done.
function ticketsDone(edges, config) {
  const r = specApproved(config);
  r.run("dispatch", "tickets");
  cut(r.s, edges);
  const done = r.run("done", "tickets");
  assert.equal(done.status, 0, done.stderr);
  return r;
}

test("nothing past the tickets dispatches, and no status changes, until done tickets checks them, and then the run goes on with no approval", () => {
  const { s, run } = specApproved();
  assert.equal(run("dispatch", "tickets").status, 0, "the approved spec is cut into tickets");
  const none = run("done", "tickets");
  assert.equal(none.status, 2, "the planner is still cutting them");
  assert.match(none.stderr, /no tickets/);
  cut(s, { "01-export-endpoint": "none", "02-export-button": "01" });
  const refused = run("dispatch", "plan:01");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`the tickets of ${s.id} haven't passed \`done tickets\`, or changed after it`));
  assert.equal(run("ticket", "01", "in-progress").status, 2, "before done tickets the tickets are the planner's");
  assert.equal(run("next-ticket").status, 2, "and they have no frontier");
  const ok = run("done", "tickets");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "done tickets");
  assert.equal(run("next-ticket").stdout.trim(), "NEXT 01-export-endpoint", "no approval");
  assert.equal(run("dispatch", "plan:01").status, 0);
  const gone = run("approve", "tickets", "approved");
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /approve spec approved \| revise/);
  assert.doesNotMatch(gone.stderr, /tickets/, "approve tickets is no command");
});

test("only ticket's status changes keep the hash done tickets recorded, any other edit is refused, and a cut made again beside the old one is checked again", () => {
  const kept = ticketsDone({ "01-export-endpoint": "none", "02-export-button": "01" });
  assert.equal(kept.run("ticket", "01", "in-progress").status, 0);
  assert.equal(kept.run("dispatch", "plan:01").status, 0, "run-state changed the status");
  const second = path.join(kept.s.run_dir, "tickets", "02-export-button.md"), cutAs = read(kept.s, "02-export-button");
  fs.writeFileSync(second, cutAs.replace("Status: ready-for-agent", "Status: done"));
  const edited = kept.run("next-ticket");
  assert.equal(edited.status, 2, "a Status line written by anything else");
  assert.match(edited.stderr, /changed after it/);
  assert.equal(kept.run("dispatch", "plan:02").status, 2);
  fs.writeFileSync(second, cutAs);
  assert.equal(kept.run("ticket", "01", "ready-for-agent").status, 0, "as a WAIT puts a ticket back");
  fs.writeFileSync(second, cutAs.replace("Blocked by: 01", "Blocked by: none"));
  const late = kept.run("done", "tickets");
  assert.equal(late.status, 2, "a ticket planned since: done tickets never takes an edit in");
  assert.match(late.stderr, /done tickets follows the tickets stage/);

  const { s, run } = ticketsDone({ "01-export-endpoint": "none", "02-export-button": "01" });
  fs.writeFileSync(path.join(s.run_dir, "tickets", "02-export-button.md"), read(s, "02-export-button").replace("Blocked by: 01", "Blocked by: none"));
  assert.equal(run("dispatch", "plan:01").status, 2, "the hash covers the cut and the edges as done tickets checked them");
  assert.equal(run("dispatch", "tickets").status, 0, "the planner cuts them again");
  assert.ok(!fs.existsSync(path.join(s.run_dir, "tickets")), "a dispatch with no output yet is working");
  assert.match(fs.readFileSync(path.join(s.run_dir, "tickets.round1", "02-export-button.md"), "utf8"), /Blocked by: none/);
  cut(s, { "01-export": "none" });
  assert.equal(run("dispatch", "plan:01").status, 2, "a new cut isn't built from until done tickets checks it");
  assert.equal(run("done", "tickets").status, 0);
  assert.equal(run("dispatch", "plan:01").status, 0);
  fs.mkdirSync(path.join(s.run_dir, "tickets", "01"));
  fs.writeFileSync(path.join(s.run_dir, "tickets", "01", "plan.md"), "---\nstatus: open_questions\n---\n");
  assert.equal(run("dispatch", "plan:01").status, 0, "a ticket planned again once its questions are answered");
  assert.ok(!fs.existsSync(path.join(s.run_dir, "tickets", "01", "plan.md")));
  assert.match(fs.readFileSync(path.join(s.run_dir, "tickets", "01", "plan.round1.md"), "utf8"), /open_questions/);
  assert.match(run("spend").stdout, /^tokens \d+\/1400000$/m, "the cap scales with the one ticket, not the ones set aside");
});

test("ticket <NN> <status> rewrites only that ticket's Status line, bold or not, and logs it; an unknown ticket or status is refused", () => {
  const { s, run } = specApproved();
  run("dispatch", "tickets");
  cut(s, { "01-export-endpoint": "none" });
  fs.writeFileSync(path.join(s.run_dir, "tickets", "02-export-button.md"), "# export-button\n\n**Status:** ready-for-agent\n**Blocked by:** 01\n\nStatus: a line in the body\n");
  assert.equal(run("done", "tickets").status, 0, "the bold form is a ticket too");
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

test("next-ticket lists the started tickets, then starts takeable ones while fewer than parallel_tickets (2) are started, then DONE once all are done, else BLOCKED with what each open one waits on", () => {
  const { run } = ticketsDone({ "01-export-endpoint": "none", "02-export-button": "01", "03-file-name": "none", "04-empty-state": "2, #3", "05-help-text": "none" });
  const next = () => { const r = run("next-ticket"); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  assert.equal(next(), "NEXT 01-export-endpoint\nNEXT 03-file-name\nWAIT 05-help-text: parallel_tickets is 2", "two at once, in order");
  run("ticket", "03", "in-progress");
  assert.equal(next(), "STARTED 03-file-name\nNEXT 01-export-endpoint\nWAIT 05-help-text: parallel_tickets is 2", "a started ticket holds its place");
  run("ticket", "01", "in-progress");
  assert.equal(next(), "STARTED 01-export-endpoint\nSTARTED 03-file-name\nWAIT 05-help-text: parallel_tickets is 2");
  run("ticket", "01", "done");
  assert.equal(next(), "STARTED 03-file-name\nNEXT 02-export-button\nWAIT 05-help-text: parallel_tickets is 2", "the next starts when a started one is done");
  run("ticket", "03", "done");
  run("ticket", "05", "done");
  assert.equal(next(), "NEXT 02-export-button", "04 still waits on 2, which is 02");
  run("ticket", "02", "blocked");
  assert.equal(next(), "BLOCKED 02-export-button: blocked\nBLOCKED 04-empty-state: waits on 02");
  run("ticket", "02", "done");
  assert.equal(next(), "NEXT 04-empty-state");
  run("ticket", "04", "done");
  assert.equal(next(), "DONE");

  const one = ticketsDone({ "01-export-endpoint": "none", "02-file-name": "none" }, { parallel_tickets: 1 });
  assert.equal(one.run("next-ticket").stdout.trim(), "NEXT 01-export-endpoint\nWAIT 02-file-name: parallel_tickets is 1", "one at a time when the config says so");
});

// tickets/<NN>/plan.md with `files` as its code map, and a path that only an interface names.
const plan = (s, n, files) => {
  fs.mkdirSync(path.join(s.run_dir, "tickets", n), { recursive: true });
  fs.writeFileSync(path.join(s.run_dir, "tickets", n, "plan.md"), `---\nstatus: ready\nticket: ${n}\n---\n\n# Plan ${n}\n\n## Code map\n`
    + files.map((f) => `- \`${f}\` (change): its part\n`).join("") + "\n## Interfaces\n- Consumes: `csv()` at `src/csv.js:3`\n\n## Tasks\n1. **Given** a report\n");
};

test("two tickets whose plans' code maps share a file never run at once, the one implementing or else planned first going on, and a manifest or lockfile counts as every one", () => {
  const { s, run } = ticketsDone({ "01-export-endpoint": "none", "02-export-button": "none", "03-file-name": "none", "04-help-text": "none" });
  const next = () => run("next-ticket").stdout.trim();
  const planned = (n, files) => { run("dispatch", `plan:${n}`); plan(s, n, files); run("done", `plan:${n}`); };  // as the orchestrator plans one
  for (const n of ["01", "02"]) run("ticket", n, "in-progress");
  planned("02", ["./src/csv.js", "src/button.js"]);
  planned("01", ["src/report.js", "src/csv.js"]);
  assert.equal(next(), "WAIT 01-export-endpoint: its code map shares src/csv.js with 02-export-button\nSTARTED 02-export-button\nWAIT 03-file-name: parallel_tickets is 2\nWAIT 04-help-text: parallel_tickets is 2",
    "the one planned first, which the orchestrator checked and started first, goes on");
  run("ticket", "01", "ready-for-agent");
  assert.equal(next(), "STARTED 02-export-button\nWAIT 01-export-endpoint: its code map shares src/csv.js with 02-export-button\nNEXT 03-file-name\nWAIT 04-help-text: parallel_tickets is 2",
    "a ticket that waited keeps waiting on its plan, and its slot goes to the next");
  run("ticket", "03", "in-progress");
  planned("03", ["src/name.js"]);
  assert.equal(next(), "STARTED 02-export-button\nSTARTED 03-file-name\nWAIT 01-export-endpoint: its code map shares src/csv.js with 02-export-button\nWAIT 04-help-text: parallel_tickets is 2",
    "a path only an interface names isn't in the code map");

  run("ticket", "01", "in-progress");
  run("ticket", "03", "done");
  assert.equal(run("dispatch", "implement:01").status, 0);
  const implementing = "STARTED 01-export-endpoint\nWAIT 02-export-button: its code map shares src/csv.js with 01-export-endpoint\nWAIT 04-help-text: parallel_tickets is 2";
  assert.equal(next(), implementing, "the one implementing goes on, whichever was planned first");
  assert.equal(run("dispatch", "plan:01").status, 0);
  assert.equal(next(), implementing, "a plan set aside while it's amended still counts");

  run("ticket", "02", "done");
  run("ticket", "04", "in-progress");
  plan(s, "01", ["package.json", "src/report.js"]);
  plan(s, "04", ["apps/web/pnpm-lock.yaml", "src/help.js"]);
  assert.equal(next(), "STARTED 01-export-endpoint\nWAIT 04-help-text: its code map shares package.json and the lockfile with 01-export-endpoint",
    "a new dependency touches the manifest and the lockfile");
  plan(s, "04", ["src/help.js"]);
  assert.equal(next(), "STARTED 01-export-endpoint\nSTARTED 04-help-text");
});

test("done tickets refuses tickets the frontier can't order, a cycle, a missing Status or Blocked by line, a shared number or a wait on a later ticket, and marks nothing done", () => {
  for (const [why, write, problem] of [
    ["a cycle", (s) => cut(s, { "01-endpoint": "02", "02-button": "01" }), /01-endpoint waits on 02, which doesn't come before it/],
    ["a later blocker", (s) => cut(s, { "01-endpoint": "none", "02-button": "03", "03-name": "none" }), /02-button waits on 03/],
    ["a missing blocker", (s) => cut(s, { "01-endpoint": "none", "02-button": "05" }), /02-button waits on 05/],
    ["a shared number", (s) => cut(s, { "01-endpoint": "none", "01-button": "none" }), /01-button shares its number/],
    ["no Blocked by line", (s) => { cut(s, { "01-endpoint": "none" }); fs.writeFileSync(path.join(s.run_dir, "tickets", "02-button.md"), "# button\n\nStatus: ready-for-agent\n"); }, /02-button has no `Blocked by:` line/],
    ["a status other than ready", (s) => { cut(s, { "01-endpoint": "none" }); fs.writeFileSync(path.join(s.run_dir, "tickets", "02-button.md"), "# button\n\nStatus: done\nBlocked by: 01\n"); }, /02-button isn't `Status: ready-for-agent`/],
  ]) {
    const { s, run } = specApproved();
    run("dispatch", "tickets");
    write(s);
    const r = run("done", "tickets");
    assert.equal(r.status, 2, why);
    assert.match(r.stderr, new RegExp(`the tickets of ${s.id} need cutting again: .*${problem.source}`), why);
    assert.ok(!JSON.parse(run("get").stdout).stages_done.includes("tickets"), `${why}: the stage isn't done`);
    assert.equal(run("next-ticket").status, 2, `${why}: nothing is built from them`);
    assert.equal(run("dispatch", "tickets").status, 0, `${why}: the planner cuts them again`);
  }
});
