# factory

A Claude Code plugin that carries a one-line request through triage, spec, tickets, implementation, verification, review and PR to a merge decision made from facts.

## Install

```
/plugin marketplace add thedammyking/factory
/plugin install factory@factory
```

`/plugin install` is the only supported install path. Installing with `npx skills add` is not supported ([#30](https://github.com/thedammyking/factory/issues/30)): it installs skills alone, and the factory also ships agents, a hook and scripts.

To install from a local checkout, pass its path to `/plugin marketplace add` instead.

## Repo layout

- `plugin/` is what installs into a project.
- `test/` holds the `node:test` suites; run them with `node --test` (Node ≥ 20). They never ship.
- `evals/` holds the `claude plugin eval` cases for the agent prompts, run before a tag; see [evals/README.md](evals/README.md). They never ship.

## Licence

MIT, see [LICENSE](LICENSE). Third-party sources are listed in [plugin/THIRD_PARTY_NOTICES.md](plugin/THIRD_PARTY_NOTICES.md).
