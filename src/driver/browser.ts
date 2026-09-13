import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { debug } from '../debug.js'
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright'

export interface Viewport {
  width: number
  height: number
}

export interface BrowserDriverOptions {
  /** Pinned viewport in CSS pixels. Model coordinates map 1:1 onto this. */
  viewport?: Viewport
  /** Directory for the per-run webm recording. Defaults to a fresh temp dir. */
  videoDir?: string
  /** JPEG quality 0-100 for observation screenshots. */
  screenshotQuality?: number
  /** Optional scale factor for the observation screenshot (<=1 downscales). */
  screenshotScale?: number
  /** Playwright browser engine: `chromium` (default), `firefox`, or `webkit`. */
  browser?: 'chromium' | 'firefox' | 'webkit' | undefined
  /** Hard limit in ms for Playwright cleanup. */
  browserTimeoutMs?: number | undefined
}

export interface Observation {
  screenshotJpeg: Buffer
  a11yYaml: string
  /** Viewport (CSS pixels) the screenshot was taken at — model coords map 1:1. */
  width: number
  height: number
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 }
const DEFAULT_QUALITY = 70

/**
 * One Playwright context per run. Viewport and deviceScaleFactor are pinned so
 * vision-model pixel coordinates map 1:1 to viewport pixels (KTD2).
 */
export class BrowserDriver {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly quality: number,
    private readonly videoDir: string,
    private readonly viewport: Viewport,
    private readonly browserTimeoutMs: number,
    private video: string | undefined,
    private closed = false,
  ) {}

  static async launch(options: BrowserDriverOptions = {}): Promise<BrowserDriver> {
    const viewport = options.viewport ?? DEFAULT_VIEWPORT
    const videoDir = options.videoDir ?? (await mkdtemp(join(tmpdir(), 'argus-video-')))
    await mkdir(videoDir, { recursive: true })

    const browserName = options.browser ?? 'chromium'
    const browserType = { chromium, firefox, webkit }[browserName]
    if (browserType === undefined) {
      throw new Error(`unknown browser: ${browserName}`)
    }
    let browser: Browser
    try {
      browser = await browserType.launch({ headless: true })
    } catch (e) {
      const msg = (e as Error).message
      if (/executable doesn't exist|browser has not been installed/i.test(msg)) {
        throw new Error(`${msg}\nHint: install it with \`npx playwright install ${browserName}\``)
      }
      throw e
    }
    try {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        recordVideo: { dir: videoDir, size: viewport },
      })
      const page = await context.newPage()
      return new BrowserDriver(
        browser,
        context,
        page,
        options.screenshotQuality ?? DEFAULT_QUALITY,
        videoDir,
        viewport,
        options.browserTimeoutMs ?? 30_000,
        undefined,
      )
    } catch (e) {
      await browser.close().catch(() => undefined)
      throw e
    }
  }

  get rawPage(): Page {
    return this.page
  }

  get recordingDir(): string {
    return this.videoDir
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load' })
  }

  /**
   * Capture the current observation: a bounded JPEG screenshot plus the page's
   * a11y tree as YAML via ariaSnapshot (not the deprecated accessibility API).
   *
   * `grid: true` paints a temporary coordinate overlay (lines + axis labels
   * every 100px) before the screenshot and removes it immediately after — the
   * set-of-marks trick that measurably improves vision-model pixel grounding.
   */
  async observe(options: { grid?: boolean } = {}): Promise<Observation> {
    const grid = options.grid === true
    if (grid) await this._paintGrid()
    try {
      const screenshotJpeg = await this.page.screenshot({
        type: 'jpeg',
        quality: this.quality,
        scale: 'css',
      })
      const a11yYaml = await this.page.locator('body').ariaSnapshot()
      return { screenshotJpeg, a11yYaml, width: this.viewport.width, height: this.viewport.height }
    } finally {
      if (grid) await this._removeGrid()
    }
  }

  private async _paintGrid(): Promise<void> {
    await this.page.evaluate(() => {
      const doc = (
        globalThis as unknown as {
          document: {
            createElement: (tag: string) => unknown
            body: { appendChild: (el: unknown) => void }
          }
        }
      ).document
      const overlay = doc.createElement('div') as {
        id: string
        setAttribute: (k: string, v: string) => void
        style: { cssText: string }
      }
      overlay.id = '__argus_grid'
      overlay.setAttribute('aria-hidden', 'true')
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
        'background-image:' +
        'linear-gradient(to right, rgba(255,0,0,.35) 1px, transparent 1px),' +
        'linear-gradient(to bottom, rgba(255,0,0,.35) 1px, transparent 1px);' +
        'background-size:100px 100px;'
      doc.body.appendChild(overlay)

      const labels = doc.createElement('div') as {
        id: string
        setAttribute: (k: string, v: string) => void
        style: { cssText: string }
        textContent: string
      }
      labels.id = '__argus_grid_labels'
      labels.setAttribute('aria-hidden', 'true')
      labels.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
        'font:9px monospace;color:rgba(200,0,0,.9);'
      const win = globalThis as unknown as {
        innerWidth: number
        innerHeight: number
        document: typeof doc
      }
      for (let x = 100; x < win.innerWidth; x += 100) {
        for (let y = 100; y < win.innerHeight; y += 100) {
          const tag = win.document.createElement('span') as {
            style: { cssText: string }
            textContent: string
          }
          tag.style.cssText = `position:absolute;left:${x + 1}px;top:${y + 1}px;`
          tag.textContent = `${x},${y}`
          ;(labels as unknown as { appendChild: (el: unknown) => void }).appendChild(tag)
        }
      }
      doc.body.appendChild(labels)
    })
  }

  private async _removeGrid(): Promise<void> {
    await this.page
      .evaluate(() => {
        const doc = (
          globalThis as unknown as {
            document: { getElementById: (id: string) => { remove: () => void } | null }
          }
        ).document
        for (const id of ['__argus_grid', '__argus_grid_labels']) {
          doc.getElementById(id)?.remove()
        }
      })
      .catch(() => undefined)
  }

  /** Path of the recorded webm, available after close(). */
  videoPath(): string | undefined {
    return this.video
  }

  /** Close the context and browser; resolves the video artifact path. Idempotent. */
  async close(): Promise<string | undefined> {
    if (this.closed) return this.video
    this.closed = true
    const video = this.page.video()
    try {
      await this._withTimeout(this.context.close())
    } catch (e) {
      debug('browser', `context close failed: ${(e as Error).message}`)
    }
    if (video) {
      try {
        this.video = await this._withTimeout(video.path())
      } catch {
        this.video = undefined
      }
    }
    try {
      await this._withTimeout(this.browser.close())
    } catch (e) {
      debug('browser', `browser close failed: ${(e as Error).message}`)
    }
    return this.video
  }

  private _withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('browser cleanup timed out')), this.browserTimeoutMs),
      ),
    ])
  }
}
