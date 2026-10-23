// Unit tests for the Host's version metadata (lib/meta.mjs): semver parsing and
// precedence, the "is an update newer?" question the update checker asks, the
// dsh >= 0.2.1 compatibility gate, and the runtime probes (plugin version from
// package.json, dsh version from an installed package layout).
//
// The discovery walk is driven against a temp layout with a fake argv entry, so
// these tests never touch the real dsh installation; no DSH_HOME / store paths
// are involved at all (this module reads package.json files only).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DSH_MODERN_BASE,
  DSH_PACKAGE_NAMES,
  PLUGIN_NAME,
  atLeastBase,
  compareSemver,
  detectDshRuntime,
  dshIsModern,
  isNewer,
  parseSemver,
  readPluginVersion,
  versionMeta,
  walkDshVersion,
} from '../lib/meta.mjs'

// ── semver primitives ─────────────────────────────────────────────────────

test('parseSemver accepts v-prefix, prerelease and build metadata', () => {
  assert.deepEqual(parseSemver('1.2.3').prerelease, [])
  assert.equal(parseSemver('v5.2.0').major, 5)
  assert.equal(parseSemver('v5.2.0').minor, 2)
  assert.equal(parseSemver(' v5.2.0-dev.1 ').patch, 0)
  assert.deepEqual(parseSemver('5.2.0-dev.1').prerelease, ['dev', '1'])
  // Prerelease AND build metadata together: only the prerelease is compared.
  assert.deepEqual(parseSemver('1.0.0-rc.1+build').prerelease, ['rc', '1'])
  // Build metadata never participates in parsing beyond being accepted.
  assert.deepEqual(parseSemver('1.0.0+sha.abc').prerelease, [])
})

test('parseSemver rejects non-semver junk instead of coercing it', () => {
  for (const bad of ['', '   ', 'latest', '1.2', '192.0.2.10', 'x.y.z', '1..2', '1.2.3-', null, undefined, 42, 'dev.1']) {
    assert.equal(parseSemver(bad), undefined, 'should reject: ' + String(bad))
  }
  // Empty prerelease identifiers are invalid semver.
  assert.equal(parseSemver('1.2.3-alpha..beta'), undefined)
})

test('compareSemver follows semver precedence (incl. prerelease ordering)', () => {
  // The canonical chain from semver.org §11.
  const chain = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ]
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.equal(compareSemver(chain[i], chain[i + 1]), -1, chain[i] + ' < ' + chain[i + 1])
    assert.equal(compareSemver(chain[i + 1], chain[i]), 1, chain[i + 1] + ' > ' + chain[i])
    assert.equal(isNewer(chain[i + 1], chain[i]), true)
    assert.equal(isNewer(chain[i], chain[i + 1]), false)
  }
  // Numeric identifiers compare numerically (not lexically): 2 < 11.
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1)
  // Build metadata is ignored for precedence.
  assert.equal(compareSemver('1.0.0+build.9', '1.0.0+sha.1'), 0)
  assert.equal(compareSemver('1.0.0', 'v1.0.0'), 0)
  // Triplet ordering.
  assert.equal(compareSemver('0.2.1', '0.2.0'), 1)
  assert.equal(compareSemver('5.2.0', '5.10.0'), -1)
})

test('compareSemver/isNewer never throw on invalid input', () => {
  assert.equal(compareSemver('nope', '1.0.0'), 0)
  assert.equal(compareSemver('1.0.0', undefined), 0)
  assert.equal(isNewer('5.2.0', ''), false, 'unknown current version never claims an update')
  assert.equal(isNewer('', '5.1.0'), false)
  assert.equal(isNewer('garbage', '5.1.0'), false)
  assert.equal(isNewer(undefined, undefined), false)
  // compareSemver also takes already-parsed objects.
  assert.equal(compareSemver(parseSemver('1.0.0'), '1.0.0'), 0)
})

test('isNewer is prerelease-aware for this repo dev builds', () => {
  // A dev build is OLDER than the release with the same base version ...
  assert.equal(isNewer('5.2.0', '5.2.0-dev.1'), true)
  assert.equal(isNewer('5.2.0-dev.2', '5.2.0-dev.1'), true)
  assert.equal(isNewer('5.2.0-dev.1', '5.2.0'), false)
  // ... and 5.2.0-dev.1 is NEWER than the previous 5.1.x release line.
  assert.equal(isNewer('5.2.0-dev.1', '5.1.0'), true)
  // Equal versions are never an update.
  assert.equal(isNewer('5.2.0', '5.2.0'), false)
  assert.equal(isNewer('5.2.0-dev.1', '5.2.0-dev.1'), false)
})

// ── the dsh >= 0.2.1 gate ─────────────────────────────────────────────────

test('atLeastBase compares the numeric triplet and ignores prerelease', () => {
  assert.equal(atLeastBase('0.2.1-rc.2', DSH_MODERN_BASE), true, 'a 0.2.1 prerelease counts as 0.2.1')
  assert.equal(atLeastBase('0.2.1', DSH_MODERN_BASE), true)
  assert.equal(atLeastBase('0.2.2', DSH_MODERN_BASE), true)
  assert.equal(atLeastBase('1.0.0', DSH_MODERN_BASE), true)
  assert.equal(atLeastBase('0.2.0-rc.2', DSH_MODERN_BASE), false)
  assert.equal(atLeastBase('0.1.9', DSH_MODERN_BASE), false)
  assert.equal(atLeastBase('', DSH_MODERN_BASE), false)
  assert.equal(atLeastBase('unknown', DSH_MODERN_BASE), false)
})

