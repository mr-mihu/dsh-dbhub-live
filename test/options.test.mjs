// Unit tests for the configurable options (lib/options.mjs): env seeding for
// the internal package knob, the one UI-exposed field, the persisted user
// layer, validated patches, and change notifications.
//
// The module derives both the storage directory and the persisted prefs layer
// from DSH_HOME at import time, so DSH_HOME is pointed at a temp dir BEFORE the
// modules load, and each layer is probed through a fresh module instance.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dbhub-options-'))
// The only test file that used to leave its temp DSH_HOME behind (every other
// fixture does this cleanup): a per-file runner would accumulate one directory
// per run, so the temp tree is removed once this file's tests are done.
test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
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

test('snapshot exposes every UI field (switches + both numbers + export dir)', () => {
  const snap = options.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), [
    'announceAccessPolicy',
    'batchConcurrency',
    'defaultMaxRows',
    'exportDir',
    'showSidebarEntry',
    'updateIntervalDays',
  ])
  // The switch hides the SHORTCUT; it does not disable the plugin. The client
  // ANDs it with the enabled state.
  assert.equal(snap.showSidebarEntry, true)
  // The policy announcement defaults ON: an installed plugin should be the
  // route database work takes. Turning it off removes one prompt section only.
  assert.equal(snap.announceAccessPolicy, true)
  // Both numbers are settings now (the per-environment row cap became one global
  // cap, and the batch runner reads its concurrency from here instead of a
  // literal in the bundle).
  assert.equal(snap.defaultMaxRows, 0, '0 = unlimited')
  assert.equal(snap.batchConcurrency, 2)
  // '' = the plugin's default directory; the card prefills its input from this.
  assert.equal(snap.exportDir, '')
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
  // ... and so is the policy announcement (boolean-only, no truthy coercion)
  assert.equal(options.applyPatch({ announceAccessPolicy: false }), true)
  assert.equal(options.get('announceAccessPolicy'), false)
  assert.equal(options.applyPatch({ announceAccessPolicy: 'no' }), false)
  assert.equal(options.get('announceAccessPolicy'), false)
  // The global row cap and the batch concurrency are INTEGERS with a range: a
  // fractional, negative or out-of-range value is skipped (never coerced).
  assert.equal(options.applyPatch({ defaultMaxRows: 500 }), true)
  assert.equal(options.get('defaultMaxRows'), 500)
  for (const ignored of [-1, 1.5, '500']) assert.equal(options.applyPatch({ defaultMaxRows: ignored }), false, String(ignored))
  assert.equal(options.get('defaultMaxRows'), 500)
  assert.equal(options.applyPatch({ batchConcurrency: 4 }), true)
  assert.equal(options.get('batchConcurrency'), 4)
  for (const ignored of [0, 9, 1.5, '4', -2]) assert.equal(options.applyPatch({ batchConcurrency: ignored }), false, String(ignored))
  assert.equal(options.get('batchConcurrency'), 4)
  // `exportDir` is a STRING that is proven writable at save time. A writable
  // directory is adopted; a non-string is a refusal (a business `badExportDir`,
  // not a silent skip — the user typed something that cannot be a directory).
  const customDir = join(home, 'exports-custom')
  assert.equal(options.applyPatch({ exportDir: customDir }), true)
  assert.equal(options.get('exportDir'), customDir)
  assert.throws(() => options.applyPatch({ exportDir: 42, updateIntervalDays: 1 }), (e) => e && e.code === 'badExportDir')
  assert.equal(options.get('exportDir'), customDir, 'a refused exportDir never half-applies the patch')
  assert.equal(options.get('updateIntervalDays'), 0, '…and no sibling field is written either')
  assert.equal(options.applyPatch({ exportDir: `  ${customDir}  ` }), false, 'trimmed to the same value: no change, no emit')
  off()
  const before = options.snapshot()
  assert.equal(options.applyPatch({ updateIntervalDays: -1, enabled: false }), false)
  assert.equal(options.applyPatch({ showSidebarEntry: false }), false) // already false: no emit
  assert.deepEqual(options.snapshot(), before)
  assert.equal(options.applyPatch(null), false)
  assert.equal(options.applyPatch(['a']), false)
  assert.equal(options.applyPatch({ updateIntervalDays: 0 }), false) // no-op does not emit
})

