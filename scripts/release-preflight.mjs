#!/usr/bin/env node
// Release preflight gate.
//
// Answers one question, with evidence rather than memory: may this exact commit
// and version ship? It refuses unless a release test was run recently, against
// this commit, with this matrix, with no claim drift, and an AI reviewer ruled
// on it. Designed to be the step you cannot forget: it is wired into the release
// commands and into a pre-push hook.
//
//   node scripts/release-preflight.mjs                 # the newest run
//   node scripts/release-preflight.mjs --run <dir>     # a specific run
//   node scripts/release-preflight.mjs --max-age-hours 12 --json
import path from 'node:path'
import { REPO_ROOT, readJson } from '../release-test/lib/util.mjs'
import { packageMeta } from '../release-test/lib/artifact.mjs'
import { gitInfoAsync, dirtyFilesAsync } from '../release-test/lib/git.mjs'
import { loadMatrix, matrixClaimWarnings, matrixHash } from '../release-test/lib/matrix.mjs'
import { latestRun, runPath } from '../release-test/lib/runs.mjs'
import { checkRun } from '../release-test/lib/verdict.mjs'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1] ?? true
}
const has = (name) => argv.includes(`--${name}`)

const MAX_AGE_HOURS = Number(arg('max-age-hours', 24))
const JSON_OUT = has('json')
const c = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m',
}
const say = (text) => process.stdout.write(`${text}\n`)
const ok = (text) => say(`  ${c.green}✓${c.reset} ${text}`)
const bad = (text) => say(`  ${c.red}✗${c.reset} ${text}`)
const warnline = (text) => say(`  ${c.yellow}!${c.reset} ${text}`)

const problems = []
const warnings = []
const facts = {}

