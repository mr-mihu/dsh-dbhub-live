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

test('snapshot exposes both UI fields (the sidebar switch is a user preference)', () => {
  const snap = options.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), ['showSidebarEntry', 'updateIntervalDays'])
  // The switch hides the SHORTCUT; it does not disable the plugin. The client
  // ANDs it with the enabled state.
  assert.equal(snap.showSidebarEntry, true)
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

test('a user write claims the field and persists it for the next boot', async () => {
  assert.equal(options.applyPatch({ updateIntervalDays: 5 }, { persist: true }), true)
  // prefs.json is the whole UI layer, so it carries both fields.
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 5, showSidebarEntry: false })
  // A boot-time layer must never claim a field, so persisting stays opt-in.
  assert.equal(options.applyPatch({ updateIntervalDays: 6 }), true)
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 5, showSidebarEntry: false })
  assert.equal(options.applyPatch({ updateIntervalDays: 5 }), true)

  // A fresh module instance models a restart: prefs outranks the env seed.
  const restarted = await import('../lib/options.mjs?options3=' + Date.now())
  assert.equal(restarted.get('updateIntervalDays'), 5)
  assert.equal(restarted.get('showSidebarEntry'), false)
  assert.equal(restarted.get('dbhubPackage'), 'test/fork-package')
})

test('the sidebar preference survives a restart and is dropped only when non-boolean', async () => {
  // The user's "hide the shortcut" choice is a real preference again (it was
  // briefly removed in dev.1/dev.2 and is back in dev.3): a stored `false` must
  // read back as `false`, not fall back to the default.
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: 5, showSidebarEntry: false }))
  const fresh = await import('../lib/options.mjs?options8=' + Date.now())
  assert.equal(fresh.get('updateIntervalDays'), 5)
  assert.equal(fresh.get('showSidebarEntry'), false)
  // A non-boolean is dropped (and the file self-heals) instead of being coerced.
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: 5, showSidebarEntry: 'nope' }))
  const cleaned = await import('../lib/options.mjs?options8b=' + Date.now())
  assert.equal(cleaned.get('showSidebarEntry'), true, 'built-in default')
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 5 })
})

test('the legacy settings document only fills fields prefs does not own', async () => {
  // prefs owns the interval; the sidebar switch is NOT in prefs here, so the
  // older document may still claim it (that is what "unclaimed" means).
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: 5 }))
  const fresh = await import('../lib/options.mjs?options4=' + Date.now())
  assert.equal(fresh.initFromLayers({ legacyUser: { updateIntervalDays: 9, showSidebarEntry: false } }), true)
  assert.equal(fresh.get('updateIntervalDays'), 5, 'prefs owns this field')
  assert.equal(fresh.get('showSidebarEntry'), false, 'unclaimed: the legacy layer applies')
  // A malformed layer is ignored entirely.
  assert.equal(fresh.initFromLayers({ legacyUser: ['nope'] }), false)
  assert.equal(fresh.initFromLayers({}), false)
  assert.equal(fresh.initFromLayers(null), false)
  // A legacy layer cannot claim a field prefs DOES own.
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: 5, showSidebarEntry: true }))
  const owned = await import('../lib/options.mjs?options4b=' + Date.now())
  assert.equal(owned.initFromLayers({ legacyUser: { updateIntervalDays: 9, showSidebarEntry: false } }), false)
  assert.equal(owned.get('updateIntervalDays'), 5)
  assert.equal(owned.get('showSidebarEntry'), true)
})

test('a corrupt prefs file cannot seed an invalid option', async () => {
  writeFileSync(PREFS_PATH, JSON.stringify({ updateIntervalDays: -4, showSidebarEntry: 'yes', junk: 1 }))
  const fresh = await import('../lib/options.mjs?options5=' + Date.now())
  assert.equal(fresh.get('updateIntervalDays'), 3) // falls back to the env seed
  assert.equal(fresh.get('showSidebarEntry'), true) // built-in default
  assert.deepEqual(fresh.snapshot(), { updateIntervalDays: 3, showSidebarEntry: true })
})

test('configValuesOf reads the declared Config in both runtime shapes', async () => {
  const fresh = await import('../lib/options.mjs?options6=' + Date.now())
  // dsh 0.1.7+/0.2.x: `.volatile()` fields arrive as live references.
  assert.deepEqual(
    fresh.configValuesOf({ updateIntervalDays: { get: () => 4 }, showSidebarEntry: { get: () => false } }),
    { updateIntervalDays: 4, showSidebarEntry: false },
  )
  // dsh 0.1.6 (schemastery 3.18.2 has no `.volatile()`): plain values.
  assert.deepEqual(
    fresh.configValuesOf({ updateIntervalDays: 2, showSidebarEntry: true }),
    { updateIntervalDays: 2, showSidebarEntry: true },
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
  const patch = fresh.configValuesOf({ updateIntervalDays: { get: () => 11 }, showSidebarEntry: { get: () => false } })
  assert.equal(fresh.applyPatch(patch, { persist: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), { updateIntervalDays: 11, showSidebarEntry: false })
  // Adopting the same value again is a no-op (no write, no republish loop).
  assert.equal(fresh.applyPatch(fresh.configValuesOf({ updateIntervalDays: { get: () => 11 }, showSidebarEntry: { get: () => false } }), { persist: true }), false)
})
