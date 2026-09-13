---
title: "feat: M2 vision reliability — record termination and multi-browser"
type: feat
date: 2026-09-12
origin: docs/plans/2026-09-09-001-feat-argus-reviewer-roadmap-plan.md
issues: [13, 16]
---

# feat: M2 vision reliability — record termination and multi-browser

## Summary

Two M2 issues: **#13** — `record` sometimes burns all 10 steps without the model
ever returning `done`; **#16** — `config.browser` nominally supports
firefox/webkit but nothing installs or exercises them.

## Problem Frame

`engine.record` loops a stateless prompt: `buildActionMessages` sends the
instruction plus the *current* screenshot/a11y tree — the model never sees what
it already did, so it can't reliably judge the flow complete, and the 10-step
cap is small for real multi-action flows ("log in and open settings" can
legitimately need 6+ actions).

For #16 the plumbing already exists end-to-end (`config.browser` →
`launchDriver` → `browserType` map in `src/driver/browser.ts`); what's missing
is browser installation in the action/CI/docs and any coverage proving the
config reaches launch.

## Requirements

- R1 (#13): recording a flow that legitimately needs >10 actions does not fail
  with a bare step-cap error.
- R2 (#13): the model can see prior actions taken in the flow, so it can emit
  `done` when the goal state is reached rather than re-acting.
- R3 (#13): when the cap is still hit, the error message says how many steps
  ran and how to raise the cap.
- R4 (#16): `config.browser: 'firefox' | 'webkit'` launches that browser;
  the action installs the configured browser instead of always chromium.
- R5 (#16): docs and defaults stay chromium-first; non-chromium is opt-in.

## Key Technical Decisions

- **KTD1. History in the prompt, not an extra done-check call.** Append a
  compact transcript of executed actions (index, action kind, target text) to
  each record call's user text. Zero extra model calls; directly addresses the
  statelessness that causes non-termination. Rejected alternative: a separate
  "is it done?" assertion call after every action — doubles record cost.
- **KTD2. Raise default cap to 40 and expose `--max-steps` + `config.stepCap`.**
  Recording is interactive/dev-time; a higher ceiling with an explicit override
  beats tuning the prompt blind. Rejected alternative: keep 10 and rely on the
  prompt fix — still fails long flows.
- **KTD3. Action installs the configured browser via a `browser` input.**
  `npx playwright install <browser>` keyed on an action input (default
  chromium); reading the TS config from bash is fragile. Rejected alternative:
  install all browsers — triples CI image download for a rarely-used feature.
- **KTD4. No runtime auto-install in the CLI.** Missing browser → fail with a
  clear `npx playwright install <name>` hint. Auto-installing on launch failure
  hides a 100MB+ download inside a test run.

## Scope Boundaries

- In scope: record-loop prompt history, step cap plumbing, error message,
  browser install in action + docs, plumbing tests.
- Deferred to follow-up work: a dedicated done-check model call for
  pathological non-termination; per-browser grounding tuning if coordinate
  behavior differs materially on webkit; replay-side browser matrix.
- Out of scope: healing-accuracy work beyond termination; headed-mode
  debugging UI.

## Implementation Units

### U1. Record loop: action history in prompt + raised cap

- **Goal:** the model sees prior steps and real flows don't hit the cap.
- **Requirements:** R1, R2, R3
- **Files:** `src/engine/loop.ts`, `src/engine/prompts.ts`, `src/cli.ts`,
  `src/config.ts`, `tests/unit/loop.test.ts`
- **Approach:**
  - `record()` accumulates a transcript of executed actions
    (`#3 click "Sign in" @ (412,318)`) and passes it into
    `buildActionMessages`, which renders it between the instruction and the
    a11y tree (e.g. `Steps already taken:` block). Replay/heal paths keep the
    current single-shot shape.
  - Default `stepCap` 10 → 40. Resolution order:
    `options.stepCap` ?? `config.recordStepCap` ?? 40 — add
    `recordStepCap?: number` to `ConfigInput`/`Config` and a
    `record --max-steps <n>` flag that passes `options.stepCap`.
  - Cap-reached error becomes
    `record did not finish after N steps (cap N) — raise with --max-steps or config.recordStepCap`.
- **Patterns to follow:** `RecordOptions`/`resolveConfig` defaults in
  `src/config.ts`; flag parsing in `cmdRecord` (`values['tests-dir']` style).
- **Test scenarios:**
  - Happy path: stub client returns 3 actions then `done`; assert each
    `buildActionMessages` user text contains the running transcript and the
    record succeeds.
  - Termination: transcript renders prior action kinds in order.
  - Cap: stub never returns `done` with `stepCap: 3` → result fails with the
    new message containing `cap 3` and the flag hint.
  - Config: `recordStepCap: 2` in config limits a run; `--max-steps` overrides
    config.
- **Verification:** unit tests above; `record` still writes the flow cache and
  generated test file on success.

### U2. Multi-browser: install + validation surface

- **Goal:** `config.browser: 'firefox'` or `'webkit'` works end-to-end.
- **Requirements:** R4, R5
- **Files:** `action/action.yml`, `docs/quickstart.md`, `README.md`,
  `tests/unit/driver.test.ts`, `.github/workflows/ci.yml` (comment or matrix
  note only — no new job)
- **Approach:**
  - New action input `browser` (default `chromium`) →
    `npx playwright install ${{ inputs.browser }}`.
  - `browser.ts` launch failure wraps with a hint:
    `browser '<name>' not installed — run: npx playwright install <name>`
    (catch Playwright's executable-missing error only; rethrow others).
  - Document `config.browser` in quickstart + README options list; note that
    the coordinate grid and video recording are browser-agnostic.
- **Test scenarios:**
  - `browser: 'firefox'` in options → `launch` is invoked on the firefox
    browser type (stub playwright `launch` or assert the `browserType` lookup;
    do not require the binary).
  - `browser: 'bogus'` → existing `unknown browser` error path (already
    covered — keep).
  - Executable-missing launch error → error message includes
    `playwright install firefox`.
- **Verification:** unit tests above; `npm run typecheck`, `npm run lint`,
  `npx vitest run` green. Manual spot-check deferred (needs playwright browser
  binaries; CI installs chromium only).

## Risks & Dependencies

- Prompt-history tokens grow with flow length — bounded by the 40-step cap and
  short transcript lines; acceptable for a dev-time command.
- Webkit video/coordinate quirks possible; scoped out — the gate is launch +
  run parity, not pixel-identical grounding.
- The action's `browser` input is a contract change for consumers — default
  keeps chromium behavior identical.

## Acceptance Examples

- `npx argus-reviewer record "sign up, open settings, toggle dark mode" --url …`
  completes past 10 steps and ends with `done`.
- A consumer sets `browser: 'firefox'`, `uses:` the action with
  `browser: firefox`, and the run launches Firefox.
- A capped record prints `cap N` and the `--max-steps`/`recordStepCap` hint.
