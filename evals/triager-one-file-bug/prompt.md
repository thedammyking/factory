---
description: A clear bug in one product file is READY and routes oneshot.
max_turns: 10
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the factory:triager agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/runs/r1
worktree: .
base_sha: HEAD

Then reply with the agent's first line and nothing else.
