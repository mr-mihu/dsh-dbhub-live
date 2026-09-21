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
})

test('snapshot exposes only the settings fields', () => {
  const snap = options.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), ['showSidebarEntry', 'updateIntervalDays'])
  assert.equal(snap.showSidebarEntry, true) // sidebar shortcut on by default
  snap.updateIntervalDays = 99
  assert.equal(options.get('updateIntervalDays'), 3)
})

test('applyPatch accepts valid values, emits, and rejects invalid', () => {
  const seen = []
  const off = options.subscribe(() => seen.push(options.snapshot()))
  assert.equal(options.applyPatch({ updateIntervalDays: 0, dbhubPackage: 'ignored' }), true)
  assert.equal(options.get('updateIntervalDays'), 0)
  assert.equal(options.get('dbhubPackage'), 'test/fork-package') // not settable via patch
  assert.equal(seen.length, 1)
  // the sidebar switch is a boolean-only option
  assert.equal(options.applyPatch({ showSidebarEntry: false }), true)
  assert.equal(options.get('showSidebarEntry'), false)
  assert.equal(options.applyPatch({ showSidebarEntry: 'yes' }), false)
  assert.equal(options.get('showSidebarEntry'), false)
  off()
  const before = options.snapshot()
  assert.equal(options.applyPatch({ updateIntervalDays: -1, enabled: false }), false)
  assert.equal(options.applyPatch({ showSidebarEntry: false }), false) // already false: no emit
  assert.deepEqual(options.snapshot(), before)
  assert.equal(options.applyPatch(null), false)
  assert.equal(options.applyPatch(['a']), false)
  assert.equal(options.applyPatch({ updateIntervalDays: 0 }), false) // no-op does not emit
})