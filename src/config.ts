import { pathToFileURL } from 'node:url'

export interface ProviderRules {
  only?: string[]
  ignore?: string[]
  order?: string[]
  allow_fallbacks?: boolean
  require_parameters?: boolean
}

export interface Target {
  command: string
  url: string
  readyTimeoutMs: number
}

export interface Config {
  model: string
  escalation_model: string
  /**
   * Optional specialist model for grounding-correction retries (e.g. a
   * ui-tars-class model that returns bare coordinates). Used only when the
   * primary model's proposed point resolves to the wrong element.
   */
  grounding_model: string | undefined
  /**
   * Optional code review model. Used by `argus-reviewer code-review` to review
   * PR diffs and post findings. Defaults to the primary `model` if not set.
   */
  code_model: string | undefined
  /**
   * Hard budget for the `argus-reviewer code-review` lane. When set, the
   * review stops early if the cumulative OpenRouter cost exceeds this cap.
   */
  codeReviewBudgetUsd: number | undefined
  provider: ProviderRules
  budgetUsd: number | undefined
  target: Target | undefined
  cacheDir: string | undefined
  /** Directory scanned by `argus-reviewer run` for *.test.* files. */
  testsDir: string | undefined
  /** Directory for JUnit XML + JSON run report output. */
  reportDir: string | undefined
  /**
   * Named secrets for `td.type(name, { secret: true })`. The value is typed
   * locally and never sent to the model — the model only resolves the field.
   */
  secrets: Record<string, string> | undefined
  /**
   * Optional module path (resolved from cwd) whose default export is invoked
   * with the Playwright `Page` after the driver launches and before any
   * navigation — the seam for `page.route` mocks, tenant seeding, and other
   * pre-navigation setup.
   */
  pageSetup: string | undefined
  /**
   * OpenRouter request metadata. `trace` is sent in the request body and
   * can be used to attribute spend by repo, PR, or run. `headers` are
   * sent verbatim with every OpenRouter request (e.g. HTTP-Referer, X-Title).
   */
  openrouter: { trace?: Record<string, string>; headers?: Record<string, string> } | undefined
  /**
   * Browser engine for Playwright: `chromium`, `firefox`, or `webkit`.
   * Defaults to `chromium`.
   */
  browser: 'chromium' | 'firefox' | 'webkit' | undefined
  /**
   * Hard limit in milliseconds for Playwright cleanup (context + browser close).
   * Prevents a hung browser from keeping the runner or test suite alive.
   * Defaults to 30 seconds.
   */
  browserTimeoutMs: number | undefined
  /**
   * Severity levels that block a pre-merge status. Defaults to `['bug']` so
   * `risk`/`nit`/`q` findings are surfaced but do not fail the status.
   */
  severity: string[] | undefined
  /**
   * Log verbosity — 'debug'|'info'|'warn'|'error'. ARGUS_DEBUG=1 forces
   * 'debug'. Default 'warn'.
   */
  logLevel: 'debug' | 'info' | 'warn' | 'error' | undefined
  /**
   * Repo globs naming the app surface the tests exercise (e.g. 'ui/src/**').
   * Diff-aware invalidation marks flow caches stale when the diff touches
   * files in this surface's dependency cone.
   */
  sourceGlobs: string[] | undefined
  /** Path (repo-relative) for the generated repo index. Default 'argus.index.json'. */
  indexPath: string | undefined
  /** Base ref for diff invalidation (e.g. 'origin/main'); unset = working tree. */
  diffBase: string | undefined
  /**
   * Max actions `argus-reviewer record` will take before giving up on `done`.
   * Real multi-action flows need headroom — defaults to 40; `record
   * --max-steps <n>` overrides.
   */
  recordStepCap: number | undefined
}

export type ConfigInput = Partial<Omit<Config, 'provider'>> & { provider?: Partial<ProviderRules> }

export const DEFAULT_RECORD_STEP_CAP = 40

