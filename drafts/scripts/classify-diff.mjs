#!/usr/bin/env node
// classify-diff.mjs <base_sha> [--run <id>] -> touches.json
// Touch mask from changed paths + diff content. Rules are globs/regexes in .factory/touch-rules.json (overridable).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runContext } from "./lib.mjs";

const { ROOT, RUN } = runContext();
const baseSha = process.argv[2];
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Conservative shipped defaults (same as touch-rules.json): directory/file segments and specific patterns, never bare
// substrings like "token" or "client", which fired auth and files on a diff with neither (dry-run fix 9).
const defaults = {
  auth: {"paths": ["/auth/", "/guards/", "/middleware/", "/session", "/login", "/passport"], "content": ["@UseGuards", "jsonwebtoken", "\\bjwt\\.", "bcrypt", "argon2", "passport", "set-cookie", "Authorization:", "getServerSession", "\\bauth\\("]},
  data: {"paths": ["/prisma/", "/migrations/", "schema.prisma", "/models/", "/repositories/", "/db/", "/store."], "content": ["prisma\\.", "\\.query\\(", "INSERT INTO", "SELECT .* FROM", "knex\\(", "drizzle", "better-sqlite3", "node:sqlite", "writeFile\\("]},
  migrations: {"paths": ["/migrations/", "/migrate/", "schema.prisma", "/alembic/versions/", "/drizzle/"], "content": []},
  network: {"paths": ["/webhooks/", "/queue", "/jobs/"], "content": ["\\bfetch\\(", "axios", "\\bgot\\(", "undici", "new WebSocket", "http\\.request"]},
  files: {"paths": ["/uploads/"], "content": ["multer", "createReadStream", "formData\\(\\)\\.get", "fs\\.promises"]},
  crypto: {"paths": [], "content": ["crypto\\.", "randomBytes", "createHash", "subtle\\."]},
  config: {"paths": [".env", "next.config", "vite.config", "nest-cli", "/main.ts", "app.module", "tsconfig"], "content": ["process\\.env\\.", "import\\.meta\\.env", "cors\\(", "helmet\\("]},
  deps: {"paths": ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"], "content": []},
  native: {"paths": ["app.json", "app.config.", "/ios/", "/android/", "eas.json"], "content": ["expo-modules", "react-native-"]},
  api_contract: {"paths": ["/controllers/", "/routes/", "route.ts", "/api/", "/dto/", "/actions/", "/app.ts"], "content": ["app\\.(get|post|put|patch|delete)\\(", "@(Get|Post|Put|Patch|Delete)\\(", "export async function (GET|POST|PUT|PATCH|DELETE)", "'use server'"]},
  ui: {"paths": [".tsx", ".jsx", ".css", ".scss", "/screens/", "/components/", "index.html"], "content": []},
  tests: {"paths": [".test.", ".spec.", "__tests__", "/e2e/", ".maestro/"], "content": []},
  analytics: {"paths": ["analytics", "track.ts", "tracking"], "content": ["\\btrack\\(", "\\bcapture\\(", "posthog", "mixpanel", "amplitude", "gtag\\(", "logEvent\\("]},
};
const rules = Object.assign(defaults, JSON.parse(fs.existsSync(path.join(ROOT, ".factory/touch-rules.json")) ? fs.readFileSync(path.join(ROOT, ".factory/touch-rules.json"), "utf8") : "{}"));

// Factory bookkeeping and plugin files are not the product: .factory/ is left out of both the file list and the content scan.
const files = git("diff", "--name-only", `${baseSha}..HEAD`, "--", ".", ":(exclude).factory").split("\n").filter(Boolean);
const diff = git("diff", `${baseSha}..HEAD`, "--", ".", ":(exclude).factory", ":(exclude)*.lock", ":(exclude)pnpm-lock.yaml", ":(exclude)package-lock.json");
const added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).join("\n");

const touches = {};
for (const [cat, r] of Object.entries(rules)) {
  if (cat.startsWith("_") || !r || !Array.isArray(r.paths)) continue;
  const byPath = files.filter(f => r.paths.some(p => ("/" + f).toLowerCase().includes(p.toLowerCase())));  // "/auth/" also matches a top-level auth/
  const byContent = r.content.filter(re => new RegExp(re, "i").test(added));
  touches[cat] = { hit: byPath.length > 0 || byContent.length > 0, paths: byPath.slice(0, 20), patterns: byContent };
}
const out = { base_sha: baseSha, head: git("rev-parse", "HEAD").trim(), files_changed: files.length, touches };
fs.writeFileSync(path.join(RUN, "touches.json"), JSON.stringify(out, null, 2) + "\n");
console.log("TOUCHES " + Object.entries(touches).filter(([, v]) => v.hit).map(([k]) => k).join(",") + ` files=${files.length}`);
