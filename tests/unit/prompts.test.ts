import { describe, expect, it } from 'vitest'

import { buildActionMessages, describeAction } from '../../src/engine/prompts.js'

describe('describeAction', () => {
  it('renders click with coords and element label', () => {
    expect(describeAction({ action: 'click', x: 200, y: 130 }, 'button "Click me"')).toBe(
      'click "button \'Click me\'" @ (200,130)',
    )
  })

  it('omits the label when the snippet is empty or whitespace', () => {
    expect(describeAction({ action: 'click', x: 1, y: 2 }, '')).toBe('click @ (1,2)')
    expect(describeAction({ action: 'click', x: 1, y: 2 }, '   ')).toBe('click @ (1,2)')
    expect(describeAction({ action: 'click', x: 1, y: 2 })).toBe('click @ (1,2)')
  })

  it('keeps labels single-line under truncation', () => {
    const label = 'line one\nline two ' + 'x'.repeat(60)
    const out = describeAction({ action: 'click', x: 0, y: 0 }, label)
    expect(out).not.toContain('\n')
    expect(out.length).toBeLessThan(80)
  })

  it('renders the remaining action kinds with sane fallbacks', () => {
    expect(describeAction({ action: 'type', text: 'user@x.com' })).toBe('type "user@x.com"')
    expect(describeAction({ action: 'pressKeys', keys: ['Enter', 'Tab'] })).toBe('pressKeys Enter+Tab')
    expect(describeAction({ action: 'scroll', dx: 0, dy: 400 })).toBe('scroll (0,400)')
    expect(describeAction({ action: 'wait', ms: 500 })).toBe('wait 500ms')
    expect(describeAction({ action: 'click' })).toBe('click @ (?,?)')
  })
})

describe('buildActionMessages history block', () => {
  const observation = {
    screenshotJpeg: Buffer.from('x'),
    a11yYaml: '- button "Go"',
    width: 1280,
    height: 720,
  }

  const userText = (msgs: ReturnType<typeof buildActionMessages>) =>
    msgs
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')

  it('omits the block with no prior actions and renders numbered lines when present', () => {
    expect(userText(buildActionMessages('do x', observation))).not.toContain(
      'Steps already taken',
    )
    const withHistory = userText(
      buildActionMessages('do x', observation, [
        { action: { action: 'click', x: 10, y: 20 }, label: 'Go' },
        { action: { action: 'type', text: 'hi' } },
      ]),
    )
    expect(withHistory).toContain('Steps already taken')
    expect(withHistory).toContain('- #1 click "Go" @ (10,20)')
    expect(withHistory).toContain('- #2 type "hi"')
  })
})
