# Software factory

A Claude Code plugin that carries a one-line request through triage, spec, tickets, implementation, verification, review and PR to a merge decision made from facts.

## Language

### Runs

**Run**:
One request carried through the factory, from the prompt to a terminal outcome (delivered, needs-human, failed or abandoned).
_Avoid_: job, session, pipeline execution

**Orchestrator**:
The skill that drives exactly one run from its own session: it routes between stages, dispatches each one and records progress, and it is where the human answers the grill and the gates. Several runs at once means several orchestrators.
_Avoid_: supervisor, controller, driver

**Stage**:
One step of a run with named input files and one named output file, performed by a fresh agent or a script.
_Avoid_: phase, step, node

**Route**:
The path a run takes through the stages, chosen at triage from the request's type and size.
_Avoid_: workflow, mode

**Lane**:
The branch a run works on and the base it starts from, chosen at triage by the branching model.
_Avoid_: branch strategy

**Gate**:
A point where the run stops until the human decides, such as approving the spec.
_Avoid_: checkpoint, approval step

**Cap**:
A limit on rounds, dispatches, minutes or tokens that stops the run when crossed.
_Avoid_: budget (when meaning a single limit), quota

**Override**:
A human's recorded decision to lift a cap for one run.

**Attention item**:
The single format in which the factory asks the human for a decision: what happened, the evidence, a recommendation and the options.
_Avoid_: escalation message, alert

### Work

**Spec**:
The approved statement of what a run delivers: requirements, numbered success criteria, analytics events and anti-goals.
_Avoid_: PRD, requirements doc

**Success criterion**:
One runnable or observable check in a spec that the run must prove.
_Avoid_: acceptance test, AC

**Ticket**:
One vertical slice of a run's spec, sized to a single fresh implementer.
_Avoid_: issue, task, story, decision ticket (a wayfinder map's question)

**Plan**:
The implementer's sole source of truth for one ticket.
_Avoid_: brief, design doc

### Proof

**Recipe**:
The project's proven commands for setting up, checking, running and previewing each app.
_Avoid_: config, manifest

**Profile**:
A named environment the recipe can start the apps in, for success criteria that need other conditions.
_Avoid_: env, scenario

**Evidence**:
The result of running the recipe's checks, pinned to one commit.
_Avoid_: test results, report

**Lens**:
One read-only reviewer's angle on the diff: code, UI, security or a human's PR comments.
_Avoid_: reviewer type, pass

**Finding**:
One typed claim a lens makes about the diff, with a severity and an action.
_Avoid_: issue, comment, bug

**Golden task**:
A fixed request with known expected outcomes, used to check the factory itself for regressions.
_Avoid_: benchmark, e2e test
