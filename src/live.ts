/**
 * Best-effort live log: appends NDJSON lines to
 * <cwd>/.argus-reviewer-cache/live.ndjson so the local dashboard
 * (`npm run app`) can follow runs started from any terminal.
 * Bounded to ~1MB; never throws — observability must not break runs.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MAX_BYTES = 1024 * 1024
const KEEP_BYTES = 256 * 1024
const MAX_MSG = 500

export function liveLogPath(cwd: string): string {
  return resolve(join(cwd, '.argus-reviewer-cache', 'live.ndjson'))
}

export function liveLog(cwd: string, source: string, level: string, msg: string): void {
  try {
    const path = liveLogPath(cwd)
    // Non-recursive: the cache dir is always one level under cwd. Recursive
    // mkdir can spin forever on Node >= 26 when cwd is a phantom procfs path.
    try {
      mkdirSync(dirname(path))
    } catch { /* already exists or unwritable — appendFileSync decides */ }
    const line =
      JSON.stringify({ ts: Date.now(), source, level, msg: msg.slice(0, MAX_MSG) }) + '\n'
    try {
      if (statSync(path).size > MAX_BYTES) {
        const buf = readFileSync(path)
        writeFileSync(path, buf.subarray(buf.length - KEEP_BYTES))
      }
    } catch { /* file doesn't exist yet */ }
    appendFileSync(path, line)
  } catch { /* live log is best-effort */ }
}
