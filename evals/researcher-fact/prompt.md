---
description: A fact the grill needs, planted on one line of one file, is appended to research.md as a Fact section citing that file and line.
max_turns: 10
timeout_seconds: 600
allowed_tools: [Agent]
---

Dispatch the factory:researcher agent in the foreground with exactly this prompt, and wait for it to finish:

run_dir: .factory/runs/r1
worktree: .
base_sha: HEAD
mode: fact
fact: What is the largest file a user can upload today, and where is that limit set?

Then reply with the agent's first line and nothing else.
