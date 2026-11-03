set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory/runs/r1 src test

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
{ "name": "acme-shop-api", "type": "module", "scripts": { "start": "node src/server.js", "test": "node --test" } }
EOF

cat > src/server.js <<'EOF'
import http from "node:http";
import { cartTotal } from "./cart.js";

const cart = [{ sku: "mug", price: 500, quantity: 2 }];

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/cart") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ items: cart, total: cartTotal(cart) }));
  }
  res.statusCode = 404;
  res.end();
}).listen(process.env.PORT || 3000);
EOF

cat > src/cart.js <<'EOF'
// Prices are in cents.
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
EOF

cat > test/cart.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/cart.js";

test("an empty cart totals 0", () => {
  assert.equal(cartTotal([]), 0);
});
EOF

cat > .factory/runs/r1/prompt.md <<'EOF'
GET /cart returns the wrong total: the cart holds two 500-cent mugs, and the total comes back as 500 instead of 1000. It ignores each item's quantity. Fix it.
EOF

git add -A
git commit -qm "Serve the cart"
