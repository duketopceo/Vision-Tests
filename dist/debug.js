import { join } from 'node:path';
import { liveLog } from './live.js';
const DEBUG = process.env.ARGUS_DEBUG === '1' || process.env.ARGUS_DEBUG === 'true';
// debug() has no config access — it lives under the default cache dir.
const LIVE_DIR = join(process.cwd(), '.argus-reviewer-cache');
function toMsg(arg) {
    if (typeof arg === 'string')
        return arg;
    try {
        const s = JSON.stringify(arg);
        return s === undefined ? String(arg) : s; // JSON.stringify(undefined) -> undefined
    }
    catch {
        return String(arg); // BigInt, cyclic refs — never throw from a debug call
    }
}
export function debug(kind, ...args) {
    if (!DEBUG)
        return; // keep debug() free of fs work on the hot path
    for (const arg of args) {
        liveLog(LIVE_DIR, kind, 'debug', toMsg(arg));
        const prefix = `[argus-reviewer:${kind}]`;
        if (typeof arg === 'string') {
            console.error(`${prefix} ${arg}`);
        }
        else {
            console.error(prefix, arg);
        }
    }
}
