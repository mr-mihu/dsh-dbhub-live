// AI verdict handling: template, validation, and the checks the preflight gate
// trusts. The harness never calls an LLM itself; it validates a verdict that an
// agent wrote, so the judgement is auditable and reproducible.
import fs from 'node:fs'
import path from 'node:path'
import { nowIso, readJson, sha256, writeJson } from './util.mjs'

export const VERDICT_FILE = 'verdict.json'
const OVERALL = new Set(['pass', 'pass-with-notes', 'fail'])
const TARGET_VERDICTS = new Set(['pass', 'pass-with-notes', 'fail'])

export const verdictPath = (runDir) => path.join(runDir, VERDICT_FILE)

/** Skeleton for the reviewer to fill in — pre-populated, never pre-approved. */
export function templateVerdict(report, reportHash) {
  return {
    reportRunId: report.runId,
    reportHash,
    overall: '',
    targets: report.targets.map((target) => ({
      version: target.version,
      verdict: '',
      reason: '',
    })),
    openQuestions: (report.needsReview ?? []).map((item) => ({ id: item.id, answered: false, answer: '' })),
    reviewer: '',
    reviewedAt: '',
  }
}

export function loadVerdict(runDir) {
  const file = verdictPath(runDir)
  if (!fs.existsSync(file)) return { ok: false, error: `no verdict at ${file}` }
  let verdict
  try {
    verdict = readJson(file)
  } catch (error) {
    return { ok: false, error: `verdict.json is not valid JSON: ${error.message}` }
  }
  return { ok: true, verdict, file }
}

/**
 * Validate a verdict against the report it claims to judge.
 * Returns { problems, warnings }.
 */
export function validateVerdict(verdict, report, reportHash) {
  const problems = []
  const warnings = []

  if (!verdict || typeof verdict !== 'object') return { problems: ['verdict is not an object'], warnings }

  if (verdict.reportRunId !== report.runId) problems.push(`reportRunId is "${verdict.reportRunId}", report is "${report.runId}"`)
  if (verdict.reportHash !== reportHash) problems.push('reportHash does not match report.json — the verdict was written against a different run')
  if (!OVERALL.has(verdict.overall)) problems.push(`overall must be one of ${[...OVERALL].join(', ')} (got ${JSON.stringify(verdict.overall)})`)
  if (!verdict.reviewer || typeof verdict.reviewer !== 'string') problems.push('reviewer must name the agent or human who judged this run')
  const reviewedAt = Date.parse(verdict.reviewedAt)
  if (!Number.isFinite(reviewedAt)) problems.push('reviewedAt must be an ISO timestamp')
  else if (reviewedAt < Date.parse(report.generatedAt)) problems.push('reviewedAt predates the report — the verdict is stale')

  const expected = new Set(report.targets.map((t) => t.version))
  const actual = new Set()
  for (const entry of verdict.targets ?? []) {
    if (!entry.version) { problems.push('targets[] entry without version'); continue }
    if (actual.has(entry.version)) problems.push(`duplicate target verdict for ${entry.version}`)
    actual.add(entry.version)
    if (!expected.has(entry.version)) problems.push(`target verdict for ${entry.version}, which is not in this report`)
    if (!TARGET_VERDICTS.has(entry.verdict)) problems.push(`${entry.version}: verdict must be one of ${[...TARGET_VERDICTS].join(', ')}`)
    if (!entry.reason || !String(entry.reason).trim()) problems.push(`${entry.version}: reason is required (cite the evidence you read)`)
    const target = report.targets.find((t) => t.version === entry.version)
    if (target?.status === 'fail' && entry.verdict !== 'fail') {
      problems.push(`${entry.version}: deterministic checks failed but verdict is "${entry.verdict}" — a failing declared target must be ruled fail`)
    }
  }
  for (const version of expected) if (!actual.has(version)) problems.push(`missing target verdict for ${version}`)

  // Every open question must be answered explicitly.
  const answers = new Map((verdict.openQuestions ?? []).map((q) => [q.id, q]))
  for (const item of report.needsReview ?? []) {
    const answer = answers.get(item.id)
    if (!answer) problems.push(`open question ${item.id} was not addressed`)
    else if (!answer.answered) problems.push(`open question ${item.id} is marked unanswered`)
    else if (!answer.answer || !String(answer.answer).trim()) problems.push(`open question ${item.id} has no answer text`)
  }

  // Overall verdict must be consistent with the per-target verdicts.
  const targetVerdicts = (verdict.targets ?? []).map((t) => t.verdict)
  if (verdict.overall === 'pass') {
    if (targetVerdicts.some((v) => v !== 'pass')) problems.push('overall is "pass" but at least one target is not "pass"')
    if ((report.needsReview ?? []).length) problems.push('overall is "pass" but the report has open questions — use "pass-with-notes"')
  }
  if (verdict.overall === 'fail' && targetVerdicts.every((v) => v === 'pass')) {
    warnings.push('overall is "fail" while every target passed — make sure that is intended')
  }

  return { problems, warnings }
}

/** Read report + verdict and validate; used by preflight and by `verdict --check`. */
export function checkRun(runDir) {
  const reportFile = path.join(runDir, 'report.json')
  if (!fs.existsSync(reportFile)) return { ok: false, problems: [`no report.json in ${runDir}`] }
  const report = readJson(reportFile)
  const reportHash = sha256(reportFile)
  const loaded = loadVerdict(runDir)
  if (!loaded.ok) return { ok: false, problems: [loaded.error], report, reportHash }
  const { problems, warnings } = validateVerdict(loaded.verdict, report, reportHash)
  return { ok: problems.length === 0, problems, warnings, report, reportHash, verdict: loaded.verdict }
}

export function writeVerdict(runDir, verdict) {
  return writeJson(verdictPath(runDir), verdict)
}

export { nowIso }
