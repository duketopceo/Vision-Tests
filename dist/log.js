const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
export function createLogger(level, sink, live) {
    const emit = (l, msg) => {
        if (ORDER[l] >= ORDER[level])
            sink.err(`[${l}] ${msg}`);
        live?.(l, msg);
    };
    // `live` receives every level regardless of `level` — the local dashboard
    // wants full detail even when the console stays quiet.
    return {
        level,
        debug: (m) => emit('debug', m),
        info: (m) => emit('info', m),
        warn: (m) => emit('warn', m),
        error: (m) => emit('error', m),
    };
}
export function resolveLogLevel(env, configured) {
    if (env.ARGUS_DEBUG === '1' || env.ARGUS_DEBUG === 'true')
        return 'debug';
    if (configured !== undefined && configured in ORDER)
        return configured;
    return 'warn';
}
