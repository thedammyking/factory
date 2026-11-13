#!/usr/bin/env node
// synthesize.mjs — turns the lenses' findings into findings.json, the only review output the merge decision reads, and
// lists the P3s in deferred.md. Takes --run <id>, or derives the run from the run worktree it runs in.
//   - The lenses are code, ui, security and human, whose review-human.md pr-comments writes from the PR's threads.
//   - Every round of each lens counts: review-<lens>.round<N>.md in N order, then review-<lens>.md, never by mtime, which
//     a checkout or a restore resets (design fix 16). A round with no `verdict:` line was cut off and counts for nothing.
//     A finding is a `- id:` block of indented `key: value` lines; its newest block wins, and a block with
//     `status: closed` and no claim resolves it.
//   - A missing action is ask and a missing severity P1, so an untyped finding never passes quietly.
//   - Two findings are one when they sit in the same file within 5 lines and their claims overlap (Jaccard over words of
//     four letters or more, at least 0.15) or they name the same CWE (design fix 3), and a resolved finding joins only
//     resolved ones. The group takes its most severe member's severity and words, and any ask makes it an ask. A
//     finding whose claim, evidence or fix names an anti-goal is at least P1.
//   - On a persuade or operate surface (spec.md's frontmatter; a oneshot's is operate), a UI lens whose latest
//     disposition isn't ship is an open P1 fix, ui-disposition, which only a later UI round saying ship resolves (design
//     fix 6).
//   - The run's own checks and walk are findings too, fixed in the same round as the lenses' (#81): each check
//     verify --full found red at the run's doing (red_cause introduced) is an open P1 fix of the verify lens, and each
//     criterion qa walked to a fail with no pinned test of its own (a pinned one is its test's red) one of the qa lens.
//     Read as they stand, so the round's green verify, or qa walking the criterion again, settles them.
//   - A group is resolved when every member is; otherwise it's open as a P0, a P1 or a human's ask, pr as a P2 and
//     deferred as a P3. A lens's ask is a judgment call, the fix round's to make like any fix (#81): only a person's
//     question on the PR (the human lens) waits for them. The disposition is ask with an open human ask, fix with an open
//     P0 or a P1 fix or ask, and ship otherwise.
// Prints the disposition and counts, then each open finding.
import fs from "node:fs";
import path from "node:path";
import { readJson, runContext } from "./lib.mjs";

const LENSES = ["code", "ui", "security", "human"], RANK = ["P0", "P1", "P2", "P3"];
const ctx = runContext(), dir = ctx.runDir;
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };

// A lens file's blocks in order, each { id, <key>: <value> }.
function blocks(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const id = line.match(/^-[ \t]+id:[ \t]*(\S+)/), kv = cur && line.match(/^[ \t]+(severity|action|location|claim|evidence|fix|cwe|status|note):[ \t]*(.*?)[ \t]*$/);
    if (id) out.push(cur = { id: id[1] });
    else if (kv) cur[kv[1]] = kv[2];
    else if (/^\S/.test(line)) cur = null;
  }
  return out;
}

const round = (lens, f) => f === `review-${lens}.md` ? Infinity : Number(f.match(new RegExp(`^review-${lens}\\.round(\\d+)\\.md$`))?.[1] ?? NaN);
const all = [], uiRounds = [];  // uiRounds: each UI round's disposition, oldest first
for (const lens of LENSES) {
  const files = fs.readdirSync(dir).filter((f) => !Number.isNaN(round(lens, f))).sort((a, b) => round(lens, a) - round(lens, b));
  const byId = new Map(), resolved = new Set();
  for (const f of files) {
    const text = read(f);
    if (!/^verdict:/m.test(text)) continue;
    if (lens === "ui") uiRounds.push(text.match(/^disposition:[ \t]*(\w+)/m)?.[1] || "missing");
    for (const b of blocks(text)) {
      if (b.status === "closed" && !b.claim) { resolved.add(b.id); continue; }
      resolved.delete(b.id);
      byId.set(b.id, { id: b.id, lens, severity: b.severity?.match(/P[0-3]/i)?.[0].toUpperCase() || "P1", action: b.action?.match(/fix|ask|note/i)?.[0].toLowerCase() || "ask",
        location: b.location || "", claim: b.claim || "", evidence: b.evidence || "", fix: b.fix || "", cwe: b.cwe?.match(/CWE-\d+/i)?.[0].toUpperCase() || "" });
    }
  }
  for (const f of byId.values()) all.push({ ...f, resolved: resolved.has(f.id) });
}

// Dedupe: a location is `path[:line]`, or a capture's file and its region.
const where = (loc) => { const m = loc.replaceAll("`", "").match(/^\s*([^\s:]+)(?::(\d+))?/); return m ? [m[1], Number(m[2] || 0)] : [null, 0]; };
const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
const jaccard = (a, b) => { const A = words(a), B = words(b), both = [...A].filter((w) => B.has(w)).length; return both / ((A.size + B.size - both) || 1); };
const groups = [];
for (const f of all) {
  [f.file, f.line] = where(f.location);
  const g = f.file && groups.find((g) => g.resolved === f.resolved && g.members.some((m) => m.file === f.file && Math.abs(m.line - f.line) <= 5
    && ((f.cwe && m.cwe === f.cwe) || jaccard(m.claim, f.claim) >= 0.15)));
  if (g) g.members.push(f); else groups.push({ resolved: f.resolved, members: [f] });
}

