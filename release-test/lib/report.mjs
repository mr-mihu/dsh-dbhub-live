// Report aggregation, Markdown rendering, and the AI review prompt.
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACTS_DIR, REPORTS_DIR, WORK_DIR, ensureDir, nowIso, redact, sha256, writeJson } from './util.mjs'
import { matrixHash } from './matrix.mjs'

const SEVERITY = { fail: 3, warn: 2, skip: 1, info: 0, pass: 0 }

/** Aggregate checks into a target status: fail > warn > pass. */
export function aggregate(checks) {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 }
  for (const check of checks) counts[check.status] = (counts[check.status] ?? 0) + 1
  const status = counts.fail ? 'fail' : counts.warn || counts.skip ? 'warn' : 'pass'
  return { status, counts }
}

export function summarizeTargets(targets) {
  const summary = { pass: 0, warn: 0, fail: 0, error: 0 }
  for (const target of targets) summary[target.status] = (summary[target.status] ?? 0) + 1
  return summary
}

/**
 * Things a human or an AI must look at, even when no hard assertion failed:
 * a declared channel that behaved unexpectedly, a soft warning, a skipped
 * probe, or a matrix that no longer matches the registry's latest.
 */
export function collectNeedsReview({ targets, drift, claims = [] }) {
  const items = []
  for (const claim of claims) {
    items.push({ id: claim.id, target: '*', reason: `claim drift: ${claim.detail}` })
  }
  for (const target of targets) {
    if (target.status === 'error') {
      items.push({ id: `target:${target.version}:error`, target: target.version, reason: target.error ?? 'target threw before checks completed' })
      continue
    }
    for (const check of target.checks ?? []) {
      if (check.status === 'warn' || check.status === 'skip') {
        items.push({ id: `${target.version}:${check.id}`, target: target.version, reason: `${check.status}: ${check.detail}` })
      }
    }
    if (target.status === 'fail') {
      items.push({ id: `${target.version}:failed`, target: target.version, reason: 'one or more hard checks failed (see checks)' })
    }
    if (target.provisionMode === 'manual') {
      items.push({ id: `${target.version}:provision-mode`, target: target.version, reason: 'manual provisioning — the real install path was not exercised on this target' })
    }
  }
  if (drift?.stale) {
    items.push({ id: 'matrix:drift', target: '*', reason: drift.detail })
  }
  return items
}

export function buildReport({ artifact, git, matrix, matrixFileHash, environment, options, targets, drift, claims = [], startedAt, finishedAt }) {
  const summary = summarizeTargets(targets)
  const needsReview = collectNeedsReview({ targets, drift, claims })
  const declared = targets.filter((t) => t.tier === 'declared')
  // red = something hard failed on a declared target; yellow = only judgement
  // calls (warnings, skips, claim drift, manual provisioning) are outstanding.
  const hardFailure = declared.some((t) => t.status === 'fail' || t.status === 'error')
  const status = hardFailure || summary.fail || summary.error ? 'red' : needsReview.length ? 'yellow' : 'green'
  return {
    schemaVersion: 1,
    runId: path.basename(options.runDir),
    generatedAt: finishedAt,
    startedAt,
    status,
    plugin: { name: artifact.name, version: artifact.version, tarball: path.basename(artifact.tarball), size: artifact.size, sha256: artifact.sha256 },
    git,
    matrix: { hash: matrixFileHash, updatedAt: matrix.updatedAt, targetCount: matrix.targets.length },
    environment,
    options: { provision: options.provision, only: options.only, tier: options.tier, keepHomes: options.keepHomes },
    drift,
    claims,
    summary,
    targets,
    needsReview,
  }
}

