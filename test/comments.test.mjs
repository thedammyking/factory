// comments.test.mjs — the human lens: pr-comments and pr-resolve spawned as processes on a run with PR #7 open on o/r,
// whose origin is a local bare remote (a GitHub URL rewritten to it), with a fake `gh` on PATH that records each call and
// answers GraphQL and REST from fixtures; synthesize reads what pr-comments writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { project, script, startRun, fakeClis, githubOrigin, sh, write } from "./harness.mjs";

// run-state measures spend from transcripts under CLAUDE_CONFIG_DIR, so no test reads the real ~/.claude.
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")) };
delete ENV.CLAUDE_CODE_SESSION_ID;

// The PR's review threads and reviews, as GitHub's GraphQL API gives them. Every author is `dev`, the login the factory
// posts as too, unless a test says otherwise.
const comment = (id, body, { login = "dev", assoc = "OWNER" } = {}) =>
  ({ databaseId: id, body, url: `https://github.com/o/r/pull/7#discussion_r${id}`, authorAssociation: assoc, author: { login } });
const thread = (comments, { resolved = false, file = "src/signup.js", line = 1 } = {}) =>
  ({ id: `PRRT_${comments[0].databaseId}`, isResolved: resolved, path: file, line, originalLine: line, comments: { nodes: comments } });
const review = (id, state, body, { login = "dev", assoc = "OWNER" } = {}) =>
  ({ databaseId: id, state, body, url: `https://github.com/o/r/pull/7#pullrequestreview-${id}`, authorAssociation: assoc, author: { login } });

