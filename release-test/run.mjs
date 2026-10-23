#!/usr/bin/env node
// Release test runner: for each DSH version in release-test/matrix.json,
// install the pinned CLI, create an isolated DSH_HOME, provision the packed
// plugin, boot `dsh web`, probe the host + HTTP surface, and write an evidence
// bundle plus a report an AI reviewer can rule on.
//
// Usage:
//   node release-test/run.mjs                      # every target in the matrix
//   node release-test/run.mjs --tier declared      # only blocking targets
//   node release-test/run.mjs --only 0.2.1-rc.2    # one version (repeatable)
//   node release-test/run.mjs --provision cli      # require the real dsh plugin add
//   node release-test/run.mjs --tarball <path>     # test an existing artifact
//   node release-test/run.mjs --keep               # keep isolated homes for debugging
//   node release-test/run.mjs report --last        # print the newest report
//   node release-test/run.mjs verdict --template   # skeleton for the AI reviewer
//   node release-test/run.mjs verdict --check      # validate the reviewer's verdict
//   node release-test/run.mjs matrix               # validate/print the support matrix
//   node release-test/run.mjs selftest             # semver + matrix self-checks
//   node release-test/run.mjs clean [--all]        # prune homes / old reports / cached CLIs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { gitInfoAsync } from './lib/git.mjs'
import {
  CACHE_DIR, HOMES_DIR, REPORTS_DIR, REPO_ROOT, TOOLS_DIR, WORK_DIR, ensureDir, hhmmss, nowIso, readJson, redact, sha256, stamp, writeJson,
} from './lib/util.mjs'
import { loadMatrix, matrixClaimWarnings, matrixHash, selectTargets, validateMatrix } from './lib/matrix.mjs'
import { ensureCli, distTags, cliEnv } from './lib/cli-install.mjs'
import { describeCli, resolveCli } from './lib/cli-source.mjs'
import { applySandboxHostPatch } from './lib/host-patch.mjs'
import { prepareHome, createProfile, provisionPlugin, dshEnv } from './lib/home.mjs'
import { bootServer, freePort, stopServer } from './lib/server.mjs'
import { openSession, runProbes } from './lib/probe.mjs'
import { packPlugin, useTarball, packageMeta } from './lib/artifact.mjs'
import { aggregate, buildReport, writeReport, renderMarkdown, renderJudgePrompt } from './lib/report.mjs'
import { checkRun, loadVerdict, templateVerdict, validateVerdict, verdictPath, writeVerdict } from './lib/verdict.mjs'
import { run, waitForFile } from './lib/proc.mjs'
import { compareVersions, selfTest } from './lib/semver.mjs'

const argv = process.argv.slice(2)
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'run'
const flags = new Map()
const lists = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  if (!token.startsWith('--')) continue
  const key = token.slice(2)
  const next = argv[i + 1]
  if (!next || next.startsWith('--')) {
    flags.set(key, true)
  } else {
    if (key === 'only') lists.set(key, [...(lists.get(key) ?? []), ...next.split(',')])
    else flags.set(key, next)
    i += 1
  }
}
const flag = (name, fallback = null) => (flags.has(name) ? flags.get(name) : fallback)

const c = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m',
}
const say = (text) => process.stdout.write(`${text}\n`)
const step = (text) => say(`${c.cyan}▶${c.reset} ${text}`)
const ok = (text) => say(`  ${c.green}✓${c.reset} ${text}`)
const warn = (text) => say(`  ${c.yellow}!${c.reset} ${text}`)
const bad = (text) => say(`  ${c.red}✗${c.reset} ${text}`)

async function detectDbhub() {
  const logFile = path.join(CACHE_DIR, 'dbhub-version.log')
  const home = path.join(HOMES_DIR, '_tooling')
  const result = await run('dbhub', ['--version'], { env: { ...process.env, DSH_HOME: home }, logFile, timeoutMs: 20_000, label: 'dbhub --version' })
  if (result.code !== 0) return null
  const text = fs.readFileSync(logFile, 'utf8')
  const match = /(\d+\.\d+\.\d+)/.exec(text)
  return match ? match[1] : null
}

