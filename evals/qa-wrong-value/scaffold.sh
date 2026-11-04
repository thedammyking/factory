set -e
# On macOS the eval sandbox can't run /usr/bin/git, an xcrun stub whose cache lies outside it, and the
# agent's shell picks that stub. Point the shell at the real binary, in the eval run's own home only.
case "$HOME" in */e-*/home)
  if [ "$PWD" = "$HOME/cwd" ] && command -v xcrun >/dev/null; then
    printf 'git() { "%s" "$@"; }\n' "$(xcrun -f git)" | tee -a "$HOME/.zshenv" >> "$HOME/.bashrc"
  fi ;;
esac
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory test

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "api", "type": "backend", "path": ".", "dev": "PORT={port:api} node server.mjs", "health": "http://localhost:{port:api}/health",
  "checks": { "test": "node --test test/cart.test.mjs" } }], "pinned": ["e2e"] }
EOF

cat > package.json <<'EOF'
{ "name": "shop", "type": "module", "scripts": { "dev": "node server.mjs", "test": "node --test test/cart.test.mjs" } }
EOF

# The planted problem: the total adds each price once, whatever the quantity, so the seeded cart totals 2750, not 4250.
cat > server.mjs <<'EOF'
import http from "node:http";

const cart = [{ sku: "notebook", price: 1500, quantity: 2 }, { sku: "pen", price: 1250, quantity: 1 }];

http.createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  if (req.method === "GET" && req.url === "/api/cart/total") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ total: cart.reduce((sum, item) => sum + item.price, 0) }));
  }
  res.statusCode = 404;
  res.end();
}).listen(Number(process.env.PORT));
EOF

cat > test/cart.test.mjs <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";

test("the cart test seam runs", () => assert.ok(true));
EOF

git add -A
git commit -qm "Serve the cart total"

# The run's worktree with its run dir, and the ticket's worktree cut from it, as run-state and run-stage lay them out.
git worktree add -q --detach .factory/worktrees/r1
RUN="$PWD/.factory/worktrees/r1/.factory/runs/r1"
mkdir -p "$RUN/tickets/01"
cat > "$RUN/state.json" <<EOF
{ "id": "r1", "request": "The cart total ignores quantities.", "stage": "qa:01", "route": "build", "base_branch": "main",
  "base_sha": "$(git rev-parse HEAD)", "worktree": "$PWD/.factory/worktrees/r1", "run_dir": "$RUN", "dispatches": [], "stages_done": [],
  "created_at": "2026-11-04T09:00:00.000Z" }
EOF
git worktree add -q -b factory/r1/01 .factory/worktrees/r1-01

cat > "$RUN/spec.md" <<'EOF'
---
surface: operate
---

# Cart total counts quantities

<frozen-after-approval>
Shoppers who buy more than one of an item see a total that charges for one. The cart's total counts every item they hold, so what they see is what they pay.
</frozen-after-approval>

## Goal
The cart total is each item's price times its quantity, summed.

## Functional requirements
- **FR-001**: `GET /api/cart/total` answers the cart's total in cents, as JSON `{ "total": <cents> }`, counting each item's price times its quantity.

## Success criteria
- **SC-001** (profile: default, live-safe: yes): With the seeded cart (2 notebooks at 1500 cents and 1 pen at 1250 cents), `GET /api/cart/total` answers 200 with the JSON body `{ "total": 4250 }`.

## Out of scope
- Discounts, tax and shipping.
EOF

cat > "$RUN/tickets/01-cart-total.md" <<'EOF'
# 01: Cart total counts quantities

Status: in-progress
Blocked by: none

## Goal
The cart total endpoint counts each item's quantity.

## Covers
- [ ] FR-001, SC-001: the seeded cart totals 4250 cents.

## Interfaces
- Consumes: the seeded cart the server holds.
- Produces: `GET /api/cart/total`, answering `{ "total": <cents> }`.

## Notes
- none
EOF

cat > "$RUN/tickets/01/plan.md" <<'EOF'
---
status: ready
ticket: 01-cart-total
context:
  - server.mjs
---

# Plan 01: Cart total counts quantities

<frozen-after-approval>
Shoppers who buy more than one of an item see a total that charges for one. The cart's total counts every item they hold, so what they see is what they pay.
</frozen-after-approval>

## Code map
- `server.mjs` (change): the total sums price times quantity.

## Interfaces
- Consumes: the seeded cart in `server.mjs`.
- Produces: `GET /api/cart/total`, answering 200 with `{ "total": <cents> }`.

## Tasks
1. **Given** the seeded cart **When** `GET /api/cart/total` is called **Then** it answers `{ "total": 4250 }`. Test first: `test/cart.test.mjs`.

## Verification
- `node --test test/cart.test.mjs` → 0 failures.

## Open questions
- none
EOF

cat > "$RUN/tickets/01/evidence.json" <<EOF
{ "mode": "full", "sha": "$(git rev-parse HEAD)", "green": true, "dirty": false, "trusted": true, "red_cause": null, "pinned_only": false,
  "checks": [{ "app": "api", "check": "test", "cmd": "node --test test/cart.test.mjs", "status": "pass" }] }
EOF
