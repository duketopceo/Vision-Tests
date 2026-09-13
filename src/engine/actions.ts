import type { BrowserDriver, Observation } from '../driver/browser.js'

/**
 * Action primitives over the driver page. All coordinates are plain viewport
 * pixels — the pinned viewport + deviceScaleFactor: 1 means model coordinates
 * map 1:1 (KTD2). Every action returns a post-action observation so callers
 * can verify the result immediately.
 */
export class Actions {
  constructor(private readonly driver: BrowserDriver) {}

  /** Single click at viewport pixel (x, y). */
  async click(x: number, y: number): Promise<Observation> {
    await this.driver.rawPage.mouse.click(x, y)
    return this.driver.observe({ grid: true })
  }

  /** Double click at viewport pixel (x, y). */
  async doubleClick(x: number, y: number): Promise<Observation> {
    await this.driver.rawPage.mouse.dblclick(x, y)
    return this.driver.observe({ grid: true })
  }

  /** Type text into the currently focused element. */
  async type(text: string): Promise<Observation> {
    await this.driver.rawPage.keyboard.type(text)
    return this.driver.observe({ grid: true })
  }

  /**
   * Press keys in sequence. Each entry is a key name ('Enter', 'Tab') or a
   * chord ('Control+a', 'Shift+ArrowLeft').
   */
  async pressKeys(keys: string[]): Promise<Observation> {
    for (const key of keys) {
      await this.driver.rawPage.keyboard.press(key)
    }
    return this.driver.observe({ grid: true })
  }

  /** Scroll the page by (dx, dy) viewport pixels. */
  async scroll(dx: number, dy: number): Promise<Observation> {
    await this.driver.rawPage.mouse.wheel(dx, dy)
    return this.driver.observe({ grid: true })
  }

  /** Wait ms milliseconds, then observe. */
  async wait(ms: number): Promise<Observation> {
    await this.driver.rawPage.waitForTimeout(ms)
    return this.driver.observe({ grid: true })
  }
}