async function driftCheck(matrix, logFile) {
  const tags = await distTags({ logFile })
  if (!tags?.latest) return { checked: false, detail: 'could not read npm dist-tags (offline?)' }
  const declared = matrix.targets.filter((t) => t.tier === 'declared').map((t) => t.version)
  const newest = [...declared].sort(compareVersions).at(-1)
  const stale = compareVersions(tags.latest, newest) > 0
  return {
    checked: true,
    latest: tags.latest,
    alpha: tags.alpha ?? null,
    newestDeclared: newest,
    stale,
    detail: stale ? `npm dist-tag latest is ${tags.latest}, newer than the newest declared target ${newest} — the matrix may be stale` : `npm latest ${tags.latest} is covered by the matrix`,
  }
}

function describeTargets(targets) {
  for (const target of targets) {
    say(`  · ${target.version.padEnd(16)} ${target.tier.padEnd(9)} ${target.era.padEnd(11)} ui=${target.ui.padEnd(6)} — ${target.why}`)
  }
}

async function runOne({ target, artifact, matrix, runDir, provision, keep, skipInstall, cliSource }) {
  const version = target.version
  const evidenceDir = ensureDir(path.join(runDir, 'evidence', version))
  const logs = {
    install: path.join(evidenceDir, 'install.log'),
    profile: path.join(evidenceDir, 'profile.log'),
    provision: path.join(evidenceDir, 'provision.log'),
    boot: path.join(evidenceDir, 'boot.log'),
  }
  const result = {
    version,
    tier: target.tier,
    era: target.era,
    ui: target.ui,
    why: target.why,
    status: 'pass',
    checks: [],
    checksCounts: {},
    timings: {},
    provisionMode: null,
    cliSource: null,
    evidence: Object.keys(logs).map((key) => `evidence/${version}/${path.basename(logs[key])}`),
    notes: [],
  }
  const startedAt = Date.now()
  let server = null
  try {
    step(`[${version}] pinned CLI (source: ${cliSource})`)
    let cli = await resolveCli(version, { source: cliSource, logFile: logs.install, skipInstall })
    result.cliSource = cli.kind
    for (const note of cli.notes) result.notes.push(note)
    ok(describeCli(cli))
    result.timings.installMs = Date.now() - startedAt

    // Bring-up is retried once when the pinned CLI was installed without install
    // scripts and a native module is missing: 0.1.5 aborts with "Cannot find the
    // native Koffi module" in that case, and re-running npm with scripts enabled
    // is exactly the fix a developer would apply by hand.
    const NATIVE_MISSING = /Cannot find the native .* module|plugin tree failed|Cannot find module/i

    // Sandbox-only host patch, declared per target in matrix.json. Never needed
    // on a normal machine or in CI (see lib/host-patch.mjs).
    const patchHost = (why) => {
      if (!target.sandboxPatch) return
      if (cli.kind !== 'npm') {
        result.notes.push(`sandbox host patch NOT applied: this target runs from mise's global install (not ours to patch); if it fails on a native module, rerun with --cli-source npm`)
        return
      }
      const patched = applySandboxHostPatch(path.join(TOOLS_DIR, `dsh-${version}`))
      if (patched.applied) {
        warn(`[${version}] sandbox host patch applied (${patched.edits} edit(s)): ${why}`)
        result.notes.push(`sandbox host patch applied to the cached CLI (${patched.edits} edit(s), ${target.sandboxPatch}) — environment workaround, not a plugin change`)
      } else if (patched.alreadyPatched) {
        result.notes.push('sandbox host patch already present in the cached CLI')
      }
      for (const warning of patched.warnings) warn(`[${version}] ${warning}`)
    }
    patchHost('junctions are invisible to Node in this sandbox')

    let provisioned
    let attempt = 1
    for (;;) {
      // Each attempt gets a clean boot log: otherwise a retry would be judged on
      // the previous attempt's fatal line (log is append-only).
      if (attempt > 1) fs.writeFileSync(logs.boot, '')
      step(`[${version}] isolated home + web profile${attempt > 1 ? ' (retry)' : ''}`)
      prepareHome(version, { clean: true })
      await createProfile(version, { logFile: logs.profile, cli })
      ok(`home: ${path.join(HOMES_DIR, `dsh-${version}`)}`)

      step(`[${version}] provision plugin (${provision})`)
      provisioned = await provisionPlugin({ version, tarball: artifact.tarball, pluginName: artifact.name, mode: provision, logFile: logs.provision, cli })
      result.provisionMode = provisioned.mode
      result.notes.push(...provisioned.notes)
      ok(`plugin ${provisioned.installed.name}@${provisioned.installed.version} (${provisioned.mode})`)

      step(`[${version}] boot dsh web`)
      const port = await freePort()
      try {
        server = await bootServer({ version, cli, port, logFile: logs.boot })
        break
      } catch (error) {
        // Sandbox-only limitation: the sandbox denies symlink creation, and the
        // 0.1.5/0.1.6 CLIs repair their profile module fallback with symlinks.
        // A normal machine does not need this; fall back to the npm-installed
        // CLI, which the host patch can make tolerate the missing link.
        if (attempt === 1 && cli.kind === 'mise' && /EPERM[^\n]*symlink|symlink[^\n]*EPERM|operation not permitted, symlink/i.test(error.message)) {
          warn(`${version}: this sandbox denies symlink creation, which the ${version} CLI needs to heal its profile`)
          warn('falling back to the npm-installed CLI (patched) for this target')
          result.notes.push('mise CLI could not boot in this sandbox (symlink denied); fell back to the npm-installed CLI for this target')
          cli = await resolveCli(version, { source: 'npm', logFile: logs.install })
          result.cliSource = cli.kind
          patchHost('fell back to the npm-installed CLI')
          attempt = 2
          continue
        }
        if (attempt === 1 && !skipInstall && NATIVE_MISSING.test(error.message)) {
          warn(`${version}: ${error.message.split('\n')[0]}`)
          warn('reinstalling the pinned CLI with install scripts enabled, then retrying once')
          result.notes.push('first boot failed on a missing native module; retried with npm install scripts enabled')
          if (cli.kind !== 'npm') throw error
          await ensureCli(version, { logFile: logs.install, force: true, withScripts: true })
          patchHost('reinstalled CLI lost the sandbox host patch')
          attempt = 2
          continue
        }
        throw error
      }
    }
    result.timings.bootMs = Date.now() - startedAt
    result.timings.readyMs = server.readyMs
    ok(`web ready at ${server.base} in ${hhmmss(server.readyMs)}`)

    // The capability probe runs asynchronously after boot. Give it a bounded
    // moment to land, otherwise the probe would race the log it asserts on.
    const capabilityWait = await waitForFile(logs.boot, (text) => /dbhub 能力探测/.test(text), { timeoutMs: 15_000 })
    if (!capabilityWait.ok) result.notes.push('dbhub capability line did not appear within 15s of boot')

    step(`[${version}] probes`)
    const session = await openSession(server.base, server.token)
    const checks = await runProbes({
      version,
      target,
      base: server.base,
      token: server.token,
      cookie: session.cookie,
      home: path.join(HOMES_DIR, `dsh-${version}`),
      logFile: logs.boot,
      artifact,
      boot: { readyMs: server.readyMs },
      provisionMode: provisioned.mode,
    })
    result.checks = checks
    const { status, counts } = aggregate(checks)
    result.status = status
    result.checksCounts = counts
    for (const check of checks) {
      if (check.status === 'fail') bad(`${check.id}: ${check.detail}`)
      else if (check.status === 'warn' || check.status === 'skip') warn(`${check.id}: ${check.detail}`)
    }
    ok(`${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail`)
    writeJson(path.join(evidenceDir, 'probe-summary.json'), checks)
  } catch (error) {
    result.status = 'error'
    result.error = redact(error?.stack ?? String(error))
    bad(`[${version}] ${error?.message ?? error}`)
  } finally {
    if (server) stopServer(server.child)
    result.timings.totalMs = Date.now() - startedAt
  }
  return result
}