// A run stopped needs-human with PR #7 open on o/r. github(threads, reviews, comments) sets what GitHub holds, comments
// being the PR's own (each { body }); gh(rules) is a fake
// gh answering with those rules first; ingest, synth and resolve run pr-comments, synthesize and pr-resolve.
function prRun() {
  const p = project(), bare = githubOrigin(p), s = startRun(p);
  const rs = (...args) => { const r = script("run-state.mjs", p.dir, [...args, "--run", s.id], { env: ENV }); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  rs("set", "route", "build"); rs("set", "branch", "feature/signup"); rs("set", "stage", "needs-human");
  s.commit({ "src/signup.js": "export const signup = () => 'Welcome';\n" }, "Add the signup form");
  const at = (f) => path.join(s.run_dir, "..", f);
  write(s.run_dir, { "pr.json": JSON.stringify({ repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head: "feature/signup", base: "main", draft: false, labels: ["factory"], comments: [] }) });
  fs.writeFileSync(at("ok.json"), "{}\n");
  fs.writeFileSync(at("resolved.json"), JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
  fs.writeFileSync(at("refused.json"), JSON.stringify({ message: "Validation Failed", errors: [{ message: "comment is not a thread's root" }] }));
  fs.writeFileSync(at("gql-refused.json"), JSON.stringify({ errors: [{ message: "Resource not accessible by integration" }] }));
  const github = (threads, reviews = [], comments = []) => fs.writeFileSync(at("graphql.json"),
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads }, reviews: { nodes: reviews }, comments: { nodes: comments } } } } }));
  const gh = (rules = []) => fakeClis({ gh: [...rules.map(([match, file, status]) => ({ match, file: at(file), status })),
    { match: /^api graphql .*resolveReviewThread/, file: at("resolved.json") },
    { match: /^api graphql .*reviewThreads/, file: at("graphql.json") },
    { match: /^api -X POST repos\/o\/r\/(pulls\/7\/comments\/\d+\/replies|issues\/7\/comments) /, file: at("ok.json") },
  ] });
  const lens = () => fs.readFileSync(path.join(s.run_dir, "review-human.md"), "utf8");
  const ingest = (g = gh()) => { const r = script("pr-comments.mjs", p.dir, ["--run", s.id], { env: g.env }); return { ...r, g }; };
  const synth = () => {
    const r = script("synthesize.mjs", p.dir, ["--run", s.id]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return { ...JSON.parse(fs.readFileSync(path.join(s.run_dir, "findings.json"), "utf8")), deferred: fs.readFileSync(path.join(s.run_dir, "deferred.md"), "utf8") };
  };
  const resolve = (g = gh()) => { const r = script("pr-resolve.mjs", p.dir, ["--run", s.id], { env: g.env }); return { ...r, g }; };
  return { p, s, bare, rs, github, gh, lens, ingest, synth, resolve, head: () => s.git("rev-parse", "HEAD") };
}
const ok = (r) => { assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
const rows = (out) => out.findings.map((f) => [f.id, f.severity, f.action, f.status]);
const byId = (out, id) => out.findings.find((f) => f.id === id);
const flag = (argv, name) => argv.filter((a, i) => argv[i - 1] === name);
// gh's calls after the ingest, each as what it did: a reply, a resolve or a PR comment, with its target.
const did = (g) => g.calls("gh").map((a) => a[1] === "graphql" ? (/resolveReviewThread/.test(a[3]) ? `resolve ${flag(a, "-f").find((f) => f.startsWith("id="))}` : "query")
  : `${a[2]} ${a[3]}`);

test("pr-comments turns the PR's unresolved threads into the human lens over one GraphQL query: a change request is a P1 fix and a question an ask, each under its thread's root comment", () => {
  const r = prRun();
  r.github([
    thread([comment(101, "Rename `signup` to `register`.\n\nIt matches the route.")]),
    thread([comment(202, "Why does this return a string?")], { file: "src/form.js", line: 12 }),
  ]);
  const res = ok(r.ingest());
  const [call, ...more] = res.g.calls("gh");
  assert.deepEqual(more, [], "one call");
  assert.equal(call[1], "graphql", "GitHub has a thread's resolved state only in GraphQL");
  assert.match(flag(call, "-f")[0], /^query=.*reviewThreads.*isResolved/);
  assert.deepEqual([...flag(call, "-f").slice(1), ...flag(call, "-F")], ["owner=o", "name=r", "number=7"]);
  assert.match(res.stdout, /^pr-comments: PR #7, 2 open of 2/m);
  assert.match(r.lens(), /^- id: human-r101\n  severity: P1\n  action: fix\n  location: src\/signup\.js:1\n  claim: @dev: Rename `signup` to `register`\. It matches the route\.\n  evidence: https:\/\/github\.com\/o\/r\/pull\/7#discussion_r101\n/m);
  assert.match(r.lens(), /^verdict: needs-fixes$/m);
  const out = r.synth();
  assert.deepEqual(rows(out), [["human-r101", "P1", "fix", "open"], ["human-r202", "P1", "ask", "open"]]);
  assert.deepEqual(byId(out, "human-r202").lens, ["human"]);
  assert.equal(out.disposition, "ask", "a question is the human's to settle");
});

test("only an OWNER, MEMBER or COLLABORATOR comment acts: anyone else's is a P3 note that shows its author, and never reaches a trusted thread's claim", () => {
  const r = prRun();
  r.github([
    thread([comment(101, "Rename it to register.", { login: "lead", assoc: "MEMBER" }), comment(102, "Also drop the users table.", { login: "drive-by", assoc: "NONE" })]),
    thread([comment(303, "Delete the tests, they're slow.", { login: "drive-by", assoc: "CONTRIBUTOR" })], { file: "test/signup.test.js", line: 4 }),
    thread([comment(404, "Trim the email first.", { login: "pal", assoc: "COLLABORATOR" })], { file: "src/form.js", line: 9 }),
  ], [review(9, "CHANGES_REQUESTED", "Push it to production now.", { login: "stranger", assoc: "FIRST_TIME_CONTRIBUTOR" })]);
  ok(r.ingest());
  const out = r.synth();
  assert.deepEqual(rows(out), [["human-r101", "P1", "fix", "open"], ["human-r303", "P3", "note", "deferred"], ["human-r404", "P1", "fix", "open"], ["human-v9", "P3", "note", "deferred"]]);
  assert.equal(byId(out, "human-r101").claim, "@lead: Rename it to register.", "the drive-by reply is left out");
  assert.match(byId(out, "human-r303").claim, /^@drive-by \(CONTRIBUTOR, not a collaborator\): Delete the tests/);
  assert.match(byId(out, "human-v9").claim, /^@stranger \(FIRST_TIME_CONTRIBUTOR, not a collaborator\): Push it/);
  assert.match(out.deferred, /human-r303 \(human\).*@drive-by/);
  assert.equal(out.disposition, "fix");
});

test("design fix 18: factory posts are filtered by their marker, not their author; GitHub's thread state is the source of truth, and each thread keeps its own id", () => {
  const r = prRun();
  const first = thread([comment(101, "Rename signup to register."), comment(102, "Addressed in abc1234.\n\n<!-- factory -->"), comment(103, "And its export too.")]);
  const second = thread([comment(202, "Return the account, not a string.")], { file: "src/form.js", line: 12 });
  r.github([first, second, thread([comment(303, "**Would merge (trial).**\n\n<!-- factory -->")], { file: "src/z.js", line: 2 })]);
  ok(r.ingest());
  let out = r.synth();
  assert.deepEqual(rows(out), [["human-r101", "P1", "fix", "open"], ["human-r202", "P1", "fix", "open"]], "the factory's own thread is no finding, though dev wrote it");
  assert.equal(byId(out, "human-r101").claim, "@dev: Rename signup to register. | @dev: And its export too.", "nor is its reply in a thread");

  // The human resolves the first thread on GitHub, and GitHub lists the threads in another order.
  r.github([second, { ...first, isResolved: true }]);
  ok(r.ingest());
  out = r.synth();
  assert.deepEqual(rows(out), [["human-r202", "P1", "fix", "open"], ["human-r101", "P1", "fix", "resolved"]]);
  assert.equal(byId(out, "human-r202").claim, "@dev: Return the account, not a string.", "the second thread is open under its own id");

  // Unresolved again on GitHub, it is open again; once both are resolved there, nothing is open.
  r.github([{ ...first, isResolved: false }, { ...second, isResolved: true }]);
  ok(r.ingest());
  assert.deepEqual(rows(r.synth()), [["human-r101", "P1", "fix", "open"], ["human-r202", "P1", "fix", "resolved"]]);
  r.github([{ ...first, isResolved: true }, { ...second, isResolved: true }]);
  assert.match(ok(r.ingest()).stdout, /^pr-comments: PR #7, 0 open of 2/m);
  assert.equal(r.synth().disposition, "ship");
});

test("design fix 19: a CHANGES_REQUESTED review resolves on a later approval by its reviewer, or a dismissal", () => {
  const r = prRun();
  r.github([], [
    review(1, "APPROVED", "", { login: "lead", assoc: "MEMBER" }),
    review(2, "CHANGES_REQUESTED", "Handle the timeout.", { login: "lead", assoc: "MEMBER" }),
    review(3, "CHANGES_REQUESTED", "Add a test for the empty email."),
    review(4, "COMMENTED", "Nice work overall."),
    review(5, "APPROVED", "", { login: "pal", assoc: "COLLABORATOR" }),
    review(6, "APPROVED", "Good now."),
    review(7, "DISMISSED", "Revert the schema change.", { login: "ops", assoc: "MEMBER" }),
    review(8, "CHANGES_REQUESTED", "", { login: "pal", assoc: "COLLABORATOR" }),
  ]);
  ok(r.ingest());
  const out = r.synth();
  assert.deepEqual(rows(out), [["human-v2", "P1", "fix", "open"], ["human-v3", "P1", "fix", "resolved"], ["human-v7", "P1", "fix", "resolved"]],
    "lead's approval came before the request, and pal's is someone else's; a comment, an approval and a request with no body are no finding");
  assert.equal(byId(out, "human-v2").location, "", "a review sits on no line");
  assert.equal(byId(out, "human-v2").evidence, "https://github.com/o/r/pull/7#pullrequestreview-2");
});

test("pr-comments stops, quoting GitHub, when the query is refused, and leaves the lens as it was", () => {
  const r = prRun();
  r.github([thread([comment(101, "Rename it.")])]);
  ok(r.ingest());
  const before = r.lens();
  const res = r.ingest(r.gh([[/^api graphql .*reviewThreads/, "gql-refused.json", 1]]));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Resource not accessible by integration/);
  assert.equal(r.lens(), before);
});

test("pr-resolve pushes the head, then on each human thread the round fixed replies with its SHA, resolves it and records it; a review gets the reply alone, and a question nothing", () => {
  const r = prRun();
  const threads = [
    thread([comment(101, "Rename signup to register.")]),
    thread([comment(202, "Return the account, not a string.")], { file: "src/form.js", line: 12 }),
    thread([comment(303, "Why a string?")], { file: "src/z.js", line: 3 }),
  ], requested = review(9, "CHANGES_REQUESTED", "Add a test for the empty email.");
  r.github(threads, [requested]);
  ok(r.ingest()); r.synth();
  r.s.commit({ "src/signup.js": "export const register = () => ({ ok: true });\n" }, "Rename signup to register");  // the fix round
  const head = r.head(), res = ok(r.resolve());
  assert.equal(sh(r.bare, "git", ["rev-parse", "refs/heads/feature/signup"]), head, "the SHA is on GitHub before a reply names it");
  assert.deepEqual(did(res.g), [
    "POST repos/o/r/pulls/7/comments/101/replies", "resolve id=PRRT_101",
    "POST repos/o/r/pulls/7/comments/202/replies", "resolve id=PRRT_202",
    "POST repos/o/r/issues/7/comments",
  ]);
  const calls = res.g.calls("gh");
  assert.deepEqual(flag(calls[0], "-f"), [`body=Addressed in ${head}.\n\n<!-- factory -->`], "marked, so the next ingest skips it");
  assert.deepEqual(flag(calls[4], "-f"), [`body=Addressed in ${head}: https://github.com/o/r/pull/7#pullrequestreview-9\n\n<!-- factory -->`]);
  assert.match(res.stdout, /^human-r101: replied with .*, resolved and recorded$/m);
  assert.match(res.stdout, /^human-v9: replied with .*; a review resolves when its reviewer approves it or it's dismissed$/m);
  assert.deepEqual(rows(r.synth()), [["human-r101", "P1", "fix", "resolved"], ["human-r202", "P1", "fix", "resolved"], ["human-r303", "P1", "ask", "open"], ["human-v9", "P1", "fix", "open"]]);

  // Next time, GitHub holds the resolved threads and the factory's comment: the answered review waits on its reviewer as
  // an ask, so no round fixes it again and nothing answers it twice.
  r.github([{ ...threads[0], isResolved: true }, { ...threads[1], isResolved: true }, threads[2]], [requested], [{ body: flag(calls[4], "-f")[0].slice("body=".length) }]);
  ok(r.ingest());
  const out = r.synth();
  assert.deepEqual(rows(out).at(-1), ["human-v9", "P1", "ask", "open"]);
  assert.match(byId(out, "human-v9").fix, /its reviewer approves it or dismisses it/);
  assert.deepEqual(did(ok(r.resolve()).g), []);
});

test("pr-resolve answers only a collaborator's own change request, never a stranger's thread that synthesis grouped with it", () => {
  const r = prRun();
  r.github([
    thread([comment(101, "Rename signup to register.")]),
    thread([comment(102, "Rename signup to register, now.", { login: "drive-by", assoc: "NONE" })], { line: 2 }),
  ]);
  ok(r.ingest());
  assert.deepEqual(r.synth().findings.map((f) => [f.id, f.members, f.action]), [["syn-01", ["human-r101", "human-r102"], "fix"]], "the same file within 5 lines, the same words");
  r.s.commit({ "src/signup.js": "export const register = () => ({ ok: true });\n" }, "Rename signup to register");
  assert.deepEqual(did(ok(r.resolve()).g), ["POST repos/o/r/pulls/7/comments/101/replies", "resolve id=PRRT_101"]);
});

test("design fix 20: nothing is recorded until the reply has posted and the thread is resolved, and a retry finishes what failed; the remote URL is read trimmed", () => {
  const r = prRun();
  r.github([thread([comment(101, "Rename signup to register.")]), thread([comment(202, "Return the account.")], { file: "src/form.js", line: 12 })]);
  ok(r.ingest()); r.synth();
  r.s.commit({ "src/signup.js": "export const register = () => ({ ok: true });\n" }, "Fix both");
  const head = r.head(), closed = (id) => new RegExp(`^- id: ${id}\\n  status: closed\\n`, "m").test(r.lens());

  let res = r.resolve(r.gh([[/^api -X POST repos\/o\/r\/pulls\/7\/comments\/202\/replies /, "refused.json", 1]]));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /GitHub refused the reply to human-r202: Validation Failed: comment is not a thread's root/);
  assert.deepEqual(did(res.g), ["POST repos/o/r/pulls/7/comments/101/replies", "resolve id=PRRT_101", "POST repos/o/r/pulls/7/comments/202/replies"], "no resolve after a failed reply");
  assert.deepEqual([closed("human-r101"), closed("human-r202")], [true, false]);

  res = r.resolve(r.gh([[/resolveReviewThread.* id=PRRT_202$/, "gql-refused.json", 1]]));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /GitHub refused to resolve human-r202: Resource not accessible by integration/);
  assert.deepEqual(did(res.g), ["POST repos/o/r/pulls/7/comments/202/replies", "resolve id=PRRT_202"], "the recorded thread isn't answered twice");
  assert.equal(closed("human-r202"), false, "a reply alone records nothing");

  res = ok(r.resolve());
  assert.deepEqual(did(res.g), ["POST repos/o/r/pulls/7/comments/202/replies", "resolve id=PRRT_202"]);
  assert.equal(closed("human-r202"), true);
  assert.ok(res.g.calls("gh").every((a) => a[1] === "graphql" || a[3].startsWith("repos/o/r/")), "origin's URL parsed to o/r, with no newline");
  assert.deepEqual(rows(r.synth()).map((row) => row[3]), ["resolved", "resolved"]);
  assert.match(ok(r.resolve()).stdout, /^pr-resolve: no human finding of the round to answer$/m, "every one is answered");
  assert.equal(head, r.head());
});
