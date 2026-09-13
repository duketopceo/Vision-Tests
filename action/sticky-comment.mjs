/* global github, context, core, require, process */

const fs = require('fs')
const path = require('path')

const SENTINEL = '<!-- argus-reviewer -->'

function formatUsd(n) {
  return `$${(n || 0).toFixed(6)}`
}

function renderMissingKeyBody() {
  const lines = []
  lines.push(SENTINEL)
  lines.push('')
  lines.push('## argus-reviewer ⚪ skipped')
  lines.push('')
  lines.push('`OPENROUTER_API_KEY` is not configured. Add it as a repository or workflow secret to run argus-reviewer.')
  lines.push('')
  lines.push('This status is intentionally neutral, not a failure.')
  lines.push('')
  return lines.join('\n')
}

function renderNoReportBody(reportDir, runUrl) {
  const lines = []
  lines.push(SENTINEL)
  lines.push('')
  lines.push('## argus-reviewer ⚠️ no report')
  lines.push('')
  lines.push(`The run step produced no \`run.json\` under \`${reportDir}\`. The commit status fails closed — check the action logs before merging.`)
  lines.push('')
  lines.push(`[View run](${runUrl})`)
  lines.push('')
  return lines.join('\n')
}

function renderBody(report, codeReview, runUrl, ok) {
  if (!report) return renderMissingKeyBody()

  const lines = []
  const budgetCap = report.config?.budgetUsd ?? 0
  const healCount = report.tests.reduce((n, t) => n + (t.healEvents?.length ?? 0), 0)
  const assertCount = report.tests.reduce((n, t) => n + (t.asserts?.length ?? 0), 0)
  const assertFails = report.tests.reduce(
    (n, t) => n + (t.asserts?.filter((a) => a.verdict === 'fail').length ?? 0),
    0,
  )
  const trace = report.trace ?? {}

  lines.push(SENTINEL)
  lines.push('')
  lines.push(`## argus-reviewer ${ok ? '✅ PASS' : '❌ FAIL'}`)
  lines.push('')
  lines.push(
    `**Summary:** ${report.totals.passed}/${report.totals.tests} passed · ` +
      `${report.totals.visionCalls} vision calls · ` +
      `${formatUsd(report.totals.visionCostUsd)} spend · ` +
      `${report.totals.sandboxSeconds.toFixed(1)}s sandbox`,
  )
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>📝 Summary</summary>')
  lines.push('')
  lines.push('**What ran**')
  for (const t of report.tests) {
    lines.push(`- \`${path.basename(t.file)}\` — ${t.name}`)
  }
  lines.push('')
  lines.push(`**Risk:** ${ok ? 'Low — UI regression tests and code review passed; no heals or failures.' : 'High — investigate failures before merge.'}`)
  lines.push('')
  if (Object.keys(trace).length > 0) {
    lines.push('**Trace**')
    for (const [k, v] of Object.entries(trace)) {
      lines.push(`- ${k}: \`${v}\``)
    }
    lines.push('')
  }
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push(`<summary>📒 Tests (${report.totals.tests})</summary>`)
  lines.push('')
  lines.push('| Test | Result | Calls | Cost | Heals | Asserts |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |')
  for (const t of report.tests) {
    const result = t.ok ? '✅ pass' : '❌ fail'
    lines.push(`| ${t.name} | ${result} | ${t.visionCalls} | ${formatUsd(t.visionCostUsd)} | ${t.healEvents?.length ?? 0} | ${t.asserts?.length ?? 0} |`)
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>💰 Cost ledger</summary>')
  lines.push('')
  lines.push('| Line item | Value |')
  lines.push('| --- | ---: |')
  lines.push(`| Vision calls | ${report.totals.visionCalls} |`)
  const perCall =
    report.totals.visionCalls > 0
      ? formatUsd(report.totals.visionCostUsd / report.totals.visionCalls)
      : '$0.00'
  lines.push(`| Per-call cost (avg) | ${perCall} |`)
  for (const model of Object.keys(report.totals.callsByModel ?? {}).sort()) {
    lines.push(`| Calls (${model}) | ${report.totals.callsByModel[model]} |`)
    lines.push(`| Spend (${model}) | ${formatUsd(report.totals.costByModel?.[model] ?? 0)} |`)
  }
  lines.push(`| Total vision spend | ${formatUsd(report.totals.visionCostUsd)} |`)
  lines.push(`| Sandbox seconds | ${report.totals.sandboxSeconds.toFixed(1)}s |`)
  if (budgetCap > 0) {
    lines.push(`| Budget cap | ${formatUsd(budgetCap)} |`)
    lines.push(`| Budget exceeded | ${report.totals.budgetExceeded ? '⚠️ yes' : '✅ no'} |`)
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>🔧 Heal events</summary>')
  lines.push('')
  const heals = report.tests.flatMap((t) => t.healEvents ?? [])
  if (heals.length === 0) {
    lines.push('No heals this run.')
  } else {
    for (const h of heals) {
      lines.push(`- \`${h.instruction}\` healed with ${h.model || 'unknown model'}`)
    }
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>✅ Assertions</summary>')
  lines.push('')
  let any = false
  for (const t of report.tests) {
    if (!t.asserts || t.asserts.length === 0) continue
    any = true
    lines.push(`**${t.name}**`)
    for (const a of t.asserts) {
      const icon = a.verdict === 'pass' ? '✅' : a.verdict === 'fail' ? '❌' : '⚪'
      lines.push(`- ${icon} *${a.question}* — ${a.reasoning}`)
    }
    lines.push('')
  }
  if (!any) {
    lines.push('No assertions recorded.')
    lines.push('')
  }
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>📂 Evidence</summary>')
  lines.push('')
  if (report.artifacts && report.artifacts.videos.length > 0) {
    for (const v of report.artifacts.videos) lines.push(`- video: \`${v}\``)
  }
  if (runUrl) lines.push(`- [workflow run / artifacts](${runUrl})`)
  if ((!report.artifacts || report.artifacts.videos.length === 0) && !runUrl) {
    lines.push('No artifact links available.')
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>🚥 Pre-merge checks</summary>')
  lines.push('')
  lines.push('| Check | Status | Explanation |')
  lines.push('| --- | --- | --- |')
  lines.push(`| Tests | ${report.ok ? '✅ Passed' : '❌ Failed'} | ${report.totals.passed}/${report.totals.tests} tests passed |`)
  lines.push(`| Budget | ${report.totals.budgetExceeded ? '⚠️ Warning' : '✅ Passed'} | ${formatUsd(report.totals.visionCostUsd)} spent${budgetCap > 0 ? ` of ${formatUsd(budgetCap)}` : ''} |`)
  lines.push(`| Heal events | ${healCount === 0 ? '✅ Passed' : '⚠️ Warning'} | ${healCount} heal event${healCount === 1 ? '' : 's'} |`)
  lines.push(`| Assertions | ${assertFails === 0 ? '✅ Passed' : '❌ Failed'} | ${assertFails === 0 ? assertCount : `${assertFails} failed`} assertion${assertCount === 1 ? '' : 's'} |`)
  lines.push(`| OpenRouter key | ✅ Passed | \`OPENROUTER_API_KEY\` configured |`)
  if (codeReview && !codeReview.skipped) {
    const codeStatus = codeReview.ok ? '✅ Passed' : '❌ Failed'
    lines.push(`| Code review | ${codeStatus} | ${codeReview.findings.length} findings (${codeReview.model}) |`)
  } else {
    lines.push(`| Code review | ⚪ Skipped | ${codeReview?.summary ?? 'no report'} |`)
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  if (codeReview && !codeReview.skipped) {
    lines.push('<details>')
    lines.push('<summary>🧠 Code review</summary>')
    lines.push('')
    lines.push(`**Verdict:** ${codeReview.verdict} · ${codeReview.model} · ${codeReview.tokens}tok ${formatUsd(codeReview.visionCostUsd)}`)
    lines.push('')
    lines.push(codeReview.summary)
    lines.push('')
    if (codeReview.findings.length > 0) {
      lines.push('| File | Severity | Finding |')
      lines.push('| --- | --- | --- |')
      for (const f of codeReview.findings) {
        lines.push(`| \`${f.file}\` | ${f.severity} | ${f.message} |`)
      }
      lines.push('')
    }
    lines.push('</details>')
    lines.push('')
  }

  lines.push('<details>')
  lines.push('<summary>✨ Actions</summary>')
  lines.push('')
  lines.push('- [ ] Re-run argus-reviewer')
  lines.push('- [ ] Open a heal PR')
  lines.push('- [ ] Record a new flow')
  lines.push('')
  lines.push('</details>')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('<sub>`argus-reviewer` — self-hosted, BYOK OpenRouter UI regression.</sub>')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const pr = context.payload && context.payload.pull_request
  const owner = context.repo.owner
  const repo = context.repo.repo
  const hasKey = !!process.env.OPENROUTER_API_KEY
  const workDir = process.env.VISION_E2E_WORKING_DIR || ''
  const reportDir = path.resolve(
    process.env.GITHUB_WORKSPACE,
    workDir,
    process.env.ARGUS_REPORT_DIR || 'argus-reviewer-report',
  )
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`

  let report
  let codeReview
  if (hasKey) {
    try {
      const raw = fs.readFileSync(path.join(reportDir, 'run.json'), 'utf8')
      report = JSON.parse(raw)
    } catch {
      report = undefined
    }
    try {
      const raw = fs.readFileSync(path.join(reportDir, 'code-review.json'), 'utf8')
      codeReview = JSON.parse(raw)
    } catch {
      codeReview = undefined
    }
  }

  // Missing code-review.json after a continue-on-error step means the review
  // crashed, not that it skipped — an intentional skip writes ok+skipped.
  // Fail closed rather than reporting it as a clean skip.
  const codeReviewOk = codeReview != null && codeReview.ok === true
  const ok = (report?.ok === true) && codeReviewOk
  const conclusion = !hasKey ? 'neutral' : ok ? 'success' : 'failure'
  const body = !hasKey
    ? renderMissingKeyBody()
    : report === undefined
      ? renderNoReportBody(reportDir, runUrl)
      : renderBody(report, codeReview, runUrl, ok)

async function postInlineComments(pr, codeReview) {
  if (!pr || !codeReview || codeReview.skipped || !codeReview.findings) return
  // Must match the severity vocabulary emitted by the code-review schema
  // (src/cli.ts): bug/risk are inline-worthy; nit/q stay in the sticky body.
  const inlineSeverities = ['bug', 'risk']
  const comments = codeReview.findings
    .filter((f) => f.file && typeof f.line === 'number' && inlineSeverities.includes(f.severity))
    .map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT',
      body: `**argus-reviewer ${f.severity}:** ${f.message}`,
    }))
  if (comments.length === 0) return

  // Re-runs on the same SHA must not duplicate inline comments — the sticky
  // body is upserted but review comments are not. Paginate fully (100/page)
  // and scope dedup to the current head: comments on older commits must not
  // suppress findings that still apply to this head.
  const posted = new Set()
  let page = 1
  for (;;) {
    const { data: existing } = await github.rest.pulls.listReviewComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      per_page: 100,
      page,
    })
    for (const c of existing) {
      if (c.body && c.body.startsWith('**argus-reviewer') && c.commit_id === pr.head.sha) {
        posted.add(`${c.path}:${c.line}:${c.body}`)
      }
    }
    if (existing.length < 100) break
    page += 1
  }
  const fresh = comments.filter((c) => !posted.has(`${c.path}:${c.line}:${c.body}`))
  if (fresh.length === 0) return

  // One batched review instead of N createReviewComment calls — avoids
  // secondary rate limits on large findings sets.
  try {
    await github.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      commit_id: pr.head.sha,
      event: 'COMMENT',
      comments: fresh,
    })
  } catch (e) {
    core.warning(`inline review failed: ${e.message}`)
  }
}

  if (pr) {
    const { data: comments } = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    })
    const existing = comments.find((c) => c.body && c.body.includes(SENTINEL))
    if (existing) {
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
    } else {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body,
      })
    }
    await postInlineComments(pr, codeReview)
  }

  const sha = pr ? pr.head.sha : context.sha
  // Commit statuses have no 'neutral'; a 'pending' skip would wedge a
  // required check forever, so skip maps to success with a clear label.
  const state = conclusion === 'failure' ? 'failure' : 'success'
  const description =
    conclusion === 'neutral'
      ? 'argus-reviewer skipped (no OPENROUTER_API_KEY)'
      : `argus-reviewer ${conclusion}`
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    description,
    context: 'argus-reviewer',
    target_url: runUrl,
  })

  core.setOutput('conclusion', conclusion)
}

return await main()
