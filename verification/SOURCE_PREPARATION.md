# Public source preparation — 2026-10-30

This report covers source organization, documentation, portable synthetic test
inputs and package contents. It is not a product release acceptance receipt.

- The owner selected MIT for RepoConduit. Third-party notices retain their own
  terms and provenance; the historical complete dependency-review gate remains
  open. The bounded notice collector read 54 production manifests and 90,912
  notice bytes, preserving 53 supplied notices and the separate koa-compose
  supplement.
- The user guide is tracked in `docs/user-guide/README.md`, with an offline HTML
  rendering. It covers setup, ChatGPT project discussions, new topics, session
  continuation, standby/shutdown, versioned delivery and local review.
- Private raw execution evidence, installation artifacts, transcripts and
  progress history were archived outside source. Original failures and UNKNOWN
  outcomes remain preserved. Public fixtures use synthetic identities.
- Selected offline scopes: 559 cases, 558 passed and one Windows file-symlink
  case skipped for EPERM. Fixture/helper migration accounted for 169 cases;
  portable paths, observation and release-verifier checks for 84; browser
  fixture consumers and the staged-secret regression for 306. After native
  message identity replacement, the 305 affected browser cases passed again.
- Typecheck and build passed. Initial lint found missing explicit Node imports
  in the relocated proxy helper; those imports were fixed and the affected
  helper/new test passed lint. Initial fixture migration omissions and private
  parent failures were repaired before the passing targeted scopes above.
- One isolated offline package smoke passed: installed CLI, MCP round trip,
  artifact discovery, OAuth HTTP startup, Skill and notice preservation.
  Its package SHA-256 was
  `407c56c305f07bbd0985045064d2415bc08657c46aca8ad5f19f7c24f9b12a7a`.
  Subsequent changes affected test identities, source-check tooling and document
  whitespace, not installed runtime behavior. This receipt does not bind a
  future source ZIP or rebuilt npm archive to those exact package bytes.
- Two retained-package OAuth integration scenarios and four opt-in native WSL
  files were not run for this cleanup. The native outer probe now requires
  `RCAC_RUN_MODEL_OUTER_PROBE_TEST=1`; its assertions remain intact. No live
  model, new tunnel, full test suite or remote publication was performed.

`npm run check:public-source` inspects actual indexed blobs and local document
links. It does not prove absence of every secret or audit binary fixture
content. Existing Git refs may retain private history. A publishable snapshot
must use the prepared root-history public branch or its dedicated source
bundle/ZIP, never an all-refs push of the original repository.

The public `RUNTIME_ACCEPTANCE.json` is deliberately a blocked/not-run template.
Complete unified-version LIVE, human handoff, second-runtime and release
evidence remain required by the unchanged acceptance rules.

## Local root layout follow-up

The physical checkout was subsequently organized as well: design and task
documents moved under `docs/`, community documents under `.github/`, and
development metadata under `.codex/`. Root-level Node configuration and both
required lockfiles remain in place. Historical `.local` contents were moved
outside the checkout: 215 directories and 127 loose files, preserving their
contents without recursively scanning installations. The tool's existing
Tunnel client dependency remains available in `.local/`.

A running process holds the old root `stdout` log. It is ignored
and retained until normal shutdown; the user-local launcher now selects an
external runtime log directory for subsequent starts. No active connection was
stopped. This follow-up changes paths, documentation and package file selection;
it does not rebind the earlier test or package receipts to a new artifact.

Follow-up validation: 151 indexed local document links passed; package smoke
passed after the relocated quick-start was included in the package whitelist.
The checked package SHA-256 was
`b98c2fe753ed1b968e483266b411ebf1bdb5a26cc5f63f7196551f1ea736c404`.
Launcher syntax and connect dry-run passed without a new connection or key input.
The existing Tunnel process remained running. No source behavior or full-suite
acceptance was changed by the directory cleanup.
