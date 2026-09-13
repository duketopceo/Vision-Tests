import { describe, expect, it, vi } from 'vitest'

const launches = vi.hoisted(() => ({ chromium: vi.fn(), firefox: vi.fn(), webkit: vi.fn() }))

vi.mock('playwright', () => ({
  chromium: { launch: launches.chromium },
  firefox: { launch: launches.firefox },
  webkit: { launch: launches.webkit },
}))

import { BrowserDriver } from '../../src/driver/browser.js'

const missing = (name: string) =>
  new Error(
    `Executable doesn't exist at /browsers/${name}/bin\n` +
      'Please run the following command to download new browsers:\n    npx playwright install',
  )

describe('BrowserDriver browser selection', () => {
  it('launches the configured browser type', async () => {
    for (const name of ['chromium', 'firefox', 'webkit'] as const) {
      launches[name].mockRejectedValueOnce(new Error('stop after launch'))
      await expect(BrowserDriver.launch({ browser: name })).rejects.toThrow('stop after launch')
      expect(launches[name]).toHaveBeenCalled()
    }
  })

  it('missing executable error includes the install hint for that browser', async () => {
    launches.firefox.mockRejectedValueOnce(missing('firefox'))
    await expect(BrowserDriver.launch({ browser: 'firefox' })).rejects.toThrow(
      'npx playwright install firefox',
    )
  })

  it('non-install launch errors propagate unchanged', async () => {
    launches.webkit.mockRejectedValueOnce(new Error('sandbox failure'))
    await expect(BrowserDriver.launch({ browser: 'webkit' })).rejects.toThrow('sandbox failure')
  })
})
