# Contributing

Use Node.js 24.x and `npm ci`. Start with [the design](DESIGN.md),
[architecture and contracts](docs/ARCHITECTURE_AND_CONTRACTS.md), and
[development rules](AGENTS.md). Keep source changes separate from private
installation state, credentials, raw chat transcripts, and execution logs.

Run checks appropriate to the change: `npm run typecheck`, `npm run lint`,
and a focused `npx tsx --test --test-concurrency=2 tests/...test.ts` selection.
The complete `npm test` suite contains more than 2,000 cases and may take
over an hour; budget that run separately. Live tests are opt-in and require
their documented accounts, native runtimes, and explicit authorization.
Skipped tests never establish that a capability works.

Tests needing Windows private directories create fresh fixtures under the
current user's home. `RCAC_TEST_PRIVATE_PARENT` can select an existing private
parent; `RCAC_TEST_PYTHON` selects Python for observer tests. Qualification
fixtures and reports belong in ignored `.local/qualification/`, not source.

Before sharing a source snapshot, run `npm run check:public-source` against
the staged tree, inspect `git diff --cached`, and check the package contents
with `npm pack --dry-run --json --ignore-scripts`. The source check is a
bounded hygiene check, not a guarantee that no secret exists. Review newly
added fixtures and binary files yourself. Preserve third-party notices.

Source cleanup does not establish product release readiness. Follow
[the acceptance runbook](docs/ACCEPTANCE_AND_LIVE_RUNBOOK.md) for a release.
