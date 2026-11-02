#!/usr/bin/env node
// preview.mjs [--run <id>] [--sha <sha>] -> <run>/preview.json
// Resolves one URL per app from .factory/setup.json "preview" (any host, stack-agnostic):
//   github-deployment: a Deployment for the head SHA (+ environment) whose latest status is success with an environment_url —
//                      Vercel, Netlify, Cloudflare Pages, Railway, Render... all report through this one API. Polls up to wait_seconds.
//   command:           runs a command ({branch},{title},{sha} substituted); the URL is url_from (a dotted JSON path) or the first http(s) URL printed.
//   fixed:             a constant URL (shared staging).
//   (fallback) local:  the recipe's local url; QA runs against the local stack via run-apps.sh.
// REST only (GraphQL is unavailable in Claude Code sessions). Never fails the run: an app without a preview falls back to local.
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const runId = arg("--run") || fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const setup = JSON.parse(fs.readFileSync(path.join(ROOT, ".factory/setup.json"), "utf8"));
const state = JSON.parse(fs.readFileSync(path.join(RUN, "state.json"), "utf8"));
const sh = (c) => { try { return execSync(c, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const sha = arg("--sha") || sh("git rev-parse HEAD");
const branch = sh("git branch --show-current");
const repo = (() => { const u = sh("git remote get-url origin"); const m = u.match(/github\.com[:/]([^/]+\/[^/.]+)/); return m ? m[1] : null; })();
const gh = (p) => { const r = spawnSync("gh", ["api", p], { encoding: "utf8" }); return r.status === 0 ? JSON.parse(r.stdout) : null; };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pick = (obj, dotted) => dotted.replace(/^\$\.?/, "").split(/[.\[\]]+/).filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);

const cfg = setup.preview || {};
const local = cfg.local || {};
const out = { run: runId, sha, branch, apps: {} };
for (const app of setup.apps || []) {
  const name = app.name;
  const p = cfg[name];
  const fallback = { mode: "local", url: local[name]?.url || null, source: "setup.preview.local" };
  if (!p || p.mode === "local") { out.apps[name] = fallback; continue; }
  try {
    if (p.mode === "fixed") { out.apps[name] = { mode: "fixed", url: p.url, source: "setup.preview.fixed" }; continue; }
    if (p.mode === "command") {
      // The title comes from the request (untrusted) and branch/sha from the run: they reach the shell only as quoted env
      // references, never as text spliced into the command string.
      const cmd = p.command.replaceAll("{branch}", '"$FACTORY_BRANCH"').replaceAll("{sha}", '"$FACTORY_SHA"').replaceAll("{title}", '"$FACTORY_TITLE"');
      const r = spawnSync("bash", ["-lc", cmd], { cwd: ROOT, encoding: "utf8", timeout: (p.wait_seconds || 600) * 1000,
        env: { ...process.env, FACTORY_BRANCH: branch, FACTORY_SHA: sha, FACTORY_TITLE: String(state.title || runId) } });
      const text = (r.stdout || "") + (r.stderr || "");
      let url = null;
      if (p.url_from) { try { url = pick(JSON.parse(r.stdout), p.url_from); } catch { /* fall through */ } }
      url ||= (text.match(/https?:\/\/[^\s"'<>]+/) || [null])[0];
      out.apps[name] = url ? { mode: "command", url, source: cmd } : { ...fallback, reason: `command printed no URL (exit ${r.status})` };
      continue;
    }
    if (p.mode === "github-deployment") {
      if (!repo) { out.apps[name] = { ...fallback, reason: "no GitHub remote" }; continue; }
      const deadline = Date.now() + (p.wait_seconds ?? 600) * 1000;
      let found = null, seen = 0;
      while (!found && Date.now() < deadline) {
        const deps = gh(`repos/${repo}/deployments?sha=${sha}${p.environment ? `&environment=${encodeURIComponent(p.environment)}` : ""}&per_page=10`) || [];
        seen = deps.length;
        for (const d of deps) {
          const st = (gh(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`) || [])[0];
          if (st?.state === "success" && (st.environment_url || st.target_url)) { found = { id: d.id, url: st.environment_url || st.target_url, env: d.environment, creator: d.creator?.login }; break; }
          if (st && ["failure", "error"].includes(st.state)) { out.apps[name] = { ...fallback, reason: `deployment ${d.id} ${st.state}` }; }
        }
        if (!found) sleep(Math.min(15000, Math.max(1000, deadline - Date.now())));
      }
      out.apps[name] = found
        ? { mode: "github-deployment", url: found.url, source: `deployment ${found.id} (${found.env}, by ${found.creator})`, deployment_id: found.id }
        : { ...fallback, reason: out.apps[name]?.reason || (seen ? `no successful status before wait_seconds` : `no deployment for ${sha.slice(0, 7)} before wait_seconds`) };
      continue;
    }
    out.apps[name] = { ...fallback, reason: `unknown mode ${p.mode}` };
  } catch (e) { out.apps[name] = { ...fallback, reason: String(e.message || e) }; }
}
fs.writeFileSync(path.join(RUN, "preview.json"), JSON.stringify(out, null, 2) + "\n");
console.log("PREVIEW " + Object.entries(out.apps).map(([k, v]) => `${k}=${v.mode}:${v.url || "none"}${v.reason ? `(${v.reason})` : ""}`).join(" "));
