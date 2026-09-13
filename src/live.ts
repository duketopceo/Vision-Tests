/**
 * Best-effort live log: appends NDJSON lines to <dir>/live.ndjson (the
 * run's cache dir, normally <cwd>/.argus-reviewer-cache) so the local
 * dashboard (`npm run app`) can follow runs started from any terminal.
 * Bounded to ~1MB; never throws — observability must not break runs.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MAX_BYTES = 1024 * 1024
const KEEP_BYTES = 256 * 1024
const MAX_MSG = 500

export function liveLogPath(dir: string): string {
  return resolve(join(dir, 'live.ndjson'))
}

export function liveLog(dir: string, source: string, level: string, msg: string): void {
  try {
    const path = liveLogPath(dir)
    // Non-recursive: callers pass the cache dir, which the flow store already
    // creates. Recursive mkdir can spin forever on Node >= 26 when the path
    // is a phantom procfs entry.
    try {
      mkdirSync(dirname(path))
    } catch { /* already exists or unwritable — appendFileSync decides */ }
    const line =
      JSON.stringify({ ts: Date.now(), source, level, msg: msg.slice(0, MAX_MSG) }) + '\n'
    try {
      if (statSync(path).size > MAX_BYTES) {
        const buf = readFileSync(path)
        // Keep the tail but discard through the first newline so every
        // retained line is a complete NDJSON record.
        const start = Math.max(0, buf.length - KEEP_BYTES)
        const nl = buf.indexOf(0x0a, start)
        // Atomic replace gives live.ndjson a new inode, which is how
        // tailers detect that rotation happened and re-seed. The tmp name is
        // per-process so concurrent argus runs can't clobber each other's
        // half-written rotation.
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, nl === -1 ? buf.subarray(start) : buf.subarray(nl + 1))
        renameSync(tmp, path)
      }
    } catch { /* file doesn't exist yet */ }
    appendFileSync(path, line)
  } catch { /* live log is best-effort */ }
}
