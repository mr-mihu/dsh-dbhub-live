// Unit tests for the runtime state machine (lib/state.mjs).
// DSH_HOME is pointed at a temp dir before the modules are imported so the
// store persists inside the test sandbox, never the real plugin store.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-state-'))
process.env.DSH_HOME = home

const cfg = await import('../lib/config.mjs')
const state = await import('../lib/state.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

function persistPath() {
  return join(home, 'storages', 'dsh-dbhub-live', 'credentials.json')
}

test('enabled defaults to true and phase starts running (no resident server)', () => {
  assert.equal(state.isEnabled(), true)
  assert.equal(state.snapshot().phase, 'running')
  assert.equal(state.snapshot().mode, 'oneshot')
})

test('setEnabled(false) persists to the store and moves to disabled', () => {
  assert.equal(state.setEnabled(false), true)
  assert.equal(state.isEnabled(), false)
  assert.equal(state.snapshot().phase, 'disabled')
  assert.ok(existsSync(persistPath()))
  const stored = JSON.parse(readFileSync(persistPath(), 'utf8'))
  assert.equal(stored.enabled, false)
  // idempotent: same value does not change state
  assert.equal(state.setEnabled(false), false)
})

test('setEnabled(true) returns to running (nothing to lazy-init — calls spawn on demand)', () => {
  assert.equal(state.setEnabled(true), true)
  assert.equal(state.isEnabled(), true)
  assert.equal(state.snapshot().phase, 'running')
})

test('recordError/clearError drive the error phase and summary', () => {
  state.recordError('boom')
  assert.equal(state.snapshot().phase, 'error')
  assert.equal(state.snapshot().lastError, 'boom')
  state.clearError()
  assert.equal(state.snapshot().lastError, '')
  state.setPhase('running')
  assert.equal(state.snapshot().phase, 'running')
})

test('tool count tracks registered tools and never goes negative', () => {
  state.setToolCount(0)
  assert.equal(state.snapshot().toolCount, 0)
  state.setToolCount(4)
  assert.equal(state.snapshot().toolCount, 4)
  state.setToolCount(-3)
  assert.equal(state.snapshot().toolCount, 0)
  state.setToolCount(0)
})

test('subscribers see every change and dispose cleanly', () => {
  const seen = []
  state.setPhase('initializing') // deterministic starting phase
  const off = state.subscribe(() => seen.push(state.snapshot().phase))
  assert.equal(seen.length, 0) // subscribe does not fire immediately
  state.setPhase('running')
  state.setPhase('error')
  off()
  state.setPhase('running')
  assert.deepEqual(seen, ['running', 'error'])
})

test('snapshot is a detached JSON value', () => {
  const before = state.snapshot().enabled
  const snap = state.snapshot()
  snap.enabled = !before
  assert.equal(state.snapshot().enabled, before)
})