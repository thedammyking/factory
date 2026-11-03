---
description: A spec whose SC-003 says only that the export "feels fast" gets a builder-check question naming SC-003.
max_turns: 10
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the factory:builder-check agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/runs/r1
worktree: .
base_sha: HEAD

Then reply with every line the agent returned, exactly as it returned them, and nothing else.
