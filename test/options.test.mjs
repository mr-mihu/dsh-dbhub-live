// Unit tests for the configurable options (lib/options.mjs): env seeding for
// the internal package knob, the two settings-exposed fields, validated
// patches, and change notifications.

import test from 'node:test'
import assert from 'node:assert/strict'

// env seeding happens at import time — set DSH_DBHUB_PACKAGE before importing.
process.env.DSH_DBHUB_PACKAGE = 'test/fork-package'
process.env.DSH_DBHUB_UPDATE_DAYS = '3'
const options = await import('../lib/options.mjs?options2=' + Date.now())

test('options seed from process environment; package stays internal-only', () => {
  assert.equal(options.get('dbhubPackage'), 'test/fork-package') // internal
  assert.equal(options.get('updateIntervalDays'), 3)
  assert.equal(options.get('idleMinutes'), 10) // no env -> builtin default
})

test('snapshot exposes only the two settings fields', () => {
  const snap = options.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), ['idleMinutes', 'updateIntervalDays'])
  snap.updateIntervalDays = 99
  assert.equal(options.get('updateIntervalDays'), 3)
})

test('applyPatch accepts valid values, emits, and rejects invalid', () => {
  const seen = []
  const off = options.subscribe(() => seen.push(options.snapshot()))
  assert.equal(options.applyPatch({ updateIntervalDays: 0, idleMinutes: 20, dbhubPackage: 'ignored' }), true)
  assert.equal(options.get('updateIntervalDays'), 0)
  assert.equal(options.get('idleMinutes'), 20)
  assert.equal(options.get('dbhubPackage'), 'test/fork-package') // not settable via patch
  assert.equal(seen.length, 1)
  off()
  const before = options.snapshot()
  assert.equal(options.applyPatch({ updateIntervalDays: -1, idleMinutes: 0, enabled: false }), false)
  assert.deepEqual(options.snapshot(), before)
  assert.equal(options.applyPatch(null), false)
  assert.equal(options.applyPatch(['a']), false)
  assert.equal(options.applyPatch({ idleMinutes: 20 }), false) // no-op does not emit
})