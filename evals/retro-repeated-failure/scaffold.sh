set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
OK=.factory/history/2026-10-28-reset-link-copy
RUN=.factory/history/2026-10-30-cart-discount
mkdir -p .factory/runs/retro src test "$OK" "$RUN/tickets/01"

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "merge": "trial", "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "api", "type": "backend", "path": ".", "checks": { "test": "node --test" } }] }
EOF

cat > package.json <<'EOF'
{ "name": "acme-shop-api", "type": "module", "scripts": { "test": "node --test" } }
EOF

cat > src/money.js <<'EOF'
// Every amount is an integer number of cents.
export const applyRate = (cents, rate) => Math.round(cents * rate);
export const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;
EOF

cat > src/cart.js <<'EOF'
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
EOF

cat > test/cart.test.mjs <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/cart.js";

test("a cart totals each price times its quantity, in cents", () => {
  assert.equal(cartTotal([{ price: 999, quantity: 1 }]), 999);
});
EOF

cat > .factory/index.md <<'EOF'
# Index

What the factory reads first about this project: one line per thing worth knowing, with where it lives. The retro adds lines here when you accept them.

## Apps

- `api` (backend): `.`

## Memory

- `.factory/log.md`: one line per event of every run, appended when the run ends.
- `.factory/lessons.md`: lessons from past runs that you accepted.
EOF

cat > .factory/lessons.md <<'EOF'
# Lessons
EOF

cat > .factory/log.md <<'EOF'
# Log
- 2026-10-28T09:12:03.000Z run: 2026-10-28-reset-link-copy started
- 2026-10-28T09:14:40.000Z run: 2026-10-28-reset-link-copy on feature/reset-link-copy from main at 1c0ffee
- 2026-10-28T09:31:12.000Z run: 2026-10-28-reset-link-copy delivered
- 2026-10-30T14:02:11.000Z run: 2026-10-30-cart-discount started
- 2026-10-30T14:03:40.000Z run: 2026-10-30-cart-discount on feature/cart-discount from main at 3f2a9c1
- 2026-10-30T14:21:05.000Z run: 2026-10-30-cart-discount implement:01 round 1/3
- 2026-10-30T14:33:52.000Z run: 2026-10-30-cart-discount implement:01 round 2/3
- 2026-10-30T14:47:19.000Z escalation: implement:01 the same failure as round 2
- 2026-10-30T14:47:20.000Z run: 2026-10-30-cart-discount needs-human
EOF

cat > "$OK/run.log" <<'EOF'
- 2026-10-28T09:12:03.000Z run: 2026-10-28-reset-link-copy started
- 2026-10-28T09:14:40.000Z run: 2026-10-28-reset-link-copy on feature/reset-link-copy from main at 1c0ffee
- 2026-10-28T09:31:12.000Z run: 2026-10-28-reset-link-copy delivered
EOF

cat > "$OK/state.json" <<'EOF'
{ "id": "2026-10-28-reset-link-copy", "stage": "delivered", "route": "oneshot", "base_branch": "main", "rounds": {} }
EOF

cat > "$RUN/run.log" <<'EOF'
- 2026-10-30T14:02:11.000Z run: 2026-10-30-cart-discount started
- 2026-10-30T14:03:40.000Z run: 2026-10-30-cart-discount on feature/cart-discount from main at 3f2a9c1
- 2026-10-30T14:21:05.000Z run: 2026-10-30-cart-discount implement:01 round 1/3
- 2026-10-30T14:33:52.000Z run: 2026-10-30-cart-discount implement:01 round 2/3
- 2026-10-30T14:47:19.000Z escalation: implement:01 the same failure as round 2
- 2026-10-30T14:47:20.000Z run: 2026-10-30-cart-discount needs-human
EOF

cat > "$RUN/state.json" <<'EOF'
{ "id": "2026-10-30-cart-discount", "stage": "needs-human", "route": "oneshot", "base_branch": "main", "rounds": { "implement:01": { "n": 2, "cap": 3 } } }
EOF

cat > "$RUN/triage.md" <<'EOF'
A 10% discount on carts of 5000 cents or more, in `src/cart.js`.

```json
{ "type": "feature", "reason": "It adds a discount to the cart total.", "contract": "READY", "questions": [], "acceptance_check": "cartTotal of a 5999-cent cart returns 5399.", "size": "s", "route": "oneshot", "in_production": false, "base_branch": "main", "target_branch": "main", "branch": "feature/cart-discount" }
```
EOF

cat > "$RUN/tickets/01/plan.md" <<'EOF'
# Plan: 10% off carts of 5000 cents or more

1. Add a failing test to `test/cart.test.mjs`: a cart of one 5999-cent item totals 5399.
2. In `src/cart.js`, take 10% off a total of 5000 or more.
EOF

cat > "$RUN/tickets/01/implementation.round1.md" <<'EOF'
- 7a1d2e0 Take 10% off carts of 5000 cents or more: the plan's step 2

status: DONE_WITH_CONCERNS
blocked_cause: none
assumptions:
- the discount is total * 0.9
concerns:
- verify --fast is red: test/cart.test.mjs "a 5999-cent cart totals 5399" fails with expected 5399, actual 5399.1
denied:
- none
assessment:
  recommendation: needs-human
  confident: false
  reason: the discount test fails.
EOF

cat > "$RUN/tickets/01/implementation.md" <<'EOF'
- 9b3c4f1 Apply the discount after summing: the round 1 fix

status: DONE_WITH_CONCERNS
blocked_cause: none
assumptions:
- the discount is applied to the summed total as total - total * 0.1
concerns:
- verify --fast is still red: test/cart.test.mjs "a 5999-cent cart totals 5399" fails with expected 5399, actual 5399.1
denied:
- none
assessment:
  recommendation: needs-human
  confident: false
  reason: the discount test still fails the same way.
EOF

cat > "$RUN/tickets/01/evidence.json" <<'EOF'
{
  "mode": "fast",
  "sha": "9b3c4f1e2d0a6b8c7d5e4f3a2b1c0d9e8f7a6b5c",
  "green": false,
  "dirty": false,
  "trusted": true,
  "red_cause": "introduced",
  "checks": [
    {
      "app": "api",
      "check": "test",
      "status": "fail",
      "digest": "not ok 2 - a 5999-cent cart totals 5399\n  error: 'Expected values to be strictly equal:\\n\\n5399.1 !== 5399\\n'\n  expected: 5399\n  actual: 5399.1\n# fail 1\nfull output: .factory/runs/2026-10-30-cart-discount/logs/verify-test.log"
    }
  ]
}
EOF

cat > "$RUN/attention-implement-01.md" <<'EOF'
# Ticket 01 failed the same way in two rounds

Run `2026-10-30-cart-discount`, stage `implement:01`.

## What happened
Both rounds took 10% off with a float multiply, and `test/cart.test.mjs` failed each time with 5399.1 against 5399. `round implement:01` escalated: the same failure as round 2.

## Evidence
- `tickets/01/implementation.md`
- `tickets/01/implementation.round1.md`
- `tickets/01/evidence.json`

## Recommendation
Round the discounted total to whole cents.

## Options
- `/factory abandon 2026-10-30-cart-discount`: ends the run abandoned
EOF

cat > .factory/runs/retro/record.txt <<'EOF'
RECORD 0 of the last 0 counted agree (0 agree, 0 disagree, 0 not counted)
EOF

git add -A
git commit -qm "Total carts in cents"
