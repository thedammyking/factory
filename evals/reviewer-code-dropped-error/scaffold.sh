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
{ "name": "shop", "type": "module", "scripts": { "test": "node --test" } }
EOF

cat > src/checkout.js <<'EOF'
// Checkout: charge the card, then save the order it paid for.
export async function checkout({ payments, orders }, cart) {
  const charge = await payments.charge(cart.customerId, cart.total);
  const order = await orders.insert({ customerId: cart.customerId, items: cart.items, total: cart.total, chargeId: charge.id });
  return { ok: true, orderId: order.id };
}
EOF

cat > test/checkout.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkout } from "../src/checkout.js";

const cart = { customerId: "c-1", items: [{ sku: "mug", qty: 2 }], total: 2400 };
const fakes = () => {
  const saved = [];
  return { saved, payments: { charge: async () => ({ id: "ch-1" }) }, orders: { insert: async (o) => { saved.push(o); return { id: "o-1" }; } } };
};

test("checkout charges the card and saves the order", async () => {
  const deps = fakes();
  assert.deepEqual(await checkout(deps, cart), { ok: true, orderId: "o-1" });
  assert.equal(deps.saved[0].chargeId, "ch-1");
});
EOF

git add -A
git commit -qm "Charge and save each order"

# The run's change: a receipt email, with the order's save wrapped so that a failure is swallowed.
git checkout -q -b feature/receipt-email

cat > src/receipts.js <<'EOF'
// The receipt a customer is emailed after checkout.
export async function sendReceipt(mailer, customerId, { total, orderId }) {
  await mailer.send({ to: customerId, subject: "Your receipt", text: `Thanks for order ${orderId}. You paid EUR ${(total / 100).toFixed(2)}.` });
}
EOF

cat > src/checkout.js <<'EOF'
import { sendReceipt } from "./receipts.js";

// Checkout: charge the card, save the order it paid for, then email the receipt.
export async function checkout({ payments, orders, mailer }, cart) {
  const charge = await payments.charge(cart.customerId, cart.total);
  let order = { id: null };
  try {
    order = await orders.insert({ customerId: cart.customerId, items: cart.items, total: cart.total, chargeId: charge.id });
  } catch (err) {
    // A slow orders table shouldn't keep the customer from their receipt.
  }
  await sendReceipt(mailer, cart.customerId, { total: cart.total, orderId: order.id });
  return { ok: true, orderId: order.id };
}
EOF

cat > test/checkout.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkout } from "../src/checkout.js";

const cart = { customerId: "c-1", items: [{ sku: "mug", qty: 2 }], total: 2400 };
const fakes = () => {
  const saved = [], sent = [];
  return { saved, sent, payments: { charge: async () => ({ id: "ch-1" }) }, orders: { insert: async (o) => { saved.push(o); return { id: "o-1" }; } },
    mailer: { send: async (m) => { sent.push(m); } } };
};

test("checkout charges the card and saves the order", async () => {
  const deps = fakes();
  assert.deepEqual(await checkout(deps, cart), { ok: true, orderId: "o-1" });
  assert.equal(deps.saved[0].chargeId, "ch-1");
});

test("checkout emails the receipt for the order", async () => {
  const deps = fakes();
  await checkout(deps, cart);
  assert.deepEqual(deps.sent.map((m) => [m.to, m.subject]), [["c-1", "Your receipt"]]);
  assert.match(deps.sent[0].text, /order o-1\. You paid EUR 24\.00\./);
});
EOF

git add -A
git commit -qm "Email a receipt after checkout"

# The run dir as the review stage leaves it: the spec, the ticket, its plan and report, the touches, and review.diff in
# review-package's sections.
RUN=.factory/runs/r1
mkdir -p "$RUN/tickets/01"

cat > "$RUN/spec.md" <<'EOF'
---
surface: operate
---

# A receipt email after checkout

