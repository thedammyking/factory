#!/usr/bin/env node
// review-package.mjs — writes the run's review.diff, what every lens reads: the commits, the files changed, then the diff
// at -U10, all of lib's run diff (from the merge base of HEAD and the recorded base, never HEAD~1, without the factory's
// bookkeeping). A lockfile is listed among the files changed but never diffed. Takes --run <id>, or derives the run from
// the run worktree it runs in.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { git, runContext, runBase, PRODUCT, LOCKFILES } from "./lib.mjs";

const ctx = runContext(), base = runBase(ctx), head = git(ctx.worktree, "rev-parse", "HEAD");
const file = path.join(ctx.runDir, "review.diff"), fd = fs.openSync(file, "w");
const section = (title, ...args) => {
  fs.writeSync(fd, `# ${title}\n`);
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: ctx.worktree, stdio: ["ignore", fd, "pipe"] });
  fs.writeSync(fd, "\n");
};
section(`Commits ${base.slice(0, 7)}..${head.slice(0, 7)}`, "log", "--oneline", "--no-decorate", "--no-color", `${base}..HEAD`, "--", ...PRODUCT);
section("Files changed", "diff", "--stat=200", "--no-color", base, "HEAD", "--", ...PRODUCT);
section("Diff", "diff", "-U10", "--no-color", "--no-ext-diff", "--no-textconv", base, "HEAD", "--", ...PRODUCT, ...LOCKFILES);
fs.closeSync(fd);
console.log(`review.diff: ${file} (${fs.readFileSync(file, "utf8").split("\n").length - 1} lines)`);
