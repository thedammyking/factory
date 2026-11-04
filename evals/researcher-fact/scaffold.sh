set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory/runs/r1 src/uploads test

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
{ "name": "acme-support", "type": "module", "scripts": { "test": "node --test" } }
EOF

cat > src/tickets.js <<'EOF'
export function createTicket(store, { title, body }) {
  const ticket = { id: store.length + 1, title, body, status: "open" };
  store.push(ticket);
  return ticket;
}
EOF

cat > src/uploads/limits.js <<'EOF'
// What the upload endpoint accepts. The gateway in front of the API turns away
// any request body larger than this before it reaches the code.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = ["image/png", "image/jpeg", "application/pdf"];
EOF

cat > src/uploads/upload.js <<'EOF'
import { MAX_UPLOAD_BYTES, ALLOWED_TYPES } from "./limits.js";

export function uploadProblem({ size, type }) {
  if (size > MAX_UPLOAD_BYTES) return "too large";
  if (!ALLOWED_TYPES.includes(type)) return "type not allowed";
  return null;
}
EOF

cat > test/tickets.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTicket } from "../src/tickets.js";

test("a new ticket is open", () => {
  assert.equal(createTicket([], { title: "Broken login", body: "" }).status, "open");
});
EOF

cat > .factory/runs/r1/prompt.md <<'EOF'
Let users attach files to support tickets.
EOF

cat > .factory/runs/r1/triage.md <<'EOF'
A feature: support tickets gain file attachments. It changes the ticket model and reuses the upload checks.

```json
{ "type": "feature", "reason": "It adds attachments to tickets, which have none.", "contract": "READY", "questions": [], "acceptance_check": "A ticket created with a PDF attached lists that attachment when it is read back.", "size": "m", "route": "build", "in_production": false, "base_branch": "main", "target_branch": "main", "branch": "feature/ticket-attachments" }
```
EOF

cat > .factory/runs/r1/research.md <<'EOF'
# Research: Let users attach files to support tickets.

## Codebase
- `src/tickets.js:1`: `createTicket` builds a ticket from a title and a body; the change adds its attachments here.
- `test/tickets.test.js:5`: the ticket tests, run with `node --test`; an attachment test sits beside them.

## Packages
- none

## Risks and unknowns
- none

Status: ok
EOF

git add -A
git commit -qm "Open support tickets, and check uploads"
