import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeRegionHash, Fingerprint, FingerprintRecord } from '../../src/cache/fingerprint.js'
import { loadFlow, saveFlow } from '../../src/cache/store.js'

describe('computeRegionHash', () => {
  it('returns the same hash for the same buffer', () => {
    const buf = Buffer.from([...Array(256).keys()])
    expect(computeRegionHash(buf)).toBe(computeRegionHash(buf))
  })

  it('returns different hashes for very different buffers', () => {
    const a = Buffer.alloc(512, 0xff)
    a.fill(0x00, 0, 256)
    const b = Buffer.alloc(512, 0xff)
    b.fill(0x00, 256, 512)
    expect(computeRegionHash(a)).not.toBe(computeRegionHash(b))
  })
})

describe('Fingerprint', () => {
  const record: FingerprintRecord = {
    instruction: 'Click the button',
    action: { action: 'click', x: 200, y: 130 },
    bbox: { x: 100, y: 100, width: 200, height: 60 },
    clickPoint: { x: 200, y: 130 },
    model: 'fake',
    a11ySnippet: 'Click me',
    regionHash: computeRegionHash(Buffer.from('click-region-bytes')),
  }

  it('resolves when both the region hash and a11y snippet match', () => {
    const fp = new Fingerprint(record)
    const result = fp.resolve(Buffer.from('click-region-bytes'), '- button "Click me"')
    expect(result.matched).toBe(true)
    expect(result.regionMatched).toBe(true)
    expect(result.a11yMatched).toBe(true)
  })

  it('misses on an edited region hash', () => {
    const fp = new Fingerprint(record)
    const result = fp.resolve(Buffer.from('different-region-bytes'), '- button "Click me"')
    expect(result.matched).toBe(false)
    expect(result.regionMatched).toBe(false)
    expect(result.a11yMatched).toBe(true)
  })

  it('misses when the a11y snippet is absent', () => {
    const fp = new Fingerprint(record)
    const result = fp.resolve(Buffer.from('click-region-bytes'), '- button "Other"')
    expect(result.matched).toBe(false)
    expect(result.regionMatched).toBe(true)
    expect(result.a11yMatched).toBe(false)
  })

  it('mismatch() returns false on match and true on miss', () => {
    const fp = new Fingerprint(record)
    expect(fp.mismatch(Buffer.from('click-region-bytes'), '- button "Click me"')).toBe(false)
    expect(fp.mismatch(Buffer.from('changed'), '- button "Click me"')).toBe(true)
  })
})

describe('Cache store round-trip', () => {
  it('writes and reads a flow with one step per entry and stable key ordering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-fp-'))
    const record: FingerprintRecord = {
      instruction: 'Click the button',
      action: { action: 'click', x: 200, y: 130 },
      bbox: { x: 100, y: 100, width: 200, height: 60 },
      clickPoint: { x: 200, y: 130 },
      model: 'fake',
      a11ySnippet: 'Click me',
      regionHash: computeRegionHash(Buffer.from('click-region-bytes')),
    }

    await saveFlow(dir, 'demo', [record])
    const loaded = await loadFlow(dir, 'demo')
    expect(loaded).toBeDefined()
    expect(loaded!.steps).toEqual([record])
  })
})
