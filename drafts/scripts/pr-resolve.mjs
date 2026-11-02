#!/usr/bin/env node
// pr-resolve.mjs <finding-id> --sha <sha> [--message "<text>"] [--run <id>]
// Closes the loop on one human-lens finding: replies on the review thread (what changed, the commit SHA, tagged with the
// factory marker so pr-comments.mjs never re-ingests it), resolves the thread (GraphQL resolveReviewThread, or the cloud
// session proxy's ccr/ route where GraphQL is blocked), and
// records the resolution in resolutions.json so synthesize.mjs marks the finding resolved. Never resolves an `ask`:
// the human answers those, and the factory only replies.
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { runContext, arg } from "./lib.mjs";

const { ROOT, RUN } = runContext();
const id = process.argv[2];
const pr = JSON.parse(fs.readFileSync(path.join(RUN, "pr.json"), "utf8"));
const items = JSON.parse(fs.readFileSync(path.join(RUN, "pr-comments.json"), "utf8")).items;
const it = items.find(i => i.id === id);
if (!it) { console.error(`no human finding ${id} in pr-comments.json`); process.exit(2); }
const sha = arg("--sha") || execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
const repo = (execSync("git remote get-url origin", { cwd: ROOT, encoding: "utf8" }).trim().match(/github\.com[:/]([^/\s]+\/[^/.\s]+)/) || [])[1];
const isAsk = /\?\s*$/.test(it.body.split("\n---\n")[0].trim()) || /^(q|question)\s*[:\-]/i.test(it.body.trim());
const message = arg("--message") || (isAsk ? "" : `Addressed in ${sha.slice(0, 7)}.`);
if (!message) { console.error(`${id} is a question: pass --message with the answer (the human resolves the thread)`); process.exit(2); }
const body = `${message}\n\n<!-- factory -->`;
const api = (args, input) => { const r = spawnSync("gh", ["api", ...args], { encoding: "utf8", input }); return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") }; };

let reply;
if (it.thread_root) reply = api(["-X", "POST", `repos/${repo}/pulls/${pr.number}/comments/${it.thread_root}/replies`, "--input", "-"], JSON.stringify({ body }));
else reply = api(["-X", "POST", `repos/${repo}/issues/${pr.number}/comments`, "--input", "-"], JSON.stringify({ body: `Re: review ${it.review_id} — ${body}` }));
let resolved = false;
const gqlResolve = (node) => { const r = api(["graphql", "-f", "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}", "-f", `id=${node}`]);
  try { return r.ok && JSON.parse(r.out).data?.resolveReviewThread?.thread?.isResolved === true; } catch { return false; } };
if (!isAsk && it.thread_root && reply.ok) resolved = (it.thread_node && gqlResolve(it.thread_node))
  || api(["-X", "POST", `repos/${repo}/pulls/${pr.number}/ccr/comments/${it.thread_root}/resolve`]).ok;
if (!isAsk && reply.ok && resolved) {  // the finding is resolved only once the thread really is
  const resPath = path.join(RUN, "resolutions.json");
  const res = fs.existsSync(resPath) ? JSON.parse(fs.readFileSync(resPath, "utf8")) : {};
  res[id] = "resolved";
  fs.writeFileSync(resPath, JSON.stringify(res, null, 2) + "\n");
}
fs.appendFileSync(path.join(RUN, "run.log"), `- ${new Date().toISOString()} pr-resolve: ${id} reply=${reply.ok} resolved=${resolved} sha=${sha.slice(0, 7)}\n`);
console.log(`RESOLVE ${id} reply=${reply.ok ? "posted" : "FAILED " + reply.out.trim().slice(0, 120)} thread=${isAsk ? "left to the human" : resolved ? "resolved" : "NOT resolved"} sha=${sha.slice(0, 7)}`);
process.exit(reply.ok && (isAsk || resolved) ? 0 : 1);
