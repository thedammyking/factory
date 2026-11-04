---
name: setup-factory
description: Sets this project up for the factory. Detects its apps, checks and settings, proves every command, shows one proposal and writes .factory/ only on approval. /setup-factory
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*)
---

# setup-factory

You turn this project into one the factory can run in. A script detects, proves and writes; you ask the human only what detection can't answer, and show them one proposal. You write nothing in the project yourself, and nothing is written before the human approves the proposal except `.factory/env.local`, which git never tracks. Setup never writes under `.claude/` and registers no MCP server.

Call the script as `node ${CLAUDE_PLUGIN_ROOT}/scripts/setup-factory.mjs <command>` from the project's root, written out in full each time (called `setup-factory` below). It keeps the proposal between commands. Change the proposal only through `setup-factory set`, never by editing a file.

A detected value is never asked about: it is confirmed once, in the proposal. A command is never asked about either: the proof runs it, and only a failure asks the human for the fix.

## Detection

1. Read your own tool list for the MCP servers the factory uses: Linear, Notion, Figma and Mobbin. A server is visible when a tool's name starts with `mcp__` and names it, such as `mcp__linear__…`, `mcp__claude_ai_Linear__…` or `mcp__plugin_<plugin>_linear__…`. Deferred tools count. Never run `claude mcp list`.
2. Run `setup-factory detect --mcp <the visible servers, comma-separated, lowercase>`, leaving `--mcp` out when none are.
   - Exit 1: a prerequisite is missing (a `package.json`, a GitHub remote, a signed-in `gh`). Print its lines as they are and stop. Nothing was written.
   - Exit 0: it printed the proposal as JSON. Keep its `tracker`, `existing` and `disagreements`; don't print the JSON.

On a re-run (`existing` is true) the project's `.factory/` values are the defaults. Detection only fills what's missing, and each field it disagrees with shows up in the proposal. A kept value stays unless the human changes it.

## A. Tracker

Always ask, in one message, leading with the recommendation from `tracker`: "Which tracker holds your request issues and maps? I recommend `<tracker>`." Offer `github` (GitHub Issues on this repo), `linear`, `local` (files under `.factory/`) and `other` (one you describe). A "yes" takes the recommendation. When the answer is `linear`, add one line: Linear moves an issue when its PR opens and merges only through Linear's GitHub integration, which setup can't check.

When the answer is `other`, ask in one message how the tracker does each of these, by a command or by an MCP server's tools: what a reference to one of its issues looks like and how to read its title and body; how to claim an issue (what that changes, such as its state or assignee) and how to undo it; the closing reference a PR body carries for it, if any; and how to comment on an issue. Write each one the human described as one bullet, in their facts and your words: `- **Read a reference**: …`, `- **Claim**: …` (the undo in the same bullet), `- **Closing reference**: …`, `- **Comment**: …`. Leave out any they can't describe: a run skips it (with none, record `- None described.`). In the same message, ask how it would hold a map for `/wayfinder`: an issue whose child issues are its tickets, one ticket blocking another, the map's open, unblocked, unclaimed children in order, claiming one, resolving one (its answer, then closing it, or closing it as out of scope) and reading a closed one. Write those after the run operations, under a `## Wayfinding operations` line, as `- **Map**: …`, `- **Decision ticket**: …`, `- **Blocking**: …`, `- **Frontier**: …`, `- **Claim**: …`, `- **Resolve**: …` and `- **Read a closed decision ticket**: …`; with none described, leave that heading out, and wayfinder won't chart on this tracker. Record them on stdin through a quoted heredoc, as in **D**: `setup-factory set tracker_doc`. On a re-run whose tracker is `other`, the kept `.factory/tracker.md` stands unless the human describes the tracker again.

## B. Specs

Only when a Notion server was visible in **Detection**; otherwise skip this section. Ask, in one message: "Copy each approved spec to a Notion page for people who don't read the repo? Give the URL of the parent page to put them under, or say no." On a re-run whose proposal has `config.notion_parent`, recommend keeping that page. The factory only writes these pages and never reads them back.

