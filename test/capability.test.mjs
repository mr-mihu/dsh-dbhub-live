// Unit tests for lib/capability.mjs — the dbhub version / capability guard.
//
// capability.mjs is a PURE module (node:fs + node:path only, it does not import
// config.mjs), so unlike the storage-bound lib tests it needs no DSH_HOME.
//
// Fixtures obey the desensitization convention: loopback / RFC 5737 hosts and
// placeholder secrets only. The dbhub executable itself is never created — the
// detector is deliberately file-based and only reads package.json manifests.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cap = await import('../lib/capability.mjs')

const tempDirs = []

function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dbhub-cap-' + tag + '-'))
  tempDirs.push(dir)
  return dir
}

/**
 * The layout runtime.mjs produces with
 * `npm install @bytebase/dbhub --prefix <RUNTIME_DIR>`:
 *   <dir>/node_modules/.bin/dbhub.cmd
 *   <dir>/node_modules/@bytebase/dbhub/package.json
 * The shim file itself need not exist (and is never read).
 */
function managedInstall(version) {
  const dir = tempDir('managed')
  const pkgDir = join(dir, 'node_modules', '@bytebase', 'dbhub')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@bytebase/dbhub', version }))
  return { dir, exe: join(dir, 'node_modules', '.bin', 'dbhub.cmd') }
}

/** The mise-install path form; the shim file need not exist either. */
function miseExe(version) {
  return join(tempDir('mise'), 'npm-bytebase-dbhub', version, 'node_modules', '.bin', 'dbhub.cmd')
}

test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// ── pure version helpers ──────────────────────────────────────────────────