async function main() {
  const pkg = packageMeta()
  const git = await gitInfoAsync()
  const matrix = loadMatrix()
  const currentMatrixHash = matrixHash(matrix)
  const claims = matrixClaimWarnings(matrix)

  facts.plugin = `${pkg.name}@${pkg.version}`
  facts.commit = git.commit
  facts.branch = git.branch
  facts.dirty = git.dirty
  facts.matrixHash = currentMatrixHash

  // 1. A run must exist at all.
  const explicit = arg('run')
  const resolved = explicit ? runPath(String(explicit)) : latestRun()?.dir ?? null
  if (!resolved) {
    problems.push('没有找到任何发布测试报告 —— 先跑 `npm run test:release`')
    return finish()
  }
  const reportDir = path.resolve(resolved)
  const report = readJson(path.join(reportDir, 'report.json'))
  facts.run = report.runId
  facts.reportStatus = report.status

  // 2. The report must be about THIS version, built from THIS commit, recently.
  if (report.plugin?.version !== pkg.version) {
    problems.push(`报告测的是 ${report.plugin?.version}，当前 package.json 是 ${pkg.version} —— 版本变了，必须重跑`)
  }
  // Compare TREE hashes: that is exactly the set of files the artifact was packed
  // from. A squash/merge that lands the same content is fine; any real change is not.
  const sameTree = report.git?.tree && git.tree && report.git.tree === git.tree
  if (!sameTree) {
    if (report.git?.commit !== git.commit) {
      problems.push(`报告对应的提交是 ${String(report.git?.commit).slice(0, 8)}（tree ${String(report.git?.tree).slice(0, 8)}），当前 HEAD 是 ${String(git.commit).slice(0, 8)}（tree ${String(git.tree).slice(0, 8)}）—— 内容变了，必须重跑`)
    } else {
      problems.push('无法确认报告与当前工作树一致（缺少 tree 记录）—— 用当前版本的 harness 重跑')
    }
  } else if (report.git?.commit !== git.commit) {
    warnings.push(`tree 相同但提交不同（报告 ${String(report.git?.commit).slice(0, 8)} → HEAD ${String(git.commit).slice(0, 8)}）：内容一致，视为有效`)
  }
  if (report.git?.dirty) {
    problems.push('那次测试是在脏工作区跑的：产物可能不包含已提交的代码 —— 先提交，再在干净工作区重跑')
  }
  const ageHours = (Date.now() - Date.parse(report.generatedAt)) / 3_600_000
  facts.reportAgeHours = Math.round(ageHours * 10) / 10
  if (!(ageHours <= MAX_AGE_HOURS)) {
    problems.push(`报告已过期：${Math.round(ageHours)} 小时前（上限 ${MAX_AGE_HOURS}）—— 重跑 \`npm run test:release\``)
  }

  // 3. The support matrix must not have changed since the run.
  if (report.matrix?.hash !== currentMatrixHash) {
    problems.push('matrix.json 在测试之后被改过 —— 矩阵变了旧报告不再有效，重跑')
  }

  // 4. Claim drift blocks the release even if tests are green.
  if (claims.length) {
    for (const claim of claims) problems.push(`声明偏差：${claim.detail}`)
  }

  // 5. No failing declared target, and every declared target was actually run.
  const declared = matrix.targets.filter((t) => t.tier === 'declared').map((t) => t.version)
  const tested = new Map((report.targets ?? []).map((t) => [t.version, t]))
  for (const version of declared) {
    const target = tested.get(version)
    if (!target) problems.push(`声明支持的 ${version} 未出现在这次测试里（用了 --only/--tier 的局部运行不能作为发版依据）`)
    else if (target.status === 'fail' || target.status === 'error') problems.push(`${version} 未通过：${target.status}${target.error ? ` — ${String(target.error).split('\n')[0]}` : ''}`)
    else if (target.status === 'warn') warnings.push(`${version} 通过但有告警（见 AI 判定）`)
  }
  if (report.status === 'red') problems.push('报告总体为 red')

  // 6. The AI reviewer must have ruled on this exact report.
  const checked = checkRun(reportDir)
  facts.verdictOverall = checked.verdict?.overall ?? null
  if (!checked.ok) {
    for (const problem of checked.problems) problems.push(`AI 判定无效：${problem}`)
    problems.push('生成判定骨架并让 AI 复核：`node release-test/run.mjs verdict --template`')
  } else {
    for (const warning of checked.warnings) warnings.push(warning)
    if (checked.verdict.overall === 'fail') problems.push('AI 判定为 fail —— 禁止发版')
  }

  // 7. Dirty tree now: the artifact the users get would include uncommitted code.
  if (git.dirty) {
    const files = await dirtyFilesAsync(5)
    problems.push(`当前工作区不干净（${files.length} 个改动，例如 ${files.slice(0, 3).map((f) => f.trim()).join('；')}）—— 发版必须从干净提交出`)
  }

  return finish()
}

function finish() {
  const pass = problems.length === 0
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ pass, facts, problems, warnings }, null, 2) + '\n')
  } else {
    say(`${c.bold}Release preflight${c.reset} — ${facts.plugin} @ ${String(facts.commit).slice(0, 8)}${facts.dirty ? ' (dirty)' : ''}`)
    say(`  run ${facts.run ?? '—'} · report ${facts.reportStatus ?? '—'} · age ${facts.reportAgeHours ?? '—'}h · verdict ${facts.verdictOverall ?? '—'}`)
    if (pass) {
      ok('可以发版：报告新鲜、矩阵一致、声明无偏差、AI 判定通过、工作区干净')
      for (const warning of warnings) warnline(warning)
    } else {
      bad(`禁止发版（${problems.length} 项）:`)
      for (const problem of problems) say(`    - ${problem}`)
      for (const warning of warnings) warnline(warning)
      say('')
      say(`${c.dim}修完后重跑：npm run test:release && （AI 判定）node release-test/run.mjs verdict --check${c.reset}`)
    }
  }
  process.exitCode = pass ? 0 : 1
}

await main()
