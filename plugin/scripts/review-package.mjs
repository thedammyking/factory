#!/usr/bin/env node
// review-package.mjs — writes the run's review.diff, what every lens reads: the commits, the files changed, then the diff
// at -U10, all of lib's run diff (from the merge base of HEAD and the recorded base, never HEAD~1, without the factory's
// bookkeeping). A lockfile is listed among the files changed but never diffed. Takes --run <id>, or derives the run from
// the run worktree it runs in. With --since <sha> it writes review-fix.diff instead, the same from that commit: a review
// fix round's own diff, which the lenses re-review.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { arg, git, runContext, runBase, PRODUCT, LOCKFILES } from "./lib.mjs";

const since = arg("--since");
if (since && !/^[0-9a-f]{7,64}$/.test(since)) { console.error("review-package: --since takes a commit SHA"); process.exit(2); }
const ctx = runContext(), base = since ? git(ctx.worktree, "rev-parse", "--verify", `${since}^{commit}`) : runBase(ctx), head = git(ctx.worktree, "rev-parse", "HEAD");
const file = path.join(ctx.runDir, since ? "review-fix.diff" : "review.diff"), fd = fs.openSync(file, "w");
const section = (title, ...args) => {
  fs.writeSync(fd, `# ${title}\n`);
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: ctx.worktree, stdio: ["ignore", fd, "pipe"] });
  fs.writeSync(fd, "\n");
};
section(`Commits ${base.slice(0, 7)}..${head.slice(0, 7)}`, "log", "--oneline", "--no-decorate", "--no-color", `${base}..HEAD`, "--", ...PRODUCT);
section("Files changed", "diff", "--stat=200", "--no-color", base, "HEAD", "--", ...PRODUCT);
section("Diff", "diff", "-U10", "--no-color", "--no-ext-diff", "--no-textconv", base, "HEAD", "--", ...PRODUCT, ...LOCKFILES);
fs.closeSync(fd);
console.log(`${path.basename(file)}: ${file} (${fs.readFileSync(file, "utf8").split("\n").length - 1} lines)`);