test('the card path refuses a bad concurrency / row cap without writing anything', () => {
  // Mirrors index.mjs `setOptions`: validate FIRST (that is the layer that throws
  // `badConcurrency` / `badMaxRows`), then apply. A refused save must leave every
  // sibling field of the same patch untouched and the prefs file byte-identical.
  const save = (patch) => {
    try {
      options.validatePatch(patch)
      return options.applyPatch(patch, { persist: true })
    } catch (e) {
      return { refused: e && e.code }
    }
  }
  const before = options.snapshot()
  // The file may not exist yet in this run (earlier tests wrote no prefs), so the
  // "byte-identical" claim is measured against whatever is there — including none.
  const readPrefs = () => {
    try {
      return readFileSync(PREFS_PATH, 'utf8')
    } catch (e) {
      return null
    }
  }
  const prefsBefore = readPrefs()
  for (const bad of [0, 9, 1.5, '2', -1]) {
    assert.deepEqual(save({ batchConcurrency: bad, updateIntervalDays: 9 }), { refused: 'badConcurrency' },
      'concurrency ' + String(bad) + ' must be refused')
  }
  for (const bad of [-1, 1.5, '10', 0.5]) {
    assert.deepEqual(save({ defaultMaxRows: bad, updateIntervalDays: 9 }), { refused: 'badMaxRows' },
      'row cap ' + String(bad) + ' must be refused')
  }
  assert.deepEqual(options.snapshot(), before, 'no field of a refused patch was written')
  assert.equal(readPrefs(), prefsBefore, 'a refused save does not touch prefs.json')
  // The same values pass once they are legal integers.
  assert.equal(save({ batchConcurrency: 8, defaultMaxRows: 0 }), true)
  assert.equal(options.get('batchConcurrency'), 8)
})

test('a user write claims the field and persists it for the next boot', async () => {
  assert.equal(options.applyPatch({ updateIntervalDays: 5 }, { persist: true }), true)
  // prefs.json is the whole UI layer, so it carries every UI field — including the
  // export directory the previous test proved writable.
  const expected = {
    updateIntervalDays: 5,
    showSidebarEntry: false,
    announceAccessPolicy: false,
    exportDir: join(home, 'exports-custom'),
    defaultMaxRows: options.get('defaultMaxRows'),
    batchConcurrency: 8,
  }
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), expected)
  // A boot-time layer must never claim a field, so persisting stays opt-in.
  assert.equal(options.applyPatch({ updateIntervalDays: 6 }), true)
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), expected)
  assert.equal(options.applyPatch({ updateIntervalDays: 5 }), true)

  // A fresh module instance models a restart: prefs outranks the env seed.
  const restarted = await import('../lib/options.mjs?options3=' + Date.now())
  assert.equal(restarted.get('updateIntervalDays'), 5)
  assert.equal(restarted.get('showSidebarEntry'), false)
  assert.equal(restarted.get('announceAccessPolicy'), false)
  assert.equal(restarted.get('dbhubPackage'), 'test/fork-package')
  assert.equal(restarted.get('batchConcurrency'), 8, 'the stored number reads back')
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

test('a corrupt prefs file cannot seed an invalid option', async () => {
  writeFileSync(PREFS_PATH, JSON.stringify({
    updateIntervalDays: -4,
    showSidebarEntry: 'yes',
    announceAccessPolicy: 'nope',
    exportDir: 42,
    defaultMaxRows: -1,
    batchConcurrency: 9,
    junk: 1,
  }))
  const fresh = await import('../lib/options.mjs?options5=' + Date.now())
  assert.equal(fresh.get('updateIntervalDays'), 3) // falls back to the env seed
  assert.equal(fresh.get('showSidebarEntry'), true) // built-in default
  assert.equal(fresh.get('announceAccessPolicy'), true) // built-in default (ON)
  assert.equal(fresh.get('exportDir'), '') // a non-string is dropped, not coerced
  assert.equal(fresh.get('defaultMaxRows'), 0) // -1 is not a row cap
  assert.equal(fresh.get('batchConcurrency'), 2) // 9 is outside 1..8
  assert.deepEqual(fresh.snapshot(), {
    updateIntervalDays: 3,
    showSidebarEntry: true,
    announceAccessPolicy: true,
    exportDir: '',
    defaultMaxRows: 0,
    batchConcurrency: 2,
  })
})

