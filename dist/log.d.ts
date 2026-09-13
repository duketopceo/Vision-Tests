/**
 * Tiny leveled logger. Level comes from ARGUS_DEBUG=1 or config.logLevel;
 * default 'warn'. Debug emits model call excerpts and recovery paths —
 * never secret values.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
    level: LogLevel;
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
}
export declare function createLogger(level: LogLevel, sink: {
    err: (line: string) => void;
}, live?: (level: LogLevel, msg: string) => void): Logger;
export declare function resolveLogLevel(env: Record<string, string | undefined>, configured?: string): LogLevel;
