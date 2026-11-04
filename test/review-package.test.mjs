// review-package.test.mjs — review-package.mjs spawned as a process against a run on a throwaway project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { project, script, startRun } from "./harness.mjs";

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("review.diff holds every commit since the recorded base at -U10 with the files changed, the recipe in and the factory's bookkeeping out", () => {
  const p = project();
  const run = startRun(p, { "src/long.txt": LINES, "package-lock.json": "{}\n" });
  run.commit({ "src/a.ts": "export const a = 1;\n" }, "add a");
  run.commit({
    "src/long.txt": LINES.replace("line 15\n", "line fifteen\n"),
    "package-lock.json": '{ "lockfileVersion": 3 }\n',
    ".factory/setup.json": '{ "apps": [] }\n',
    ".factory/log.md": "- run: other delivered\n",
    ".factory/history/other/state.json": "{}\n",
  }, "rename line 15");
  const r = script("review-package.mjs", p.dir, ["--run", run.id]);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(run.run_dir, "review.diff");
  assert.match(r.stdout, new RegExp(`review\\.diff: ${file.replace(/[.\\]/g, "\\$&")}`));
  const diff = fs.readFileSync(file, "utf8");
  const [commits, changed, body] = diff.split(/^# (?:Commits.*|Files changed|Diff)\n/m).slice(1);
  assert.match(diff, new RegExp(`^# Commits ${run.base_sha.slice(0, 7)}\\.\\.${run.git("rev-parse", "--short=7", "HEAD")}$`, "m"));
  assert.deepEqual(commits.trim().split("\n").map((l) => l.replace(/^\w+ /, "")), ["rename line 15", "add a"], "never only HEAD~1");
  assert.deepEqual(changed.trim().split("\n").slice(0, -1).map((l) => l.split("|")[0].trim()),
    [".factory/setup.json", "package-lock.json", "src/a.ts", "src/long.txt"], "the lockfile is listed, the bookkeeping isn't");
  assert.deepEqual([...body.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), [".factory/setup.json", "src/a.ts", "src/long.txt"], "a lockfile is never diffed");
  assert.match(body, /^ line 5\n( line \d+\n){9}-line 15\n\+line fifteen\n( line \d+\n){9} line 25\n$/m, "ten lines of context either side");
  assert.doesNotMatch(body, /^ line 4$/m);
});
