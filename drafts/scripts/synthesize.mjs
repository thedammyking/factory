#!/usr/bin/env node
// synthesize.mjs [--run <id>] -> findings.json (+ review-summary.md)
// Mechanical synthesis of the review lenses: parse finding blocks, dedupe by location, max severity, apply rules,
// merge resolutions from re-review, and emit machine-readable status per finding. The merge rule reads findings.json, not prose.
import fs from "node:fs";
import path from "node:path";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const runIdx = process.argv.indexOf("--run");
const runId = runIdx > -1 ? process.argv[runIdx + 1] : fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const read = (f) => { try { return fs.readFileSync(path.join(RUN, f), "utf8"); } catch { return ""; } };

// ---- parse lens files: blocks start with "- id:" and carry indented key: value lines
const lensResolutions = {};
function parseFindings(text, lens) {
  const out = [];
  const lines = text.split("\n");
  let cur = null;
  for (const line of lines) {
    const idm = line.match(/^-\s*id:\s*([\w-]+)/);
    if (idm) { if (cur) out.push(cur); cur = { id: idm[1], lens, raw: {} }; continue; }
    if (!cur) continue;
    const kv = line.match(/^\s+(severity|action|location|claim|evidence|fix|cwe|status|note):\s*(.*)$/);
    if (kv) cur.raw[kv[1]] = kv[2].trim();
    else if (/^\S/.test(line) && cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  // A re-review block "- id: X / status: closed|resolved / note: ..." is a resolution of X, not a new finding (fail closed:
  // it only counts when the block names no new claim).
  for (const f of out) if (/^(closed|resolved|fixed)$/i.test(f.raw.status || "") && !f.raw.claim) lensResolutions[f.id] = "resolved";
  return out.filter(f => !(/^(closed|resolved|fixed)$/i.test(f.raw.status || "") && !f.raw.claim)).map(f => ({
    id: f.id, lens,
    severity: (f.raw.severity || "P3").match(/P[0-3]/)?.[0] || "P3",
    action: (f.raw.action || "ask").match(/fix|ask|note/)?.[0] || "ask",   // fail closed: missing action = ask
    location: f.raw.location || "", claim: f.raw.claim || "", fix: f.raw.fix || "", cwe: f.raw.cwe || "",
  }));
}
// "human" is written by pr-comments.mjs from unresolved PR review threads; a human comment is never deduped away (see below).
const lenses = { code: "review-code.md", ui: "review-ui.md", security: "review-security.md", human: "review-human.md" };
// Every round of a lens counts. Naming: `review-<lens>.md` is the latest round; before a re-review writes a new one, the
// orchestrator archives the previous file as `review-<lens>.round<N>.md` (N = 1, 2, ...). Rounds are ordered by N, with the
// unsuffixed file last — never by mtime, which a checkout or a snapshot restore resets. A finding id seen in several rounds
// keeps its newest block; findings from earlier rounds stay in the ledger so their resolutions remain visible.
let all = [];
for (const [lens, file] of Object.entries(lenses)) {
  const stem = file.replace(/\.md$/, "");
  const roundOf = (f) => f === file ? Infinity : Number((f.match(/[.-]round(\d+)\.md$/) || [])[1] ?? -1);
  const files = fs.readdirSync(RUN).filter(f => f === file || (f.startsWith(stem) && /^[.-]round\d+\.md$/.test(f.slice(stem.length))))
    .sort((a, b) => roundOf(a) - roundOf(b));
  const byId = new Map();
  for (const f of files) for (const fd of parseFindings(read(f), lens)) byId.set(fd.id, fd);
  all = all.concat([...byId.values()]);
}

// ---- dedupe by location: same file and first line within 5
const locKey = (loc) => { const m = loc.match(/([\w./-]+\.(?:ts|tsx|js|mjs|css|json|md|yaml|yml|html))(?::(\d+))?/); return m ? [m[1], Number(m[2] || 0)] : [loc.slice(0, 40), 0]; };
const sevRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
// Same file and nearby lines is necessary but not sufficient: two findings on neighbouring lines can be different bugs.
// They merge only if their claims overlap (Jaccard over content words >= 0.15) or they carry the same CWE.
const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 3));
const jaccard = (a, b) => { const A = words(a), B = words(b); const inter = [...A].filter(w => B.has(w)).length; return inter / (A.size + B.size - inter || 1); };
const groups = [];
for (const f of all) {
  const [file, line] = locKey(f.location);
  const g = f.lens === "human" ? null : groups.find(g => g.file === file && file && Math.abs(g.line - line) <= 5 &&
    g.members.every(m => m.lens !== "human") &&
    g.members.some(m => (m.cwe && m.cwe === f.cwe) || jaccard(m.claim + " " + m.fix, f.claim + " " + f.fix) >= 0.15));
  if (g) g.members.push(f); else groups.push({ file, line, members: [f] });
}

