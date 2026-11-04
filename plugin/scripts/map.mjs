#!/usr/bin/env node
// map.mjs — a map on the local tracker, .factory/maps/<slug>/: map.md (the map's body), tickets/NN-slug.md (one decision
// ticket each, with `Type:`, `Status:` and `Blocked by:` lines) and research/<name>.md (a research ticket's findings).
// It reads the base branch's tip, never the working tree, and writes only through lib's commitToBase, so every session
// on one map sees the others' writes. Under any other tracker the map lives there, and only research/ is written here.
//   map.mjs frontier <slug>                -> `NEXT <NN-slug> (<type>): <title>` per open decision ticket whose blockers
//                                             are all closed, in number order; with none, `CLAIMED <NN-slug>: <title>`
//                                             or `BLOCKED <NN-slug>: waits on <NN>, …` per open one; with no open one,
//                                             `CLEAR`
//   map.mjs claim <slug> <NN>              -> `Status: claimed` on an open decision ticket, committed. One that isn't
//                                             open at the tip, another session's claim having won the race, fails
//                                             cleanly: exit 2, nothing committed, and the session takes the next `NEXT`
//   map.mjs resolve <slug> <NN> --gist "<line>" < answer -> a claimed decision ticket's answer under `## Answer` and
//                                             `Status: resolved`, and a pointer to it (its title, linked, and the gist)
//                                             last in map.md's `## Decisions so far`, in one commit
//   map.mjs write <slug> <path> < text     -> map.md, tickets/NN-slug.md (with its three lines) or research/<name>.md,
//                                             written whole as one commit; under any tracker, research/ alone. What
//                                             another session committed since the text was read is refused, never
//                                             lost: a ticket's Status (claim and resolve change it, write only to
//                                             out-of-scope) and map.md's pointers in `## Decisions so far`
import { mainRoot, readJson, arg, git, frontier, commitToBase, attributed, STATUS_LINE } from "./lib.mjs";
import fs from "node:fs";
import path from "node:path";

const STATUSES = ["open", "claimed", "resolved", "out-of-scope"];
const WORDS = { closed: ["resolved", "out-of-scope"], started: null, ready: "open" };  // lib's frontier in a map's words: next is what's takeable
const TYPES = ["research", "grilling", "task"];
const SLUG = /^[a-z0-9][a-z0-9-]*$/, RESEARCH = /^research\/[a-z0-9][a-z0-9-]*\.md$/, TICKET = /^tickets\/\d{2}-[a-z0-9][a-z0-9-]*\.md$/;
const DECISIONS = /^## Decisions so far[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;  // map.md's section, its lines in [1]

