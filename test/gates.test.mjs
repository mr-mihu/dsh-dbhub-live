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
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

test('check:secrets — an unquoted or JSON-keyed literal is a leak in every file type (D1/D2)', () => {
  const dir = stageRepo()
  try {
    const clean = run('scripts/desensitize-check.mjs', [], dir)
    assert.equal(clean.code, 0, `pristine copy must be clean:\n${clean.out}`)
    // The bare-identifier exemption used to apply to EVERY unquoted value in EVERY
    // file, so the most common leak shape passed everywhere: a value typed after
    // `password:` in a README, an example YAML/TOML/dotenv, a JSON object, and even
    // plain code. Only a code REFERENCE may be exempt, and only in a code file.
    const cases = [
      ['lib/i18n.mjs', `const fixtureLeak = { password: ${BARE_WORD} }`, 'code'],
      ['doc/DESENSITIZE.md', `password: ${BARE_WORD}`, 'doc'],
      ['cordis.patch.yml', `password: ${BARE_WORD}`, 'yml'],
      ['release-test/mise.toml', `password = ${BARE_WORD}`, 'toml'],
      ['package.json', `"password": "${BARE_WORD}",`, 'json key (D2)'],
    ]
    for (const [rel, line, label] of cases) {
      const file = join(dir, rel)
      const original = readFileSync(file, 'utf8')
      try {
        appendFileSync(file, `\n${line}\n`)
        const bad = run('scripts/desensitize-check.mjs', [], dir)
        assert.equal(bad.code, 1, `${label}: an assigned literal must fail the gate:\n${bad.out}`)
        assert.match(
          bad.out,
          new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+: \\[password\\]`),
          `${label}: the finding must name the file and the password rule:\n${bad.out}`,
        )
      } finally {
        writeFileSync(file, original)
      }
    }
    // The other direction: a real code REFERENCE must stay clean, or the gate
    // would be unusable and everyone would reach for the pragma.
    const refFile = join(dir, 'lib', 'i18n.mjs')
    const before = readFileSync(refFile, 'utf8')
    try {
      appendFileSync(refFile, '\nconst fixtureRef = { password: req.body.password, token: PASSWORD_FIELD }\n')
      const stillClean = run('scripts/desensitize-check.mjs', [], dir)
      assert.equal(stillClean.code, 0, `a member path / CONSTANT reference must stay clean:\n${stillClean.out}`)
    } finally {
      writeFileSync(refFile, before)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check:secrets — a config file nobody registered is still covered (D1 scope)', () => {
  // The judgement was fixed first, but the RULE never reached an unregistered
  // file: only slots and code got `password`, so a brand-new .yml/.env stayed
  // invisible. Worse, `.env` keys embed the keyword (`DB_PASSWORD=`), and `_` is
  // a word character, so `\bpassword\b` cannot match them at all.
  const dir = stageRepo()
  const cases = [
    { rel: 'doc/NEW.yml', text: `password: ${BARE_WORD}\n`, red: true },
    { rel: 'doc/nested/NEW.toml', text: `password = "${BARE_WORD}"\n`, red: true },
    { rel: 'doc/NEW.json', text: `{ "password": "${BARE_WORD}" }\n`, red: true },
    { rel: 'doc/NEW.env', text: `DB_PASSWORD=${BARE_WORD}\n`, red: true },
    { rel: 'doc/NEW2.env.local', text: `export SMTP_PASSWORD="${BARE_WORD}"\n`, red: true },
    { rel: 'doc/safe.yml', text: 'password: CHANGE_ME\n', red: false },
    { rel: 'doc/safe.env', text: 'DB_PASSWORD=${DB_PASSWORD}\n', red: false },
    { rel: 'doc/safe2.env', text: 'DB_PASSWORD=\n', red: false },
    { rel: 'lib/safe.mjs', text: 'const cfg = { password: req.body.password }\n', red: false },
    { rel: 'lib/safe2.mjs', text: 'const cfg = { password: PASSWORD_FIELD }\n', red: false },
  ]
  try {
    for (const cs of cases) {
      const p = join(dir, cs.rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, cs.text)
      const run1 = run('scripts/desensitize-check.mjs', [], dir)
      assert.equal(run1.code, cs.red ? 1 : 0, `${cs.rel} must be ${cs.red ? 'CAUGHT' : 'clean'}:\n${run1.out}`)
      rmSync(p, { force: true })
    }
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
  // Pin a STABLE version in the fixture: the gate's evidence rules are hard for
  // `x.y.z` and warnings for a prerelease (a preview may ship before the matrix
  // runs, by policy). Without this the fixture would exercise the relaxed path.
  const pkgFile = join(dir, 'package.json')
  const pkgBefore = JSON.parse(readFileSync(pkgFile, 'utf8'))
  writeFileSync(pkgFile, JSON.stringify({ ...pkgBefore, version: '1.2.3' }, null, 2) + '\n')
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
  const writeRun = ({ pass, skip, git: gitRef }) => {
    const report = {
      schemaVersion: 1,
      runId,
      generatedAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      status: 'green',
      plugin: { name: pkg.name, version: pkg.version, tarball: 'fixture.tgz', size: 1, sha256: 'a'.repeat(64) },
      git: { branch: 'dev', commit: gitRef?.commit ?? head, tree: gitRef?.tree ?? tree, dirty: false, tag: null },
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

  return { dir, writeRun, git, head, tree }
}

test('release:preflight — an earlier diff cannot fail a later, clean run (D4)', async (t) => {
  const fixture = await stagePreflightFixture()
  if (!fixture) {
    t.skip('git is not available — the preflight fixture needs a real commit')
    return
  }
  const { dir, writeRun, git } = fixture
  /** Commit everything and report the new {commit, tree}. */
  const commitAll = (message) => {
    const added = git('add', '-A')
    assert.equal(added.code, 0, added.out)
    const committed = git(
      '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', message,
    )
    assert.equal(committed.code, 0, committed.out)
    return {
      commit: runCapture('git', ['rev-parse', 'HEAD'], dir).out.trim(),
      tree: runCapture('git', ['rev-parse', 'HEAD^{tree}'], dir).out.trim(),
    }
  }
  const preflight = () => {
    const result = run('scripts/release-preflight.mjs', ['--json'], dir)
    let json = null
    try {
      json = JSON.parse(result.out)
    } catch {
      json = null
    }
    return { ...result, json }
  }
  try {
    // The report describes the commit the fixture was staged at.
    writeRun({ pass: 18, skip: 0 })

    // ① A SHIPPED file really changed: the report must be refused (correct red).
    const shipped = join(dir, 'lib', 'config.mjs')
    const shippedOriginal = readFileSync(shipped, 'utf8')
    const readme = join(dir, 'README.md')
    const readmeOriginal = readFileSync(readme, 'utf8')
    appendFileSync(shipped, '\n// fixture change A (shipped code)\n')
    appendFileSync(readme, '\nfixture change B (generated doc)\n')
    commitAll('A: shipped code + doc changed')
    const red = preflight()
    assert.equal(red.code, 1, `a shipped change must block the release:\n${red.out}`)
    assert.match(red.out, /内容变了，必须重跑/)

    // ② That change is REVERTED; only the generated doc differs from the report's
    // tree now. The report is valid again — unless the gate is still reading the
    // paths of the previous diff out of the shared log file (D4).
    writeFileSync(shipped, shippedOriginal)
    commitAll('B: revert A, keep the doc change')
    const green = preflight()
    assert.equal(green.code, 0, `only generated docs differ, so the report stays valid:\n${green.out}`)
    assert.equal(green.json?.pass, true, `--json must report pass:\n${green.out}`)
    assert.ok(
      (green.json?.warnings || []).some((w) => String(w).includes('README.md')),
      `the diff must be the CURRENT one (README.md only):\n${green.out}`,
    )
    assert.ok(
      !(green.json?.problems || []).some((p) => String(p).includes('config.mjs')),
      `a reverted path must not come back: ${JSON.stringify(green.json?.problems)}`,
    )
    // The shared log is not evidence and is cleared on start; per-call files are
    // removed after they are read.
    assert.equal(existsSync(join(dir, '.release-test', 'preflight-git.log')), false,
      'the shared diff log must not survive a run')
    assert.deepEqual(
      readdirSync(join(dir, '.release-test')).filter((f) => f.startsWith('preflight-git-')),
      [],
      'a per-call diff log must be deleted after it is read',
    )
    // Keep the baseline content reachable for a readable diff on failure.
    assert.equal(readmeOriginal.length > 0, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release:preflight — a declared target with no executed check cannot pass (G6)', async (t) => {
  const fixture = await stagePreflightFixture()
  if (!fixture) {
    // SKIP, not PASS: a silently-returning test is reported as `ok` and a suite
    // that ran nothing looks exactly like a suite that verified something.
    t.skip('git is not available — the preflight fixture needs a real commit')
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

test('release:preflight — stale evidence still blocks the release (sanity)', async (t) => {
  // The same fixture, aged past the freshness window: proves the "good" result
  // above is not the only thing this gate knows how to say.
  const fixture = await stagePreflightFixture()
  if (!fixture) {
    // SKIP, not PASS (see the case above): "not run" must be visible as such.
    t.skip('git is not available — the preflight fixture needs a real commit')
    return
  }
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

test('release:preflight — a preview may ship before the matrix, but never from a dirty tree', async (t) => {
  const fixture = await stagePreflightFixture()
  if (!fixture) {
    t.skip('git is not available — the preflight fixture needs a real commit')
    return
  }
  const { dir, writeRun, git } = fixture
  try {
    // A preview version: evidence gaps become warnings, so the same stale report
    // that blocks a stable release must NOT block here.
    const pkgFile = join(dir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    writeFileSync(pkgFile, JSON.stringify({ ...pkg, version: '1.2.3-rc.1' }, null, 2) + '\n')
    writeRun({ pass: 18, skip: 0 })
    git('add', '-A')
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'preview')
    const preview = run('scripts/release-preflight.mjs', ['--json'], dir)
    assert.equal(preview.code, 0, `a preview may publish before the matrix runs:\n${preview.out}`)
    assert.match(preview.out, /预览版放行/)

    // The safety rule that does NOT depend on evidence still blocks: a preview may
    // not ship from a dirty tree either.
    appendFileSync(join(dir, 'lib', 'collect.mjs'), '\n// uncommitted change\n')
    const dirty = run('scripts/release-preflight.mjs', ['--json'], dir)
    assert.equal(dirty.code, 1, `a dirty tree must block even a preview:\n${dirty.out}`)
    assert.match(dirty.out, /工作区不干净/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