// ---- rules
const spec = read("spec.md");
const surface = (spec.match(/surface:\s*(\w+)/) || [])[1] || "";
const antiGoalWords = (spec.match(/## Anti-goals[\s\S]*?(?=\n## )/) || [""])[0].toLowerCase();
const resolutions = { ...lensResolutions, ...(() => { try { return JSON.parse(read("resolutions.json")); } catch { return {}; } })() };
const uiDisposition = (read("review-ui.md").match(/disposition:\s*(\w+)/) || [])[1] || "";

const findings = groups.map((g, i) => {
  const members = g.members;
  let severity = members.map(m => m.severity).sort((a, b) => sevRank[a] - sevRank[b])[0];
  let action = members.some(m => m.action === "fix") ? "fix" : members.some(m => m.action === "ask") ? "ask" : "note";
  const text = members.map(m => m.claim + " " + m.fix).join(" ").toLowerCase();
  const rules = [];
  if (/anti-goal/.test(text) && sevRank[severity] > 1) { severity = "P1"; rules.push("anti-goal => at least P1"); }
  if (members.some(m => m.action === "ask") && action === "fix") rules.push("ask wins over fix");
  if (members.some(m => m.action === "ask")) action = "ask";
  const id = members.length > 1 ? `syn-${String(i + 1).padStart(2, "0")}` : members[0].id;
  let status = members.every(m => resolutions[m.id] === "resolved") && members.some(m => m.id in resolutions) ? "resolved"
    : (severity === "P0" || severity === "P1" || action === "ask") ? "open"
    : severity === "P2" ? "pr" : "deferred";
  return { id, members: members.map(m => m.id), lens: [...new Set(members.map(m => m.lens))], severity, action, status,
    location: members[0].location, claim: members[0].claim, cwe: members.find(m => m.cwe)?.cwe || "", rules };
});

// UI disposition rule: on persuade/operate surfaces, a UI lens `fix` disposition is itself an open P1 until re-review says ship
if (["persuade", "operate"].includes(surface) && uiDisposition === "fix") {
  const resolved = resolutions["ui-disposition"] === "resolved";
  findings.push({ id: "ui-disposition", members: [], lens: ["ui"], severity: "P1", action: "fix", status: resolved ? "resolved" : "open",
    location: "captures/", claim: `UI lens disposition is 'fix' on a ${surface} surface; enters the fix loop (rule: UI fix loops on persuade/operate)`, cwe: "", rules: ["ui fix on persuade/operate => P1"] });
}

const openBlocking = findings.filter(f => f.status === "open" && (f.severity === "P0" || f.severity === "P1") && f.action === "fix");
const openAsks = findings.filter(f => f.status === "open" && f.action === "ask");
const disposition = findings.some(f => f.status === "open" && f.severity === "P0") || openAsks.length ? "ask" : openBlocking.length ? "fix" : "ship";
const out = { run: runId, surface, ui_disposition: uiDisposition, disposition, counts: {
  P0: findings.filter(f => f.severity === "P0").length, P1: findings.filter(f => f.severity === "P1").length,
  P2: findings.filter(f => f.severity === "P2").length, P3: findings.filter(f => f.severity === "P3").length,
  open_blocking: openBlocking.length, open_asks: openAsks.length, resolved: findings.filter(f => f.status === "resolved").length }, findings };
fs.writeFileSync(path.join(RUN, "findings.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`SYNTH disposition=${disposition} P0=${out.counts.P0} P1=${out.counts.P1} P2=${out.counts.P2} P3=${out.counts.P3} open_blocking=${openBlocking.length} open_asks=${openAsks.length} resolved=${out.counts.resolved}`);
for (const f of findings.filter(f => f.severity !== "P3")) console.log(`  ${f.status.padEnd(8)} ${f.severity} ${f.action.padEnd(4)} ${f.id.padEnd(18)} ${f.location.slice(0, 40).padEnd(40)} ${f.members.length > 1 ? "= " + f.members.join("+") : ""} ${f.rules.length ? "[" + f.rules.join("; ") + "]" : ""}`);
