import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { liveLog, liveLogPath } from '../../src/live.js'

describe('liveLog', () => {
  it('appends NDJSON lines under the given cache dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-live-'))
    liveLog(dir, 'run', 'debug', 'hello')
    liveLog(dir, 'run', 'warn', 'second')
    const lines = (await readFile(liveLogPath(dir), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    const a = JSON.parse(lines[0])
    expect(a.source).toBe('run')
    expect(a.level).toBe('debug')
    expect(a.msg).toBe('hello')
    expect(typeof a.ts).toBe('number')
    expect(JSON.parse(lines[1]).level).toBe('warn')
  })

  it('caps message length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-live-'))
    liveLog(dir, 'run', 'info', 'x'.repeat(2000))
    const line = (await readFile(liveLogPath(dir), 'utf8')).trim()
    expect(JSON.parse(line).msg.length).toBe(500)
  })

  it('never throws on unwritable path', () => {
    expect(() => liveLog('/proc/1/nonexistent', 'run', 'info', 'x')).not.toThrow()
  })

  it('rotates when file exceeds 1MB and every retained line parses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-live-'))
    // Messages cap at 500 chars, so each line is ~560 bytes — need ~1900
    // writes to actually cross the 1MB rotation threshold.
    for (let i = 0; i < 2000; i++) liveLog(dir, 'run', 'info', `entry-${i} ` + 'y'.repeat(600))
    const { size } = await stat(liveLogPath(dir))
    expect(size).toBeLessThan(400 * 1024)
    const lines = (await readFile(liveLogPath(dir), 'utf8')).trim().split('\n')
    for (const l of lines) JSON.parse(l) // rotation must not keep a partial first line
    expect(JSON.parse(lines[lines.length - 1]).msg).toContain('entry-1999')
  })
})