const defaults: Config = {
  model: 'google/gemini-2.5-flash-lite',
  escalation_model: 'moonshotai/kimi-k2.5',
  grounding_model: undefined,
  code_model: 'deepseek/deepseek-v4.1-flash',
  codeReviewBudgetUsd: undefined,
  provider: {
    ignore: ['siliconflow', 'novitaai', 'atlascloud', 'streamlake', 'chutes'],
  },
  budgetUsd: undefined,
  target: undefined,
  cacheDir: undefined,
  testsDir: undefined,
  reportDir: undefined,
  secrets: undefined,
  pageSetup: undefined,
  openrouter: undefined,
  browser: 'chromium',
  browserTimeoutMs: 30_000,
  severity: ['bug'],
  logLevel: undefined,
  sourceGlobs: undefined,
  indexPath: undefined,
  diffBase: undefined,
  recordStepCap: DEFAULT_RECORD_STEP_CAP,
}

export function defineConfig(input: ConfigInput): ConfigInput {
  return input
}

export function resolveConfig(input: ConfigInput = {}): Config {
  const provider: ProviderRules = { ...defaults.provider, ...(input.provider ?? {}) }
  return {
    ...defaults,
    ...input,
    provider,
  }
}

export async function loadConfig(cwd: string): Promise<Config> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const names = ['argus-reviewer.config', 'vision-e2e.config']
  for (const name of names) {
    for (const ext of ['.ts', '.json']) {
      const file = path.join(cwd, `${name}${ext}`)
      try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue

      if (ext === '.json') {
        const raw = await fs.readFile(file, 'utf8')
        return resolveConfig(JSON.parse(raw) as ConfigInput)
      }

      let mod: { default?: ConfigInput } & ConfigInput
      try {
        mod = (await import(pathToFileURL(file).href)) as typeof mod
      } catch (e) {
        // Node cannot import .ts directly — transpile to a temp .mjs, matching
        // how the CLI loads TypeScript test files.
        const code = (e as { code?: string }).code
        if (code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw e
        const ts = await import('typescript')
        const { readFile, mkdtemp, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const source = await readFile(file, 'utf8')
        const js = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText
        const dir = await mkdtemp(join(tmpdir(), 'argus-config-'))
        const out = join(dir, 'config.mjs')
        await writeFile(out, js, 'utf8')
        mod = (await import(pathToFileURL(out).href)) as typeof mod
      }
      const exported = mod.default ?? mod
      return resolveConfig(exported as ConfigInput)
    } catch (e: unknown) {
      const code = (e as { code?: string }).code
      if (code === 'ENOENT') continue
      throw e
    }
  }
  }

  return resolveConfig()
}

/**
 * Provider slugs the harness recognizes for `provider.only/ignore/order`
 * (KTD4). Unknown slugs warn but do not fail — OpenRouter's catalog changes
 * faster than this list, so validation is fail-open by design.
 */
export const KNOWN_PROVIDER_SLUGS: ReadonlySet<string> = new Set([
  'ai21',
  'aion-labs',
  'alibaba',
  'amazon-bedrock',
  'anthropic',
  'atlascloud',
  'azure',
  'bedrock',
  'cerebras',
  'chutes',
  'cloudflare',
  'cohere',
  'coreweave',
  'crusoe',
  'deepinfra',
  'deepseek',
  'featherless',
  'fireworks',
  'friendli',
  'gmicloud',
  'google',
  'google-ai-studio',
  'groq',
  'hyperbolic',
  'inception',
  'inference-net',
  'lambda',
  'mistral',
  'moonshotai',
  'ncompass',
  'nebius',
  'nineteen',
  'novitaai',
  'open-inference',
  'openai',
  'openrouter',
  'parasail',
  'perplexity',
  'phala',
  'relace',
  'sambanova',
  'siliconflow',
  'streamlake',
  'targon',
  'together',
  'ubicloud',
  'venice',
  'wandb',
  'xai',
  'zai',
])

/** Slugs in the provider rules that are not recognized; callers warn, not fail. */
export function unknownProviderSlugs(provider: ProviderRules): string[] {
  const slugs = [...(provider.only ?? []), ...(provider.ignore ?? []), ...(provider.order ?? [])]
  return slugs.filter((slug) => !KNOWN_PROVIDER_SLUGS.has(slug.toLowerCase()))
}
