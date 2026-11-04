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

// synthesize.mjs parses this schema, so each lens states it word for word: its section runs to the next ## heading.
test("the finding schema is identical across the three reviewer files", () => {
  const schema = (lens) => fs.readFileSync(path.join(ROOT, `plugin/agents/reviewer-${lens}.md`), "utf8").match(/^## Finding schema\n[\s\S]*?(?=^## )/m)?.[0];
  const [code, ...others] = ["code", "ui", "security"].map(schema);
  assert.match(code ?? "", /^- id: <lens>-NN\n  severity: P0 \| P1 \| P2 \| P3\n  action: fix \| ask \| note\n  location: .+\n  claim: .+\n  evidence: .+\n  fix: .+\n  cwe: .+\n/m);
  assert.match(code, /status: closed/);
  assert.match(code, /`verdict: approve \| needs-fixes \| block`/);
  for (const [lens, text] of [["ui", others[0]], ["security", others[1]]]) assert.equal(text, code, `reviewer-${lens}.md's finding schema differs from reviewer-code.md's`);
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
