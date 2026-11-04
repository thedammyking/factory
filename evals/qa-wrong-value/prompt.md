---
description: Against an app whose cart total ignores quantity, qa's pinned test asserts the spec's total, not the app's, and qa.json records the criterion fail.
max_turns: 10
timeout_seconds: 1800
allowed_tools: [Agent]
---

Dispatch the factory:qa agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/worktrees/r1/.factory/runs/r1
worktree: .factory/worktrees/r1-01
ticket: 01-cart-total
evidence: .factory/worktrees/r1/.factory/runs/r1/tickets/01/evidence.json

Then reply with every line the agent returned, exactly as it returned them, and nothing else.
