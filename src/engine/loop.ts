import { BrowserDriver, Observation } from '../driver/browser.js'
import { Actions } from './actions.js'
import { Config, DEFAULT_RECORD_STEP_CAP, ProviderRules } from '../config.js'
import { CallCost, CallKind } from '../vision/cost.js'
import { Ledger } from '../vision/ledger.js'
import { JsonSchema, Message } from '../vision/openrouter.js'
import {
  ActionPayload,
  Bbox,
  computeRegionHash,
  Fingerprint,
  fnv1a,
  FingerprintRecord,
  Point,
  ResolveResult,
} from '../cache/fingerprint.js'
import { CachedAssert, FlowCache, saveFlow } from '../cache/store.js'
import { ErrorRecord } from '../journal/schema.js'
import { Logger } from '../log.js'
import {
  actionSchema,
  AssertionResult,
  assertionSchema,
  buildActionMessages,
  buildAssertMessages,
  ProposedAction,
} from './prompts.js'

export interface VisionClient {
  complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    escalationModels?: string[]
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }>
}

export interface TestDriverApi {
  click(x: number, y: number): Promise<Observation>
  type(text: string): Promise<Observation>
  pressKeys(keys: string[]): Promise<Observation>
  scroll(dx: number, dy: number): Promise<Observation>
  wait(ms: number): Promise<Observation>
}

export interface EngineOptions {
  driver: BrowserDriver
  actions: Actions
  client: VisionClient
  ledger: Ledger
  config: Config
  /** Assertion verdicts persisted from a prior run of this flow. */
  initialAsserts?: CachedAssert[]
  /** Leveled logger; silent when absent. */
  logger?: Logger
}

export interface RecordOptions {
  flowName?: string
  stepCap?: number
}

export interface ReplayOptions {
  flowName?: string
}

export interface StepResult {
  instruction: string
  action: string
  ok: boolean
  reason?: string
  healed?: boolean
  model?: string
}

export interface RunResult {
  ok: boolean
  reason?: string
  steps: StepResult[]
  visionCalls: number
}

export interface AssertResult extends AssertionResult {
  cached: boolean
}

export interface LocateResult {
  ok: boolean
  reason: string | undefined
  healed: boolean
  point: Point | undefined
  fingerprint: FingerprintRecord | undefined
  model: string | undefined
}

export class Engine {
  private _visionCalls = 0
  private _steps: StepResult[] = []
  private _fingerprints: FingerprintRecord[] = []
  private _assertCache = new Map<string, CachedAssert>()
  private _errors: ErrorRecord[] = []

  /** Structured, non-fatal anomalies — journaled as evidence, never thrown. */
  get errorRecords(): ErrorRecord[] {
    return this._errors
  }

  private _note(stage: string, message: string, context?: string): void {
    const rec: ErrorRecord = { stage, message, ...(context !== undefined ? { context } : {}) }
    this._errors.push(rec)
    this._opts.logger?.debug(`${stage}: ${message}${context ? ` (${context})` : ''}`)
  }

  constructor(private _opts: EngineOptions) {
    for (const entry of _opts.initialAsserts ?? []) {
      this._assertCache.set(`${entry.question}${entry.a11yHash}`, entry)
    }
  }

  /** Assertion verdicts collected/known this run — persist into the flow cache. */
  get assertEntries(): CachedAssert[] {
    return [...this._assertCache.values()]
  }

  get visionCalls(): number {
    return this._visionCalls
  }

