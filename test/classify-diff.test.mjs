// classify-diff.test.mjs — classify-diff.mjs spawned as a process against a run on a throwaway project holding the
// touch rules setup copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project, script, startRun } from "./harness.mjs";

const RULES = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/templates/touch-rules.json"), "utf8");
const TOUCHES = ["auth", "data", "migrations", "network", "files", "crypto", "config", "deps", "native", "api_contract", "ui", "tests", "ci"];

// A run on a project whose main holds the touch rules and `files`; classify() runs classify-diff and returns touches.json.
function run(files = {}) {
  const p = project();
  const r = startRun(p, { ".factory/touch-rules.json": RULES, ...files });
  const classify = () => {
    const c = script("classify-diff.mjs", p.dir, ["--run", r.id]);
    assert.equal(c.status, 0, c.stderr);
    return { ...JSON.parse(fs.readFileSync(path.join(r.run_dir, "touches.json"), "utf8")), stdout: c.stdout };
  };
  return { ...r, p, classify };
}
const fired = (t) => Object.entries(t.touches).filter(([, v]) => v.hit).map(([k]) => k).sort();

test("design fix 9: a signup endpoint that makes a token and calls a mail client fires data, network, crypto and api_contract, never auth or files", () => {
  const r = run();
  r.commit({
    "apps/api/src/signup/signup.controller.ts": `import { Body, Controller, Post } from "@nestjs/common";
import { SignupService } from "./signup.service";

@Controller("signup")
export class SignupController {
  constructor(private readonly signups: SignupService) {}

  @Post()
  create(@Body() body: { email: string }) {
    return this.signups.create(body.email);
  }
}
`,
    "apps/api/src/signup/signup.service.ts": `import { randomBytes } from "node:crypto";
import { prisma } from "../prisma";
import { client } from "../client/mailer-client";

export class SignupService {
  async create(email: string) {
    const token = randomBytes(16).toString("hex");
    await prisma.signup.create({ data: { email, token } });
    await client.send(email, token);
    return { ok: true };
  }
}
`,
    "apps/api/src/client/mailer-client.ts": `export const client = {
  send: (to: string, token: string) => fetch("https://mail.example.com/send", { method: "POST", body: JSON.stringify({ to, token }) }),
};
`,
  });
  const t = r.classify();
  assert.deepEqual(Object.keys(t.touches), TOUCHES, "no analytics or load touch");
  assert.deepEqual(fired(t), ["api_contract", "crypto", "data", "network"]);
  assert.deepEqual(t.touches.crypto.patterns, ["randomBytes"]);
  assert.deepEqual(t.touches.network.patterns, ["\\bfetch\\("]);
  assert.deepEqual(t.touches.auth, { hit: false, paths: [], patterns: [] });
  assert.equal(t.files_changed, 3);
  assert.equal(t.head, r.git("rev-parse", "HEAD"));
  assert.match(t.stdout, /^touches: data,network,crypto,api_contract files=3/m);
});

test("paths match as segments and content only on added lines, never a removed or context line or a lockfile's", () => {
  const r = run({ "src/lib/tokens.ts": 'import jwt from "jsonwebtoken";\nimport bcrypt from "bcrypt";\nexport const x = 0;\n', "package-lock.json": "{}\n" });
  r.commit({
    "src/lib/tokens.ts": 'import jwt from "jsonwebtoken";\nexport const x = 0;\nexport const y = 1;\n',
    "auth/index.ts": "export const guard = true;\n",
    "docs/ideas.json": "[]\n",
    "apps/mobile/eas.json": "{}\n",
    "package-lock.json": '{ "packages": { "node_modules/axios": {} } }\n',
  });
  const t = r.classify();
  assert.deepEqual(fired(t), ["auth", "deps", "native"]);
  assert.deepEqual(t.touches.auth, { hit: true, paths: ["auth/index.ts"], patterns: [] }, "a top-level auth/ is a segment; bcrypt was removed and jsonwebtoken is context");
  assert.deepEqual(t.touches.native.paths, ["apps/mobile/eas.json"], "eas.json is a file segment, so ideas.json isn't one");
  assert.deepEqual(t.touches.network.patterns, [], "axios in a lockfile isn't code");

  // the rules are the base's: a run that empties them still fires what its diff touches
  r.commit({ ".factory/touch-rules.json": "{}\n" });
  assert.deepEqual(fired(r.classify()), ["auth", "deps", "native"]);
});

test("new_env names each variable an added line reads that nothing in the project at the base mentions", () => {
  const r = run({
    ".env.example": "DATABASE_URL=\nPORT=3000\n",
    "src/db.ts": "export const url = process.env.DATABASE_URL;\n",
    ".factory/history/old/prompt.md": "Report errors to SENTRY_DSN\n",
  });
  r.commit({ "src/pay.ts": [
    "const key = process.env.STRIPE_SECRET_KEY;",
    "const db = process.env.DATABASE_URL;",
    'const hook = process.env["WEBHOOK_SECRET"] ?? process.env.PORT;',
    "const api = import.meta.env.VITE_API_URL;",
    "const dsn = process.env.SENTRY_DSN;",
    "const again = process.env.STRIPE_SECRET_KEY;",
    "const { RESEND_KEY, PORT: port = 3000, ...rest } = process.env;",
    "const flag = process.env?.FEATURE_FLAG;",
  ].join("\n") + "\n" });
  const t = r.classify();
  assert.deepEqual(t.new_env, ["STRIPE_SECRET_KEY", "WEBHOOK_SECRET", "VITE_API_URL", "SENTRY_DSN", "RESEND_KEY", "FEATURE_FLAG"],
    "DATABASE_URL and PORT are known at the base; a run's history is the factory's, not the project's");
  assert.equal(t.touches.config.hit, true);
  assert.match(t.stdout, /^new_env: STRIPE_SECRET_KEY,WEBHOOK_SECRET,VITE_API_URL,SENTRY_DSN,RESEND_KEY,FEATURE_FLAG$/m);
  r.commit({ "src/pay.ts": null });
  assert.deepEqual(r.classify().new_env, [], "a variable no longer read is no new one");
});

test("classify-diff refuses a project without the touch rules setup copies", () => {
  const p = project();
  const r = startRun(p);
  r.commit({ "src/a.ts": "export const a = 1;\n" });
  const c = script("classify-diff.mjs", p.dir, ["--run", r.id]);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /no \.factory\/touch-rules\.json on main: run \/setup-factory/);
});
