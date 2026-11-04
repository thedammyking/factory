---
description: A diff that swallows a failed order save, so a customer is charged for an order that's lost, gets a P0 or P1 code finding at src/checkout.js.
max_turns: 10
timeout_seconds: 900
allowed_tools: [Agent]
---

Dispatch the factory:reviewer-code agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/runs/r1
worktree: .
base_sha: main

Then reply with every line the agent returned, exactly as it returned them, and nothing else.