function pruneReports(keepCount) {
  if (!fs.existsSync(REPORTS_DIR)) return
  const dirs = fs.readdirSync(REPORTS_DIR).filter((name) => /^\d{8}-\d{6}/.test(name)).sort()
  for (const dir of dirs.slice(0, Math.max(0, dirs.length - keepCount))) {
    fs.rmSync(path.join(REPORTS_DIR, dir), { recursive: true, force: true })
  }
}

async function cmdRun() {
  const matrix = loadMatrix()
  validateMatrix(matrix)
  const claims = matrixClaimWarnings(matrix)
  const targets = selectTargets(matrix, { only: lists.get('only') ?? [], tier: flag('tier') })
  const provision = flag('provision', 'auto')
  const keep = Boolean(flag('keep'))
  const skipInstall = Boolean(flag('skip-install'))
  const cliSource = String(flag('cli-source', 'auto'))
  const git = await gitInfoAsync()
  const runId = `${stamp()}-${matrixHash(matrix).slice(0, 6)}`
  const runDir = ensureDir(path.join(REPORTS_DIR, runId))

  say(`${c.bold}Release test${c.reset} ${packageMeta().name}@${packageMeta().version}`)
  say(`  commit ${git.branch}@${git.commit?.slice(0, 8)}${git.dirty ? ' (dirty)' : ''} · node ${process.version} · ${os.platform()} ${os.release()}`)
  say(`  targets (${targets.length}):`)
  describeTargets(targets)
  if (claims.length) {
    say('')
    say(`${c.yellow}${claims.length} claim-drift warning(s) — declared support vs manifest:${c.reset}`)
    for (const claim of claims) say(`  ${c.yellow}!${c.reset} ${claim.detail}`)
    say(`${c.dim}  (these block the release preflight, not the test run)${c.reset}`)
  }
  say('')

  say(`${c.cyan}▶${c.reset} artifact`)
  const artifact = flag('tarball') ? useTarball(flag('tarball')) : await packPlugin({ logFile: path.join(runDir, 'artifact.log') })
  if (artifact.version !== packageMeta().version) {
    warn(`artifact version ${artifact.version} ≠ package.json ${packageMeta().version}`)
  }
  ok(`${path.basename(artifact.tarball)} (${artifact.size} bytes, sha256 ${artifact.sha256.slice(0, 16)}…)`)

  step('matrix drift vs npm dist-tags')
  const drift = await driftCheck(matrix, path.join(runDir, 'drift.log'))
  if (drift.stale) warn(drift.detail)
  else ok(drift.detail)

  const dbhub = await detectDbhub()
  const startedAt = nowIso()
  const results = []
  for (const target of targets) {
    say('')
    results.push(await runOne({ target, artifact, matrix, runDir, provision, keep, skipInstall, cliSource }))
  }

  const report = buildReport({
    artifact,
    git,
    matrix,
    matrixFileHash: matrixHash(matrix),
    environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, dbhub, cwd: REPO_ROOT },
    options: { runDir, provision, cliSource, only: lists.get('only') ?? [], tier: flag('tier'), keepHomes: keep },
    targets: results,
    drift,
    claims,
    startedAt,
    finishedAt: nowIso(),
  })
  const written = writeReport({ runDir, report })
  pruneReports(Number(flag('keep-reports', 10)))

  say('')
  say(`${c.bold}Summary${c.reset} ${report.status.toUpperCase()} · ${JSON.stringify(report.summary)}`)
  say(`  report:  ${path.relative(REPO_ROOT, written.reportFile)}`)
  say(`  evidence: ${path.relative(REPO_ROOT, path.join(runDir, 'evidence'))}`)
  say(`  AI review request: ${path.relative(REPO_ROOT, written.judgeFile)}`)
  if (report.needsReview.length) {
    say('')
    say(`${c.yellow}${report.needsReview.length} item(s) need an AI/human ruling:${c.reset}`)
    for (const item of report.needsReview) say(`  - [${item.target}] ${item.reason}`)
    say('')
    say(`Next: write the verdict from the template, then validate it:`)
    say(`  node release-test/run.mjs verdict --template --run ${path.relative(REPO_ROOT, runDir)}`)
    say(`  node release-test/run.mjs verdict --check    --run ${path.relative(REPO_ROOT, runDir)}`)
  }
  if (report.status === 'red') {
    say(`${c.red}Release blocked: at least one declared target failed.${c.reset}`)
    process.exitCode = 1
  } else if (report.status === 'yellow') {
    process.exitCode = 0
  }
}

