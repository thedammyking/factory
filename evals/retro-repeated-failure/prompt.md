---
description: A run whose ticket failed the same way in two rounds gets a lesson proposed for that failure, and nothing that tests the factory.
max_turns: 10
timeout_seconds: 900
allowed_tools: [Agent]
---

Dispatch the factory:retro agent in the foreground with exactly this prompt, and wait for it to finish:

retro: .factory/runs/retro/retro.md
record: .factory/runs/retro/record.txt
worktree: .
base: main

Then reply with every line the agent returned, exactly as it returned them, and nothing else.
