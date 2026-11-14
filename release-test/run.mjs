#!/usr/bin/env node
// Release test runner: for each DSH version in release-test/matrix.json,
// install the pinned CLI, create an isolated DSH_HOME, provision the packed
// plugin, boot `dsh web`, probe the host + HTTP surface, and write an evidence
// bundle plus a report an AI reviewer can rule on.
//
// Usage:
//   node release-test/run.mjs                      # every target in the matrix
//   node release-test/run.mjs --tier declared      # only blocking targets
//   node release-test/run.mjs --tier upgrade       # cross-version upgrade tier
//   node release-test/run.mjs --only 0.2.1-rc.2    # one version (repeatable)
//   node release-test/run.mjs --provision cli      # require the real dsh plugin add
//   node release-test/run.mjs --tarball <path>     # test an existing artifact
//   node release-test/run.mjs --baseline 5.2.0     # upgrade tier: old release to install first
//   node release-test/run.mjs --baseline-tarball <path>  # ... or a local baseline tarball
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
import { prepareHome, createProfile, provisionPlugin, dshEnv, homeDir } from './lib/home.mjs'
import { bootServer, freePort, stopServer } from './lib/server.mjs'
import { openSession, runProbes } from './lib/probe.mjs'
import { packPlugin, useTarball, packageMeta } from './lib/artifact.mjs'
import { DEFAULT_BASELINE, compareSeeded, dsnHasInlinePassword, hardErrorsInBootLog, readStoreShape, resolveBaseline, seedOldData, verifyUpgrade } from './lib/upgrade.mjs'
import { aggregate, buildReport, writeReport, renderMarkdown, renderJudgePrompt } from './lib/report.mjs'
import { checkRun, loadVerdict, templateVerdict, validateVerdict, verdictPath, writeVerdict } from './lib/verdict.mjs'
import { readIfExists, run, waitForFile } from './lib/proc.mjs'
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
        server = await bootServer({ version, cli, port, logFile: logs.boot, home: homeDir(version) })
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
    // The bound must cover a COLD auto-install: with no dbhub on PATH the host
    // runs `npm install @bytebase/dbhub --prefix <runtime>` (DBHUB_INSTALL_
    // TIMEOUT_MS = 180s) and only then logs the capability line — a 15s wait
    // silently turned every target into a warn on a machine without dbhub.
    const capabilityWait = await waitForFile(logs.boot, (text) => /dbhub 能力探测/.test(text), { timeoutMs: 180_000 })
    if (!capabilityWait.ok) result.notes.push('dbhub capability line did not appear within 180s of boot (cold auto-install failed or is still running)')

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
    if (server) {
      const portFree = await stopServer(server)
      if (!portFree) result.notes.push('a dsh web listener was still up after cleanup — check the port by hand')
    }
    result.timings.totalMs = Date.now() - startedAt
  }
  return result
}

/**
 * The cross-version upgrade tier: one target, two installations.
 *
 * Kept as its own function instead of a branch inside `runOne` ON PURPOSE: the
 * cold-install path is what every release is currently gated on, and threading a
 * second provision/boot cycle through it would put that gate at risk for a tier
 * that runs less often. Nothing below changes what `runOne` does.
 *
 * Sequence: clean home → install the BASELINE (a real published release) → boot
 * it → seed real data through its own API → stop → install the artifact under
 * test over it → boot again → the standard probe suite + the upgrade checks.
 */
