#!/usr/bin/env node
// classify-diff.mjs — writes the run's touches.json: which touches lib's run diff fires, from the project's
// .factory/touch-rules.json (setup copies it) as the base branch's tip holds it, so no run rewrites its own, and each
// lens and check runs only when the diff earns it. Takes --run <id>, or derives the run from the run worktree it runs in.
//   - A rule's paths match the changed files as segments: one starting with / or . may start anywhere in a path (a
//     directory segment, an extension), any other only where a segment starts, so eas.json never matches ideas.json.
//     Its content patterns are case-insensitive regexes over the added lines only, lockfiles left out (design fix 9).
//   - new_env lists the environment variables the diff starts reading (below).
// Prints the touches that fired and any new variable.
import fs from "node:fs";
import path from "node:path";
import { readJson, git, runContext, runDiff, PRODUCT } from "./lib.mjs";

const TOUCHES = ["auth", "data", "migrations", "network", "files", "crypto", "config", "deps", "native", "api_contract", "ui", "tests"];
const ctx = runContext(), BASE = readJson(ctx.state).base_branch;
let rules; try { rules = JSON.parse(git(ctx.worktree, "show", `refs/heads/${BASE}:.factory/touch-rules.json`)); } catch {}
if (!rules) { console.error(`classify-diff: no .factory/touch-rules.json on ${BASE}: run /setup-factory`); process.exit(2); }
const { base, files, added } = runDiff(ctx), lines = Object.values(added).flat();

const segment = (p) => (/^[/.]/.test(p) ? p : `/${p}`).toLowerCase();
const touches = Object.fromEntries(TOUCHES.map((t) => {
  const { paths: ps = [], content = [] } = rules[t] || {};
  const paths = files.filter((f) => ps.some((p) => `/${f}`.toLowerCase().includes(segment(p))));
  const patterns = content.filter((re) => { const r = new RegExp(re, "i"); return lines.some((l) => r.test(l)); });
  return [t, { hit: paths.length > 0 || patterns.length > 0, paths: paths.slice(0, 20), patterns }];
}));

// The new-environment-variable fact: every name an added line reads that no file at the base mentions, bookkeeping aside,
// since the host needs it set before the deploy works.
// ponytail: JavaScript reads on one line only (process.env.X, ?.X, ["X"], a destructuring, import.meta.env.X); add a
//           multi-line destructuring or another language's when a project needs it.
const READS = /\b(?:process\.env(?:\?\.|\.)([A-Za-z_]\w*)|process\.env(?:\?\.)?\[\s*["'`]([A-Za-z_]\w*)["'`]\s*\]|import\.meta\.env(?:\?\.|\.)([A-Za-z_]\w*))/g;
const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*process\.env\b/g;
const reads = (l) => [...[...l.matchAll(READS)].map((m) => m[1] || m[2] || m[3]),
  ...[...l.matchAll(DESTRUCTURED)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/[\s:=]/)[0]).filter((n) => /^[A-Za-z_]\w*$/.test(n)))];
const known = (name) => { try { git(ctx.worktree, "grep", "-q", "-w", "-F", "-e", name, base, "--", ...PRODUCT); return true; } catch { return false; } };
const new_env = [...new Set(lines.flatMap(reads))].filter((n) => !known(n));

const file = path.join(ctx.runDir, "touches.json");
fs.writeFileSync(file, JSON.stringify({ base, head: git(ctx.worktree, "rev-parse", "HEAD"), files_changed: files.length, touches, new_env }, null, 2) + "\n");
console.log(`touches: ${TOUCHES.filter((t) => touches[t].hit).join(",") || "none"} files=${files.length}`
  + `${new_env.length ? `\nnew_env: ${new_env.join(",")}` : ""}\ntouches.json: ${file}`);
