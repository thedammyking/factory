// repo.test.mjs — checks on the repo itself rather than on any script.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plugin/LICENSE is byte-identical to LICENSE", () => {
  assert.ok(fs.readFileSync(path.join(ROOT, "LICENSE")).equals(fs.readFileSync(path.join(ROOT, "plugin/LICENSE"))), "plugin/LICENSE differs from LICENSE");
});

// Tracked and untracked files alike, minus what .gitignore drops (reference/, other worktrees).
test("no SKILL.md is 20 KB or more", () => {
  const ls = spawnSync("git", ["ls-files", "-co", "--exclude-standard", ":(glob)**/SKILL.md"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(ls.status, 0, ls.stderr);
  const big = ls.stdout.split("\n").filter(Boolean)
    .map((f) => [f, fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false })?.size ?? 0])
    .filter(([, bytes]) => bytes >= 20 * 1024);
  assert.deepEqual(big, [], "SKILL.md files of 20 KB or more, as [path, bytes]");
});