  async record(
    instruction: string,
    tdApi: TestDriverApi = this._opts.actions,
    options: RecordOptions = {},
  ): Promise<RunResult> {
    this._visionCalls = 0
    this._steps = []
    this._fingerprints = []

    const cap = options.stepCap ?? this._opts.config.recordStepCap ?? DEFAULT_RECORD_STEP_CAP
    let observation = await this._opts.driver.observe({ grid: true })

    for (let i = 0; i < cap; i++) {
      const response = await this._callModel(
        'ground',
        buildActionMessages(
          instruction,
          observation,
          this._fingerprints.map((f) => ({ action: f.action, label: f.a11ySnippet })),
        ),
      )
      if (!response) {
        return this._result(false, 'budget exceeded or model call blocked')
      }

      const action = this._parseAction(response.content)

      if (action.action === 'done') {
        this._steps.push({
          instruction,
          action: 'done',
          ok: true,
          reason: action.reasoning,
          model: response.model,
        })
        break
      }

      if (action.action === 'fail') {
        this._steps.push({
          instruction,
          action: 'fail',
          ok: false,
          reason: action.reasoning,
          model: response.model,
        })
        return this._result(false, action.reasoning)
      }

      const resolved = await this._resolveAction(action)
      const nextObservation = await this._executeAction(tdApi, action)
      const fingerprint = await this._buildFingerprint(
        instruction,
        action,
        resolved,
        response.model,
      )

      this._fingerprints.push(fingerprint)
      this._steps.push({ instruction, action: action.action, ok: true, model: response.model })
      observation = nextObservation
    }

    const finished = this._steps[this._steps.length - 1]?.action === 'done'
    if (!finished) {
      return this._result(
        false,
        `record did not finish after ${cap} steps — raise the cap with --max-steps or config.recordStepCap`,
      )
    }

    if (options.flowName && this._opts.config.cacheDir) {
      await saveFlow(this._opts.config.cacheDir, options.flowName, this._fingerprints)
    }

    return this._result(true)
  }

  async replay(flow: FlowCache, options: ReplayOptions = {}): Promise<RunResult> {
    this._visionCalls = 0
    this._steps = []

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]
      if (!step) continue
      let observation = await this._opts.driver.observe({ grid: true })
      // Diff-invalidated entries skip hash verification entirely and go
      // straight to the heal path — the diff already told us they're stale.
      let resolve: ResolveResult
      if (step.stale !== undefined) {
        this._note('heal', 'cache entry invalidated by diff', step.stale)
        resolve = { matched: false, currentHash: '', regionMatched: false, a11yMatched: false }
      } else {
        const regionBuffer = await this._regionScreenshot(step.bbox)
        resolve = new Fingerprint(step).resolve(regionBuffer, observation.a11yYaml)
      }

      if (resolve.matched) {
        await this._executeAction(this._opts.actions, step.action)
        this._steps.push({ instruction: step.instruction, action: step.action.action, ok: true })
        continue
      }

