import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { main } from '../../src/cli.js'
import { VisionClient } from '../../src/engine/loop.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'
import { ProviderRules } from '../../src/config.js'

const FIXTURE_URL = `file://${fileURLToPath(new URL('../fixtures/index.html', import.meta.url))}`

class StubClient implements VisionClient {
  calls: { kind: CallKind; model: string }[] = []
  private queue: { content: string }[]

  constructor(queue: { content: string }[]) {
    this.queue = [...queue]
  }

  async complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    escalationModels?: string[]
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    const next = this.queue.shift()
    if (!next) throw new Error('stub client queue empty')
    this.calls.push({ kind: opts.kind ?? 'ground', model: opts.model })
    const cost: CallCost = {
      model: opts.model,
      provider: 'stub',
      tokens: 10,
      costUsd: 0.001,
      kind: opts.kind ?? 'ground',
    }
    return { id: `stub-${this.calls.length}`, content: next.content, model: opts.model, cost }
  }
}

interface Captured {
  lines: string[]
  fn: (line: string) => void
}

function capture(): Captured {
  const lines: string[] = []
  return { lines, fn: (line) => lines.push(line) }
}

describe('argus-reviewer CLI', () => {
  it('record --help and run --help exit 0', async () => {
    const out = capture()
    expect(await main(['record', '--help'], { out: out.fn })).toBe(0)
    expect(await main(['run', '--help'], { out: out.fn })).toBe(0)
    expect(await main(['--help'], { out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('argus-reviewer run')
    expect(out.lines.join('\n')).toContain('argus-reviewer record')
  })

  it('record rejects a non-positive-integer --max-steps before launching', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-maxsteps-'))
    const out = capture()
    const err = capture()
    for (const bad of ['0', '-3', '1.5', 'abc']) {
      const code = await main(
        ['record', 'click the thing', '--url', FIXTURE_URL, `--max-steps=${bad}`],
        { cwd, out: out.fn, err: err.fn },
      )
      expect(code).toBe(2)
    }
    expect(err.lines.join('\n')).toContain('--max-steps must be a positive integer')
  })

  it('runs a td-API test file end-to-end, warns on unknown provider slugs, writes JUnit + report', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cli-'))
    const testsDir = join(cwd, 'tests')
    const cacheDir = join(cwd, 'cache')
    const reportDir = join(cwd, 'report')
    await mkdir(testsDir, { recursive: true })

    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        cacheDir,
        reportDir,
        budgetUsd: 1,
        provider: { ignore: ['siliconflow', 'nonexistent-provider'] },
      }),
    )

    // Plain-TS test using the td DSL — globals `test`/`td` injected by `run`.
    await writeFile(
      join(testsDir, 'landing.test.ts'),
      `test('fixture click flow', async (td) => {
  await td.find('the "Click me" button').click()
  const ok = await td.assert('the marker shows clicked')
  if (ok.verdict !== 'pass') throw new Error(ok.reasoning)
})
`,
    )

    const client = new StubClient([
      { content: JSON.stringify({ action: 'click', x: 200, y: 130, reasoning: 'the button' }) },
      { content: JSON.stringify({ verdict: 'pass', reasoning: 'marker reads clicked' }) },
    ])

    const out = capture()
    const err = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: out.fn,
      err: err.fn,
      createClient: () => client,
      env: { ...process.env, OPENROUTER_API_KEY: 'test-key' },
    })

    expect(code).toBe(0)
    expect(err.lines.join('\n')).toContain('unknown provider slug "nonexistent-provider"')
    expect(out.lines.join('\n')).toContain('PASS fixture click flow')
    expect(client.calls.length).toBe(2)

    const junit = await readFile(join(reportDir, 'junit.xml'), 'utf8')
    expect(junit).toContain('name="fixture click flow"')
    expect(junit).toMatch(/time="\d+\.\d{3}"/)
    expect(junit).not.toContain('<failure')

    const report = JSON.parse(await readFile(join(reportDir, 'run.json'), 'utf8')) as {
      ok: boolean
      totals: { passed: number; failed: number; visionCalls: number; visionCostUsd: number }
      tests: { name: string; ok: boolean; asserts: { verdict: string }[] }[]
    }
    expect(report.ok).toBe(true)
    expect(report.totals.passed).toBe(1)
    expect(report.totals.failed).toBe(0)
    expect(report.totals.visionCalls).toBe(2)
    expect(report.totals.visionCostUsd).toBeCloseTo(0.002)
    expect(report.tests[0]!.asserts[0]!.verdict).toBe('pass')

    // The locate call wrote a fingerprint cache entry for the test flow.
    const cache = JSON.parse(
      await readFile(join(cacheDir, 'landing__fixture-click-flow.json'), 'utf8'),
    ) as { steps: { instruction: string; action: { action: string } }[] }
    expect(cache.steps.length).toBe(1)
    expect(cache.steps[0]!.action.action).toBe('click')
  }, 60_000)

  it('marks the run failed when an assertion fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cli-fail-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ testsDir, reportDir: join(cwd, 'report'), budgetUsd: 1 }),
    )
    await writeFile(
      join(testsDir, 'failing.test.mjs'),
      `test('failing assert', async (td) => {
  await td.assert('an element that does not exist is visible')
})
`,
    )
    const client = new StubClient([
      { content: JSON.stringify({ verdict: 'fail', reasoning: 'no such element on screen' }) },
    ])
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    expect(code).toBe(1)
    const junit = await readFile(join(cwd, 'report', 'junit.xml'), 'utf8')
    expect(junit).toContain('<failure')
    expect(junit).toContain('failing assert')
  }, 60_000)

  it('invokes config pageSetup with the page before navigation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-setup-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })

    // pageSetup receives the Playwright page; assert it fires pre-navigation
    // (url is still about:blank) and records a marker we can observe.
    await writeFile(
      join(cwd, 'setup.mjs'),
      `export default async function setup(page) {
  if (page.url() !== 'about:blank') throw new Error('pageSetup ran after navigation')
  globalThis.__pageSetupCalls = (globalThis.__pageSetupCalls || 0) + 1
  await page.addInitScript('globalThis.__seeded = true')
}
`,
    )
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        pageSetup: './setup.mjs',
        budgetUsd: 1,
      }),
    )
    await writeFile(
      join(testsDir, 'noop.test.mjs'),
      `test('noop', async () => {})
`,
    )
    const client = new StubClient([])
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    expect(code).toBe(0)
    expect((globalThis as Record<string, unknown>).__pageSetupCalls).toBe(1)
  }, 60_000)

  it('cache list and prune operate on the cache dir', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cache-'))
    const cacheDir = join(cwd, 'cache')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, 'flow-a.json'), JSON.stringify({ steps: [] }))
    await writeFile(join(cwd, 'argus-reviewer.config.json'), JSON.stringify({ cacheDir }))
    const out = capture()
    expect(await main(['cache', 'list'], { cwd, out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('flow-a: 0 steps')
    expect(await main(['cache', 'prune', 'flow-a'], { cwd, out: out.fn })).toBe(0)
    expect(await main(['cache', 'list'], { cwd, out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('cache empty')
  })

  it('init scaffolds config, smoke test, and workflow; skips existing files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-init-'))
    const out = capture()
    expect(await main(['init'], { cwd, out: out.fn })).toBe(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(cwd, 'argus-reviewer.config.ts'))).toBe(true)
    expect(existsSync(join(cwd, 'tests/argus/smoke.test.ts'))).toBe(true)
    expect(existsSync(join(cwd, '.github/workflows/argus-reviewer.yml'))).toBe(true)
    // Second run without --force skips rather than overwriting
    const out2 = capture()
    expect(await main(['init'], { cwd, out: out2.fn })).toBe(0)
    expect(out2.lines.join('\n')).toContain('exists, skipping')
  })
})

describe('loadConfig', () => {
  it('loads a TypeScript config via transpile fallback', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    await writeFile(
      join(cwd, 'argus-reviewer.config.ts'),
      `export default { model: 'test/model', budgetUsd: 0.5 } satisfies import('../../src/config.js').ConfigInput
`,
    )
    const config = await loadConfig(cwd)
    expect(config.model).toBe('test/model')
    expect(config.budgetUsd).toBe(0.5)
  })

  it('still loads a legacy vision-e2e.config.json', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    await writeFile(join(cwd, 'vision-e2e.config.json'), JSON.stringify({ model: 'legacy/model' }))
    expect((await loadConfig(cwd)).model).toBe('legacy/model')
  })
})