function latestRunDir() {
  if (!fs.existsSync(REPORTS_DIR)) return null
  const dirs = fs.readdirSync(REPORTS_DIR).filter((name) => /^\d{8}-\d{6}/.test(name)).sort()
  return dirs.length ? path.join(REPORTS_DIR, dirs.at(-1)) : null
}

function resolveRunDir() {
  if (flag('run')) {
    const run = path.resolve(REPO_ROOT, flag('run'))
    if (!fs.existsSync(run)) throw new Error(`run directory not found: ${run}`)
    return run
  }
  const latest = latestRunDir()
  if (!latest) throw new Error('no report runs yet — run `node release-test/run.mjs` first')
  return latest
}

async function cmdMatrix() {
  const matrix = loadMatrix()
  validateMatrix(matrix)
  const pkg = packageMeta()
  const claims = matrixClaimWarnings(matrix)
  say(`${c.bold}Support matrix${c.reset} (release-test/matrix.json, hash ${matrixHash(matrix).slice(0, 12)}…)`)
  for (const target of matrix.targets) {
    const advertised = Object.keys(pkg.compatibility).includes(target.version) ? 'advertised' : '—'
    say(`  ${target.version.padEnd(16)} ${target.tier.padEnd(9)} ${target.era.padEnd(11)} ui=${target.ui.padEnd(6)} ${advertised}`)
  }
  say('')
  say('peer ranges:')
  for (const [name, range] of Object.entries(pkg.peerDependencies)) say(`  ${name}: ${range}`)
  say('')
  ok('matrix structure is valid')
  if (claims.length) {
    say('')
    say(`${c.yellow}${claims.length} claim-drift warning(s):${c.reset}`)
    for (const claim of claims) say(`  ${c.yellow}!${c.reset} ${claim.detail}`)
    say(`${c.dim}  These block the release preflight: a version we list as supported must actually be installable.${c.reset}`)
  } else {
    ok('every declared version satisfies the declared peer ranges')
  }
}

