// Unit tests for the configurable options (lib/options.mjs): defaults, env
// seeding, validated patches, and change notifications.

import test from 'node:test'
import assert from 'node:assert/strict'

// env seeding happens at import time — set DSH_DBHUB_PACKAGE before importing.
process.env.DSH_DBHUB_PACKAGE = 'test/fork-package'
process.env.DSH_DBHUB_UPDATE_DAYS = '3'
const options = await import('../lib/options.mjs?options=' + Date.now())

test('options seed from process environment', () => {
  assert.equal(options.get('dbhubPackage'), 'test/fork-package')
  assert.equal(options.get('updateIntervalDays'), 3)
  assert.equal(options.get('idleMinutes'), 10) // no env -> builtin default
})

test('snapshot is a detached JSON value with all three keys', () => {
  const snap = options.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), ['dbhubPackage', 'idleMinutes', 'updateIntervalDays'])
  snap.updateIntervalDays = 99
  assert.equal(options.get('updateIntervalDays'), 3)
})

test('applyPatch accepts valid values, trims the package name, and emits', () => {
  const seen = []
  const off = options.subscribe(() => seen.push(options.snapshot()))
  assert.equal(options.applyPatch({ dbhubPackage: '  @bytebase/dbhub@1.2.1  ', updateIntervalDays: 0, idleMinutes: 20 }), true)
  assert.equal(options.get('dbhubPackage'), '@bytebase/dbhub@1.2.1')
  assert.equal(options.get('updateIntervalDays'), 0)
  assert.equal(options.get('idleMinutes'), 20)
  assert.equal(seen.length, 1)
  off()
})

test('applyPatch rejects invalid or unchanged values', () => {
  const before = options.snapshot()
  assert.equal(options.applyPatch({ dbhubPackage: '   ', idleMinutes: 0, updateIntervalDays: -1, enabled: false }), false)
  assert.deepEqual(options.snapshot(), before)
  // no-op patch (same values) does not emit
  assert.equal(options.applyPatch({ idleMinutes: 20 }), false)
})

test('applyPatch rejects non-object input', () => {
  const before = options.snapshot()
  assert.equal(options.applyPatch(null), false)
  assert.equal(options.applyPatch(42), false)
  assert.equal(options.applyPatch(['a']), false)
  assert.deepEqual(options.snapshot(), before)
})