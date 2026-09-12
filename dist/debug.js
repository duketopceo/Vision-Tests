import { liveLog } from './live.js';
const DEBUG = process.env.ARGUS_DEBUG === '1' || process.env.ARGUS_DEBUG === 'true';
export function debug(kind, ...args) {
    for (const arg of args) {
        liveLog(process.cwd(), kind, 'debug', typeof arg === 'string' ? arg : JSON.stringify(arg));
        if (!DEBUG)
            continue;
        const prefix = `[argus-reviewer:${kind}]`;
        if (typeof arg === 'string') {
            console.error(`${prefix} ${arg}`);
        }
        else {
            console.error(prefix, arg);
        }
    }
}
