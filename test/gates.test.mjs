// Self-test of the GATES themselves: every check below is proven able to go RED.
//
// A gate that cannot fail is decoration. Each case therefore stages a throwaway
// copy of the repository in the OS temp dir, proves the GOOD sample exits 0, then
// injects one bad sample and proves the SAME command exits 1 with the expected
// finding. Nothing here touches the real tree: the copy excludes `.git`,
// `.release-test/` (machine-local caches, homes and reports) and the local `.env`
// denylist, so the fixtures stay zero-knowledge (no real host, path or password).
//
// The preflight case is the expensive one: it needs a real git commit, because
// `release-preflight` refuses a report that is not tied to the current tree. The
// commit happens inside the temp fixture only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Local-only trees: no git metadata, no machine-local release evidence/caches,
// no installed dependencies, no tarballs, no developer denylist.
const SKIP_TOP = new Set(['.git', '.release-test', 'node_modules'])
const SKIP_FILE_RE = /(?:^|[\\/])\.env(?:\.local)?$|\.tgz$/

// Written as a concatenation so the repository's own password rule does not
// (correctly) report this file: what we ship is the shape, not a value.
const BARE_WORD = ['hunter', '2'].join('')
// Same trick for the address: a dotted quad written literally here would (rightly)
// be a finding in this very file, so the fixture assembles it at runtime.
const FORBIDDEN_HOST = ['10', '11', '12', '13'].join('.')
const DOTTED = FORBIDDEN_HOST.replace(/\./g, '\\.')

/** Copy the repository into a fresh temp dir and return its path. */
function stageRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dbhub-gate-'))
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (from) => {
      const rel = relative(ROOT, from)
      if (!rel) return true
      if (SKIP_TOP.has(rel.split(sep)[0])) return false
      return !SKIP_FILE_RE.test(rel)
    },
  })
  return dir
}

/**
 * Run a script inside a staged copy with that copy as the repository root.
 *
 * Output goes to a FILE, not through a pipe: a sandboxed harness may refuse to
 * open the named pipes that `stdio: 'pipe'` needs, which turns every fixture into
 * `status: null` and makes this whole file fail for a reason that has nothing to
 * do with the gates. File descriptors work in both environments.
 */
