---
name: setup-factory
description: Sets this project up for the factory. Detects its apps, checks and settings, proves every command, shows one proposal and writes .factory/ only on approval. /setup-factory
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(gh auth status)
---

# setup-factory

You turn this project into one the factory can run in. A script detects, proves and writes; you ask the human only what detection can't answer, and show them one proposal. You write nothing in the project yourself, and nothing is written before the human approves the proposal except `.factory/env.local`, which git never tracks. Under `.claude/` setup writes only the project's `settings.json`, adding to its `permissions.allow` the Bash rules the factory runs under (the recipe's check programs, the package manager's install, run and test commands, and git but push), so no one edits their own Claude Code settings for it. A runner that runs whatever it's handed (`node`, `npx`, `exec`, `dlx`, `create`) is never among them: only the factory's implementer gets those, for its ticket. It registers no MCP server but Maestro's, at local scope, for a mobile app (see **Mobile**).

Call the script as `node ${CLAUDE_PLUGIN_ROOT}/scripts/setup-factory.mjs <command>` from the project's root, written out in full each time (called `setup-factory` below). It keeps the proposal between commands. Change the proposal only through `setup-factory set`, never by editing a file.

A detected value is never asked about: it is confirmed once, in the proposal. A command is never asked about either: the proof runs it, and only a failure asks the human for the fix.

Ask each question with `AskUserQuestion`, one question a call: 2 to 4 options, the recommended one first with ` (Recommended)` after its label, each option's description saying what it does, its benefit and its trade-off. Free text, such as a URL or a command, comes in an option's notes or through Other; an option that needs it, taken without it, is asked again. Never ask a question with one option. A question that closes with the human away decides nothing: wait for them.

## Detection

1. Read your own tool list for the MCP servers the factory uses: Linear, Notion, Figma and Mobbin. A server is visible when a tool's name starts with `mcp__` and names it, such as `mcp__linear__…`, `mcp__claude_ai_Linear__…` or `mcp__plugin_<plugin>_linear__…`, and that tool isn't its sign-in tool (`…__authenticate`): a server whose only tool is its sign-in isn't signed in, so it isn't visible. Deferred tools count. Never run `claude mcp list`.
2. Run `setup-factory detect --mcp <the visible servers, comma-separated, lowercase>`, leaving `--mcp` out when none are.
   - Exit 1: a prerequisite is missing (a GitHub remote, a signed-in `gh`). Print its lines as they are and stop. Nothing was written.
   - Exit 0: it printed the proposal as JSON. Keep its `tracker`, `existing`, `disagreements` and `auth`; don't print the JSON.

On a re-run (`existing` is true) the project's `.factory/` values are the defaults. Detection only fills what's missing, and each field it disagrees with shows up in the proposal. A kept value stays unless the human changes it.

A repo with no `package.json` is empty, and setup starts it. The proposal records `package_manager` as `pnpm`, and its source says apply runs `pnpm init` first to make the `package.json`. The recipe has no apps until the first run's scaffold ticket fills it.

## A. Tracker

On a re-run whose `.factory/config.json` records a `tracker` that **Detection** can still reach, keep it without asking: the proposal shows it, and the human changes it at **Apply this?**. Otherwise ask "Which tracker holds your request issues and maps?", with `github` (GitHub Issues on this repo), `linear`, `local` (files under `.factory/`) and `other` (one you describe), the recommendation from `tracker` first, unless it's `linear` and Linear wasn't visible in **Detection**: then `github` is first. `linear`'s trade-off is that Linear moves an issue when its PR opens and merges only through Linear's GitHub integration, which setup can't check.

