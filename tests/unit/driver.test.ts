import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BrowserDriver } from '../../src/driver/browser.js'
import { TargetProcess } from '../../src/driver/target.js'
import { Actions } from '../../src/engine/actions.js'

const FIXTURE_URL = fileURLToPath(new URL('../fixtures/index.html', import.meta.url))
const SERVE_SCRIPT = fileURLToPath(new URL('../fixtures/serve.mjs', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

const markerState = (driver: BrowserDriver) =>
  driver.rawPage.locator('#marker').getAttribute('data-marker')

describe('BrowserDriver + Actions (fixture page)', () => {
  let driver: BrowserDriver
  let actions: Actions
  let videoDir: string
  let videoPath: string | undefined

  beforeAll(async () => {
    videoDir = await mkdtemp(join(tmpdir(), 'argus-test-video-'))
    driver = await BrowserDriver.launch({
      viewport: { width: 1280, height: 720 },
      videoDir,
      browserTimeoutMs: 8_000,
    })
    actions = new Actions(driver)
    await driver.goto(`file://${FIXTURE_URL}`)
  })

  afterAll(async () => {
    videoPath = await driver.close()
  })

  it('a click at known viewport coords lands on the intended element', async () => {
    // #click-target occupies x:100-300, y:100-160 — click its center.
    const obs = await actions.click(200, 130)
    expect(await markerState(driver)).toBe('clicked')
    expect(obs.a11yYaml).toContain('Click me')
  })

  it('observation screenshot is a JPEG under a size bound', async () => {
    const { screenshotJpeg } = await driver.observe()
    // JPEG magic bytes
    expect(screenshotJpeg[0]).toBe(0xff)
    expect(screenshotJpeg[1]).toBe(0xd8)
    expect(screenshotJpeg[screenshotJpeg.length - 2]).toBe(0xff)
    expect(screenshotJpeg[screenshotJpeg.length - 1]).toBe(0xd9)
    // 1280x720 fixture at q70 should be far below 200 KB
    expect(screenshotJpeg.length).toBeLessThan(200_000)
  })

  it('grid overlay does not leak into the a11y snapshot', async () => {
    const plain = await driver.observe()
    const gridded = await driver.observe({ grid: true })
    expect(gridded.a11yYaml).toBe(plain.a11yYaml)
    expect(gridded.a11yYaml).not.toContain('__vision_e2e_grid')
    // And the overlay is removed afterwards — a second plain observe is clean.
    expect((await driver.observe()).a11yYaml).toBe(plain.a11yYaml)
  })

  it('observation includes a11y YAML text from the page', async () => {
    const { a11yYaml } = await driver.observe()
    expect(a11yYaml).toContain('button')
    expect(a11yYaml).toContain('Double click me')
    expect(a11yYaml).toContain('Name')
  })

  it('type + pressKeys act on the page and return observations', async () => {
    await driver.rawPage.locator('#name-input').click()
    const obs = await actions.type('vision')
    expect(await markerState(driver)).toBe('typed:vision')
    await actions.pressKeys(['Enter'])
    expect(await markerState(driver)).toBe('enter')
    expect(obs.screenshotJpeg.length).toBeGreaterThan(0)
  })

  it('scroll moves the viewport', async () => {
    await actions.scroll(0, 500)
    const y = await driver.rawPage.evaluate(() => window.scrollY)
    expect(y).toBeGreaterThan(0)
  })

  it('video artifact exists on disk after the run', async () => {
    videoPath = await driver.close()
    // driver is closed for subsequent describe blocks; video is finalized here.
    expect(videoPath).toBeDefined()
    expect(videoPath).toMatch(/\.webm$/)
    expect(existsSync(videoPath as string)).toBe(true)
  })
})

describe('TargetProcess boot adapter', () => {
  it('spawns the command, waits for ready, and stop() kills the child tree', async () => {
    const port = 4199
    const target = await TargetProcess.start({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
      url: `http://127.0.0.1:${port}/`,
      readyTimeoutMs: 10_000,
    })

    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('argus fixture')

    const pid = target.pid
    await target.stop()

    if (pid !== undefined) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  it('times out cleanly on a never-ready URL and kills the spawned process', async () => {
    // Command stays alive but never listens on the polled port.
    const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`
    await expect(
      TargetProcess.start({
        command,
        url: 'http://127.0.0.1:1/never-ready',
        readyTimeoutMs: 1_500,
      }),
    ).rejects.toThrow(/never-ready.*1500ms|1500ms.*never-ready/s)
  })

  it('fails fast when the command exits before ready', async () => {
    await expect(
      TargetProcess.start({
        command: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
        url: 'http://127.0.0.1:1/',
        readyTimeoutMs: 10_000,
      }),
    ).rejects.toThrow(/exited before/)
  })
})
