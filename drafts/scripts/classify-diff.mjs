#!/usr/bin/env node
// classify-diff.mjs <base_sha> [--run <id>] -> touches.json
// Touch mask from changed paths + diff content. Rules are globs/regexes in .factory/touch-rules.json (overridable).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const baseSha = process.argv[2];
const runIdx = process.argv.indexOf("--run");
const runId = runIdx > -1 ? process.argv[runIdx + 1] : fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const sh = (c) => execSync(c, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const defaults = {
  auth: { paths: ["auth", "guard", "middleware", "session", "login", "signup", "password", "token"], content: ["@UseGuards", "jwt", "bcrypt", "argon2", "cookie", "Authorization"] },
  data: { paths: ["prisma", "migrations", "schema", "models", "repository", "db", "database", "seed"], content: ["prisma\\.", "\\.query\\(", "INSERT INTO", "SELECT ", "createTable", "knex", "drizzle"] },
  network: { paths: ["webhook", "queue", "jobs", "client"], content: ["fetch\\(", "axios", "got\\(", "undici", "WebSocket", "new URL\\("] },
  files: { paths: ["upload"], content: ["fs\\.", "multer", "createReadStream", "path\\.join\\(.*req"] },
  crypto: { paths: [], content: ["crypto\\.", "createHash", "randomBytes", "subtle\\."] },
  config: { paths: [".env", "next.config", "main.ts", "app.module", "vite.config", "tsconfig"], content: ["process\\.env\\.", "cors\\(", "helmet"] },
  deps: { paths: ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"], content: [] },
  native: { paths: ["app.json", "app.config", "ios/", "android/", "eas.json"], content: ["expo-modules", "react-native-"] },
  api_contract: { paths: ["controller", "routes", "route.ts", "api/", "dto", "actions"], content: ["app\\.(get|post|put|patch|delete)\\(", "@(Get|Post|Put|Patch|Delete)\\(", "export async function (GET|POST|PUT|PATCH|DELETE)", "'use server'"] },
  ui: { paths: [".tsx", ".jsx", ".css", ".scss", "screens/", "components/"], content: [] },
  tests: { paths: [".test.", ".spec.", "__tests__", "e2e/", ".maestro/"], content: [] },
  analytics: { paths: ["analytics", "tracking"], content: ["track\\(", "capture\\(", "posthog", "mixpanel", "amplitude", "gtag\\(", "logEvent\\("] },
};
const rules = Object.assign(defaults, JSON.parse(fs.existsSync(path.join(ROOT, ".factory/touch-rules.json")) ? fs.readFileSync(path.join(ROOT, ".factory/touch-rules.json"), "utf8") : "{}"));

const files = sh(`git diff --name-only ${baseSha}..HEAD`).split("\n").filter(Boolean);
const diff = sh(`git diff ${baseSha}..HEAD -- . ':(exclude)*.lock' ':(exclude)pnpm-lock.yaml' ':(exclude)package-lock.json'`);
const added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).join("\n");

const touches = {};
for (const [cat, r] of Object.entries(rules)) {
  if (cat.startsWith("_") || !r || !Array.isArray(r.paths)) continue;
  const byPath = files.filter(f => r.paths.some(p => f.toLowerCase().includes(p.toLowerCase())));
  const byContent = r.content.filter(re => new RegExp(re, "i").test(added));
  touches[cat] = { hit: byPath.length > 0 || byContent.length > 0, paths: byPath.slice(0, 20), patterns: byContent };
}
const out = { base_sha: baseSha, head: sh("git rev-parse HEAD").trim(), files_changed: files.length, touches };
fs.writeFileSync(path.join(ROOT, ".factory/runs", runId, "touches.json"), JSON.stringify(out, null, 2) + "\n");
console.log("TOUCHES " + Object.entries(touches).filter(([, v]) => v.hit).map(([k]) => k).join(",") + ` files=${files.length}`);
