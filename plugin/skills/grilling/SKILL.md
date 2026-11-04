---
name: grilling
description: Puts the open decisions of a request or a map to the human with the question tool, one at a time or the whole frontier at once as the project chose, and has the facts found rather than asked. Loaded by the factory's build route and by wayfinder.
user-invocable: false
---

The grill settles what only the human can decide, before anything is written from it. Facts are researched, never asked: only decisions go to the human. Whatever loaded this skill says what is being settled, where facts come from and where the answers go, and its rules come before these.

## The tree and the frontier

Lay out the decisions the work needs as a **design tree**: each decision sits under the ones it depends on, because their answers change what it asks or rule it out. Call the open decisions that depend on nothing still open the **frontier**: those are the ones the human can answer now. Each answer settles a node and opens or prunes the branches under it, so work the frontier out again after every answer.

## Facts and decisions

A **fact** is what the code, the docs or the files you were given can tell you: what exists, how a package behaves, what a request already says. A **decision** is a choice that changes what gets built and that only the human can make: what done looks like, the scope, what a user sees. Never ask the human a fact.

- Before you ask a question, check whether it rests on a fact you don't hold. If it does, find the fact first, the way whatever loaded this skill says, else by reading the code and docs yourself, and change nothing while you do. A question still waiting on a fact isn't on the frontier yet.
- A fact that can't be found is recorded as unknown, where whatever loaded this skill says, else beside the answers, and never asked.
- Give every question a recommended answer, grounded in the facts you found.
- A decision with one real option isn't asked: say what you're taking and why, and settle it.

## Asking

Ask with `AskUserQuestion`. Read `grill` from `.factory/config.json`: `one` or `all`, and `one` when the file or the key is missing.

- Each question's header is at most 12 characters. It has 2 to 4 options, the recommended one first with ` (Recommended)` after its label, and each option's description says what it does, its benefit and its trade-off. The human types their own answer through Other, or adds notes to an option.
- **`one`**: one question a call. After each answer, take from the new frontier the question that answer makes most pressing, so the human's answers steer what comes next.
- **`all`**: the whole frontier in as few calls as it takes, up to four questions a call, the most important first. Drop a question an earlier answer in the round made moot. Once every call of the round is answered, put the new frontier the same way.
- An Other answer that picks an option is that option. One that gives an answer of its own is the answer, in the human's words. One that is neither is asked again.
- "go on" in Other, or words that plainly mean it, settles that question and every question left in the grill with its recommended answer, marked `(default)`. Answers the human already gave stand.
- A question that closes with the human away settles nothing: stop and wait.

## Ending

Each decision, as its question and its answer, goes where whatever loaded this skill says as soon as it is settled. When no open decision is left, and each thing the work needs is either an answer or a recorded unknown, the grill is done. Act on none of the decisions here.
