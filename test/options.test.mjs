// Unit tests for the configurable options (lib/options.mjs): env seeding for
// the internal package knob, the one UI-exposed field, the persisted user
// layer, validated patches, and change notifications.
//
// The module derives both the storage directory and the persisted prefs layer
// from DSH_HOME at import time, so DSH_HOME is pointed at a temp dir BEFORE the
// modules load, and each layer is probed through a fresh module instance.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dbhub-options-'))
// env seeding happens at import time — set these before importing.
process.env.DSH_HOME = home
process.env.DSH_DBHUB_PACKAGE = 'test/fork-package'
process.env.DSH_DBHUB_UPDATE_DAYS = '3'
const options = await import('../lib/options.mjs?options2=' + Date.now())

const PREFS_PATH = join(home, 'storages', 'dsh-dbhub-live', 'prefs.json')

test('options seed from process environment; package stays internal-only', () => {
  assert.equal(options.get('dbhubPackage'), 'test/fork-package') // internal
  assert.equal(options.get('updateIntervalDays'), 3)
})

test('snapshot exposes only the UI field (the sidebar is not an option anymore)', () => {
  const snap = options.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), ['updateIntervalDays'])
  // F0: the sidebar entry follows the enabled state, so no option may reappear.
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'showSidebarEntry'), false)
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
  off()
  const before = options.snapshot()
  assert.equal(options.applyPatch({ updateIntervalDays: -1, enabled: false }), false)
  // A removed option is not patchable either: an old page writing it must be a
  // harmless no-op rather than resurrecting a field.
  assert.equal(options.applyPatch({ showSidebarEntry: false }), false)
  assert.equal(Object.prototype.hasOwnProperty.call(options.snapshot(), 'showSidebarEntry'), false)
  assert.deepEqual(options.snapshot(), before)
  assert.equal(options.applyPatch(null), false)
  assert.equal(options.applyPatch(['a']), false)
  assert.equal(options.applyPatch({ updateIntervalDays: 0 }), false) // no-op does not emit
})

test('a user write claims the field and persists it for the next boot', async () => {
  assert.equal(options.applyPatch({ updateIntervalDays: 5 }, { persist: true }), true)
  // prefs.json is the whole UI layer, so it carries exactly that field.
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 5 })
  // A boot-time layer must never claim a field, so persisting stays opt-in.
  assert.equal(options.applyPatch({ updateIntervalDays: 6 }), true)
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 5 })
  assert.equal(options.applyPatch({ updateIntervalDays: 5 }), true)

  // A fresh module instance models a restart: prefs outranks the env seed.
  const restarted = await import('../lib/options.mjs?options3=' + Date.now())
  assert.equal(restarted.get('updateIntervalDays'), 5)
  assert.equal(restarted.get('dbhubPackage'), 'test/fork-package')
})

test('a legacy showSidebarEntry key in prefs.json is dropped and never revived', async () => {
  // Upgrade path: the file an older build wrote still contains the removed key.
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: 5, showSidebarEntry: false }))
  const fresh = await import('../lib/options.mjs?options8=' + Date.now())
  assert.equal(fresh.get('updateIntervalDays'), 5)
  assert.equal(fresh.get('showSidebarEntry'), undefined)
  // Saving the layer rewrites the file through normalizePrefs, so the key is
  // gone from disk rather than lingering as a dead field.
  assert.equal(fresh.applyPatch({ updateIntervalDays: 4 }, { persist: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 4 })
})

test('the legacy settings document only fills fields prefs does not own', async () => {
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: 5 }))
  const fresh = await import('../lib/options.mjs?options4=' + Date.now())
  assert.equal(fresh.initFromLayers({ legacyUser: { updateIntervalDays: 9, showSidebarEntry: false } }), false)
  assert.equal(fresh.get('updateIntervalDays'), 5, 'prefs owns this field')
  assert.equal(fresh.get('showSidebarEntry'), undefined, 'the removed key is not a field')
  // A malformed layer is ignored entirely.
  assert.equal(fresh.initFromLayers({ legacyUser: ['nope'] }), false)
  assert.equal(fresh.initFromLayers({}), false)
  assert.equal(fresh.initFromLayers(null), false)
  // A legacy layer still fills a field prefs does NOT own.
  writeFileSync(PREFS_PATH, JSON.stringify({}))
  const unowned = await import('../lib/options.mjs?options4b=' + Date.now())
  assert.equal(unowned.initFromLayers({ legacyUser: { updateIntervalDays: 9 } }), true)
  assert.equal(unowned.get('updateIntervalDays'), 9)
})

test('a corrupt prefs file cannot seed an invalid option', async () => {
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: -4, showSidebarEntry: 'yes', junk: 1 }))
  const fresh = await import('../lib/options.mjs?options5=' + Date.now())
  assert.equal(fresh.get('updateIntervalDays'), 3) // falls back to the env seed
  assert.deepEqual(fresh.snapshot(), { updateIntervalDays: 3 })
})

test('configValuesOf reads the declared Config in both runtime shapes', async () => {
  const fresh = await import('../lib/options.mjs?options6=' + Date.now())
  // dsh 0.1.7+/0.2.x: `.volatile()` fields arrive as live references.
  assert.deepEqual(
    fresh.configValuesOf({ updateIntervalDays: { get: () => 4 }, showSidebarEntry: { get: () => false } }),
    { updateIntervalDays: 4 },
  )
  // dsh 0.1.6 (schemastery 3.18.2 has no `.volatile()`): plain values.
  assert.deepEqual(
    fresh.configValuesOf({ updateIntervalDays: 2, showSidebarEntry: true }),
    { updateIntervalDays: 2 },
  )
  // Unset, invalid and junk input is skipped — the field keeps its other layers.
  assert.deepEqual(fresh.configValuesOf({ updateIntervalDays: { get: () => undefined }, showSidebarEntry: { get: () => 'yes' } }), {})
  assert.deepEqual(fresh.configValuesOf({ updateIntervalDays: -1, showSidebarEntry: null }), {})
  assert.deepEqual(fresh.configValuesOf({ unknownKey: 5 }), {})
  assert.deepEqual(fresh.configValuesOf(undefined), {})
  assert.deepEqual(fresh.configValuesOf('nope'), {})
})

test('an adopted Config value claims the field and outlives the config edit', async () => {
  const fresh = await import('../lib/options.mjs?options7=' + Date.now())
  const patch = fresh.configValuesOf({ updateIntervalDays: { get: () => 11 } })
  assert.equal(fresh.applyPatch(patch, { persist: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 11 })
  // Adopting the same value again is a no-op (no write, no republish loop).
  assert.equal(fresh.applyPatch(fresh.configValuesOf({ updateIntervalDays: { get: () => 11 } }), { persist: true }), false)
})