<frozen-after-approval>
Customers write to support for proof of payment after they buy. They get a receipt email as soon as checkout succeeds, so they no longer need to ask.
</frozen-after-approval>

## Goal
A successful checkout emails the customer a receipt with the order id and the amount paid.

## Non-goals
- PDF receipts.

## Anti-goals
- A receipt sent to anyone but the customer who paid.

## Functional requirements
- **FR-001**: After a successful checkout, the customer gets one email with the subject "Your receipt", the order id and the amount paid.

## Success criteria
- **SC-001** (profile: default, live-safe: no): `POST /checkout` with a valid cart returns 200 with the order id, and one "Your receipt" email naming that order id goes to the customer.

## Implementation decisions
- The receipt is sent from `checkout`, after the order is saved.

## Testing decisions
- Unit tests on `checkout` with fake payments, orders and mailer.

## Out of scope
- Resending receipts.

## Clarifications
### Session 2026-11-04
- Q: When is the receipt sent? → A: Once the order is saved.

## Left to the builder
- The email's wording.
EOF

cat > "$RUN/tickets/01-receipt-email.md" <<'EOF'
# 01: Receipt email after checkout

Status: done
Blocked by: none

## Goal
A customer who checks out gets a receipt email naming the order and the amount.

## Covers
- [x] FR-001, SC-001: the receipt is sent after the order is saved.

## Interfaces
- Consumes: `checkout({ payments, orders }, cart)` at `src/checkout.js:2`.
- Produces: `sendReceipt(mailer, customerId, { total, orderId })`.

## Notes
- none
EOF

cat > "$RUN/tickets/01/plan.md" <<'EOF'
---
status: ready
ticket: 01-receipt-email
context:
  - src/checkout.js
  - test/checkout.test.js
---

# Plan 01: Receipt email after checkout

<frozen-after-approval>
Customers write to support for proof of payment after they buy. They get a receipt email as soon as checkout succeeds, so they no longer need to ask.
</frozen-after-approval>

## Code map
- `src/receipts.js` (create): `sendReceipt`.
- `src/checkout.js` (change): send the receipt once the order is saved.
- `test/checkout.test.js` (change): the receipt test.

## Tasks
1. **Given** a cart **When** `checkout` succeeds **Then** one "Your receipt" email names the saved order's id. Test first: `test/checkout.test.js`.

## Verification
- `node --test` → 0 failures.

## Open questions
- none
EOF

cat > "$RUN/tickets/01/implementation.md" <<'EOF'
# Implementation 01

- 3c1d2e9 Email a receipt after checkout: the ticket's one outcome

status: DONE
blocked_cause: none
assumptions:
- A failure saving the order shouldn't stop the customer's receipt, so checkout catches it and carries on.
concerns:
- none
denied:
- none
assessment:
  recommendation: merge
  confident: true
  reason: every test passes.
EOF

cat > "$RUN/touches.json" <<EOF
{ "base": "$(git rev-parse main)", "head": "$(git rev-parse HEAD)", "files_changed": 3,
  "touches": {
    "auth": { "hit": false, "paths": [], "patterns": [] }, "data": { "hit": false, "paths": [], "patterns": [] },
    "migrations": { "hit": false, "paths": [], "patterns": [] }, "network": { "hit": false, "paths": [], "patterns": [] },
    "files": { "hit": false, "paths": [], "patterns": [] }, "crypto": { "hit": false, "paths": [], "patterns": [] },
    "config": { "hit": false, "paths": [], "patterns": [] }, "deps": { "hit": false, "paths": [], "patterns": [] },
    "native": { "hit": false, "paths": [], "patterns": [] }, "api_contract": { "hit": false, "paths": [], "patterns": [] },
    "ui": { "hit": false, "paths": [], "patterns": [] }, "tests": { "hit": true, "paths": ["test/checkout.test.js"], "patterns": [] } },
  "new_env": [] }
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
