const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
const esc = (s) => String(s ?? '')

const ICON = { SUCCESS: ['✓','ok'], FAILURE: ['✗','bad'], fail: ['✗','bad'], PENDING: ['…','warn'], pending: ['…','warn'] }
const icon = (st, bucket) => {
  const [g, c] = ICON[st] || ICON[bucket] || ['·','dim']
  return el('span', c, g)
}

function renderPrs(s) {
  const d = $('prs'); d.replaceChildren()
  if (!s.prs.length) { d.append(el('div', 'dim', 'none open')); return }
  for (const p of s.prs) {
    const r = el('div', 'row')
    r.append(el('span', 'num', `#${p.number}`))
    r.append(el('span', 't', esc(p.title)))
    const v = p.reviewDecision === 'APPROVED' ? el('span','ok','approved')
      : p.reviewDecision === 'CHANGES_REQUESTED' ? el('span','bad','changes')
      : el('span','dim', esc(p.mergeStateStatus).toLowerCase())
    r.append(el('span', 'm')); r.lastChild.append(v, ' ', el('span','dim',esc(p.headRefName)))
    d.append(r)
    const checks = (s.prChecks[p.number] || []).slice(0, 6)
    if (checks.length) {
      const c = el('div', 'checks')
      for (const ck of checks) {
        const cr = el('div', 'row')
        cr.append(icon(ck.state, ck.bucket), el('span', 't', esc(ck.name)))
        c.append(cr)
      }
      d.append(c)
    }
  }
}

function renderRuns(s) {
  const d = $('runs'); d.replaceChildren()
  for (const r of s.runs) {
    const row = el('div', 'row')
    const ic = r.conclusion === 'success' ? el('span','ok','✓')
      : r.conclusion === 'failure' ? el('span','bad','✗')
      : ['in_progress','queued'].includes(r.status) ? el('span','warn','…') : el('span','dim','·')
    const age = Math.max(0, Math.round((Date.now() - new Date(r.createdAt).getTime()) / 60000))
    row.append(ic, el('span','t',esc(r.displayTitle)),
      el('span','m', `${esc(r.workflowName)} · ${esc(r.headBranch)} · ${age}m`))
    if (r.databaseId) {
      const btn = el('button', 'logs-btn', 'logs')
      btn.onclick = async () => {
        const res = await window.argus.runLogs(r.databaseId)
        if (!res.ok) liveAppend({ level: 'warn', source: 'gh', msg: esc(res.msg) })
      }
      row.append(btn)
    }
    d.append(row)
  }
  if (!s.runs.length) d.append(el('div','dim','no runs'))
}

function renderJournals(s) {
  const d = $('jhist'); d.replaceChildren()
  const js = s.journals || []
  if (!js.length) { d.append(el('div','dim','no journal entries')); return }
  for (const j of js.slice(-8)) {
    const r = el('div','row')
    r.append(el('span', j.ok ? 'ok' : 'bad', j.ok ? '✓' : '✗'),
      el('span','t', esc(j.runId)),
      el('span','m', `${j.steps} steps · $${(j.costUsd||0).toFixed(4)} · ${j.errors} err`))
    d.append(r)
  }
  // cost sparkline
  const cv = $('spark'), ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, cv.width, cv.height)
  const costs = js.map(j => j.costUsd || 0)
  const max = Math.max(...costs, 1e-6)
  const w = cv.width / Math.max(costs.length - 1, 1)
  ctx.strokeStyle = '#39c5cf'; ctx.lineWidth = 1.5; ctx.beginPath()
  costs.forEach((c, i) => {
    const x = i * w, y = cv.height - 6 - (c / max) * (cv.height - 12)
    if (i) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
    ctx.fillStyle = js[i].ok ? '#3fb950' : '#f85149'
    ctx.fillRect(x - 2, y - 2, 4, 4)
  })
  ctx.stroke()
}

function renderJournal(s) {
  const d = $('journal'); d.replaceChildren()
  $('jfile').textContent = s.journalFile ? `(${s.journalFile})` : ''
  const j = s.journal
  if (!j) { d.append(el('div','dim','no journal entries')); return }
  const r = el('div','row')
  r.append(el('span','t', `run ${esc(j.runId)}`),
    el('span','m', `ok=${j.ok} · $${(j.costUsd||0).toFixed(4)}`))
  d.append(r)
  for (const e of (j.errors || []).slice(-6)) {
    const er = el('div','row')
    er.append(el('span','bad','err'), el('span','t', `${esc(e.phase)} ${esc(e.message ?? e)}`))
    d.append(er)
  }
}

async function refresh() {
  const s = await window.argus.collect()
  $('updated').textContent = 'updated ' + new Date(s.updatedAt).toLocaleTimeString()
  $('err').textContent = s.error || ''
  renderPrs(s); renderRuns(s); renderJournals(s); renderJournal(s)
  $('evalfile').textContent = s.evalFile ? `(${s.evalFile})` : ''
  $('evaldoc').textContent = s.evalDoc || 'no docs/evals/*.md yet — run eval'
}

$('refresh').onclick = refresh
$('eval').onclick = async () => {
  $('evalcard').hidden = false
  const res = await window.argus.runEval()
  if (!res.ok) {
    $('evallog').append(el('div','warn', esc(res.msg)))
  }
}
window.argus.onEvalLog(({ stream, line }) => {
  $('evalcard').hidden = false
  $('evallog').append(el('div', stream === 'err' ? 'bad' : stream === 'done' ? 'warn' : '', esc(line)))
  $('evallog').scrollTop = $('evallog').scrollHeight
  if (stream === 'done') refresh()
})

const LVL_CLS = { debug: 'dim', info: '', warn: 'warn', error: 'bad' }
function liveAppend(m) {
  const d = $('livelog')
  const t = new Date(m.ts ?? Date.now()).toLocaleTimeString()
  const row = el('div', 'row')
  row.append(
    el('span', 'm', t),
    el('span', 'lv', esc(m.source)),
    el('span', LVL_CLS[m.level] ?? '', `[${esc(m.level)}]`),
    el('span', 't', esc(m.msg ?? m.line)),
  )
  d.append(row)
  while (d.childElementCount > 400) d.firstChild.remove()
  d.scrollTop = d.scrollHeight
}
window.argus.onLiveLog(liveAppend)
window.argus.onRunLog(({ stream, line }) => {
  liveAppend({ ts: Date.now(), source: 'gh', level: stream === 'err' ? 'error' : stream === 'done' ? 'warn' : 'info', msg: line })
})

refresh()
setInterval(refresh, 30000)