- A URL: `setup-factory set notion_parent '<the URL>'`, which keeps the page's ID and sets `docs` to `notion`. If it says the URL names no Notion page, ask again.
- No: `setup-factory set notion_parent null`, which sets `docs` to `repo`.

## C. Environment

A script copies the dev environment, so no value ever reaches the chat. Never read or print a `.env*` file or `.factory/env.local`, and never ask for a value: a human who pastes one into the chat is told to put it in the file instead.

1. Run `setup-factory env` and print its lines as they are. It copies into `.factory/env.local` each variable the project's env files name, from `.env.local`, then `.env.development`, then `.env`, and keeps every line already there. A `copied` or `kept` line names where the value is and, for a URL, its host; a `gap` line names a variable with no value, or with only a live one (`_live_`), which is never copied.
2. With no `gap` line, go to step 4. Otherwise ask once: "Fill in each gap in `.factory/env.local` (uncomment its line and add a dev or test value, never a production one), or leave it commented out if the factory can't have it. Say done when you're finished."
3. On "done", run `setup-factory env` again and print its lines. A gap still there is not available: the checks needing it are skipped (see **D**).
4. Give each variable of detect's `recipe.env` whose purpose is null one line saying what it's for, from its name and where the code reads it: `setup-factory set env.<NAME> '<purpose>'`.

## D. Proof

1. Run `setup-factory prove` and print its lines as they are. It runs every check and dev command once, each dev command on a free port until its health URL answers, and records each one's wall-clock seconds. It can take minutes: give the Bash call its longest timeout, or run it in the background and wait for it to finish. It stops every server it started, even when it's interrupted.
2. Exit 0: go to **E**.
3. Exit 1: for each `fail` line, show the human its output and ask for the fix: a corrected command, or to drop it from the recipe. Record the answer with `setup-factory set`:
   - A corrected command goes on stdin through a quoted heredoc, so no shell parses it (pick another delimiter if a line of it is exactly `FACTORY_VALUE`):

     ```bash
     node ${CLAUDE_PLUGIN_ROOT}/scripts/setup-factory.mjs set apps.<app>.checks.<name> <<'FACTORY_VALUE'
     <the command>
     FACTORY_VALUE
     ```

     The field is `apps.<app>.checks.<name>` for a check and `apps.<app>.dev` for a dev command.
   - A dropped check is `set apps.<app>.checks.<name> null`, then `set apps.<app>.needs_apps '<the JSON list without it>'` when it was listed there. A dropped dev command is `set apps.<app>.dev null` and `set apps.<app>.health null`.
   - A check that fails for want of a variable left not available in **C** keeps its command and gains the names it needs, the same way, as `{"cmd": "<the command>", "env": ["<NAME>"]}`. The proof and every run then skip it rather than fail it: its line reads `skipped`.
   - A `semgrep` line is the starter project rules: it lists what they found in the project's tree, or says they found nothing in a planted file. The fix is in that code, or going without project rules, which leaves every run's SAST `missing`: `set security '<the JSON list without "semgrep">'`. Prove it again with `setup-factory prove semgrep`.

   Then run `setup-factory prove <app>.<name>` for each command changed, and repeat until nothing fails. Never change a command the human didn't answer for.

## E. Proposal

1. Run `setup-factory apply --dry-run --tracker <answer>` and print its output as it is. It holds a table of every detected value with its source and marked guesses, the kept values detection disagrees with, what `.factory/env.local` sets (names, and each URL's host), the installs, and each file's diff.
2. Ask "Apply this?". The human may correct any value in plain words: record it with `setup-factory set` as in **D**, using the field the table names (a list or object as JSON), run `setup-factory prove <app>.<name>` when it was a command, and show the proposal again.
3. Only on a yes, run `setup-factory apply --tracker <answer>` and print its output as it is: what it wrote, the installs it ran and the closing notes.
   - Exit 1 naming commands not proven: run `setup-factory prove`, then apply again.
   - Exit 1 after an install: show its output, and once the human has fixed the cause, apply again. Applying again rewrites nothing.
4. End with one line: commit what setup wrote (`.factory/`, `.gitignore`, `CLAUDE.md`, plus `package.json` and the lockfile when it installed Playwright) to the base branch before the first `/factory` run, because a run starts from the base branch's tip.
