---
type: llm
focus:
  source: file
  path: .factory/runs/r1/tickets/01/plan.md
---

The text is an implementation plan for one ticket.

PASS if, in its tasks, a test of the new behaviour is written and run, and fails, before the code that makes it pass is changed.
FAIL if a task changes the code before any test of it is written, if no task names a test, or if the plan never says the test fails first.