/** Persist report + evidence index. Returns { reportFile, markdownFile, judgeFile, runDir }. */export function writeReport({ runDir, report }) {
  const reportFile = path.join(runDir, 'report.json')
  const markdownFile = path.join(runDir, 'report.md')
  const judgeFile = path.join(runDir, 'judge-prompt.md')
  writeJson(reportFile, report)
  const reportHash = sha256(reportFile)
  fs.writeFileSync(markdownFile, renderMarkdown(report) + '\n')
  fs.writeFileSync(judgeFile, renderJudgePrompt(report, { reportHash }) + '\n')

  // history.jsonl: one line per run so trend/staleness checks do not need to
  // scan every report directory.
  const historyFile = path.join(REPORTS_DIR, 'history.jsonl')
  fs.appendFileSync(
    historyFile,
    JSON.stringify({ runId: report.runId, generatedAt: report.generatedAt, status: report.status, plugin: report.plugin.version, commit: report.git?.commit, reportHash }) + '\n',
  )
  return { reportFile, markdownFile, judgeFile, runDir, reportHash }
}

const badge = { pass: '✅', warn: '⚠️', fail: '❌', error: '💥', info: 'ℹ️', skip: '⏭️' }
const statusBadge = { green: '🟢 green', yellow: '🟡 needs review', red: '🔴 red' }

