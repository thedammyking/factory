---
description: Given a plan and a red pinned test, the implementer makes the whole test run pass without editing the pinned test, and commits.
max_turns: 15
timeout_seconds: 1800
allowed_tools: [Agent]
---

Dispatch the factory:implementer agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/worktrees/r1/.factory/runs/r1
worktree: .factory/worktrees/r1-01
ticket: 01-csv-of-matching-rows
plan: .factory/worktrees/r1/.factory/runs/r1/tickets/01/plan.md
implementation: .factory/worktrees/r1/.factory/runs/r1/tickets/01/implementation.md

Implement the plan.

Then run this with Bash, exactly as written, and reply with its output and nothing else:

(cd .factory/worktrees/r1-01 && node --test --test-reporter=tap) > test-run.txt 2>&1; tail -n 8 test-run.txt
