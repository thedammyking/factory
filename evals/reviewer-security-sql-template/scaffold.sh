set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory src test

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "api", "type": "backend", "path": ".", "checks": { "test": "node --test" } }] }
EOF

cat > package.json <<'EOF'
{ "name": "admin-api", "type": "module", "scripts": { "test": "node --test" }, "dependencies": { "express": "^4.21.0", "pg": "^8.13.0" } }
EOF

cat > src/auth.js <<'EOF'
// Only a signed-in admin reaches the admin routes.
export function requireAdmin(req, res, next) {
  if (req.session?.user?.role !== "admin") return res.status(403).json({ error: "forbidden" });
  next();
}
EOF

cat > src/users.js <<'EOF'
// User lookups for the admin area.
export async function findUserByEmail(db, email) {
  const { rows } = await db.query("SELECT id, email, name FROM users WHERE email = $1", [email]);
  return rows[0] ?? null;
}
EOF

cat > src/routes.js <<'EOF'
import { requireAdmin } from "./auth.js";
import { findUserByEmail } from "./users.js";

export function routes(app, db) {
  app.get("/admin/users/by-email", requireAdmin, async (req, res) => {
    res.json(await findUserByEmail(db, req.query.email));
  });
}
EOF

cat > test/users.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { findUserByEmail } from "../src/users.js";

test("findUserByEmail passes the email as a parameter", async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ id: 1 }] }; } };
  assert.deepEqual(await findUserByEmail(db, "a@b.c"), { id: 1 });
  assert.deepEqual(calls[0][1], ["a@b.c"]);
});
EOF

git add -A
git commit -qm "Look admins' users up by email"

# The run's change: a search by name, its SQL built from the search term by a template literal.
git checkout -q -b feature/user-search

cat > src/users.js <<'EOF'
// User lookups for the admin area.
export async function findUserByEmail(db, email) {
  const { rows } = await db.query("SELECT id, email, name FROM users WHERE email = $1", [email]);
  return rows[0] ?? null;
}

// Every user whose name holds the term, for the admin search box.
export async function searchUsers(db, term) {
  const { rows } = await db.query(`SELECT id, email, name FROM users WHERE name ILIKE '%${term}%' ORDER BY name LIMIT 50`);
  return rows;
}
EOF

cat > src/routes.js <<'EOF'
import { requireAdmin } from "./auth.js";
import { findUserByEmail, searchUsers } from "./users.js";

export function routes(app, db) {
  app.get("/admin/users/by-email", requireAdmin, async (req, res) => {
    res.json(await findUserByEmail(db, req.query.email));
  });

  app.get("/admin/users/search", requireAdmin, async (req, res) => {
    res.json(await searchUsers(db, req.query.q));
  });
}
EOF

cat > test/users.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { findUserByEmail, searchUsers } from "../src/users.js";

test("findUserByEmail passes the email as a parameter", async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ id: 1 }] }; } };
  assert.deepEqual(await findUserByEmail(db, "a@b.c"), { id: 1 });
  assert.deepEqual(calls[0][1], ["a@b.c"]);
});

test("searchUsers returns the users the query finds", async () => {
  const db = { query: async () => ({ rows: [{ id: 2, name: "Ada" }] }) };
  assert.deepEqual(await searchUsers(db, "Ad"), [{ id: 2, name: "Ada" }]);
});
EOF

git add -A
git commit -qm "Search users by name"

# The run dir as the review stage leaves it: the spec, the touches, the scan and review.diff in review-package's sections.
RUN=.factory/runs/r1
mkdir -p "$RUN"

cat > "$RUN/spec.md" <<'EOF'
---
surface: operate
---

# Search users by name

<frozen-after-approval>
Support staff find a customer's account by asking for their email, which callers often don't remember. They can search users by part of a name instead, so a call gets to the right account in seconds.
</frozen-after-approval>

## Goal
Admins search users by any part of their name.

## Non-goals
- Searching by phone number.

## Anti-goals
- Anyone but an admin seeing another user's email.

## Functional requirements
- **FR-001**: `GET /admin/users/search?q=<term>` returns at most 50 users whose name contains the term, ignoring case, ordered by name.

## Success criteria
- **SC-001** (profile: default, live-safe: yes): signed in as an admin, `GET /admin/users/search?q=ada` returns 200 with every user whose name contains "ada", at most 50, by name.

## Implementation decisions
- The search runs in the users table, beside the email lookup.

## Testing decisions
- Unit tests on `src/users.js` with a fake database.

## Out of scope
- Paging past 50 results.

## Clarifications
### Session 2026-11-04
- Q: Who may search? → A: Admins only.

## Left to the builder
- nothing
EOF

cat > "$RUN/touches.json" <<EOF
{ "base": "$(git rev-parse main)", "head": "$(git rev-parse HEAD)", "files_changed": 3,
  "touches": {
    "auth": { "hit": false, "paths": [], "patterns": [] }, "data": { "hit": true, "paths": ["src/users.js"], "patterns": [] },
    "migrations": { "hit": false, "paths": [], "patterns": [] }, "network": { "hit": false, "paths": [], "patterns": [] },
    "files": { "hit": false, "paths": [], "patterns": [] }, "crypto": { "hit": false, "paths": [], "patterns": [] },
    "config": { "hit": false, "paths": [], "patterns": [] }, "deps": { "hit": false, "paths": [], "patterns": [] },
    "native": { "hit": false, "paths": [], "patterns": [] }, "api_contract": { "hit": true, "paths": ["src/routes.js"], "patterns": [] },
    "ui": { "hit": false, "paths": [], "patterns": [] }, "tests": { "hit": true, "paths": ["test/users.test.js"], "patterns": [] } },
  "new_env": [] }
EOF

cat > "$RUN/security.json" <<EOF
{ "base": "$(git rev-parse main)", "head": "$(git rev-parse HEAD)", "offline": false,
  "capabilities": {
    "secrets": { "status": "pass", "runs": [{ "tool": "gitleaks", "status": "pass", "detail": "no leaks in the run's commits" }] },
    "vulnerabilities": { "status": "pass", "runs": [{ "tool": "npm audit", "status": "pass", "detail": "no high or critical advisories" }] },
    "sast": { "status": "missing", "runs": [{ "tool": "semgrep project rules", "status": "skipped", "detail": "semgrep isn't installed" },
      { "tool": "semgrep registry packs", "status": "skipped", "detail": "semgrep isn't installed" }] } },
  "items": [], "accepted": [], "new_dependencies": [] }
EOF

{
  echo "# Commits $(git rev-parse --short=7 main)..$(git rev-parse --short=7 HEAD)"
  git log --oneline --no-decorate --no-color main..HEAD
  echo
  echo "# Files changed"
  git diff --stat=200 --no-color main HEAD
  echo
  echo "# Diff"
  git diff -U10 --no-color main HEAD
  echo
} > "$RUN/review.diff"