test('configValuesOf reads the declared Config in both runtime shapes', async () => {
  const fresh = await import('../lib/options.mjs?options6=' + Date.now())
  // dsh 0.1.7+/0.2.x: `.volatile()` fields arrive as live references.
  assert.deepEqual(
    fresh.configValuesOf({
      updateIntervalDays: { get: () => 4 },
      showSidebarEntry: { get: () => false },
      announceAccessPolicy: { get: () => false },
      exportDir: { get: () => '/tmp/dbhub-exports' },
      defaultMaxRows: { get: () => 200 },
      batchConcurrency: { get: () => 4 },
    }),
    {
      updateIntervalDays: 4,
      showSidebarEntry: false,
      announceAccessPolicy: false,
      exportDir: '/tmp/dbhub-exports',
      defaultMaxRows: 200,
      batchConcurrency: 4,
    },
  )
  // dsh 0.1.6 (schemastery 3.18.2 has no `.volatile()`): plain values.
  assert.deepEqual(
    fresh.configValuesOf({ updateIntervalDays: 2, showSidebarEntry: true, announceAccessPolicy: true, defaultMaxRows: 0, batchConcurrency: 8 }),
    { updateIntervalDays: 2, showSidebarEntry: true, announceAccessPolicy: true, defaultMaxRows: 0, batchConcurrency: 8 },
  )
  // Unset, invalid and junk input is skipped — the field keeps its other layers.
  assert.deepEqual(fresh.configValuesOf({ updateIntervalDays: { get: () => undefined }, showSidebarEntry: { get: () => 'yes' } }), {})
  assert.deepEqual(fresh.configValuesOf({ updateIntervalDays: -1, showSidebarEntry: null, announceAccessPolicy: 'yes' }), {})
  // The new fields honor their own validators too (integers/ranges, string dir).
  assert.deepEqual(fresh.configValuesOf({ defaultMaxRows: -1, batchConcurrency: 0, exportDir: 42 }), {})
  assert.deepEqual(fresh.configValuesOf({ defaultMaxRows: 1.5, batchConcurrency: 9, exportDir: { get: () => 42 } }), {})
  assert.deepEqual(fresh.configValuesOf({ unknownKey: 5 }), {})
  assert.deepEqual(fresh.configValuesOf(undefined), {})
  assert.deepEqual(fresh.configValuesOf('nope'), {})
})

test('an adopted Config value claims the field and outlives the config edit', async () => {
  const fresh = await import('../lib/options.mjs?options7=' + Date.now())
  const patch = fresh.configValuesOf({
    updateIntervalDays: { get: () => 11 },
    showSidebarEntry: { get: () => false },
    announceAccessPolicy: { get: () => false },
    defaultMaxRows: { get: () => 50 },
    batchConcurrency: { get: () => 3 },
  })
  assert.equal(fresh.applyPatch(patch, { persist: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(PREFS_PATH, 'utf8')), {
    updateIntervalDays: 11,
    showSidebarEntry: false,
    announceAccessPolicy: false,
    exportDir: '',
    defaultMaxRows: 50,
    batchConcurrency: 3,
  })
  // Adopting the same value again is a no-op (no write, no republish loop).
  assert.equal(fresh.applyPatch(fresh.configValuesOf({
    updateIntervalDays: { get: () => 11 },
    showSidebarEntry: { get: () => false },
    announceAccessPolicy: { get: () => false },
    defaultMaxRows: { get: () => 50 },
    batchConcurrency: { get: () => 3 },
  }), { persist: true }), false)
})