When the answer is `other`, ask how the tracker does each of these, by a command or by an MCP server's tools: what a reference to one of its issues looks like and how to read its title and body; how to claim an issue (what that changes, such as its state or assignee) and how to undo it; the closing reference a PR body carries for it, if any; how to comment on an issue; how to file one with a title, a body and you as its assignee; how to file one as a sub-issue of another, blocked by others; and how to close one as completed or as not planned. Write each one the human described as one bullet, in their facts and your words: `- **Read a reference**: …`, `- **Claim**: …` (the undo in the same bullet), `- **Closing reference**: …`, `- **Comment**: …`, `- **File**: …`, `- **Spec comment**: as **Comment**`, `- **File tickets**: …`, `- **Close ticket**: …`. Leave out any they can't describe: a run skips it (with none, record `- None described.`). In the same question, ask how it would hold a map for `/wayfinder`: an issue whose child issues are its tickets, one ticket blocking another, the map's open, unblocked, unclaimed children in order, claiming one, resolving one (its answer, then closing it, or closing it as out of scope) and reading a closed one. Write those after the run operations, under a `## Wayfinding operations` line, as `- **Map**: …`, `- **Decision ticket**: …`, `- **Blocking**: …`, `- **Frontier**: …`, `- **Claim**: …`, `- **Resolve**: …` and `- **Read a closed decision ticket**: …`; with none described, leave that heading out, and wayfinder won't chart on this tracker. The options are `Runs and maps` (Recommended), `Runs only` (wayfinder won't chart on it) and `Neither` (a run skips every operation), the descriptions coming in the notes or through Other. Record them on stdin through a quoted heredoc, as in **D**: `setup-factory set tracker_doc`. On a re-run whose tracker is `other`, the kept `.factory/tracker.md` stands unless the human describes the tracker again.

## B. Specs

On a re-run whose config records a `grill`, keep it without asking, as the tracker. Otherwise ask "How should a run's grill put its questions to you?", with `One at a time` (Recommended), each question picked after the last answer so the answers steer what's asked, at the cost of more turns, and `All at once`, every question that can be asked now, up to four a call: fewer turns, but no question in a call can follow from another's answer. On a re-run, the kept `grill` is the first option, recommended. Record it with `setup-factory set grill one` or `setup-factory set grill all`. Wayfinder's grilling tickets ask the same way.

Only when a Notion server was visible in **Detection**; otherwise go to **C**. On a re-run whose proposal has `config.notion_parent` (or `docs` set to `repo`), keep it without asking. Otherwise ask "Copy each approved spec to a Notion page for people who don't read the repo?", with `Yes` (Recommended), the URL of the parent page to put them under in its notes or through Other, and `No`. On a re-run whose proposal has `config.notion_parent`, keeping that page is the first option, recommended. The factory only writes these pages and never reads them back.

- A URL: `setup-factory set notion_parent '<the URL>'`, which keeps the page's ID and sets `docs` to `notion`. If it says the URL names no Notion page, ask again.
- No: `setup-factory set notion_parent null`, which sets `docs` to `repo`.

## C. Environment

A script copies the dev environment, so no value ever reaches the chat. Never read or print a `.env*` file or `.factory/env.local`, and never ask for a value: a human who pastes one into the chat is told to put it in the file instead.

1. Run `setup-factory env` and print its lines as they are. It copies into `.factory/env.local` each variable the project's env files name, from `.env.local`, then `.env.development`, then `.env`, and keeps every line already there. A `copied` or `kept` line names where the value is and, for a URL, its host; a `gap` line names a variable with no value, or with only a live one (`_live_`), which is never copied.
2. With no `gap` line, go to step 4. Otherwise ask once: "Fill in each gap in `.factory/env.local` (uncomment its line and add a dev or test value, never a production one), or leave it commented out if the factory can't have it, then answer.", with `Done` (Recommended) and `Leave them`.
3. On `Done`, run `setup-factory env` again and print its lines. A gap still there, or every gap on `Leave them`, is not available: the checks needing it are skipped (see **D**).
4. Give each variable of detect's `recipe.env` whose purpose is null one line saying what it's for, from its name and where the code reads it: `setup-factory set env.<NAME> '<purpose>'`.
5. **Login wall.** After an auto merge, the watch smoke-tests the deployment of the branch `auto` merges into. Run `setup-factory probe` and print its lines as they are. It sends one GET to that branch's latest deployment, with the recipe's `smoke.headers` once they're set, and names headers only.
   - Exit 0 (`no wall`, or no ready deployment): no question.
   - Exit 1, a `wall` line: ask once, "The watch can't get past the login wall at `<url>`. Put a bypass header's value in `.factory/env.local`, then answer.", with `Done` (Recommended) and `Skip`. On a re-run whose recipe has `smoke.headers` as `{}`, the human skipped before: don't ask.
   - Recommend Vercel's Protection Bypass for Automation when the redirect goes to vercel.com or the host ends in `.vercel.app`. The secret is in the project's Deployment Protection settings, and goes in the file as `VERCEL_AUTOMATION_BYPASS_SECRET=`. It's free on every plan and only lets the watch view this project's deployments.
   - On `Done`, record the header by its variable, never its value: `setup-factory set smoke.headers '{"x-vercel-protection-bypass": "{env:VERCEL_AUTOMATION_BYPASS_SECRET}"}'`, or for another host the header it names, as `{env:<the variable>}`. Then run `setup-factory probe` again to prove it. If a `wall` line is still there, say so: the watch's smoke stays blocked until the header works.
   - On `Skip`: `setup-factory set smoke.headers '{}'`. The watch's smoke stays blocked by the wall.
6. **Test users.** Only when detect's `auth` names a library, ask once: "Does any app need a signed-in user for its checks? `<library>` is in `<app>`. If so, add two test users to `.factory/env.local`, then answer.", with `Yes` (Recommended) and `No`. The question names the two: a local one as `E2E_EMAIL` and `E2E_PASSWORD`, and one on the deployment `auto` merges into as `WATCH_E2E_EMAIL` and `WATCH_E2E_PASSWORD`. The factory never creates a user on a hosted environment, so that one must already exist. On `Yes`, run `setup-factory set smoke.test_user '["E2E_EMAIL", "E2E_PASSWORD"]'`. Until the `WATCH_` values are in the file, the watch's smoke is blocked for want of a test user.

## D. Proof

1. Run `setup-factory prove` and print its lines as they are. It runs every check and dev command once, each dev command on a free port until its health URL answers, and records each one's wall-clock seconds. It can take minutes: give the Bash call its longest timeout, or run it in the background and wait for it to finish. It stops every server it started, even when it's interrupted.
2. Exit 0: go to **Mobile**.
3. Exit 1: for each `fail` line, show the human its output and ask for the fix: a corrected command first, recommended, when its output shows one, then `Prove it again` (once they've fixed its cause) and `Drop it` (from the recipe). Their own command comes through Other. Record the answer with `setup-factory set`:
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

   Then run `setup-factory prove <app>.<name>` for each command changed or to be proved again, and repeat until nothing fails. Never change a command the human didn't answer for.

### Mobile

Only when detect's recipe has an app of type `mobile`; otherwise go to **E**.

1. Run `setup-factory mobile` and print its lines as they are. It probes each platform's tools: full Xcode for iOS; `adb`, an emulator and hardware acceleration for Android; Java 17 or newer and Maestro for both. A `fail` line names what a platform lacks, with its fix. Then it picks one device, iOS's where iOS is available, else Android's: the one running, else the newest runtime's, which it boots once to prove and shuts down again, else a `factory` one it makes from the newest runtime installed. It records that device in `.factory/env.local`, so every run verifies on that platform alone. It can take minutes: give the Bash call its longest timeout.
2. Exit 0: go to **E**. Exit 1: no platform is available. Ask once: "Fix what the `fail` lines say and I'll probe again, or go on without a device?", with `Probe again` (Recommended) and `Go on without one`, whose trade-off is that each mobile criterion is blocked and each run with a mobile app needs the human. On `Probe again`, run `setup-factory mobile` again.

The mobile app's `app_id` and `build` come from its `app.json`, and the proposal marks the build a guess: no proof runs it, so a run's first `run-apps up` is its proof. Once a device is recorded, apply registers the Maestro MCP server that `qa` drives the device through, at local scope: this project's alone, on this machine alone.

## E. Proposal

First test each integration setup records, with one read each, so a broken one is found now rather than mid-run:

- the tracker answered in **A**: `gh auth status` for `github`, and listing the teams through the Linear MCP for `linear`;
- `notion`, when the proposal has a `notion_parent`, set in **B** or kept on a re-run: fetching that page through the Notion MCP;
- `figma`, when visible in **Detection**: its `whoami`;
- `mobbin`, when visible: one search.

Record each result with `setup-factory set integration <name> ok`, or `setup-factory set integration <name> broken "<why, in one line>"` when the read fails or is refused, or the server isn't visible. A broken one is still written: apply's closing notes say what to do about it.

1. Run `setup-factory apply --dry-run --tracker <answer>` and print its output as it is. It holds a table of every detected value with its source and marked guesses, the kept values detection disagrees with, what `.factory/env.local` sets (names, and each URL's host), the installs, and each file's diff.
2. Ask "Apply this?", with `Apply` (Recommended) and `Not now` (nothing is written but `.factory/env.local`). The human may correct any value through Other or an option's notes: record it with `setup-factory set` as in **D**, using the field the table names (a list or object as JSON), run `setup-factory prove <app>.<name>` when it was a command, and show the proposal again.
3. Only on `Apply`, run `setup-factory apply --tracker <answer>` and print its output as it is: what it wrote, the installs it ran and the closing notes.
   - Exit 1 naming commands not proven: run `setup-factory prove`, then apply again.
   - Exit 1 after an install: show its output, and once the human has fixed the cause, apply again. Applying again rewrites nothing.
   - Exit 1 after `pnpm init`, in an empty repo: nothing was written. Show its output and ask "Fix it, then answer.", naming `corepack enable pnpm` when pnpm isn't installed, with `Done` (Recommended) and `Not now` (nothing is written but `.factory/env.local`). On `Done`, apply again.
4. End with one line, never a question (committing and pushing are the human's): commit what setup wrote (`.factory/`, `.claude/settings.json`, `.gitignore`, `CLAUDE.md`, plus `package.json` when it ran `pnpm init` or installed Playwright, and the lockfile when it installed Playwright) to the base branch before the first `/factory` run, because a run starts from the base branch's tip.

When the human asks to go on with the factory once setup is done (a run, a map's run list, a resume), read `${CLAUDE_PLUGIN_ROOT}/skills/factory/SKILL.md` and follow it with their request, as wayfinder does: the factory skill can't be invoked by name from a session, only typed by the human.
