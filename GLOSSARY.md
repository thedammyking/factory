# Software factory

A Claude Code plugin that carries a one-line request through triage, spec, tickets, implementation, verification, review and PR to a merge decision made from facts.

## Language

### Runs

**Run**:
One request carried through the factory, from the prompt to a terminal outcome (delivered, needs-human, failed, abandoned, answered when a reply was the whole deliverable, or charted when the request was handed to a map).
_Avoid_: job, session, pipeline execution

**Request issue**:
The tracker issue a run belongs to: the one it was started from, its run-list entry's own issue, or, for a run started from plain text, the one it files when its spec is approved. The run's tickets hang off it as sub-issues.
_Avoid_: source issue, linked issue, ticket

**Orchestrator**:
The skill that drives exactly one run from its own session: it routes between stages, dispatches each one and records progress, and it is where the human answers the grill and any question the run stops on. A map's runs go one after another under one orchestrator; several unrelated runs at once means several orchestrators.
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
A point where the run stops until the human decides, such as whether to chart a map. Once the grill is over, a run has none until its PR.
_Avoid_: checkpoint, approval step

**Cap**:
A limit on rounds, dispatches, minutes or tokens that stops the run when crossed.
_Avoid_: budget (when meaning a single limit), quota

**Override**:
A human's recorded decision to lift a cap for one run.

**Attention item**:
The single format in which the factory asks the human for a decision: what happened, the evidence, a recommendation with its benefit and trade-off, and the options. It is put to the human as a question with those options, and kept in the run as the record.
_Avoid_: escalation message, alert

**Retro**:
A look back over finished runs that proposes at most three durable changes (a lesson, an index line, an ADR or a mechanical rule) and applies only the ones the human accepts.
_Avoid_: postmortem, review (a lens's job), golden task

### Work

**Grill**:
The decisions a run puts to the human before its spec is written, each with options. Questions come one at a time or all at once, as the project chose at setup. Facts are researched, never asked. A run from a map's run list has none of its own: the map was its grill.
_Avoid_: interview, Q&A, questionnaire

**Factory's call**:
A decision the factory makes in the human's place once the grill is over, taking the recommended answer, and lists on the PR for the human to review.
_Avoid_: default (a recommended answer before it is taken), assumption (an implementer's)

**Spec**:
The approved statement of what a run delivers: requirements, numbered success criteria and anti-goals.
_Avoid_: PRD, requirements doc

**Success criterion**:
One runnable or observable check in a spec that the run must prove.
_Avoid_: acceptance test, AC

**Acceptance check**:
The one check written at triage from the request text alone. A request without one is not ready, and on the oneshot route it is the run's only success criterion.
_Avoid_: acceptance criterion, acceptance test

**Ticket**:
One vertical slice of a run's spec, sized to a single fresh implementer.
_Avoid_: issue, task, story, decision ticket (a wayfinder map's question)

**Plan**:
The implementer's sole source of truth for one ticket.
_Avoid_: brief, design doc

**Design token**:
A named color, type, space, radius or duration value that a project's UI is built from.
_Avoid_: token (on its own, which means model tokens), theme value, variable

### Maps

**Map**:
A shared plan for a request too foggy for one run: the decisions made so far, the open decision tickets and the fog ahead, ending in a run list.
_Avoid_: epic, roadmap, project

**Decision ticket**:
One question on a map whose answer is a decision, not a slice of work.
_Avoid_: ticket (a run's slice), issue

**Tracker**:
Where a project's maps live (local files, GitHub Issues, Linear, or another tracker the human describes) and, on any but local files, its request issues with their tickets as sub-issues, each showing the phase its run or ticket is in. What the tracker shows is a copy: the run's own files stay the record.
_Avoid_: board, issue tracker

**Run list**:
A cleared map's destination: ordered one-line requests, each sized to one run's spec, built in order, each on the one before. On a tracker each entry is an issue under the map from the start, queued until its run takes it.
_Avoid_: backlog, queue

**Stack**:
A run built on an earlier run of its list whose PR hasn't merged yet: it starts from that run's branch and its PR goes into it, until that PR merges and the run goes back onto the trunk.
_Avoid_: chain, dependent PR

### Proof

**Recipe**:
The project's proven commands for setting up, checking, running and previewing each app. A run that adds an app extends it. The commands the factory may run are granted in the project's own Claude Code settings, never in anyone's personal ones.
_Avoid_: config, manifest

**Profile**:
A named environment the recipe can start the apps in, for success criteria that need other conditions.
_Avoid_: env, scenario

**Preview**:
A copy of a PR's head that the project's own host, or a command in the recipe, makes reachable for the human to try. The factory only reads where it is and never builds one. Starting the apps locally is not a preview.
_Avoid_: review app, preview environment, local preview, staging (the target branch's deployment)

**Evidence**:
The result of running the recipe's checks, pinned to one commit.
_Avoid_: test results, report

**Pinned test**:
An end-to-end test written from one success criterion by an agent other than the implementer, kept in the product's repo and rerun on every later run.
_Avoid_: pinned spec, e2e spec, Playwright spec

**Digest**:
The short account a script gives in place of a command's full output: the failing lines quoted word for word, and where the full output is kept.
_Avoid_: log tail, summary

**Capture**:
A picture of one named state of an app's UI, taken by a script, that the UI lens judges.
_Avoid_: screenshot

**Lens**:
One read-only reviewer's angle on the diff: code, UI, security or a human's PR comments.
_Avoid_: reviewer type, pass

**Finding**:
One typed claim a lens makes about the diff, with a severity and an action.
_Avoid_: issue, comment, bug

**Eval**:
A fixed case that checks one agent prompt's behaviour on a planted input, run in this repo before a version is tagged and never shipped.
_Avoid_: golden task, benchmark, test (the `node:test` suites)

### Merging

**Merge decision**:
The verdict on a finished run, merge or needs-human, computed by a script from facts and never from an agent's judgement.
_Avoid_: verdict, approval, merge gate

**Merge mode**:
What the factory does with a merge decision of merge: in trial it only says it would merge, in auto it merges and watches.
_Avoid_: merge policy

**Trial record**:
How the trial merge decisions compare with what the human then did with each PR, as GitHub holds it: the evidence for switching to auto, which only the human does.
_Avoid_: track record, score

**Catch-up**:
In auto, the one merge of the base into a PR that is behind it and fails no other fact, followed by a fresh verify and one more merge decision.
_Avoid_: rebase, sync

**Watch**:
The fixed window after the factory's own merge in which it checks the target branch and, on red, opens a revert PR that it never merges.
_Avoid_: post-merge monitoring, canary

**Login wall**:
A host's sign-in page in front of a deployment, which the watch counts as blocked, never red. The app's own sign-in is not a login wall.
_Avoid_: deployment protection, auth wall, password page
