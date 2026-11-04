---
description: A ticket on a small repo gets a plan that names a real path and writes a failing test before the change.
max_turns: 10
timeout_seconds: 900
allowed_tools: [Agent]
---

Dispatch the factory:planner agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/runs/r1
worktree: .
base_sha: HEAD
mode: plan
ticket: 01-csv-of-matching-rows

Then reply with every line the agent returned, exactly as it returned them, and nothing else.