test('dshIsModern: resolved version wins; unresolvable is modern only on desktop', () => {
  assert.equal(dshIsModern({ version: '0.2.1-rc.2', desktop: false }), true)
  assert.equal(dshIsModern({ version: '0.2.1-rc.2', desktop: true }), true)
  assert.equal(dshIsModern({ version: '0.1.6-alpha.2', desktop: true }), false, 'an old resolved version is old even on desktop')
  assert.equal(dshIsModern({ version: '', desktop: true }), true, 'desktop with an unresolvable version stays modern')
  assert.equal(dshIsModern({ version: '', desktop: false }), false, 'unknown web version => legacy UI')
  assert.equal(dshIsModern({}), false)
  assert.equal(dshIsModern(undefined), false)
})

// ── runtime discovery ─────────────────────────────────────────────────────

function writePkg(dir, name, version) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }, null, 2))
}

test('walkDshVersion finds the installed dsh package above a fake argv entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-meta-walk-'))
  try {
    // <root>/app is the dsh package; the entry point is <root>/app/lib/cli.js.
    writePkg(join(root, 'app'), '@deepseek-ai/dsh', '0.2.1-rc.2')
    const entry = join(root, 'app', 'lib', 'cli.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// fake entry\n')
    assert.equal(walkDshVersion(entry), '0.2.1-rc.2')

    // A directory entry works too (some loaders pass one).
    assert.equal(walkDshVersion(join(root, 'app', 'lib')), '0.2.1-rc.2')

    // A nearer, non-dsh package.json is skipped rather than accepted.
    writePkg(join(root, 'app', 'lib'), 'some-other-package', '9.9.9')
    assert.equal(walkDshVersion(entry), '0.2.1-rc.2')

    // An unresolvable path simply yields ''.
    assert.equal(walkDshVersion(join(root, 'nope', 'nested', 'cli.js')), '')
    assert.equal(walkDshVersion(''), '')
    assert.equal(walkDshVersion(undefined), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walkDshVersion honours the maxDepth budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-meta-depth-'))
  try {
    writePkg(root, '@deepseek-ai/dsh', '0.2.1')
    // 10 directories between the entry file and the package root: beyond the
    // default 8-level walk, so the version must NOT be found.
    let dir = root
    const parts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    for (const part of parts) dir = join(dir, part)
    mkdirSync(dir, { recursive: true })
    const entry = join(dir, 'cli.js')
    writeFileSync(entry, '// fake entry\n')
    assert.equal(walkDshVersion(entry), '')
    assert.equal(walkDshVersion(entry, { maxDepth: 12 }), '0.2.1')
    // A package.json whose version is not semver is ignored.
    const other = mkdtempSync(join(tmpdir(), 'dsh-meta-badver-'))
    try {
      writePkg(join(other, 'pkg'), '@deepseek-ai/dsh', 'not-a-version')
      assert.equal(walkDshVersion(join(other, 'pkg', 'bin.js')), '')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walkDshVersion recognises every documented host package name', () => {
  assert.deepEqual([...DSH_PACKAGE_NAMES], [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-desktop-runtime',
    '@deepseek-ai/dsh-desktop',
  ])
  for (const name of DSH_PACKAGE_NAMES) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-meta-name-'))
    try {
      writePkg(root, name, '0.2.1')
      assert.equal(walkDshVersion(join(root, 'lib', 'bin.js')), '0.2.1', name)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('readPluginVersion equals this package.json version and is cached', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_NAME, 'dsh-dbhub-live')
  assert.equal(readPluginVersion(), pkg.version)
  assert.equal(readPluginVersion(), pkg.version, 'the value is stable across calls')
  // The package.json version must itself be semver, otherwise the update check
  // would be comparing against an unknown version forever.
  assert.ok(parseSemver(readPluginVersion()), 'package.json version must be semver')
})

test('detectDshRuntime reports a coherent runtime (never throws)', () => {
  const runtime = detectDshRuntime()
  assert.equal(typeof runtime.version, 'string')
  assert.equal(typeof runtime.desktop, 'boolean')
  // This test process runs under plain node (no Electron), so unless the shell
  // exports DSH_CLIENT_VERSION the runtime must be web.
  if (!process.versions.electron && !process.env.DSH_CLIENT_VERSION) {
    assert.equal(runtime.desktop, false)
    assert.equal(runtime.version, '')
  }
  if (runtime.version) assert.ok(parseSemver(runtime.version), 'a resolved version is always semver')
})

test('versionMeta publishes the four view fields', () => {
  const meta = versionMeta()
  assert.deepEqual(Object.keys(meta).sort(), ['dshModern', 'dshVersion', 'pluginVersion', 'runtime'])
  assert.equal(meta.pluginVersion, readPluginVersion())
  assert.ok(meta.runtime === 'web' || meta.runtime === 'desktop')
  assert.equal(meta.dshModern, dshIsModern({ version: meta.dshVersion, desktop: meta.runtime === 'desktop' }))
  assert.equal(typeof meta.dshModern, 'boolean')
})
