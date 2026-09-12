// argus-reviewer dash — local-only Electron dashboard over scripts/collect.mjs.
// `npm run app`. Reads gh CLI + local artifacts; renderer polls via IPC.
import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { collect, ROOT } from '../scripts/collect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIVE_LOG = join(ROOT, '.argus-reviewer-cache/live.ndjson')
app.disableHardwareAcceleration()
app.setVersion('0.0.1')
let win
let evalChild
let logChild
let liveOffset = -1 // -1 = uninitialized; first tail seeds recent history
let liveIno = -1 // rotation replaces the file (new inode) — re-seed on change
let liveBuf = ''
const LIVE_SEED = 32 * 1024

// Tail .argus-reviewer-cache/live.ndjson — argus processes append NDJSON
// lines; we emit new entries to the renderer as 'live-log'.
async function tailLive() {
  try {
    const st = statSync(LIVE_LOG)
    if (st.ino !== liveIno) {
      liveIno = st.ino
      liveOffset = -1
      liveBuf = ''
    }
    const size = st.size
    if (liveOffset === -1) liveOffset = Math.max(0, size - LIVE_SEED)
    if (size < liveOffset) liveOffset = 0 // truncated
    if (size === liveOffset) return
    const fh = await open(LIVE_LOG)
    const { buffer } = await fh.read(Buffer.alloc(size - liveOffset), 0, size - liveOffset, liveOffset)
    await fh.close()
    liveOffset = size
    liveBuf += buffer.toString('utf8')
    const lines = liveBuf.split('\n')
    liveBuf = lines.pop() // keep partial line
    for (const l of lines) {
      if (!l) continue
      try {
        win?.webContents.send('live-log', JSON.parse(l))
      } catch { /* partial write */ }
    }
  } catch { /* file doesn't exist yet */ }
}

ipcMain.handle('run-logs', (_e, runId) => {
  if (typeof runId !== 'number' || !Number.isInteger(runId)) return { ok: false, msg: 'bad run id' }
  if (logChild) return { ok: false, msg: 'already tailing a run' }
  // `gh run view --log` dumps completed logs; `--log-failed` for failures.
  logChild = spawn('gh', ['run', 'view', String(runId), '--log'], { cwd: ROOT })
  // Buffer per stream — a chunk can split a log line in two.
  const pending = { out: '', err: '' }
  const send = (stream, d) => {
    const lines = (pending[stream] + String(d)).split('\n')
    pending[stream] = lines.pop()
    for (const l of lines.filter(Boolean)) {
      win?.webContents.send('run-log', { stream, line: l })
    }
  }
  logChild.stdout.on('data', (d) => send('out', d))
  logChild.stderr.on('data', (d) => send('err', d))
  let errored = false
  logChild.on('error', (err) => {
    errored = true
    logChild = undefined
    win?.webContents.send('run-log', { stream: 'done', line: `gh failed to start: ${err.message}` })
  })
  logChild.on('close', (code) => {
    logChild = undefined
    for (const s of ['out', 'err']) {
      if (pending[s]) win?.webContents.send('run-log', { stream: s, line: pending[s] })
    }
    if (!errored) {
      win?.webContents.send('run-log', { stream: 'done', line: `logs exited ${code}` })
    }
  })
  return { ok: true }
})

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'argus-reviewer',
    webPreferences: {
      preload: join(HERE, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadFile(join(HERE, 'index.html'))
}

ipcMain.handle('collect', () => collect())

ipcMain.handle('run-eval', () => {
  if (evalChild) return { ok: false, msg: 'already running' }
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, msg: 'OPENROUTER_API_KEY not set' }
  }
  evalChild = spawn('node', ['evals/run.mjs'], { cwd: ROOT, env: process.env })
  const send = (stream, d) => {
    for (const l of String(d).split('\n').filter(Boolean)) {
      win?.webContents.send('eval-log', { stream, line: l })
    }
  }
  evalChild.stdout.on('data', (d) => send('out', d))
  evalChild.stderr.on('data', (d) => send('err', d))
  evalChild.on('close', (code) => {
    evalChild = undefined
    win?.webContents.send('eval-log', { stream: 'done', line: `eval exited ${code}` })
  })
  return { ok: true }
})

app.whenReady().then(() => {
  createWindow()
  const tailTimer = setInterval(tailLive, 2000)
  tailTimer.unref()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  evalChild?.kill()
  logChild?.kill()
  app.quit()
})
