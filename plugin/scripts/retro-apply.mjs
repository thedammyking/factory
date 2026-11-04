#!/usr/bin/env node
// retro-apply.mjs <retro.md> --accept <n,n> — commits the retro's proposals the human accepted onto the base runs start
// from, through lib's commitToBase, never in a checkout (#21). Each `## <n>. <title>` section of retro.md is one proposal:
// `- kind:`, `- file:` for an adr, and one fenced block, the text it adds:
//   lesson   `- <the line>` last in .factory/lessons.md
//   index    `- <the line>` last in .factory/index.md
//   adr      the stub as .factory/knowledge/<slug>.md, the directory made on first use, and a line naming it last in
//            index.md, which the triager and planner read first
//   semgrep  the rule (`- id: …` and its keys) last under `rules:` in .factory/semgrep/project.yaml, made when missing,
//            then compiled offline: a scan of an empty directory, metrics off (design fix 25: --validate fetches rule lints
//            from the registry). Without semgrep installed it isn't compiled, and says so.
// What the base holds already (the same line, the same stub, a rule of that id) stays as it is, so a second run of the
// same proposals commits nothing. Every accepted proposal is checked before anything is written. Prints a line per accepted
// proposal, then `RETRO <sha> on <base>` or `RETRO unchanged on <base>`; exits 1 when nothing was committed (a rule that
// doesn't compile, an ADR's file holding another, git refusing), 2 when a proposal can't be applied as written.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJson, arg, mainRoot, commitToBase } from "./lib.mjs";

const die = (msg, code = 2) => { console.error(`retro-apply: ${msg}`); process.exit(code); };
const file = process.argv[2], accept = arg("--accept");
if (!file || file.startsWith("--") || !/^\d+(,\d+)*$/.test(accept ?? "")) die("usage: retro-apply.mjs <retro.md> --accept <n,n>");
const MAIN = mainRoot(), config = readJson(path.join(MAIN, ".factory", "config.json"));
if (!config) die("no .factory/config.json: run /setup-factory first");
const branching = config.branching || {}, base = branching.model === "git-flow" ? branching.develop || "develop" : branching.main || "main";
let text; try { text = fs.readFileSync(file, "utf8"); } catch { die(`no retro at ${file}`); }

const RULES = ".factory/semgrep/project.yaml", TARGET = { lesson: ".factory/lessons.md", index: ".factory/index.md" };
const sections = new Map([...text.matchAll(/^## (\d+)\. (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map(([, n, title, body]) => [n, {
  n, title: title.trim(), kind: body.match(/^- kind:[ \t]*(\S+)/m)?.[1], file: body.match(/^- file:[ \t]*`?([^`\s]+)`?/m)?.[1],
  block: body.match(/^```[\w-]*\n([\s\S]*?)\n```[ \t]*$/m)?.[1].replace(/\s+$/, "") }]));
const proposals = [...new Set(accept.split(","))].map((n) => {
  const p = sections.get(n) ?? die(`no proposal ${n} in ${file}`);
  if (!p.block) die(`proposal ${n}: it has no fenced block`);
  if (Object.hasOwn(TARGET, p.kind ?? "")) {
    if (p.block.includes("\n")) die(`proposal ${n}: a ${p.kind === "lesson" ? "lesson" : "index line"} is one line`);
    return { ...p, line: `- ${p.block.trim().replace(/^- /, "")}`, file: TARGET[p.kind] };
  }
  if (p.kind === "adr") return /^\.factory\/knowledge\/[a-z0-9][a-z0-9-]*\.md$/.test(p.file ?? "") ? p : die(`proposal ${n}: an adr's file is .factory/knowledge/<slug>.md`);
  if (p.kind === "semgrep") return { ...p, id: p.block.match(/^- id:[ \t]*([\w.-]+)[ \t]*\n/)?.[1] ?? die(`proposal ${n}: a rule starts \`- id: <id>\``), file: RULES };
  die(`proposal ${n}: its kind ${p.kind} isn't lesson, index, adr or semgrep`);
});

// semgrep over the rules file and an empty directory: the rules are parsed and nothing is scanned or fetched
function compile(wt) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "factory-rules-"));
  try { return spawnSync("semgrep", ["scan", "--config", RULES, "--metrics=off", "--disable-version-check", "--quiet", empty], { cwd: wt, encoding: "utf8", timeout: 5 * 60_000 }); }
  finally { fs.rmSync(empty, { recursive: true, force: true }); }
}

let lines;
const apply = (wt) => {
  lines = [];  // a moved base applies again from its new tip
  const at = (f) => path.join(wt, f), read = (f) => { try { return fs.readFileSync(at(f), "utf8"); } catch { return ""; } };
  const put = (f, t) => { fs.mkdirSync(path.dirname(at(f)), { recursive: true }); fs.writeFileSync(at(f), t); };
  const append = (f, line) => { const cur = read(f); if (cur.split("\n").includes(line)) return false; put(f, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n"); return true; };
  const changed = new Set();
  for (const p of proposals) {
    let added;
    if (p.line) added = append(p.file, p.line);
    else if (p.kind === "adr") {
      const cur = read(p.file), stub = `${p.block}\n`;
      if (cur && cur !== stub) throw new Error(`proposal ${p.n}: ${p.file} already holds another record on ${base}`);
      if ((added = !cur)) put(p.file, stub);
      if (!read(TARGET.index).includes(`\`${p.file}\``) && append(TARGET.index, `- \`${p.file}\`: ${p.title}`)) changed.add(TARGET.index);
    } else {
      // ponytail: the rules file is edited as text: a rule goes last, so `rules:` must be its last top-level key, and a
      // rule is known by its id written unquoted. Parse the YAML if a project's rules file ever breaks either.
      const cur = read(RULES).replace(/^rules:[ \t]*\[\][ \t]*$/m, "rules:");  // setup's starter is a block list; an emptied one may not be
      if ((added = !new RegExp(`^[ \\t]*- id:[ \\t]*${p.id.replace(/\./g, "\\.")}[ \\t]*$`, "m").test(cur))) {
        const indent = cur.match(/^( *)- id:/m)?.[1] ?? "  ", list = /^rules:/m.test(cur) ? cur.replace(/\n*$/, "\n") : `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}rules:\n`;
        put(RULES, list + p.block.split("\n").map((l) => l && indent + l).join("\n") + "\n");
        const r = compile(wt), missing = r.error?.code === "ENOENT";
        if (!missing && r.status !== 0) throw new Error(`rule ${p.id} doesn't compile, so nothing was committed: ${r.error?.message ?? (`${r.stdout}${r.stderr}`.trim().split("\n").slice(-10).join("\n") || `semgrep ended by ${r.signal}`)}`);
        p.compiled = missing ? "not compiled: semgrep isn't installed" : "compiled";
      }
    }
    if (added) changed.add(p.file);
    lines.push(`${p.n} ${p.kind}: ${p.id ? `rule ${p.id} ` : ""}${added ? "added to" : "already in"} ${p.file}${added && p.compiled ? `, ${p.compiled}` : ""}`);
  }
  return [...changed];
};
let sha;
try { sha = commitToBase(MAIN, base, `factory(retro): ${proposals.map((p) => p.title).join("; ")}`, apply); } catch (e) { die(e.message, 1); }
console.log([...lines, `RETRO ${sha ? sha.slice(0, 7) : "unchanged"} on ${base}`].join("\n"));
