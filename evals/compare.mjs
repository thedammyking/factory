#!/usr/bin/env node
// compare.mjs [aggregate-result.json] — an eval result next to the last committed release: each case's score and mean
// cost per eval run, a mark on any case more than 20% dearer, and both results' Claude Code versions and pinned models.
// It only reports and always exits 0: the human judges a rise. With no argument, it takes the newest result in results/.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EVALS = path.dirname(fileURLToPath(import.meta.url));
const parse = (text, name) => { try { return { label: name, ...JSON.parse(text) }; } catch { return null; } };
const newest = (results) => results.filter(Boolean).sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")))[0];
const dirName = (file) => path.basename(path.dirname(file));
const git = (...a) => execFileSync("git", a, { cwd: EVALS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// The release is the newest aggregate-result.json committed under results/, as committed, other than the result itself.
function release(result) {
  let tracked = [];
  try { tracked = git("ls-files", "-z", "--", "results").split("\0").filter((f) => f.endsWith("/aggregate-result.json")); } catch {}
  return newest(tracked.map((f) => {
    try { return parse(git("show", `HEAD:./${f}`), dirName(f)); } catch { return null; }
  }).filter((r) => r && r.startedAt !== result.startedAt));
}

function latest() {
  const dir = path.join(EVALS, "results");
  return newest((fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((d) => path.join(dir, d, "aggregate-result.json"))
    .filter((f) => fs.existsSync(f)).map((f) => parse(fs.readFileSync(f, "utf8"), dirName(f))));
}

// Each case's score and its mean cost per eval run; a run's costUsd already includes its judge calls.
const cases = (r) => new Map((r?.cases || []).map((c) => {
  const runs = c.arms?.with || [];
  return [c.name, { score: c.aggregates?.score, cost: runs.length ? runs.reduce((s, x) => s + (x.costUsd || 0), 0) / runs.length : null }];
}));
const score = (c) => (typeof c?.score === "number" ? c.score.toFixed(2) : "-");
const usd = (c) => (typeof c?.cost === "number" ? `$${c.cost.toFixed(4)}` : "-");
const header = (name, r) => `${name.padEnd(8)} ${String(r.label).padEnd(26)} claude ${r.claudeVersion ?? "?"}  `
  + `model ${r.suite?.modelOverride ?? "unpinned"}  judge ${r.suite?.judgeModel ?? "unpinned"}${r.partial ? "  (partial)" : ""}`;

try {
  const arg = process.argv[2];
  const result = arg ? fs.existsSync(arg) && parse(fs.readFileSync(arg, "utf8"), dirName(path.resolve(arg))) : latest();
  if (!result) console.log(arg ? `compare: ${arg} isn't a readable eval result` : "compare: no eval result in results/; run the evals first");
  else {
    const rel = release(result);
    console.log(header("result", result));
    console.log(rel ? header("release", rel) : "release  none committed yet");
    console.log(`\n${"case".padEnd(28)} ${"score".padEnd(6)} ${"cost/run".padEnd(10)} ${"release".padEnd(7)} cost/run`);
    const ours = cases(result), theirs = cases(rel);
    for (const name of new Set([...ours.keys(), ...theirs.keys()])) {
      const a = ours.get(name), b = theirs.get(name);
      const dearer = a?.cost > 0 && b?.cost > 0 && a.cost > b.cost * 1.2 ? `  +${Math.round((a.cost / b.cost - 1) * 100)}% dearer` : "";
      console.log(`${name.padEnd(28)} ${score(a).padEnd(6)} ${usd(a).padEnd(10)} ${score(b).padEnd(7)} ${usd(b)}${dearer}`);
    }
  }
} catch (e) {
  console.log(`compare: ${e.message}`);
}