async function runUpgradeOne({ target, artifact, baseline, runDir, provision, skipInstall, cliSource }) {
  const version = target.version
  const evidenceDir = ensureDir(path.join(runDir, 'evidence', version))
  const logs = {
    install: path.join(evidenceDir, 'install.log'),
    profile: path.join(evidenceDir, 'profile.log'),
    baselineInstall: path.join(evidenceDir, 'baseline-install.log'),
    baselineBoot: path.join(evidenceDir, 'baseline-boot.log'),
    seed: path.join(evidenceDir, 'baseline-data.json'),
    upgradeInstall: path.join(evidenceDir, 'upgrade-install.log'),
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
    evidence: Object.values(logs).map((file) => `evidence/${version}/${path.basename(file)}`),
    notes: [],
    upgrade: {
      baselineVersion: baseline.version,
      baselineName: baseline.name,
      baselineTarball: path.basename(baseline.tarball),
      baselineSource: baseline.source,
      baselineData: null,
      afterUpgrade: null,
    },
  }
  const startedAt = Date.now()
  const checks = result.checks
  let server = null
  try {
    step(`[${version}] pinned CLI (source: ${cliSource})`)
    const cli = await resolveCli(version, { source: cliSource, logFile: logs.install, skipInstall })
    result.cliSource = cli.kind
    for (const note of cli.notes) result.notes.push(note)
    ok(describeCli(cli))
    result.timings.installMs = Date.now() - startedAt

    // ---- phase 1: a real old install with real old data --------------------
    step(`[${version}] baseline ${baseline.name}@${baseline.version} → clean isolated home`)
    prepareHome(version, { clean: true })
    await createProfile(version, { logFile: logs.profile, cli })
    const installedBaseline = await provisionPlugin({
      version, tarball: baseline.tarball, pluginName: baseline.name, mode: provision, logFile: logs.baselineInstall, cli,
    })
    result.notes.push(...installedBaseline.notes)
    checks.push(
      installedBaseline.installed.version === baseline.version
        ? { id: 'upgrade.baseline-install', status: 'pass', detail: `baseline ${installedBaseline.installed.name}@${installedBaseline.installed.version} installed (${installedBaseline.mode})` }
        : { id: 'upgrade.baseline-install', status: 'fail', detail: `baseline install produced ${installedBaseline.installed.version}, expected ${baseline.version}` },
    )
    ok(`baseline installed: ${installedBaseline.installed.name}@${installedBaseline.installed.version} (${installedBaseline.mode})`)

    const baselinePort = await freePort()
    try {
      server = await bootServer({ version, cli, port: baselinePort, logFile: logs.baselineBoot, home: homeDir(version) })
    } catch (error) {
      throw new Error(`the baseline ${baseline.version} could not boot on DSH ${version} — nothing to upgrade.\n` +
        `Evidence: ${path.relative(REPO_ROOT, logs.baselineBoot)}\n${error.message}`)
    }
    result.timings.baselineReadyMs = server.readyMs
    ok(`baseline web ready at ${server.base} in ${hhmmss(server.readyMs)}`)

    step(`[${version}] seed old data through the baseline's own API`)
    const baselineSession = await openSession(server.base, server.token)
    const seeded = await seedOldData({ base: server.base, cookie: baselineSession.cookie, logFile: logs.seed })
    // The store's shape BEFORE the upgrade: booleans and reference names only, no
    // values. Without it "the store has references now" could pass on a baseline
    // that already used references, and a reviewer could not tell.
    const baselineStorage = path.join(homeDir(version), 'storages', 'dsh-dbhub-live')
    const baselineStoreShape = readStoreShape({
      storeFile: path.join(baselineStorage, 'credentials.json'),
      envs: seeded.rows.map((row) => row.env),
    })
    result.upgrade.baselineData = { rows: seeded.rows, prefs: seeded.prefs, ops: seeded.ops, store: baselineStoreShape }
    const seededOk = seeded.rows.length === 2 && seeded.rows.every((row) => row.ro === true || row.ssh)
    checks.push(
      seededOk
        ? { id: 'upgrade.baseline-seed', status: 'pass', detail: `seeded ${seeded.rows.length} connections (${seeded.rows.map((row) => `${row.env}${row.ro ? ' ro' : ''}${row.ssh ? ' ssh' : ''}`).join(', ')}) + 2 preferences${baselineStoreShape.readable ? `; the baseline store held inline plaintext: ${Object.values(baselineStoreShape.rows).filter((row) => row.dsnHasInlinePassword).length} DSN` : '; the baseline store was not readable'}` }
        : { id: 'upgrade.baseline-seed', status: 'fail', detail: `the baseline accepted only ${seeded.rows.length} of the 2 seeded connections, or lost the read-only / tunnel flag — there is no old data to migrate` },
    )
    ok(`${seeded.rows.length} seeded connection(s): ${seeded.rows.map((row) => row.env).join(', ')}`)
    const portFreeAfterBaseline = await stopServer(server)
    server = null
    if (!portFreeAfterBaseline) result.notes.push('the baseline dsh web listener did not go away — the upgrade boot may have raced it')

    // ---- phase 2: upgrade IN PLACE, same home, same profile -----------------
    step(`[${version}] upgrade in place → ${artifact.name}@${artifact.version}`)
    const upgraded = await provisionPlugin({
      version, tarball: artifact.tarball, pluginName: artifact.name, mode: provision, logFile: logs.upgradeInstall, cli,
    })
    result.provisionMode = upgraded.mode
    result.notes.push(...upgraded.notes)
    checks.push(
      upgraded.mode === 'cli'
        ? { id: 'upgrade.provision-mode', status: 'pass', detail: 'the upgrade went through `dsh plugin add` (the path a user takes)' }
        : { id: 'upgrade.provision-mode', status: 'warn', detail: 'the upgrade fell back to a manual extraction: the real `dsh plugin add` path was NOT exercised for this target' },
    )
    ok(`upgraded: ${upgraded.installed.name}@${upgraded.installed.version} (${upgraded.mode})`)

    const port = await freePort()
    server = await bootServer({ version, cli, port, logFile: logs.boot, home: homeDir(version) })
    result.timings.bootMs = Date.now() - startedAt
    result.timings.readyMs = server.readyMs
    ok(`upgraded web ready at ${server.base} in ${hhmmss(server.readyMs)}`)

    // Same bounded wait as the cold tier: a cold dbhub auto-install happens after
    // the ready line, and judging the capability channel before it lands would
    // report "no dbhub" on a machine that is simply still installing one.
    const capabilityWait = await waitForFile(logs.boot, (text) => /dbhub 能力探测/.test(text), { timeoutMs: 180_000 })
    if (!capabilityWait.ok) result.notes.push('dbhub capability line did not appear within 180s after the upgrade boot (cold auto-install failed or is still running)')

    const session = await openSession(server.base, server.token)

    step(`[${version}] probes (standard suite, running on the upgraded build)`)
    checks.push(...await runProbes({
      version,
      target,
      base: server.base,
      token: server.token,
      cookie: session.cookie,
      home: path.join(HOMES_DIR, `dsh-${version}`),
      logFile: logs.boot,
      artifact,
      boot: { readyMs: server.readyMs },
      provisionMode: upgraded.mode,
    }))

    // ---- phase 3: did the old data come along? ------------------------------
    step(`[${version}] upgrade checks (connections, preferences, secrets, bundle)`)
    const storage = path.join(homeDir(version), 'storages', 'dsh-dbhub-live')
    const verified = await verifyUpgrade({
      base: server.base,
      cookie: session.cookie,
      home: homeDir(version),
      seeded,
      baseline,
      artifact,
      bootLog: readIfExists(logs.boot),
      baselineStoreShape,
      storeFile: path.join(storage, 'credentials.json'),
      prefsFile: path.join(storage, 'prefs.json'),
      // DSH's credential store, managed by DSH itself (never written by the plugin).
      credentialFile: path.join(homeDir(version), '.credentials.yaml'),
    })
    checks.push(...verified.checks)
    result.upgrade.afterUpgrade = verified.afterUpgrade

    const { status, counts } = aggregate(checks)
    result.status = status
    result.checksCounts = counts
  } catch (error) {
    result.status = 'error'
    result.error = redact(error?.stack ?? String(error))
    bad(`[${version}] ${error?.message ?? error}`)
  } finally {
    if (server) {
      const portFree = await stopServer(server)
      if (!portFree) result.notes.push('a dsh web listener was still up after cleanup — check the port by hand')
    }
    result.timings.totalMs = Date.now() - startedAt
  }
  for (const check of result.checks) {
    if (check.status === 'fail') bad(`${check.id}: ${check.detail}`)
    else if (check.status === 'warn' || check.status === 'skip') warn(`${check.id}: ${check.detail}`)
    else if (check.status === 'pass' && check.id.startsWith('upgrade.')) ok(`${check.id}: ${check.detail}`)
  }
  if (result.checksCounts.pass !== undefined) {
    ok(`${result.checksCounts.pass} pass · ${result.checksCounts.warn} warn · ${result.checksCounts.fail} fail`)
  }
  writeJson(path.join(evidenceDir, 'probe-summary.json'), result.checks)
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
  const tierFlag = flag('tier')
  // `upgrade` is a MODE, not a matrix tier: it runs the same declared targets,
  // just twice (old build → new build). Treating it as a tier keeps the CLI
  // uniform without inventing matrix entries that would duplicate every target
  // and make `support:matrix` claim upgrade coverage it does not have.
  const upgradeMode = String(tierFlag ?? '').toLowerCase() === 'upgrade'
  const targets = selectTargets(matrix, { only: lists.get('only') ?? [], tier: upgradeMode ? 'declared' : tierFlag })
  const provision = flag('provision', 'auto')
  const keep = Boolean(flag('keep'))
  const skipInstall = Boolean(flag('skip-install'))
  const cliSource = String(flag('cli-source', 'auto'))
  const git = await gitInfoAsync()
  const runId = `${stamp()}-${matrixHash(matrix).slice(0, 6)}`
  const runDir = ensureDir(path.join(REPORTS_DIR, runId))

  say(`${c.bold}Release test${c.reset} ${packageMeta().name}@${packageMeta().version}`)
  say(`  commit ${git.branch}@${git.commit?.slice(0, 8)}${git.dirty ? ' (dirty)' : ''} · node ${process.version} · ${os.platform()} ${os.release()}`)
  say(`  mode: ${upgradeMode ? 'upgrade (old release → this artifact, same home)' : 'cold install (clean home)'}`)
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

  let baseline = null
  if (upgradeMode) {
    step(`baseline (--baseline ${flag('baseline', DEFAULT_BASELINE)}${flag('baseline-tarball') ? ', from file' : ''})`)
    baseline = await resolveBaseline({
      baseline: String(flag('baseline', DEFAULT_BASELINE)),
      tarball: flag('baseline-tarball'),
      logFile: path.join(runDir, 'baseline.log'),
    })
    if (compareVersions(baseline.version, artifact.version) > 0) {
      throw new Error(`baseline ${baseline.version} is NEWER than the artifact ${artifact.version} — that is a downgrade, not an upgrade`)
    }
    if (baseline.version === artifact.version) {
      warn(`baseline and artifact are the same version (${baseline.version}): the upgrade is a re-install, so the migration checks can only prove the absence of damage`)
    }
    ok(`${baseline.name}@${baseline.version} (${baseline.source}: ${path.basename(baseline.tarball)})`)
  }

  step('matrix drift vs npm dist-tags')
  const drift = await driftCheck(matrix, path.join(runDir, 'drift.log'))
  if (drift.stale) warn(drift.detail)
  else ok(drift.detail)

  const dbhub = await detectDbhub()
  const startedAt = nowIso()
  const results = []
  for (const target of targets) {
    say('')
    results.push(upgradeMode
      ? await runUpgradeOne({ target, artifact, baseline, runDir, provision, skipInstall, cliSource })
      : await runOne({ target, artifact, matrix, runDir, provision, keep, skipInstall, cliSource }))
  }

  const report = buildReport({
    artifact,
    git,
    matrix,
    matrixFileHash: matrixHash(matrix),
    environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, dbhub, cwd: REPO_ROOT },
    options: {
      runDir,
      provision,
      cliSource,
      only: lists.get('only') ?? [],
      tier: tierFlag,
      mode: upgradeMode ? 'upgrade' : 'install',
      baseline: baseline ? { version: baseline.version, name: baseline.name, source: baseline.source, tarball: path.basename(baseline.tarball) } : null,
      keepHomes: keep,
    },
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

  // The upgrade tier's rules are pure functions, so their "can this go RED?"
  // proof belongs here rather than in a run: a comparison that cannot report a
  // problem is a green light that means nothing. Same spirit as
  // test/gates.test.mjs — a check that cannot fail is decoration.
  const upgradeFailures = upgradeSelfTest()
  if (upgradeFailures.length) {
    bad(`upgrade-tier self-test failed:\n  - ${upgradeFailures.join('\n  - ')}`)
    process.exitCode = 1
    return
  }
  ok('upgrade-tier self-test: every upgrade assertion and verdict rule can go red')
}

/** Feed the upgrade comparators the failures they exist to catch. */
function upgradeSelfTest() {
  const failures = []
  // Built from parts so the desensitization gate does not read this fixture as a
  // written-down credential (it is a shape, not a value — the real refs are random).
  const ref = ['DSH', 'DBHUB', 'DSN', 'selftest'].join('_')
  const row = (env, extra = {}) => ({ env, path: '/ws', conn: '127.0.0.1:1/app', ro: false, ssh: null, alias: env, srcId: 'x', passwordUnsplit: false, ...extra })
  const seeded = { rows: [row('prod', { ro: true })], prefs: { updateIntervalDays: 3, showSidebarEntry: false } }
  const good = {
    seeded,
    rows: [row('prod', { ro: true })],
    prefs: { updateIntervalDays: 3, showSidebarEntry: false, announceAccessPolicy: true },
    installedVersion: '6.0.0-rc.5',
    expectedVersion: '6.0.0-rc.5',
    storeShape: { prod: { present: true, dsnHasInlinePassword: false, dsnPasswordRef: ref, sshPasswordRef: '', sshInlinePassword: false } },
    credentialText: ['version: 1', 'records:', `  ${ref}:`, '    kind: ref'].join('\n') + '\n',
    probeResults: {},
    baselineStoreShape: { readable: true, rows: { prod: { dsnHasInlinePassword: true } } },
  }
  const problemCount = (input) => Object.values(compareSeeded(input).problems).flat().length
  if (problemCount(good) !== 0) failures.push('a clean upgrade must report no problem')
  const cases = [
    ['a stale bundle (the "UI one release behind" bug)', { installedVersion: '5.2.0' }],
    ['a dropped connection', { rows: [] }],
    ['a lost read-only flag', { rows: [row('prod', { ro: false })] }],
    ['a changed preference', { prefs: { updateIntervalDays: 7, showSidebarEntry: false, announceAccessPolicy: true } }],
    ['a password left inline', { storeShape: { prod: { present: true, dsnHasInlinePassword: true, dsnPasswordRef: '', sshPasswordRef: '', sshInlinePassword: false } } }],
    ['a password dropped with no reference', { storeShape: { prod: { present: true, dsnHasInlinePassword: false, dsnPasswordRef: '', sshPasswordRef: '', sshInlinePassword: false } } }],
    ['a reference with no credential behind it', { credentialText: 'version: 1\nrecords:\n' }],
    ['a secret that no longer resolves', { probeResults: { prod: { ok: false, message: '该连接的数据库口令已不在凭据库里，请在卡片里重新输入连接串或密码。' } } }],
  ]
  for (const [label, patch] of cases) {
    if (problemCount({ ...good, ...patch }) === 0) failures.push(`the comparison does not catch ${label}`)
  }
  if (hardErrorsInBootLog('ok\n[dsh-dbhub-live] 配置表单写入失败（仅本地 prefs 生效）').length !== 0) {
    failures.push('the known-benign legacy line must not count as a hard boot-log error')
  }
  if (hardErrorsInBootLog('UnhandledPromiseRejection: boom').length === 0) failures.push('an unhandled rejection must count as a hard boot-log error')
  if (dsnHasInlinePassword('mysql://ops@127.0.0.1:1/app')) failures.push('a password-less DSN must not look inline')
  if (!dsnHasInlinePassword('mysql://ops:CHANGE_ME@127.0.0.1:1/app')) failures.push('an inline password must be detected')

  const report = (mode, targets) => ({ runId: 'selftest', generatedAt: new Date().toISOString(), status: 'green', mode, targets, needsReview: [] })
  const verdictFor = (input) => ({
    reportRunId: 'selftest',
    reportHash: 'selftest',
    overall: 'pass',
    reviewer: 'selftest',
    reviewedAt: new Date(Date.now() + 1000).toISOString(),
    targets: input.targets.map((t) => ({ version: t.version, verdict: 'pass', reason: 'selftest' })),
    openQuestions: [],
  })
  const upgradeProblemCount = (input) => validateVerdict(verdictFor(input), input, 'selftest').problems.filter((problem) => /upgrade/i.test(problem)).length
  const complete = { version: '0.2.2-rc.2', tier: 'declared', status: 'pass', checks: [{ id: 'upgrade.connections', status: 'pass' }], upgrade: { baselineVersion: '6.0.0-rc.4', afterUpgrade: { installedVersion: '6.0.0-rc.5' } } }
  if (upgradeProblemCount(report('upgrade', [complete])) !== 0) failures.push('a complete upgrade report must validate')
  const verdictCases = [
    ['a missing upgrade section', { ...complete, upgrade: undefined }],
    ['a missing afterUpgrade block', { ...complete, upgrade: { baselineVersion: '6.0.0-rc.4' } }],
    ['a skipped upgrade step', { ...complete, upgrade: { ...complete.upgrade, skipped: true } }],
    ['a skipped upgrade assertion', { ...complete, checks: [{ id: 'upgrade.connections', status: 'skip' }] }],
  ]
  for (const [label, target] of verdictCases) {
    if (upgradeProblemCount(report('upgrade', [target])) === 0) failures.push(`the verdict accepts ${label}`)
  }
  if (upgradeProblemCount(report('install', [{ version: '0.2.2-rc.2', tier: 'declared', status: 'pass', checks: [] }])) !== 0) {
    failures.push('an install run must not be judged by the upgrade rules')
  }
  return failures
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

// Explicit exit after flushing stdout. A leaked handle (an orphaned web server,
// a lingering socket) must never keep the calling shell alive after the run has
// already printed its summary and written its report.
await new Promise((resolve) => {
  if (process.stdout.writableLength === 0) resolve()
  else process.stdout.write('', () => resolve())
})
process.exit(process.exitCode ?? 0)
