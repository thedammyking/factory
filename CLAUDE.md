## Agent skills

### Issue tracker

Issues live in GitHub Issues on `thedammyking/factory` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Testing the factory

Checks of the factory's own behaviour (`node:test` suites, evals) live and run in this repo and never ship. Nothing the plugin installs into or writes to a project exists to test the factory.