export function renderMarkdown(report) {
  const lines = []
  lines.push(`# Release test — ${report.plugin.name}@${report.plugin.version}`)
  lines.push('')
  lines.push(`- Status: **${statusBadge[report.status] ?? report.status}**`)
  lines.push(`- Run: \`${report.runId}\` · started ${report.startedAt} · finished ${report.generatedAt}`)
  lines.push(`- Artifact: \`${report.plugin.tarball}\` (${report.plugin.size} bytes, sha256 \`${report.plugin.sha256.slice(0, 16)}…\`)`)
  lines.push(`- Git: \`${report.git.branch}\` @ \`${report.git.commit}\`${report.git.dirty ? ' (dirty worktree)' : ''}`)
  lines.push(`- Node ${report.environment.node} · ${report.environment.platform} · dbhub ${report.environment.dbhub ?? 'not found'}`)
  lines.push(`- Matrix: ${report.matrix.targetCount} targets, hash \`${report.matrix.hash.slice(0, 16)}…\`, provision=${report.options.provision}`)
  lines.push('')
  lines.push('| Target | Tier | Era / UI | Status | Provision | Ready | Checks (pass/warn/fail) |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const target of report.targets) {
    const counts = target.checksCounts ?? {}
    lines.push(
      `| ${target.version} | ${target.tier} | ${target.era} / ${target.ui} | ${badge[target.status] ?? target.status} | ${target.provisionMode ?? '—'} | ${target.timings?.readyMs ? `${Math.round(target.timings.readyMs / 1000)}s` : '—'} | ${counts.pass ?? 0}/${counts.warn ?? 0}/${counts.fail ?? 0} |`,
    )
  }
  lines.push('')
  if (report.needsReview.length) {
    lines.push('## Needs review')
    lines.push('')
    for (const item of report.needsReview) lines.push(`- [${item.target}] ${item.reason}  \`${item.id}\``)
    lines.push('')
  }
  for (const target of report.targets) {
    lines.push(`## ${target.version} — ${badge[target.status] ?? target.status}`)
    lines.push('')
    if (target.error) {
      lines.push('```')
      lines.push(redact(target.error))
      lines.push('```')
      lines.push('')
    }
    if (target.checks?.length) {
      for (const check of target.checks) {
        lines.push(`- ${badge[check.status] ?? check.status} \`${check.id}\` — ${check.detail}`)
      }
      lines.push('')
    }
    const evidence = target.evidence ?? []
    if (evidence.length) {
      lines.push(`Evidence: ${evidence.map((file) => `\`${file}\``).join(' · ')}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * The prompt handed to the AI reviewer. It is deliberately self-contained: the
 * reviewer gets the facts, the open questions, the exact output schema, and the
 * command that validates its answer. No model calls from the harness itself —
 * judgement stays with an agent that can read the evidence.
 */
export function renderJudgePrompt(report, { reportHash }) {
  const lines = []
  lines.push(`# AI review request — release test ${report.runId}`)
  lines.push('')
  lines.push('You are reviewing the evidence of an automated release test for a DSH plugin.')
  lines.push('Deterministic checks have already run. Your job is judgement, not re-execution:')
  lines.push('read the report and the evidence files, then decide whether the release may proceed.')
  lines.push('')
  lines.push('## Facts')
  lines.push('')
  lines.push(`- Plugin: ${report.plugin.name}@${report.plugin.version} (artifact sha256 ${report.plugin.sha256})`)
  lines.push(`- Commit: ${report.git.branch} @ ${report.git.commit}${report.git.dirty ? ' — WARNING: worktree dirty, the artifact may not match HEAD' : ''}`)
  lines.push(`- Deterministic status: ${report.status} (${JSON.stringify(report.summary)})`)
  lines.push(`- Matrix hash: ${report.matrix.hash}`)
  lines.push(`- Report hash: ${reportHash}`)
  lines.push('')
  lines.push('## Per-target results')
  lines.push('')
  lines.push('| Version | Tier | Status | Failing checks | Warnings |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const target of report.targets) {
    const fails = (target.checks ?? []).filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`)
    const warns = (target.checks ?? []).filter((c) => c.status === 'warn' || c.status === 'skip').map((c) => `${c.id}: ${c.detail}`)
    lines.push(`| ${target.version} | ${target.tier} | ${target.status} | ${fails.length ? fails.join('<br>').replace(/\|/g, '\\|') : '—'} | ${warns.length ? warns.join('<br>').replace(/\|/g, '\\|') : '—'} |`)
  }
  lines.push('')
  if (report.needsReview.length) {
    lines.push('## Open questions (must be answered explicitly)')
    lines.push('')
    for (const item of report.needsReview) lines.push(`- \`${item.id}\` [${item.target}] ${item.reason}`)
    lines.push('')
  } else {
    lines.push('## Open questions')
    lines.push('')
    lines.push('None flagged by the harness. Still sanity-check the evidence summary below.')
    lines.push('')
  }
  lines.push('## Evidence')
  lines.push('')
  lines.push(`Evidence lives next to this file under \`evidence/<version>/\`: \`install.log\`, \`profile.log\`, \`provision.log\`, \`boot.log\`, \`probe-summary.json\`. Read at least the boot log and probe summary of every target you rule on.`)
  lines.push('')
  lines.push('## How to decide')
  lines.push('')
  lines.push('1. Any declared target failing a hard check => overall `fail`. Do not soften it because other targets passed.')
  lines.push('2. A warning is not automatically a failure. Decide whether it is benign for THIS release (e.g. manual provisioning in a sandboxed shell) or a real regression masked by a weak test.')
  lines.push('3. If a claimed support version is missing from the run, or the matrix looks older than the registry\'s latest, say so under that target and set `pass-with-notes`.')
  lines.push('4. If the worktree was dirty, the artifact may not match the commit: rule `pass-with-notes` at best and name it.')
  lines.push('5. Never approve a target you did not see evidence for.')
  lines.push('')
  lines.push('## Output')
  lines.push('')
  lines.push('Write `verdict.json` next to this file, then run `node release-test/run.mjs verdict --check`:')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({
    reportRunId: report.runId,
    reportHash,
    overall: 'pass | pass-with-notes | fail',
    targets: report.targets.map((t) => ({ version: t.version, verdict: 'pass | pass-with-notes | fail', reason: 'one line, cite the evidence you read' })),
    openQuestions: report.needsReview.map((n) => ({ id: n.id, answered: true, answer: 'what you concluded and why' })),
    reviewer: 'agent-name',
    reviewedAt: nowIso(),
  }, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('Start from the template with: `node release-test/run.mjs verdict --template --run ' + path.join(REPORTS_DIR, report.runId) + '`')
  return lines.join('\n')
}

export { SEVERITY, WORK_DIR, ARTIFACTS_DIR }
