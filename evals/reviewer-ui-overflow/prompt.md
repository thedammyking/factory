---
description: Captures whose heading runs past the right edge at 390 px get a P0 or P1 UI finding that names a 390 px capture, past check 0.
max_turns: 10
timeout_seconds: 900
allowed_tools: [Agent]
---

Dispatch the factory:reviewer-ui agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/runs/r1
worktree: .
base_sha: main

Then reply with every line the agent returned, exactly as it returned them, and nothing else.
