#!/usr/bin/env node
// pr-comments.mjs [--run <id>] -> <run>/review-human.md (+ pr-comments.json)
// Ingests the PR's UNRESOLVED review threads and top-level review comments as a "human" lens for synthesize.mjs.
// Ids are stable (`human-r<thread root id>`, `human-v<review id>`) so a resolution recorded for one thread never shifts to another.
// Rules (fail closed): a human comment is a finding the factory must act on, never a note.
//   - a thread that ends with a question mark, or starts with "q:"/"question" -> action ask (the human wants an answer, not a change)
//   - "nit"/"nitpick"/"optional" prefix -> P3 fix; everything else -> P1 fix (blocks the merge until the thread is resolved)
//   - threads the factory itself resolved, or comments by the factory's own account, are skipped
// REST only. Review threads come from the session's CCR route (GraphQL is unavailable); falls back to flat review comments.
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const runId = arg("--run") || fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const pr = JSON.parse(fs.readFileSync(path.join(RUN, "pr.json"), "utf8"));
const sh = (c) => { try { return execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const repo = (sh("git remote get-url origin").match(/github\.com[:/]([^/]+\/[^/.]+)/) || [])[1];
const gh = (p) => { const r = spawnSync("gh", ["api", p, "--paginate"], { encoding: "utf8" }); if (r.status !== 0) return null; try { return JSON.parse(r.stdout); } catch { return null; } };
// In a solo repo the human and the factory share one login, so the factory's own posts are recognised by a marker, not by author.
const FACTORY_MARK = /<!--\s*factory\s*-->/;
const botLike = (login, body = "") => !login || /\[bot\]$/.test(login) || FACTORY_MARK.test(body);

// Flat review comments carry the bodies; the CCR review_threads route carries resolution state as
// [{resolved, outdated, path, line, comment_ids:[...]}] (no bodies). Join the two by comment id.
const flat = gh(`repos/${repo}/pulls/${pr.number}/comments`) || [];
const byId = new Map(flat.map(c => [c.id, c]));
const threads = gh(`repos/${repo}/pulls/${pr.number}/ccr/review_threads`);
let items = [];
if (Array.isArray(threads)) {
  for (const t of threads) {
    const comments = (t.comment_ids || []).map(id => byId.get(id)).filter(Boolean);
    const first = comments[0]; if (!first) continue;
    if (botLike(first.user?.login, first.body)) continue;
    // Resolved threads stay in the ledger (GitHub's thread state is the source of truth for their resolution).
    items.push({ id: `human-r${first.id}`, thread_root: first.id, resolved: !!t.resolved, outdated: !!t.outdated, author: first.user.login,
      path: t.path || first.path, line: t.line || first.line || first.original_line || 0, body: comments.map(c => c.body).join("\n---\n"), url: first.html_url });
  }
} else {
  // Fallback when the route is unavailable: "resolved" is unknown, so every non-factory thread root is a finding (fail closed).
  for (const c of flat.filter(c => !c.in_reply_to_id && !botLike(c.user?.login, c.body)))
    items.push({ id: `human-r${c.id}`, thread_root: c.id, outdated: false, author: c.user.login, path: c.path, line: c.line || c.original_line || 0, body: c.body, url: c.html_url });
}
// Top-level reviews count too: a CHANGES_REQUESTED review body is a finding at PR level; it is resolved when that reviewer's
// latest review is APPROVED (or the review was DISMISSED), because a review has no thread to resolve.
const reviews = (gh(`repos/${repo}/pulls/${pr.number}/reviews`) || []).filter(r => !botLike(r.user?.login, r.body));
const latestByUser = new Map();
for (const r of reviews) if (r.state !== "COMMENTED") latestByUser.set(r.user.login, r);
for (const r of reviews.filter(r => r.state === "CHANGES_REQUESTED" && r.body)) {
  const latest = latestByUser.get(r.user.login);
  const resolved = r.state === "DISMISSED" || (latest && latest.id !== r.id && latest.state === "APPROVED");
  items.push({ id: `human-v${r.id}`, thread_root: null, review_id: r.id, resolved, outdated: false, author: r.user.login, path: "", line: 0, body: r.body, url: r.html_url, review: true });
}
// Reviews later dismissed are resolved as well.
for (const r of reviews.filter(r => r.state === "DISMISSED" && r.body)) if (!items.some(i => i.review_id === r.id))
  items.push({ id: `human-v${r.id}`, thread_root: null, review_id: r.id, resolved: true, outdated: false, author: r.user.login, path: "", line: 0, body: r.body, url: r.html_url, review: true });

const classify = (body) => {
  const t = body.trim().split("\n---\n")[0].trim();
  const q = /\?\s*$/.test(t) || /^(q|question)\s*[:\-]/i.test(t);
  const nit = /^(nit|nitpick|optional)\b/i.test(t);
  return { action: q ? "ask" : "fix", severity: q ? "P1" : nit ? "P3" : "P1" };
};
// Threads resolved on GitHub (by the factory via pr-resolve, or by the human) are recorded as resolutions.
const resPath = path.join(RUN, "resolutions.json");
const res = fs.existsSync(resPath) ? JSON.parse(fs.readFileSync(resPath, "utf8")) : {};
for (const it of items) if (it.resolved) res[it.id] = "resolved"; else delete res[it.id];  // an unresolved (re-opened) thread is open again
fs.writeFileSync(resPath, JSON.stringify(res, null, 2) + "\n");
const open = items.filter(i => !i.resolved);
const md = ["# Human lens (PR review threads)", `PR #${pr.number} · ${open.length} unresolved of ${items.length} · generated ${new Date().toISOString()}`, ""];
for (const it of items) {
  const { action, severity } = classify(it.body);
  const claim = it.body.replace(/\n+---\n_Generated by \[Claude Code\][^\n]*/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  md.push(`- id: ${it.id}`, `  severity: ${severity}`, `  action: ${action}`, `  location: ${it.path ? `${it.path}:${it.line}` : `PR #${pr.number}`}`,
    `  claim: (@${it.author}) ${claim}`, `  evidence: ${it.url}`, `  fix: address the comment, reply on the thread with the commit SHA, then resolve the thread`, "");
}
fs.writeFileSync(path.join(RUN, "review-human.md"), md.join("\n"));
fs.writeFileSync(path.join(RUN, "pr-comments.json"), JSON.stringify({ pr: pr.number, fetched_at: new Date().toISOString(), items }, null, 2) + "\n");
console.log(`COMMENTS unresolved=${open.length} of ${items.length} ${open.map(i => `${i.id}:${classify(i.body).action}/${classify(i.body).severity}@${i.path || "PR"}`).join(" ")}`);