const [cmd, slug, target = ""] = process.argv.slice(2);  // target: a ticket's NN, or write's path
function die(msg) { console.error(`map: ${msg}`); process.exit(2); }
const MAIN = mainRoot();
const config = readJson(path.join(MAIN, ".factory", "config.json"));
if (!config) die("no .factory/config.json: run /setup-factory first");
if (!SLUG.test(slug || "")) die(`${cmd ?? "usage:"} <slug>: a map's folder name under .factory/maps/`);
// the base a run starts from (run-state init's), which holds every map
const branching = config.branching || {}, base = branching.model === "git-flow" ? branching.develop || "develop" : branching.main || "main";
const dir = `.factory/maps/${slug}`, ref = `refs/heads/${base}`;
const title = (t) => t.text.match(/^# (.+)$/m)?.[1].trim() ?? t.id;
const type = (t) => t.text.match(/^\**Type:\**[ \t]*(\S+)/m)?.[1];
const parse = (f, text) => frontier("", WORDS, { [f]: text }).items[0];  // one decision ticket, read as the frontier reads it
const pointers = (text) => (text.match(DECISIONS)?.[1] ?? "").split("\n").filter((l) => l.startsWith("- "));
const tickets = () => git(MAIN, "ls-tree", "--name-only", ref, "--", `${dir}/tickets/`).split("\n").filter(Boolean);
// The file name of ticket NN (or NN-slug) at the base tip.
function ticketName(n) {
  const f = /^\d{2}(-|$)/.test(n) && tickets().map((p) => path.posix.basename(p)).find((f) => f.startsWith(`${n.slice(0, 2)}-`) && f.endsWith(".md"));
  return f || die(`no ticket ${n || "<NN>"} in map ${slug} on ${base}`);
}
// That ticket as the temp worktree at the tip holds it.
function ticketIn(wt, f) {
  const file = path.join(wt, dir, "tickets", f);
  return { ...parse(f, fs.readFileSync(file, "utf8")), file, path: `${dir}/tickets/${f}` };
}
// One commit onto the base, `apply` re-run on a moved tip; a throw from it (a lost race) ends the command committing nothing.
// It acts on no run, so only an exported FACTORY_COMMIT_TRAILER attributes it.
function commit(what, apply) {
  try { return commitToBase(MAIN, base, attributed(`factory(map): ${slug} ${what}`, "commit", null), apply); } catch (e) { die(e.message); }
}

if (config.tracker !== "local" && !(cmd === "write" && RESEARCH.test(target))) die(`${cmd} is for the local tracker, and this one is ${config.tracker}: its map lives there`);
switch (cmd) {
  case "frontier": {
    try { git(MAIN, "cat-file", "-e", `${ref}:${dir}/map.md`); } catch { die(`no map ${slug} on ${base}`); }
    const files = Object.fromEntries(tickets().map((n) => [path.posix.basename(n), git(MAIN, "show", `${ref}:${n}`)]));
    const { open, next, done } = frontier(`${dir}/tickets`, WORDS, files);
    if (next.length) for (const t of next) console.log(`NEXT ${t.id} (${type(t)}): ${title(t)}`);
    else if (!open.length) console.log("CLEAR");
    else for (const t of open) console.log(t.status === "claimed" ? `CLAIMED ${t.id}: ${title(t)}`
      : `BLOCKED ${t.id}: ${t.status === "open" ? `waits on ${(t.blockedBy || []).filter((b) => !done.has(b)).join(", ")}` : `its status is ${t.status}`}`);
    break;
  }
  case "claim": {
    const f = ticketName(target), session = process.env.CLAUDE_CODE_SESSION_ID;
    // Named for its claimer: two claims of one tip would otherwise be the same commit, and both would win.
    commit(`claim ${f.slice(0, -3)}\n\nClaimed by process ${process.pid}${session ? ` of session ${session}` : ""}.`, (wt) => {
      const t = ticketIn(wt, f);
      if (t.status !== "open") throw new Error(`${t.id} is ${t.status} now: take the next one on the frontier`);
      fs.writeFileSync(t.file, t.text.replace(STATUS_LINE, "$1claimed"));
      return [t.path];
    });
    console.log(`claimed ${f.slice(0, -3)}`);
    break;
  }
  case "resolve": {
    const f = ticketName(target), gist = arg("--gist"), answer = fs.readFileSync(0, "utf8").trim();
    if (!/^[^\n]{1,200}$/.test(gist ?? "")) die('resolve <slug> <NN> --gist "<one line>", the answer on stdin');
    if (!answer) die("resolve takes the answer on stdin");
    commit(`resolve ${f.slice(0, -3)}`, (wt) => {
      const t = ticketIn(wt, f), map = path.join(wt, dir, "map.md");
      if (t.status !== "claimed") throw new Error(`${t.id} is ${t.status}: claim it first`);
      fs.writeFileSync(t.file, `${t.text.replace(STATUS_LINE, "$1resolved").trimEnd()}\n\n## Answer\n\n${answer}\n`);
      // the pointer goes last in the map's Decisions so far, which it gains if it has none
      const text = fs.readFileSync(map, "utf8"), line = `- [${title(t)}](tickets/${f}): ${gist}\n`;
      const s = text.match(DECISIONS), body = s?.[1].trimEnd();
      fs.writeFileSync(map, s ? `${text.slice(0, s.index)}## Decisions so far\n${body ? `${body}\n` : "\n"}${line}\n${text.slice(s.index + s[0].length)}`.replace(/\n+$/, "\n")
        : `${text.trimEnd()}\n\n## Decisions so far\n\n${line}`);
      return [t.path, `${dir}/map.md`];
    });
    console.log(`resolved ${f.slice(0, -3)}`);
    break;
  }
  case "write": {
    if (!(target === "map.md" || TICKET.test(target) || RESEARCH.test(target))) die("a map file is map.md, tickets/NN-slug.md or research/<name>.md");
    const text = fs.readFileSync(0, "utf8");
    if (!text.trim()) die("write takes the file's text on stdin");
    // A ticket the frontier can't read would never reach it, nor leave it.
    const t = TICKET.test(target) && parse(path.basename(target), text);
    if (t && !TYPES.includes(type(t))) die(`a ticket has a \`Type: ${TYPES.join(" | ")}\` line`);
    if (t && !STATUSES.includes(t.status)) die(`a ticket has a \`Status: ${STATUSES.join(" | ")}\` line`);
    if (t && !t.blockedBy) die("a ticket has a `Blocked by:` line: `none`, or the number of each ticket it waits on");
    const sha = commit(`write ${target}`, (wt) => {
      const file = path.join(wt, dir, target), was = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const status = t && (was ? parse(path.basename(target), was).status : "open");
      if (t && t.status !== status && t.status !== "out-of-scope") throw new Error(`${t.id} is ${status} at the tip: a write keeps a ticket's Status, but for out-of-scope, so read it again`);
      const lost = target === "map.md" && was ? pointers(was).filter((l) => !text.includes(l)) : [];
      if (lost.length) throw new Error(`map.md at the tip has decisions this text leaves out, another session's: read it again (${lost.join("; ")})`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return [`${dir}/${target}`];
    });
    console.log(`${sha ? "wrote" : "unchanged"} ${dir}/${target} on ${base}`);
    break;
  }
  default: die("usage: map.mjs frontier | claim | resolve | write <slug> …");
}
