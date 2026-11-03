// harness.mjs — what every factory test builds on: a throwaway project, fake CLIs on PATH, a local bare remote and a
// stub app.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
export const sh = (cwd, cmd, args) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

const RECIPE = { apps: [{ name: "app", type: "backend", path: ".", checks: { test: "true" } }] };

// A git project on `main` with one commit holding a stub recipe and config under .factory/ and the
// gitignore setup writes, plus an empty, ignored run dir for run `r1`.
export function project({ recipe = RECIPE, config = {} } = {}) {
  const dir = tmp("factory-project-");
  const git = (...args) => sh(dir, "git", args);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t"); git("config", "user.email", "t@t"); git("config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, ".factory"));
  fs.writeFileSync(path.join(dir, ".factory/setup.json"), JSON.stringify(recipe, null, 2));
  fs.writeFileSync(path.join(dir, ".factory/config.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, ".gitignore"), ".factory/runs/\n.factory/worktrees/\n.factory/env.local\n");
  git("add", "."); git("commit", "-qm", "init");
  const runId = "r1", runDir = path.join(dir, ".factory/runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  return { dir, git, runId, runDir };
}

// Fake CLIs in a bin dir that `env.PATH` puts first. Each call appends its argv to calls(name). The first
// rule whose `match` regex finds the argv joined by spaces prints its canned `file` and exits `status`
// (default 0); a call no rule matches exits 127 and names its argv on stderr.
export function fakeClis(rules) {
  const bin = tmp("factory-bin-");
  for (const [name, list] of Object.entries(rules)) {
    const canned = list.map(({ match, file, status = 0 }) => ({ match: match.source, flags: match.flags, file, status }));
    fs.writeFileSync(path.join(bin, `${name}.rules.json`), JSON.stringify(canned));
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(__filename + ".calls", JSON.stringify(argv) + "\\n");
const rule = JSON.parse(fs.readFileSync(__filename + ".rules.json", "utf8")).find((r) => new RegExp(r.match, r.flags).test(argv.join(" ")));
if (rule) { process.stdout.write(fs.readFileSync(rule.file)); process.exitCode = rule.status; }
else { process.stderr.write(${JSON.stringify(`fake ${name}: no canned reply for `)} + JSON.stringify(argv) + "\\n"); process.exitCode = 127; }
`, { mode: 0o755 });
  }
  const calls = (name) => {
    const log = path.join(bin, `${name}.calls`);
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  return { bin, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, calls };
}

// A stub app for run-apps: `node server.mjs <port>` (else $PORT) answers every request with its pid, cwd, argv and env
// as JSON. It exits within 100 ms of the file $ALIVE names going away, so a test cleans up the apps it started by
// removing that file, never by killing a pid.
export const STUB_SERVER = `import http from "node:http";
import fs from "node:fs";
http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2), env: process.env })))
  .listen(Number(process.argv[2] || process.env.PORT));
setInterval(() => fs.existsSync(process.env.ALIVE) || process.exit(), 100);
`;

// A bare repo added as the project's `origin`, with `main` pushed to it.
export function bareRemote(p) {
  const dir = tmp("factory-remote-");
  sh(dir, "git", ["init", "-q", "--bare", "-b", "main"]);
  p.git("remote", "add", "origin", dir);
  p.git("push", "-q", "-u", "origin", "main");
  return dir;
}
