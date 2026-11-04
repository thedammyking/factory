// harness.test.mjs — one self-test per harness helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { project, fakeClis, bareRemote } from "./harness.mjs";

test("project is a clean git repo with a stub recipe and config, and an ignored run dir", () => {
  const p = project({ config: { merge: "trial" } });
  assert.equal(p.git("branch", "--show-current"), "main");
  assert.equal(p.git("rev-list", "--count", "HEAD"), "1");
  assert.equal(p.git("ls-files"), ".factory/config.json\n.factory/setup.json\n.gitignore");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, ".factory/config.json"), "utf8")), { merge: "trial" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, ".factory/setup.json"), "utf8")).apps[0].name, "app");
  fs.writeFileSync(path.join(p.runDir, "state.json"), "{}");
  assert.equal(p.git("status", "--porcelain"), "", "the run dir never dirties the tree");
});

test("fake CLIs on PATH record their argv and answer from canned files", () => {
  const canned = fs.mkdtempSync(path.join(os.tmpdir(), "factory-canned-"));
  fs.writeFileSync(path.join(canned, "pulls.json"), '[{"number":7}]');
  fs.writeFileSync(path.join(canned, "merge.txt"), "not mergeable");
  const f = fakeClis({ gh: [{ match: /^api repos\/o\/r\/pulls$/, file: path.join(canned, "pulls.json") }, { match: /^pr merge/, file: path.join(canned, "merge.txt"), status: 1 }] });
  const gh = (command) => { const r = spawnSync("sh", ["-c", command], { env: f.env, encoding: "utf8" }); return [r.status, r.stdout, r.stderr]; };
  assert.deepEqual(gh("gh api repos/o/r/pulls"), [0, '[{"number":7}]', ""]);
  assert.deepEqual(gh("gh pr merge 7"), [1, "not mergeable", ""]);
  const [status, , stderr] = gh("gh issue comment 7 --body 'two words'");
  assert.equal(status, 127);
  assert.match(stderr, /fake gh: no canned reply for \["issue","comment","7","--body","two words"\]/);
  assert.deepEqual(f.calls("gh"), [["api", "repos/o/r/pulls"], ["pr", "merge", "7"], ["issue", "comment", "7", "--body", "two words"]]);
});

test("a fake CLI's rule with a list of files answers its n-th call with the n-th, then the last", () => {
  const canned = fs.mkdtempSync(path.join(os.tmpdir(), "factory-canned-"));
  const [a, b] = ["a", "b"].map((n) => { fs.writeFileSync(path.join(canned, n), n); return path.join(canned, n); });
  const f = fakeClis({ gh: [{ match: /^api x$/, file: [a, b] }, { match: /^api/, file: a }] });
  const gh = (args) => spawnSync("gh", args, { env: f.env, encoding: "utf8" }).stdout;
  assert.deepEqual([gh(["api", "x"]), gh(["api", "y"]), gh(["api", "x"]), gh(["api", "x"])], ["a", "a", "b", "b"]);
});

test("bareRemote is origin and takes the project's pushes", () => {
  const p = project();
  const remote = bareRemote(p);
  const remoteRev = (ref) => spawnSync("git", ["--git-dir", remote, "rev-parse", ref], { encoding: "utf8" }).stdout.trim();
  assert.equal(remoteRev("main"), p.git("rev-parse", "HEAD"));
  p.git("checkout", "-q", "-b", "factory/r1");
  fs.writeFileSync(path.join(p.dir, "app.js"), "1\n");
  p.git("add", "."); p.git("commit", "-qm", "change");
  p.git("push", "-q", "origin", "factory/r1");
  assert.equal(remoteRev("factory/r1"), p.git("rev-parse", "HEAD"));
});