function cmdReport() {
  const runDir = resolveRunDir()
  const report = readJson(path.join(runDir, 'report.json'))
  if (flag('markdown')) {
    say(renderMarkdown(report))
    return
  }
  say(`${c.bold}${report.plugin.name}@${report.plugin.version}${c.reset} run ${report.runId} — ${report.status}`)
  say(`  commit ${report.git?.branch}@${report.git?.commit?.slice(0, 8)} · ${report.generatedAt}`)
  for (const target of report.targets) {
    const counts = target.checksCounts ?? {}
    say(`  ${target.version.padEnd(16)} ${target.status.padEnd(6)} ${counts.pass ?? 0}/${counts.warn ?? 0}/${counts.fail ?? 0}  ${target.provisionMode ?? ''}`)
    if (target.error) say(`    error: ${target.error.split('\n')[0]}`)
    for (const check of target.checks ?? []) {
      if (check.status === 'fail') say(`    ${c.red}✗ ${check.id}${c.reset}: ${check.detail}`)
      if (check.status === 'warn') say(`    ${c.yellow}! ${check.id}${c.reset}: ${check.detail}`)
    }
  }
  const verdict = loadVerdict(runDir)
  say('')
  if (verdict.ok) say(`AI verdict: ${verdict.verdict.overall} by ${verdict.verdict.reviewer} at ${verdict.verdict.reviewedAt}`)
  else say(`AI verdict: ${c.yellow}missing${c.reset} (${verdict.error})`)
  if (report.needsReview.length) say(`open questions: ${report.needsReview.length}`)
}

