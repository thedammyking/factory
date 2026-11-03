// compare.test.mjs — evals/compare.mjs spawned as a process in a throwaway project holding committed releases.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project } from "./harness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../evals/compare.mjs");
// An aggregate-result.json whose cases each ran twice at the given cost per run, the second run's cost including a judge.
const result = (startedAt, claudeVersion, model, costs) => JSON.stringify({
  schemaVersion: 1, claudeVersion, startedAt, suite: { modelOverride: model, judgeModel: "claude-haiku-5-5" },
  cases: Object.entries(costs).map(([name, cost]) => ({
    name, aggregates: { score: 1 }, arms: { with: [{ costUsd: cost, judgeCostUsd: 0 }, { costUsd: cost, judgeCostUsd: cost / 2 }] },
  })),
});
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const withCompare = () => { const p = project(); fs.mkdirSync(path.join(p.dir, "evals")); fs.copyFileSync(SCRIPT, path.join(p.dir, "evals/compare.mjs")); return p; };
const compare = (cwd, ...args) => spawnSync(process.execPath, [path.join(cwd, "evals/compare.mjs"), ...args], { cwd, encoding: "utf8" });
const row = (stdout, name) => stdout.split("\n").find((l) => l.startsWith(`${name} `));

test("compares the newest result with the newest committed release, marking a case more than 20% dearer", () => {
  const p = withCompare();
  write(p.dir, "evals/results/0.1.0/aggregate-result.json", result("2026-10-01T00:00:00Z", "2.1.300", "claude-haiku-4-5", { a: 0.05 }));
  write(p.dir, "evals/results/0.2.0/aggregate-result.json", result("2026-11-01T00:00:00Z", "2.1.317", "claude-haiku-5-5", { a: 0.1, b: 0.1, gone: 0.1 }));
  p.git("add", "."); p.git("commit", "-qm", "releases");
  // Not committed: the newest result is the one compared; an edited release copy and a result without startedAt are not.
  write(p.dir, "evals/results/2026-11-02T00-00-00-000Z/aggregate-result.json", result("2026-11-02T00:00:00Z", "2.1.316", "claude-haiku-5-5", {}));
  write(p.dir, "evals/results/2026-11-03T00-00-00-000Z/aggregate-result.json", result("2026-11-03T00:00:00Z", "2.1.400", "claude-haiku-5-5", { a: 0.13, b: 0.11, fresh: 0.2 }));
  write(p.dir, "evals/results/undated/aggregate-result.json", JSON.stringify({ cases: [] }));
  write(p.dir, "evals/results/0.2.0/aggregate-result.json", "edited, not committed");

  let r = compare(p.dir);
  assert.equal(r.status, 0, r.stderr);
  const [first, second] = r.stdout.split("\n");
  assert.match(first, /^result +2026-11-03T00-00-00-000Z +claude 2\.1\.400 +model claude-haiku-5-5 +judge claude-haiku-5-5$/);
  assert.match(second, /^release +0\.2\.0 +claude 2\.1\.317 +model claude-haiku-5-5 +judge claude-haiku-5-5$/);
  assert.match(row(r.stdout, "a"), /^a +1\.00 +\$0\.1300 +1\.00 +\$0\.1000 +\+30% dearer$/, "a run's judge cost is already in its costUsd");
  assert.match(row(r.stdout, "b"), /^b +1\.00 +\$0\.1100 +1\.00 +\$0\.1000$/, "10% dearer is not marked");
  assert.match(row(r.stdout, "fresh"), /^fresh +1\.00 +\$0\.2000 +- +-$/);
  assert.match(row(r.stdout, "gone"), /^gone +- +- +1\.00 +\$0\.1000$/);

  // The release itself, given as the argument, is compared with the release before it.
  p.git("checkout", "-q", "--", "evals/results/0.2.0/aggregate-result.json");
  r = compare(p.dir, "evals/results/0.2.0/aggregate-result.json");
  assert.match(r.stdout, /^result +0\.2\.0 .*\nrelease +0\.1\.0 +claude 2\.1\.300 +model claude-haiku-4-5 /);
  assert.match(row(r.stdout, "a"), /^a +1\.00 +\$0\.1000 +1\.00 +\$0\.0500 +\+100% dearer$/);
});

test("never fails: no result, no release, an unreadable result or a missing file all exit 0", () => {
  const p = withCompare();
  let r = compare(p.dir);
  assert.deepEqual([r.status, r.stdout.trim()], [0, "compare: no eval result in results/; run the evals first"]);

  write(p.dir, "evals/results/2026-11-03T00-00-00-000Z/aggregate-result.json", result("2026-11-03T00:00:00Z", "2.1.400", "claude-haiku-5-5", { a: 0.1 }));
  r = compare(p.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^release +none committed yet$/m);
  assert.match(row(r.stdout, "a"), /^a +1\.00 +\$0\.1000 +- +-$/);

  write(p.dir, "broken.json", "{");
  for (const arg of ["broken.json", "missing.json"]) {
    r = compare(p.dir, arg);
    assert.deepEqual([r.status, r.stdout.trim()], [0, `compare: ${arg} isn't a readable eval result`]);
  }
});
