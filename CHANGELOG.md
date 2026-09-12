# Changelog

All notable changes to argus-reviewer are documented here. The project is
pre-release (`0.0.x`); breaking changes may ship without a major bump until
`0.1.0`.

## [Unreleased]

### Added
- Live NDJSON log (`<cacheDir>/live.ndjson`) tailed by the Electron dashboard's
  new Live Log card; `ARGUS_DEBUG` output streams there too (#40)
- Per-run "logs" button in the dashboard streaming `gh run view --log` (#40)
- `npm run app` — Electron dashboard for local observability (#39)
- `npm run watch` — local TUI for PRs, runs, evals, and journals (#38)
- Index-informed code review — context blocks for changed files (#36)
- Grounding → escalation-model fallback for locate (#37)
- Repo index, run journal, and diff-aware cache invalidation
- M3 code review: inline comments, `code_review.budgetUsd`, file chunking,
  severity filter, multi-stage review (#31–#34)

### Changed
- **Rebrand complete**: user-facing `vision-e2e` strings renamed to
  `argus-reviewer` — config default (`argus-reviewer.config.*`), cache dir
  (`.argus-reviewer-cache`), report dir (`argus-reviewer-report`), runner
  labels, DOM overlay ids. `vision-e2e.config.*` still loads as a legacy
  fallback (#8)
- Default review model is `deepseek-v4.1-flash` (#29)

### Fixed
- `liveLog` can no longer hang on Node >= 26 (non-recursive mkdir, atomic
  rotation) and `debug()` can no longer throw on BigInt/cyclic args (#40)
- Action: `cache-dependency-path` + `node-version` inputs — npm cache failed
  for consumers without a root package-lock.json

## [0.0.1] — unreleased baseline

Initial functional build: OpenRouter client with provider routing and a hard
budget cap, Playwright driver with pixel actions, record/replay/heal engine
with screenshot-fingerprint cache, `record`/`run`/`cache` CLI, composite
GitHub Action with sticky PR comment, self-hosted runner registration, and
the `td` test API.