function cmdVerdict() {
  const runDir = resolveRunDir()
  const reportFile = path.join(runDir, 'report.json')
  const report = readJson(reportFile)
  const reportHash = sha256(reportFile)

  if (flag('template')) {
    const target = verdictPath(runDir)
    if (fs.existsSync(target) && !flag('force')) {
      bad(`${path.relative(REPO_ROOT, target)} already exists — pass --force to overwrite`)
      process.exitCode = 1
      return
    }
    writeVerdict(runDir, templateVerdict(report, reportHash))
    ok(`wrote ${path.relative(REPO_ROOT, target)} — fill in every verdict/reason/open answer, then run: node release-test/run.mjs verdict --check`)
    return
  }

  const checked = checkRun(runDir)
  if (!checked.report) {
    bad(`cannot check: ${checked.problems.join('; ')}`)
    process.exitCode = 1
    return
  }
  for (const warning of checked.warnings ?? []) warn(warning)
  if (checked.ok) {
    ok(`verdict is valid: overall=${checked.verdict.overall}, ${checked.verdict.targets.length} target(s) ruled, ${checked.verdict.openQuestions.filter((q) => q.answered).length} open question(s) answered`)
    if (checked.verdict.overall === 'fail') {
      bad('verdict is "fail" — this release is blocked')
      process.exitCode = 1
    }
    return
  }
  bad('verdict is not valid:')
  for (const problem of checked.problems) say(`  - ${problem}`)
  process.exitCode = 1
}

async function cmdClean() {
  const all = Boolean(flag('all'))
  const toolsOnly = Boolean(flag('tools'))
  let removed = 0

  // The npm fallback leaves one full CLI tree per version (~470 MB each).
  // Once every target is pre-installed through mise, drop them all:
  //   node release-test/run.mjs clean --tools
  if (toolsOnly || all) {
    if (fs.existsSync(TOOLS_DIR)) {
      const entries = fs.readdirSync(TOOLS_DIR)
      for (const name of entries) {
        fs.rmSync(path.join(TOOLS_DIR, name), { recursive: true, force: true })
        removed += 1
      }
      ok(`removed ${entries.length} cached npm CLI(s)`)
    }
  }
  if (all && !toolsOnly && fs.existsSync(TOOLS_DIR)) {
    const matrix = loadMatrix()
    const keep = new Set(matrix.targets.map((t) => `dsh-${t.version}`))
    for (const name of fs.readdirSync(TOOLS_DIR)) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(TOOLS_DIR, name), { recursive: true, force: true })
        removed += 1
      }
    }
    ok(`removed ${removed} cached CLI(s) not in the matrix`)
  }
  if (fs.existsSync(HOMES_DIR)) {
    for (const name of fs.readdirSync(HOMES_DIR)) {
      fs.rmSync(path.join(HOMES_DIR, name), { recursive: true, force: true })
      removed += 1
    }
    ok('removed isolated homes')
  }
  if (!all && fs.existsSync(REPORTS_DIR)) {
    const dirs = fs.readdirSync(REPORTS_DIR).filter((name) => /^\d{8}-\d{6}/.test(name)).sort()
    for (const dir of dirs.slice(0, Math.max(0, dirs.length - Number(flag('keep-reports', 5))))) {
      fs.rmSync(path.join(REPORTS_DIR, dir), { recursive: true, force: true })
      removed += 1
    }
    ok('pruned old reports')
  }
  if (!removed) say('nothing to clean')
}

function cmdSelftest() {
  const failures = selfTest()
  if (failures.length) {
    bad(`semver self-test failed:\n  - ${failures.join('\n  - ')}`)
    process.exitCode = 1
    return
  }
  ok(`semver self-test: all vectors pass (including the prerelease-tuple rule)`)
  const matrix = loadMatrix()
  validateMatrix(matrix)
  ok(`matrix valid: ${matrix.targets.length} targets across ${new Set(matrix.targets.map((t) => t.tier)).size} tier(s)`)
}

const COMMANDS = {
  run: cmdRun,
  matrix: cmdMatrix,
  report: cmdReport,
  verdict: cmdVerdict,
  clean: cmdClean,
  selftest: cmdSelftest,
}

const handler = COMMANDS[command]
if (!handler) {
  bad(`unknown command "${command}" — one of: ${Object.keys(COMMANDS).join(', ')}`)
  process.exitCode = 1
} else {
  await handler()
}
