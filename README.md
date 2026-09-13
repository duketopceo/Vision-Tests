# argus-reviewer

Open-source, self-hosted vision-model E2E testing — the hundred-eyed watcher for your UI. Bring your own `OPENROUTER_API_KEY`: record a flow once, fingerprint-cache every step, replay near-free, heal on UI drift, and get results as a check + comment on the GitHub PR.

- **Vision-first**: a model looks at a screenshot and decides where to click — no selectors to write or maintain.
- **Cache-first**: replay costs zero vision calls on an unchanged UI; heals re-spend only on drift and show up as reviewable cache diffs.
- **Cost-explicit**: every call is metered from OpenRouter's per-call cost and rolled into a per-run dollar figure on the PR.
- **Grounding specialist**: a `grounding_model` (e.g. a ui-tars-class model) can drive element location with its native coordinate output, verified against the DOM before any click executes.

```bash
npm i -D argus-reviewer-e2e        # or github:duketopceo/argus-reviewer
npx argus-reviewer record "log in and open settings" --url https://localhost:3000
npx argus-reviewer run             # replays + asserts, zero-cost on cache hit
```

Configuration lives in `argus-reviewer.config.ts` (a legacy `vision-e2e.config.*` is still accepted) — see `src/config.ts` for the full shape: `model`, `grounding_model`, `escalation_model`, `provider` routing rules, `budgetUsd`, `target`, `pageSetup`, `secrets`.

### OpenRouter cost attribution

Add an `openrouter` block to tag every request. `trace` is sent in the request body and is the right hook for cost allocation by repo/PR/run. `headers` are sent verbatim with every OpenRouter request (useful for `HTTP-Referer` or `X-Title`).

```ts
export default {
  openrouter: {
    trace: { repo: 'duketopceo/myapp', pr: '42', run: 'argus-reviewer' },
    headers: { 'HTTP-Referer': 'https://github.com/duketopceo/myapp' },
  },
}
```

The GitHub Action automatically sets `ARGUS_REVIEWER_TRACE` with the repository, PR number, commit, and run id, so every PR review is attributed in OpenRouter without extra config. You can also set `ARGUS_REVIEWER_TRACE` yourself (JSON object) to add more fields.

Status: early development. See `action/` for the composite GitHub Action and `runner/` for self-hosted runner registration.

## File structure

```text
argus-reviewer/
├── action/                  # GitHub Actions composite action + sticky PR comment
│   ├── action.yml
│   └── sticky-comment.mjs
├── runner/                  # Self-hosted runner registration docs + script
│   ├── README.md
│   └── register-runner.sh
├── src/
│   ├── api.ts               # Test-facing `test`/`td` API + generated test file renderer
│   ├── cli.ts               # `record`, `run`, and `cache` commands
│   ├── config.ts            # `argus-reviewer.config.*` loader (legacy `vision-e2e.config.*` accepted)
│   ├── driver/
│   │   ├── browser.ts       # Playwright browser launch (chromium/firefox/webkit) + observation capture
│   │   └── target.ts        # Optional local dev-server target process
│   ├── engine/
│   │   ├── actions.ts       # Low-level page actions (click, type, scroll, …)
│   │   ├── loop.ts          # Vision model record/replay + healing loop
│   │   └── prompts.ts       # OpenRouter action/assertion prompts + JSON schemas
│   ├── cache/
│   │   ├── fingerprint.ts   # Per-step screenshot/a11y fingerprint + resolve
│   │   └── store.ts         # Flow cache read/write
│   ├── report/
│   │   ├── comment.ts       # Markdown PR comment + commit-status rendering
│   │   ├── junit.ts         # JUnit XML output
│   │   └── run.ts           # JSON run report consumed by the action
│   └── vision/
│       ├── cost.ts          # OpenRouter cost parsing per call
│       ├── ledger.ts        # Per-run USD budget tracking
│       └── openrouter.ts    # OpenRouter chat-completion client + schema parsing
└── tests/                   # Unit tests + small Playwright fixture page
```

License: MIT.
