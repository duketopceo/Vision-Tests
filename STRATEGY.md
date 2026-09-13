# argus-reviewer strategy

## Target problem

E2E UI tests are expensive to write and brittle to maintain: selectors rot,
flows break on cosmetic changes, and nobody reviews the review. Meanwhile PR
review quality is inconsistent and cost is opaque.

## Approach

Two lanes, one PR surface:

- **Vision lane** — record a flow once in plain English; a vision model
  grounds each step on screenshots. Replay is cache-first (zero model calls
  on an unchanged UI); drift heals re-spend only where the UI changed, and
  show up as reviewable cache diffs.
- **Code lane** — model reads the PR diff (index-informed context, chunked,
  budgeted, multi-stage) and posts inline findings plus a verdict.
- **Output** — one sticky PR comment with per-model dollar cost, test
  evidence, review verdict, and a commit status that gates merge.

## Users

- Self-hosted teams who want AI testing/review without a SaaS dependency or
  per-seat pricing — BYOK via OpenRouter, runs on your own runners.
- This repo first: dogfooding on our own PRs is the quality bar.

## Key metrics

- Replay cost per run (target: ~$0 on cache hit)
- Heal rate per run (journal-tracked; spikes signal UI drift or weak fingerprints)
- Review findings posted vs. resolved (signal-to-noise)
- Dollar spend per PR (OpenRouter `trace` attribution)

## Tracks of work

1. **M0 — Release hygiene** (in progress): finish the rebrand, CHANGELOG,
   tarball audit, stale-branch cleanup → publish `argus-reviewer-e2e@0.1.0`.
2. **Vision hardening**: record-prompt termination (#13), multi-browser (#16).
3. **Review quality**: get argus's own inline findings posting reliably —
   it has historically dropped `nit`/`q` findings due to severity-schema
   drift — then close the gap vs. execution-backed reviewers (sandboxed
   probes, running the diff's own tests).
4. **Scale**: runner fleet dashboard (#21), org spend caps (#22), GHE/GitLab
   (#23).

## Explicitly out of scope

- Managed cloud hosting (self-hosted-first by design)
- Selector-based test authoring (vision-first is the point)