const rank = (s) => RANK.indexOf(s);
const findings = groups.map(({ members: ms }, i) => {
  const top = [...ms].sort((a, b) => rank(a.severity) - rank(b.severity))[0], rules = [];
  let severity = top.severity;
  if (rank(severity) > 1 && ms.some((m) => /anti-goal/i.test(`${m.claim} ${m.evidence} ${m.fix}`))) { severity = "P1"; rules.push("anti-goal => at least P1"); }
  const action = ms.some((m) => m.action === "ask") ? "ask" : ms.some((m) => m.action === "fix") ? "fix" : "note";
  const theirs = action === "ask" && ms.some((m) => m.lens === "human");
  const status = ms.every((m) => m.resolved) ? "resolved" : rank(severity) <= 1 || theirs ? "open" : severity === "P2" ? "pr" : "deferred";
  return { id: ms.length > 1 ? `syn-${String(i + 1).padStart(2, "0")}` : top.id, members: ms.map((m) => m.id), lens: [...new Set(ms.map((m) => m.lens))],
    severity, action, status, location: top.location, claim: top.claim, evidence: top.evidence, fix: top.fix, cwe: top.cwe || ms.find((m) => m.cwe)?.cwe || "", rules };
});

// The latest UI round decides: an earlier round's ship never closes a newer round's fix. A oneshot has no spec to name
// its surface, and its acceptance check is someone using the app: operate.
const fm = read("spec.md").match(/^---\n([\s\S]*?)\n---/)?.[1] || "", ui = uiRounds.at(-1) ?? null;
const surface = fm.match(/^surface:[ \t]*(\w+)/m)?.[1] || (readJson(ctx.state)?.route === "oneshot" ? "operate" : null);
if (["persuade", "operate"].includes(surface) && uiRounds.some((d) => d !== "ship")) findings.push({
  id: "ui-disposition", members: ["ui-disposition"], lens: ["ui"], severity: "P1", action: "fix", status: ui === "ship" ? "resolved" : "open",
  location: "captures/", claim: `The UI lens's disposition is ${ui} on a ${surface} surface`, evidence: "review-ui.md",
  fix: "Fix what review-ui.md finds, until a UI re-review says ship.", cwe: "", rules: ["ui not ship on persuade or operate => open P1 fix"],
});

const own = (id, lens, location, claim, evidence, fix) => findings.push({ id, members: [id], lens: [lens], severity: "P1", action: "fix", status: "open",
  location, claim, evidence, fix, cwe: "", rules: [`${lens} => open P1 fix`] });
const ev = readJson(path.join(dir, "evidence.json"));
if (ev && !ev.green && ev.red_cause === "introduced") for (const c of ev.checks.filter((c) => c.status === "fail")) {
  own(`verify-${c.app}-${c.check}`.replace(/[^\w.-]+/g, "-"), "verify", c.pinned ? c.check : c.log || `${c.app}/${c.check}`,
    `${c.app}/${c.check} fails at ${ev.sha.slice(0, 7)}: ${String(c.digest ?? "").split("\n").find((l) => l.trim()) ?? "see its log"}`, "evidence.json",
    "Make it pass by changing the product code: evidence.json has its digest and log. Never change a pinned test's expected value.");
}
for (const c of (readJson(path.join(dir, "qa.json"))?.criteria || []).filter((c) => c.status === "fail" && !c.test)) {
  own(`qa-${c.id}`, "qa", (c.captures || [])[0] || "qa.json", `${c.id} fails in qa's walk: expected ${c.expected}, observed ${c.observed}`, (c.captures || []).join(", ") || "qa.json",
    `Make the app do what ${c.id} says in spec.md; qa walks it again after the round.`);
}

const open = findings.filter((f) => f.status === "open");
const asks = open.filter((f) => f.action === "ask" && f.lens.includes("human"));
const blocking = open.filter((f) => !asks.includes(f) && (f.severity === "P0" || (f.severity === "P1" && f.action !== "note")));
const disposition = asks.length ? "ask" : blocking.length ? "fix" : "ship";
const counts = { ...Object.fromEntries(RANK.map((s) => [s, findings.filter((f) => f.severity === s).length])),
  open_blocking: blocking.length, open_asks: asks.length, resolved: findings.filter((f) => f.status === "resolved").length };
const file = path.join(dir, "findings.json"), deferredFile = path.join(dir, "deferred.md");
fs.writeFileSync(file, JSON.stringify({ run: ctx.id, surface, ui_disposition: ui, disposition, counts, findings }, null, 2) + "\n");
const deferred = findings.filter((f) => f.status === "deferred").map((f) => `- ${f.id} (${f.lens.join(", ")}) \`${f.location}\`: ${f.claim}`);
fs.writeFileSync(deferredFile, `# Deferred\n\nThe review's P3 findings, which never enter a fix round.\n\n${deferred.join("\n") || "- none"}\n`);

console.log(`synthesize: disposition=${disposition} ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")}`);
for (const f of open) console.log(`  ${f.severity} ${f.action} ${f.id} ${f.location}${f.members.length > 1 ? ` = ${f.members.join("+")}` : ""}${f.rules.length ? ` [${f.rules.join("; ")}]` : ""}`);
console.log(`findings.json: ${file}\ndeferred.md: ${deferredFile}`);