test('parseVersion accepts a leading v, prerelease/build suffixes and a missing patch', () => {
  assert.deepEqual(cap.parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(cap.parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(cap.parseVersion('1.4.0-beta.1'), { major: 1, minor: 4, patch: 0 })
  assert.deepEqual(cap.parseVersion('1.4.0+build.9'), { major: 1, minor: 4, patch: 0 })
  assert.deepEqual(cap.parseVersion('1.2'), { major: 1, minor: 2, patch: 0 })
  assert.deepEqual(cap.parseVersion('  v0.9.0  '), { major: 0, minor: 9, patch: 0 })
  // only a LEADING numeric triplet counts — a version buried in text is not one
  for (const bad of ['', 'garbage', 'dbhub 1.4.0', 'v', 'x1.2.3', '1', '1.x', undefined, null, 42, {}]) {
    assert.equal(cap.parseVersion(bad), null, 'expected null for ' + String(bad))
  }
})

test('compareVersions orders by major/minor/patch and atLeast is inclusive', () => {
  const p = cap.parseVersion
  assert.equal(cap.compareVersions(p('1.2.3'), p('1.2.3')), 0)
  assert.ok(cap.compareVersions(p('1.2.3'), p('1.2.4')) < 0)
  assert.ok(cap.compareVersions(p('1.3.0'), p('1.2.9')) > 0)
  assert.ok(cap.compareVersions(p('2.0.0'), p('1.9.9')) > 0)
  // a missing side counts as 0.0.0 (defensive, never throws)
  assert.equal(cap.compareVersions(null, null), 0)
  assert.equal(cap.compareVersions(p('0.0.1'), null), 1)
  assert.equal(cap.compareVersions(null, p('0.0.1')), -1)
  // atLeast: inclusive floor, prerelease suffix ignored, unparsable -> false
  assert.equal(cap.atLeast(p('1.4.0'), '1.4.0'), true)
  assert.equal(cap.atLeast(p('1.4.1'), '1.4.0'), true)
  assert.equal(cap.atLeast(p('1.4.0-beta.1'), '1.4.0'), true)
  assert.equal(cap.atLeast(p('1.3.9'), '1.4.0'), false)
  assert.equal(cap.atLeast(p('0.9.0'), '1.0.0'), false)
  assert.equal(cap.atLeast(null, '1.4.0'), false)
  assert.equal(cap.atLeast(p('1.4.0'), 'not-a-version'), false)
  // the documented floors
  assert.equal(cap.DBHUB_MIN_VERSION, '1.4.0')
  assert.equal(cap.DBHUB_TOML_SINCE, '1.0.0')
})

test('capabilitiesOf maps the version matrix onto the two generated features', () => {
  // < 1.0.0 predates the TOML tool model entirely -> refuse both features
  assert.deepEqual(cap.capabilitiesOf('0.9.0'), {
    version: '0.9.0', readonlyTools: false, ssh: false, warning: 'tooOld',
  })
  assert.equal(cap.capabilitiesOf('0.0.1').warning, 'tooOld')
  // 1.0.0-1.3.x: allowed but never measured -> warn
  assert.deepEqual(cap.capabilitiesOf('1.2.0'), {
    version: '1.2.0', readonlyTools: true, ssh: true, warning: 'untested',
  })
  assert.equal(cap.capabilitiesOf('1.0.0').warning, 'untested')
  assert.equal(cap.capabilitiesOf('1.3.99').warning, 'untested')
  // >= 1.4.0: the dialect this plugin was measured against -> no warning
  assert.deepEqual(cap.capabilitiesOf('1.4.0'), {
    version: '1.4.0', readonlyTools: true, ssh: true, warning: '',
  })
  assert.equal(cap.capabilitiesOf('1.5.2').warning, '')
  assert.equal(cap.capabilitiesOf('v2.0.0').warning, '')
})

test('capabilitiesOf reports unknown (features ON) for an unparsable version', () => {
  for (const raw of ['', 'garbage', undefined, null]) {
    const c = cap.capabilitiesOf(raw)
    assert.equal(c.readonlyTools, true)
    assert.equal(c.ssh, true)
    assert.equal(c.warning, 'unknown')
  }
  // the raw value is echoed back as a string so the UI can show what was seen
  assert.equal(cap.capabilitiesOf('').version, '')
  assert.equal(cap.capabilitiesOf(undefined).version, '')
  assert.equal(cap.capabilitiesOf('garbage').version, 'garbage')
})

// ── executable-path detection ─────────────────────────────────────────────

test('a managed install resolves the version from its package.json', () => {
  const { exe } = managedInstall('1.4.0')
  const detected = cap.detectVersion(exe)
  const c = cap.detectDbhubCapabilities(exe)
  // KNOWN GAP, reported rather than worked around: versionFromPackageJson only
  // probes `<dir>/package.json` and `<dir>/node_modules/dbhub/package.json`, so
  // the SCOPED manifest of this plugin's own managed install
  // (`<dir>/node_modules/@bytebase/dbhub/package.json`, see runtime.mjs) is
  // never read. Fix: probe `join(dir, 'node_modules', '@bytebase', 'dbhub',
  // 'package.json')` as well.
  assert.equal(
    detected,
    '1.4.0',
    'managed install not detected (see the KNOWN GAP note above)',
  )
  assert.equal(c.version, '1.4.0')
  assert.equal(c.readonlyTools, true)
  assert.equal(c.ssh, true)
  assert.equal(c.warning, '')
})

test('a mise layout resolves the version from the path segment', () => {
  const exe = miseExe('1.2.0')
  const c = cap.detectDbhubCapabilities(exe)
  assert.equal(c.version, '1.2.0')
  assert.equal(c.readonlyTools, true)
  assert.equal(c.ssh, true)
  assert.equal(c.warning, 'untested')
  assert.equal(cap.detectVersion(miseExe('1.4.0')), '1.4.0')
  assert.equal(cap.detectDbhubCapabilities(miseExe('1.4.0')).warning, '')
  // a non-version segment is not a version
  assert.equal(cap.versionFromMisePath(miseExe('latest')), '')
  assert.equal(cap.versionFromMisePath('/usr/local/bin/dbhub'), '')
})

test('a pre-1.0 install refuses BOTH features with an upgrade hint', () => {
  const c = cap.detectDbhubCapabilities(miseExe('0.9.0'))
  assert.equal(c.version, '0.9.0')
  assert.equal(c.readonlyTools, false)
  assert.equal(c.ssh, false)
  assert.equal(c.warning, 'tooOld')
})

test('an unresolvable executable reports unknown and never throws', () => {
  // Deep enough that the bounded walk-up stays inside the temp dir, and with no
  // package.json and no mise segment anywhere above it.
  const deep = join(tempDir('unknown'), 'a', 'b', 'c', 'd', 'e', 'node_modules', '.bin')
  mkdirSync(deep, { recursive: true })
  const exe = join(deep, 'dbhub.cmd')
  assert.equal(cap.detectVersion(exe), '')
  const c = cap.detectDbhubCapabilities(exe)
  assert.equal(c.version, '')
  assert.equal(c.readonlyTools, true)
  assert.equal(c.ssh, true)
  assert.equal(c.warning, 'unknown')
  // the defensive surface: unresolvable PATHS must not throw either
  for (const bad of [join(deep, 'nope.cmd'), join(deep, 'gone', 'dbhub.cmd'), exe.toUpperCase()]) {
    const safe = cap.detectDbhubCapabilities(bad)
    assert.equal(safe.readonlyTools, true)
    assert.equal(safe.ssh, true)
    assert.equal(safe.warning, 'unknown')
  }
  // REPORTED (not asserted here, no spec for it): a bare relative name is NOT
  // an unresolvable path for this detector. `detectDbhubCapabilities('garbage')`
  // resolves it against process.cwd() and then accepts any manifest whose name
  // merely matches /dbhub/i — including this plugin's OWN package.json
  // (`dsh-dbhub-live`), whose version it then reports with warning ''.
  // Measured here: detectDbhubCapabilities('garbage') -> the repository's own
  // package.json version, warning ''. The pure `capabilitiesOf('garbage')` is
  // unaffected (asserted above with the empty/unparsable matrix).
})

test('versionFromPackageJson only trusts a dbhub-looking manifest', () => {
  // Nested deep enough that the bounded (6-level) walk-up stays inside the temp
  // dir whatever lives above the OS temp root.
  const base = join(tempDir('foreign'), 'a', 'b', 'c', 'd', 'e', 'f')
  const bin = join(base, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  // a foreign package.json directly above the shim: its version is NOT dbhub's
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name: 'some-other-tool', version: '9.9.9' }))
  assert.equal(cap.versionFromPackageJson(join(bin, 'dbhub.cmd')), '')
  // the unscoped `node_modules/dbhub` form IS trusted when it is really dbhub
  const unscoped = tempDir('unscoped')
  const inner = join(unscoped, 'node_modules', 'dbhub')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'dbhub', version: '1.4.0' }))
  assert.equal(cap.versionFromPackageJson(join(unscoped, 'node_modules', '.bin', 'dbhub.cmd')), '1.4.0')
})

// ── manifest trust ────────────────────────────────────────────────────────

test('an unrelated manifest above the executable never lends its version', () => {
  // Regression: the resolver walks UP from the executable, so without a name
  // check it could read any package.json above it — including this plugin's own
  // (`dsh-dbhub-live`, whose name merely CONTAINS "dbhub") when the executable
  // path is relative or empty.
  const dir = tempDir('foreign-manifest')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-dbhub-live', version: '9.9.9' }))
  const fakeExe = join(dir, 'node_modules', '.bin', 'dbhub.cmd')
  assert.equal(cap.versionFromPackageJson(fakeExe), '', 'a foreign name is not a dbhub version')
  const detected = cap.detectDbhubCapabilities(fakeExe)
  assert.equal(detected.version, '')
  assert.equal(detected.warning, 'unknown')
  assert.equal(detected.readonlyTools, true, 'an unknown version must not disable a working setup')
  // An empty/blank executable can never be resolved into somebody's manifest.
  assert.equal(cap.detectVersion(''), '')
  assert.equal(cap.detectVersion('   '), '')
  assert.equal(cap.detectDbhubCapabilities('').warning, 'unknown')
})