      if (this._opts.ledger.replayOnly || !this._opts.ledger.canSpend(0.001)) {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: 'fingerprint mismatch and budget/replay-only prevents heal',
        })
        return this._result(false)
      }

      const response = await this._callModel(
        'heal',
        buildActionMessages(step.instruction, observation),
        { escalationModels: [this._opts.config.escalation_model] },
      )
      if (!response) {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: 'heal blocked by budget',
        })
        return this._result(false)
      }

      const action = this._parseAction(response.content)
      if (action.action === 'fail') {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: action.reasoning,
          healed: false,
        })
        return this._result(false)
      }

      if (action.action === 'done') {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: 'heal returned done instead of a relocated action',
          healed: false,
        })
        return this._result(false)
      }

      const resolved = await this._resolveAction(action)
      const nextObservation = await this._executeAction(this._opts.actions, action)
      const newFingerprint = await this._buildFingerprint(
        step.instruction,
        action,
        resolved,
        response.model,
      )
      flow.steps[i] = newFingerprint
      this._note('heal', 'fingerprint mismatch healed by model', step.instruction)

      this._steps.push({
        instruction: step.instruction,
        action: action.action,
        ok: true,
        healed: true,
        model: response.model,
      })
      observation = nextObservation
    }

    if (options.flowName && this._opts.config.cacheDir) {
      await saveFlow(this._opts.config.cacheDir, options.flowName, flow.steps)
    }

    return this._result(true)
  }

  /**
   * Resolve a single element for the `td.find()` DSL (R13). When `cached` is
   * provided and still resolves locally, this costs zero vision calls (R2);
   * otherwise it grounds (or heals) via the model and returns a fresh
   * fingerprint (R4). The returned point is the viewport-pixel click target.
   */
  async locate(instruction: string, cached?: FingerprintRecord): Promise<LocateResult> {
    const observation = await this._opts.driver.observe({ grid: true })

    if (cached && cached.stale !== undefined) {
      this._note('locate', 'cache entry invalidated by diff', cached.stale)
    }
    if (cached && cached.stale === undefined) {
      const regionBuffer = await this._regionScreenshot(cached.bbox)
      const resolve = new Fingerprint(cached).resolve(regionBuffer, observation.a11yYaml)
      if (resolve.matched) {
        return {
          ok: true,
          reason: undefined,
          healed: false,
          point: cached.clickPoint,
          fingerprint: cached,
          model: undefined,
        }
      }
      if (this._opts.ledger.replayOnly || !this._opts.ledger.canSpend(0.001)) {
        return {
          ok: false,
          reason: 'fingerprint mismatch and budget/replay-only prevents heal',
          healed: false,
          point: undefined,
          fingerprint: undefined,
          model: undefined,
        }
      }
    }

    // A diff-invalidated (stale) entry is a fresh ground, not a heal — heal
    // implies the fingerprint *checked out as wrong*, stale means we never
    // verified it. Keeping the kind split honest keeps the heal-rate signal
    // in the journal meaningful and avoids spending escalation calls on
    // entries we already know are stale.
    const isStale = cached !== undefined && cached.stale !== undefined
    const useHeal = cached !== undefined && !isStale
    const primary = await this._locateWithModel(instruction, observation, useHeal)
    if (primary.ok) return primary

    // Semantic escalation fallback (issue #14): the model answered but could
    // not ground — provider-level OpenRouter fallback only covers unavailable
    // models, not bad answers. Retry once with escalation_model as primary on
    // a fresh observation; a page may have changed under the failure.
    const esc = this._opts.config.escalation_model
    const failedModel = primary.model ?? this._opts.config.model
    if (
      esc === undefined ||
      esc === failedModel ||
      this._opts.ledger.replayOnly ||
      !this._opts.ledger.canSpend(0.001)
    ) {
      return primary
    }
    this._note(
      'locate',
      'escalating to fallback model',
      `failed=${failedModel} esc=${esc} reason=${(primary.reason ?? '').slice(0, 80)}`,
    )
    const fresh = await this._opts.driver.observe({ grid: true })
    return this._locateWithModel(instruction, fresh, useHeal, esc)
  }

  /**
   * One locate attempt against a specific model: initial call plus the
   * verify-then-correct loop. `modelOverride` is the escalation fallback —
   * it keeps the action schema unless a specialist grounding model is in
   * play (native "(x,y)" format).
   */
  private async _locateWithModel(
    instruction: string,
    observation: Observation,
    useHeal: boolean,
    modelOverride?: string,
  ): Promise<LocateResult> {
    const specialist = this._opts.config.grounding_model !== undefined
    const prompt = specialist
      ? // ui-tars-class models ignore JSON schemas and answer with bare
        // "(x,y)" coordinates — ask in their native format.
        `Click on the UI element matching this description: ${instruction.replace(/^locate:\s*/i, '')}.`
      : instruction
    // The escalation retry (modelOverride) wins; otherwise a specialist's
    // grounding_model is the primary. Don't also pass esc as the provider
    // fallback list when esc IS the primary — that just duplicates it.
    const primaryModel = modelOverride ?? this._opts.config.grounding_model
    const escalation =
      (specialist || useHeal) && primaryModel !== this._opts.config.escalation_model
        ? [this._opts.config.escalation_model]
        : undefined
    let response
    try {
      response = await this._callModel(
        useHeal ? 'heal' : 'ground',
        buildActionMessages(prompt, observation),
        {
          ...(escalation !== undefined ? { escalationModels: escalation } : {}),
          ...(primaryModel !== undefined ? { model: primaryModel } : {}),
          dropSchema: specialist,
        },
      )
    } catch (e) {
      // Provider failures are hard errors — still journal them as evidence.
      this._note('locate', 'model call threw', (e as Error).message)
      throw e
    }
    if (!response) {
      return {
        ok: false,
        reason: 'model call blocked by budget',
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model: undefined,
      }
    }

    let action = this._parseAction(response.content)
    let model = response.model

    // Verify-then-correct: resolve the DOM node under the proposed point and
    // check its label against the instruction's target words. A mismatch means
    // the model's pixel grounding drifted (small models are systematically
    // imprecise); re-ask once with the resolved element as feedback.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (action.action === 'fail') {
        return {
          ok: false,
          reason: action.reasoning,
          healed: false,
          point: undefined,
          fingerprint: undefined,
          model,
        }
      }
      const coordsOk =
        action.action === 'click' &&
        typeof action.x === 'number' &&
        Number.isFinite(action.x) &&
        typeof action.y === 'number' &&
        Number.isFinite(action.y)
      const probe = coordsOk ? await this._resolveNode(action.x as number, action.y as number) : null
      // A point that resolves to no element at all is a mismatch too — it was
      // previously accepted and cached, which let clicks into empty space get
      // fingerprinted and replayed as "ok". Retry once with feedback; if the
      // second attempt still resolves to nothing we accept it (canvas/shadow
      // DOM and other unresolvable nodes are legitimate).
      if (action.action === 'click' && coordsOk && probe !== null &&
          instructionMatchesNode(instruction, probe.a11ySnippet)) {
        break
      }

      if (attempt === 1 || !this._opts.ledger.canSpend(0.001)) break
      this._note(
        'locate',
        action.action !== 'click'
          ? `locate steered after "${action.action}" response`
          : coordsOk
            ? probe !== null
              ? 'grounding corrected after probe mismatch'
              : 'grounding corrected after no element at coordinates'
            : 'grounding corrected after missing/invalid coords',
        `attempt=${attempt} instruction=${instruction.slice(0, 80)}`,
      )
      const feedback = specialist
        ? // ui-tars-class models want their native prompt format.
          `Click on the UI element matching this description: ${instruction.replace(/^locate:\s*/i, '')}.`
        : action.action !== 'click'
          ? `A locate step must return the click point (x, y in CSS pixels) for: ${instruction}. You returned "${action.action}".`
          : probe !== null
            ? `Your previous coordinates (${action.x},${action.y}) resolved to "${probe.a11ySnippet}", which does not match the target. Re-examine the grid labels and return corrected coordinates for: ${instruction}`
            : coordsOk
              ? `Your previous coordinates (${action.x},${action.y}) did not resolve to any element. Re-examine the grid labels and return corrected coordinates for: ${instruction}`
              : `Your previous response was a "${action.action}" action with no usable coordinates. Return the click point (x, y in CSS pixels) for: ${instruction}`
      let retry
      try {
        retry = await this._callModel(
          useHeal ? 'heal' : 'ground',
          buildActionMessages(feedback, observation),
          {
            ...(escalation !== undefined ? { escalationModels: escalation } : {}),
            ...(primaryModel !== undefined ? { model: primaryModel } : {}),
            dropSchema: specialist,
          },
        )
      } catch (e) {
        this._note('locate', 'correction retry threw', (e as Error).message)
        break
      }
      if (!retry) break
      action = this._parseAction(retry.content)
      model = retry.model
    }

    if (action.action === 'fail') {
      return {
        ok: false,
        reason: action.reasoning,
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model,
      }
    }
    if (typeof action.x !== 'number' || !Number.isFinite(action.x) || typeof action.y !== 'number' || !Number.isFinite(action.y)) {
      return {
        ok: false,
        reason: `model returned "${action.action}" without coordinates`,
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model,
      }
    }

    const resolved = await this._resolveNode(action.x, action.y)
    // Never commit a fingerprint for a node we can see is wrong — a false
    // cache entry would silently replay the mis-click forever.
    if (
      resolved !== null &&
      action.action === 'click' &&
      !instructionMatchesNode(instruction, resolved.a11ySnippet)
    ) {
      this._note('locate', 'grounding mismatch rejected', `resolved_hash=${fnv1a(resolved.a11ySnippet)}`)
      return {
        ok: false,
        reason: `model grounded to "${resolved.a11ySnippet}", which does not match the instruction`,
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model,
      }
    }
    const fingerprint = await this._buildFingerprint(instruction, action, resolved, model)
    return {
      ok: true,
      reason: undefined,
      healed: useHeal,
      point: { x: action.x, y: action.y },
      fingerprint,
      model: response.model,
    }
  }

  async assert(question: string): Promise<AssertResult> {
    const observation = await this._opts.driver.observe()
    // Page-state key is the a11y tree, not screenshot bytes — JPEG pixels
    // shift every render, but identical DOM means the answer is unchanged.
    const a11yHash = fnv1a(observation.a11yYaml)
    const key = `${question}${a11yHash}`
    const cached = this._assertCache.get(key)
    if (cached) {
      return { verdict: cached.verdict, reasoning: cached.reasoning, cached: true }
    }

    if (this._opts.ledger.replayOnly || !this._opts.ledger.canSpend(0.001)) {
      return { verdict: 'fail', reasoning: 'budget exceeded or replay-only', cached: false }
    }

    const response = await this._callModel('assert', buildAssertMessages(question, observation))
    if (!response) {
      return { verdict: 'fail', reasoning: 'budget exceeded', cached: false }
    }

    const parsed = this._parseAssertion(response.content)
    this._assertCache.set(key, {
      question,
      a11yHash,
      verdict: parsed.verdict,
      reasoning: parsed.reasoning,
      model: response.model,
    })
    return { ...parsed, cached: false }
  }

  private async _callModel(
    kind: CallKind,
    messages: Message[],
    opts: { escalationModels?: string[]; model?: string; dropSchema?: boolean } = {},
  ): Promise<{ id: string; content: string; cost: CallCost; model: string } | undefined> {
    if (!this._opts.ledger.canSpend(0.001)) {
      return undefined
    }
    // Specialist grounding models don't emit JSON — sending response_format
    // plus require_parameters would filter out their providers entirely.
    const schema =
      opts.dropSchema === true ? undefined : kind === 'assert' ? assertionSchema : actionSchema
    const response = await this._opts.client.complete({
      model: opts.model ?? this._opts.config.model,
      messages,
      ...(schema !== undefined ? { schema } : {}),
      ...(opts.escalationModels !== undefined ? { escalationModels: opts.escalationModels } : {}),
      provider: this._opts.config.provider,
      kind,
    })
    this._opts.ledger.recordCall(response.cost)
    if (
      this._opts.config.budgetUsd !== undefined &&
      this._opts.ledger.visionCostUsd > this._opts.config.budgetUsd
    ) {
      this._opts.ledger.flagBudgetExceeded()
    }
    this._visionCalls++
    return response
  }

  private _parseAction(content: string): ProposedAction {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      // Variant shape some models emit: {"click": "(x,y)"} or
      // {"click": {"x": .., "y": ..}} — action name as key, payload as value.
      const variantKey = ['click', 'type', 'pressKeys', 'scroll', 'wait', 'done', 'fail'].find(
        (k) => k in parsed,
      )
      if (parsed.action === undefined && variantKey !== undefined) {
        this._note('locate', 'tolerant action parse: variant JSON shape', content.slice(0, 80))
        const v = parsed[variantKey]
        const out: Record<string, unknown> = { action: variantKey }
        if (typeof v === 'object' && v !== null) Object.assign(out, v)
        else if (typeof v === 'string') {
          const coord = v.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
          if (coord) {
            out.x = Number(coord[1])
            out.y = Number(coord[2])
          } else {
            out.text = v
          }
          if (typeof out.x === 'string') out.x = Number(out.x)
          if (typeof out.y === 'string') out.y = Number(out.y)
        }
        if (typeof parsed.reasoning === 'string') out.reasoning = parsed.reasoning
        return out as unknown as ProposedAction
      }

      const action = String(parsed.action ?? '')
      if (!['click', 'type', 'pressKeys', 'scroll', 'wait', 'done', 'fail'].includes(action)) {
        return {
          action: 'fail',
          reasoning: `unknown action: ${action} (raw: ${content.slice(0, 160)})`,
        }
      }
      // Some specialist models return JSON action names but put coordinates in
      // a trailing "(x,y)" or start_box token instead of the schema fields.
      let x = typeof parsed.x === 'number' ? parsed.x : undefined
      let y = typeof parsed.y === 'number' ? parsed.y : undefined
      if (x === undefined || y === undefined) {
        const coord = content.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
        if (coord) {
          x = Number(coord[1])
          y = Number(coord[2])
        }
      }
      return {
        action: action as ProposedAction['action'],
        x,
        y,
        text: typeof parsed.text === 'string' ? parsed.text : undefined,
        keys: Array.isArray(parsed.keys) ? parsed.keys.map((k) => String(k)) : undefined,
        dx: typeof parsed.dx === 'number' ? parsed.dx : undefined,
        dy: typeof parsed.dy === 'number' ? parsed.dy : undefined,
        ms: typeof parsed.ms === 'number' ? parsed.ms : undefined,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      } as unknown as ProposedAction
    } catch (e) {
      // Tolerant fallback for specialist grounding models (e.g. ui-tars) that
      // answer with a bare "(x,y)" or `click(start_box='(x,y)')` instead of
      // JSON. Coordinates are absolute pixels of the screenshot; values <= 1
      // are treated as normalized [0,1] and scaled to the viewport.
      const coord = content.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
      // Malformed-JSON fallback: pull "x":N and "y":N fields independently.
      const xm = content.match(/"x"\s*:\s*(\d+(?:\.\d+)?)/)
      const ym = content.match(/"y"\s*:\s*(\d+(?:\.\d+)?)/)
      const px = coord?.[1] ?? xm?.[1]
      const py = coord?.[2] ?? ym?.[1]
      if (px !== undefined && py !== undefined) {
        this._note('locate', 'tolerant action parse: coordinate extraction', content.slice(0, 80))
        let x = Number(px)
        let y = Number(py)
        if (x <= 1 && y <= 1) {
          x = Math.round(x * 1280)
          y = Math.round(y * 720)
        }
        return {
          action: 'click',
          x: Math.round(x),
          y: Math.round(y),
          reasoning: `coordinate-only response: ${content.slice(0, 120)}`,
        } as ProposedAction
      }
      this._note('locate', 'model output unparseable', content.slice(0, 80))
      return { action: 'fail', reasoning: `JSON parse failed: ${(e as Error).message}` }
    }
  }

  private _parseAssertion(content: string): AssertionResult {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      const verdict = String(parsed.verdict ?? '')
      if (verdict !== 'pass' && verdict !== 'fail') {
        return { verdict: 'fail', reasoning: `invalid verdict: ${verdict}` }
      }
      return {
        verdict,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      }
    } catch (e) {
      return { verdict: 'fail', reasoning: `JSON parse failed: ${(e as Error).message}` }
    }
  }

  private async _resolveAction(
    action: ProposedAction,
  ): Promise<{ bbox: Bbox; clickPoint: Point; a11ySnippet: string } | undefined> {
    if (typeof action.x !== 'number' || !Number.isFinite(action.x) || typeof action.y !== 'number' || !Number.isFinite(action.y)) {
      return undefined
    }
    return this._resolveNode(action.x, action.y)
  }

  private async _resolveNode(
    x: number,
    y: number,
  ): Promise<{ bbox: Bbox; clickPoint: Point; a11ySnippet: string }> {
    const info = await this._opts.driver.rawPage.evaluate<
      { x: number; y: number; width: number; height: number; snippet: string } | null,
      [number, number]
    >(
      ([cx, cy]) => {
        const doc = (
          globalThis as unknown as {
            document: { elementFromPoint: (x: number, y: number) => unknown }
          }
        ).document
        const el = doc.elementFromPoint(cx, cy) as {
          getBoundingClientRect: () => { x: number; y: number; width: number; height: number }
          getAttribute: (attr: string) => string | null
          textContent: string | null
        } | null
        if (!el) {
          return null
        }
        const rect = el.getBoundingClientRect()
        const snippet = ((el.getAttribute('aria-label') as string | null) || el.textContent || '')
          .trim()
          .slice(0, 200)
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          snippet,
        }
      },
      [x, y],
    )

    if (!info) {
      return {
        bbox: { x, y, width: 0, height: 0 },
        clickPoint: { x, y },
        a11ySnippet: '',
      }
    }
    return { bbox: info, clickPoint: { x, y }, a11ySnippet: info.snippet }
  }

  private async _executeAction(
    tdApi: TestDriverApi,
    action: ProposedAction | ActionPayload,
  ): Promise<Observation> {
    switch (action.action) {
      case 'click':
        return tdApi.click(Number.isFinite(action.x) ? (action.x as number) : 0, Number.isFinite(action.y) ? (action.y as number) : 0)
      case 'type':
        return tdApi.type(action.text ?? '')
      case 'pressKeys':
        return tdApi.pressKeys(action.keys ?? [])
      case 'scroll':
        return tdApi.scroll(action.dx ?? 0, action.dy ?? 0)
      case 'wait':
        return tdApi.wait(action.ms ?? 0)
      default:
        return this._opts.driver.observe({ grid: true })
    }
  }

  private async _buildFingerprint(
    instruction: string,
    action: ProposedAction,
    resolved: { bbox: Bbox; clickPoint: Point; a11ySnippet: string } | undefined,
    model: string,
  ): Promise<FingerprintRecord> {
    const { reasoning: _, ...payload } = action
    const actionPayload = payload as ActionPayload
    if (!resolved) {
      return {
        instruction,
        action: actionPayload,
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        clickPoint: { x: 0, y: 0 },
        model,
        a11ySnippet: '',
        regionHash: '',
      }
    }
    const regionBuffer = await this._regionScreenshot(resolved.bbox)
    return {
      instruction,
      action: actionPayload,
      bbox: resolved.bbox,
      clickPoint: resolved.clickPoint,
      model,
      a11ySnippet: resolved.a11ySnippet,
      regionHash: computeRegionHash(regionBuffer),
    }
  }

  private async _regionScreenshot(bbox: Bbox): Promise<Buffer> {
    const raw = await this._opts.driver.rawPage.screenshot({
      clip: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      type: 'jpeg',
      quality: 70,
      scale: 'css',
    })
    return Buffer.from(raw)
  }

  private _result(ok: boolean, reason?: string): RunResult {
    return { ok, steps: this._steps, visionCalls: this._visionCalls, ...(reason ? { reason } : {}) }
  }
}

/**
 * Cheap semantic check for the verify-then-correct loop: does the resolved
 * node's label share any content word with the instruction? Stopwords and
 * short words are ignored; quoted phrases are split into words.
 */
const LOCATE_STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'with', 'below', 'above',
  'left', 'right', 'top', 'bottom', 'side', 'sidebar', 'navigation', 'nav',
  'item', 'button', 'link', 'field', 'input', 'section', 'area', 'panel',
  'that', 'this', 'into', 'onto', 'page', 'view', 'menu', 'click', 'find',
])

export function instructionMatchesNode(instruction: string, nodeSnippet: string): boolean {
  const words = instruction
    .replace(/^locate:\s*/i, '')
    .toLowerCase()
    .replace(/["'']/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !LOCATE_STOPWORDS.has(w))
  if (words.length === 0) return true
  const haystack = nodeSnippet.toLowerCase()
  return words.some((w) => haystack.includes(w))
}