function run(script, args = [], cwd = ROOT) {
  const logDir = mkdtempSync(join(tmpdir(), 'dbhub-gate-log-'))
  const logFile = join(logDir, 'out.log')
  const fd = openSync(logFile, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [join(cwd, script), ...args], { cwd, stdio: ['ignore', fd, fd] })
  } finally {
    closeSync(fd)
  }
  const out = readFileSync(logFile, 'utf8')
  rmSync(logDir, { recursive: true, force: true })
  return { code: result.status, out }
}

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('check:secrets — in-repo dev directories are not repository content (G5)', () => {
  const dir = stageRepo()
  const dsn = `{"dsn":"mysql://ops:CHANGE_ME@${FORBIDDEN_HOST}:3306/app"}\n`
  try {
    // doc/DEVELOPMENT.md tells developers to create the isolated DSH_HOME and the
    // pnpm store INSIDE the repo. Both hold real local material, so scanning them
    // reported the developer's own machine as a leak (and `.pnpm-store` also
    // dirtied the tree, which blocks `release:preflight`).
    mkdirSync(join(dir, '.dsh-a', 'storages'), { recursive: true })
    writeFileSync(join(dir, '.dsh-a', 'storages', 'credentials.json'), dsn)
    mkdirSync(join(dir, '.pnpm-store', 'v3'), { recursive: true })
    writeFileSync(join(dir, '.pnpm-store', 'v3', 'index.json'), '{"registry":"registry.npmjs.org"}\n')
    const clean = run('scripts/desensitize-check.mjs', [], dir)
    assert.equal(clean.code, 0, `dev-only directories must be skipped:\n${clean.out}`)

    // ... and the skip is what saves it: the same content inside the tree is caught.
    mkdirSync(join(dir, 'lib', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'nested', 'credentials.json'), dsn)
    const bad = run('scripts/desensitize-check.mjs', [], dir)
    assert.equal(bad.code, 1, `the same content inside the tree must be caught:\n${bad.out}`)
    assert.match(bad.out, new RegExp(`${DOTTED} is not loopback or an RFC 5737 documentation address`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check:secrets — a quoted bare word assigned to a secret keyword is a leak (G1)', () => {
  const dir = stageRepo()
  try {
    const clean = run('scripts/desensitize-check.mjs', [], dir)
    assert.equal(clean.code, 0, `pristine copy must be clean:\n${clean.out}`)
    // The old gate exempted `^[A-Za-z_$][A-Za-z0-9_$.]*$` even when the value was
    // QUOTED, so a typed-in password written as a bare word passed as clean.
    appendFileSync(join(dir, 'lib', 'i18n.mjs'), `\nconst fixtureLeak = { password: '${BARE_WORD}' }\n`)
    const bad = run('scripts/desensitize-check.mjs', [], dir)
    assert.equal(bad.code, 1, `quoted password literal must fail the gate:\n${bad.out}`)
    assert.match(bad.out, /lib\/i18n\.mjs:\d+: \[password\] password is assigned the literal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check:secrets — an uncompilable local denylist fails instead of warning (G4)', () => {
  const dir = stageRepo()
  try {
    const clean = run('scripts/desensitize-check.mjs', [], dir)
    assert.equal(clean.code, 0, `pristine copy must be clean:\n${clean.out}`)
    // A broken `.env` used to print a note and then report "clean" with exit 0:
    // the denylist layer (the only layer that catches bare project names) was
    // silently inert while the gate said everything was fine.
    writeFileSync(join(dir, '.env'), 'DSH_DBHUB_DESENSITIZE_RE=(unclosed\n')
    const bad = run('scripts/desensitize-check.mjs', [], dir)
    assert.equal(bad.code, 1, `broken denylist must fail the gate:\n${bad.out}`)
    assert.match(bad.out, /not a valid regular expression/)
    assert.doesNotMatch(bad.out, /\[check:secrets\] clean:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check:docs — a dead link in either README fails the gate (G3)', () => {
  const dir = stageRepo()
  try {
    const clean = run('scripts/docs-check.mjs', [], dir)
    assert.equal(clean.code, 0, `pristine copy must be clean:\n${clean.out}`)
    for (const readme of ['README.md', 'README.en.md']) {
      const original = readFileSync(join(dir, readme), 'utf8')
      try {
        appendFileSync(join(dir, readme), '\nSee [a document that is not there](doc/NOT-A-REAL-DOC.md).\n')
        const bad = run('scripts/docs-check.mjs', [], dir)
        assert.equal(bad.code, 1, `${readme}: a dead link must fail the gate:\n${bad.out}`)
        assert.match(bad.out, new RegExp(`${readme.replace('.', '\\.')}: link target "doc/NOT-A-REAL-DOC\\.md" does not exist`))
      } finally {
        writeFileSync(join(dir, readme), original)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('support-matrix — a clean copy without .release-test/ still reproduces the docs (P3-3)', () => {
  // `stageRepo()` deliberately has no `.release-test/`, which is exactly the CI
  // situation: the evidence table must come from the committed summary, not from
  // whatever reports happen to exist on this machine.
  const dir = stageRepo()
  try {
    const checked = run('release-test/support-matrix.mjs', ['--check'], dir)
    assert.equal(checked.code, 0, `structural check must pass without local reports:\n${checked.out}`)
    const evidence = run('release-test/support-matrix.mjs', ['--check-evidence'], dir)
    assert.equal(evidence.code, 0, evidence.out)
    assert.match(evidence.out, /skipped: no local \.release-test\/reports\//)

    // ... and the check still goes red when the committed table is edited by hand.
    appendFileSync(join(dir, 'doc', 'SUPPORT-MATRIX.md'), '\n<!-- hand edit -->\n')
    const stale = run('release-test/support-matrix.mjs', ['--check'], dir)
    assert.equal(stale.code, 1, `an out-of-date table must fail:\n${stale.out}`)
    assert.match(stale.out, /out of date: doc\/SUPPORT-MATRIX\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Build a git-committed fixture plus one release-test run for the preflight gate.
 * `mode` decides whether the declared targets carry real passing checks or none.
 */
/**
 * Run any command and capture its output through a FILE (never a pipe, same
 * reason as `run()` above). Returns `{ code, out }`.
 */
function runCapture(cmd, args, cwd) {
  const logDir = mkdtempSync(join(tmpdir(), 'dbhub-gate-cmd-'))
  const logFile = join(logDir, 'out.log')
  const fd = openSync(logFile, 'w')
  let result
  try {
    result = spawnSync(cmd, args, { cwd, stdio: ['ignore', fd, fd] })
  } finally {
    closeSync(fd)
  }
  const out = readFileSync(logFile, 'utf8')
  rmSync(logDir, { recursive: true, force: true })
  return { code: result.status, out }
}

async function stagePreflightFixture() {
  const dir = stageRepo()
  const git = (...args) => runCapture('git', args, dir)
  const init = git('init', '-q')
  if (init.code !== 0) {
    rmSync(dir, { recursive: true, force: true })
    return null // git unavailable: the caller skips
  }
  git('add', '-A')
  const commit = git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture')
  if (commit.code !== 0) {
    rmSync(dir, { recursive: true, force: true })
    return null
  }
  const head = runCapture('git', ['rev-parse', 'HEAD'], dir).out.trim()
  const tree = runCapture('git', ['rev-parse', 'HEAD^{tree}'], dir).out.trim()

  const matrixLib = await import(pathToFileURL(join(dir, 'release-test', 'lib', 'matrix.mjs')).href)
  const matrix = matrixLib.loadMatrix()
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const declared = matrix.targets.filter((t) => t.tier === 'declared')
  const runId = '20260101-000000-abcdef'
  const runDir = join(dir, '.release-test', 'reports', runId)
  mkdirSync(runDir, { recursive: true })

  /** Write report.json + a valid verdict for a given per-target check mix. */
  const writeRun = ({ pass, skip }) => {
    const report = {
      schemaVersion: 1,
      runId,
      generatedAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      status: 'green',
      plugin: { name: pkg.name, version: pkg.version, tarball: 'fixture.tgz', size: 1, sha256: 'a'.repeat(64) },
      git: { branch: 'dev', commit: head, tree, dirty: false, tag: null },
      matrix: { hash: matrixLib.matrixHash(matrix), updatedAt: matrix.updatedAt, targetCount: matrix.targets.length },
      environment: { node: process.versions.node, platform: process.platform, dbhub: '1.4.0' },
      options: { provision: 'manual', only: [], tier: 'declared', keepHomes: false },
      drift: null,
      claims: [],
      summary: { pass: 0, warn: declared.length, fail: 0, error: 0 },
      targets: declared.map((t) => ({
        version: t.version,
        tier: t.tier,
        era: t.era,
        ui: t.ui,
        status: 'warn',
        provisionMode: 'manual',
        timings: { readyMs: 14_000 },
        checksCounts: { pass, warn: 0, fail: 0, skip, info: 0 },
        checks: [{ id: 'boot', status: pass > 0 ? 'pass' : 'skip', detail: 'fixture' }],
        evidence: [],
      })),
      needsReview: [],
    }
    const reportFile = join(runDir, 'report.json')
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(
      join(runDir, 'verdict.json'),
      `${JSON.stringify({
        reportRunId: runId,
        reportHash: sha256File(reportFile),
        overall: 'pass',
        targets: report.targets.map((t) => ({ version: t.version, verdict: 'pass', reason: 'fixture evidence read' })),
        openQuestions: [],
        reviewer: 'fixture-agent',
        reviewedAt: new Date(Date.now() + 1000).toISOString(),
      }, null, 2)}\n`,
    )
  }

  return { dir, writeRun }
}

test('release:preflight — a declared target with no executed check cannot pass (G6)', async () => {
  const fixture = await stagePreflightFixture()
  if (!fixture) {
    console.warn('[gates] git is not available — skipping the release-preflight fixture')
    return
  }
  const { dir, writeRun } = fixture
  try {
    // GOOD: every declared target has 18 passing checks.
    writeRun({ pass: 18, skip: 0 })
    const good = run('scripts/release-preflight.mjs', ['--json'], dir)
    assert.equal(good.code, 0, `a fully executed report must pass:\n${good.out}`)

    // BAD: the same report outcome, but every check was SKIPPED. `aggregate()`
    // maps all-skip to `warn`, and the gate used to treat `warn` as acceptable,
    // so a run that asserted nothing at all was accepted as release evidence.
    writeRun({ pass: 0, skip: 18 })
    const bad = run('scripts/release-preflight.mjs', ['--json'], dir)
    assert.equal(bad.code, 1, `an all-skip report must block the release:\n${bad.out}`)
    assert.match(bad.out, /没有任何通过的检查/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release:preflight — stale evidence still blocks the release (sanity)', async () => {
  // The same fixture, aged past the freshness window: proves the "good" result
  // above is not the only thing this gate knows how to say.
  const fixture = await stagePreflightFixture()
  if (!fixture) return
  const { dir, writeRun } = fixture
  try {
    writeRun({ pass: 18, skip: 0 })
    const reportFile = join(dir, '.release-test', 'reports', '20260101-000000-abcdef', 'report.json')
    const report = JSON.parse(readFileSync(reportFile, 'utf8'))
    report.generatedAt = new Date(Date.now() - 72 * 3_600_000).toISOString()
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
    const verdictFile = join(dir, '.release-test', 'reports', '20260101-000000-abcdef', 'verdict.json')
    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8'))
    verdict.reportHash = sha256File(reportFile)
    verdict.reviewedAt = new Date().toISOString()
    writeFileSync(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`)
    const bad = run('scripts/release-preflight.mjs', ['--json'], dir)
    assert.equal(bad.code, 1, bad.out)
    assert.match(bad.out, /报告已过期/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
