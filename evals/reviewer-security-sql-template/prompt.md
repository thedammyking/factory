---
description: An admin search whose SQL is built from the search term by a template literal gets a P0 or P1 security finding with a CWE.
max_turns: 10
timeout_seconds: 900
allowed_tools: [Agent]
---

Dispatch the factory:reviewer-security agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/runs/r1
worktree: .
base_sha: main

Then reply with every line the agent returned, exactly as it returned them, and nothing else.
