/**
 * Tiny leveled logger. Level comes from ARGUS_DEBUG=1 or config.logLevel;
 * default 'warn'. Debug emits model call excerpts and recovery paths —
 * never secret values.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  level: LogLevel
  debug: (msg: string) => void
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export function createLogger(
  level: LogLevel,
  sink: { err: (line: string) => void },
  live?: (level: LogLevel, msg: string) => void,
): Logger {
  const emit = (l: LogLevel, msg: string) => {
    if (ORDER[l] >= ORDER[level]) sink.err(`[${l}] ${msg}`)
    live?.(l, msg)
  }
  // `live` receives every level regardless of `level` — the local dashboard
  // wants full detail even when the console stays quiet.
  return {
    level,
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  }
}

export function resolveLogLevel(env: Record<string, string | undefined>, configured?: string): LogLevel {
  if (env.ARGUS_DEBUG === '1' || env.ARGUS_DEBUG === 'true') return 'debug'
  if (configured !== undefined && configured in ORDER) return configured as LogLevel
  return 'warn'
}
