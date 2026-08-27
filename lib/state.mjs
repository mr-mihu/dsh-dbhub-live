// dsh-dbhub-live: plugin runtime state machine.
//
// The single source of truth for the status surface:
//   enabled    - the enable/disable toggle, persisted in the credentials store
//                so the choice survives restarts (the settings-document mirror
//                converges to this value at boot);
//   phase      - 'initializing' | 'running' | 'error' | 'disabled'
//   toolCount  - number of currently registered dbhub tools
//   lastError  - most recent init/run error text (shown while phase === 'error')
//   mode       - deployment mode label ('lazy': init deferred to first use)
//
// The module owns only the state; orchestration (starting/stopping the dbhub
// process, publishing to the settings namespace) subscribes to changes.

import { store, saveStore } from './config.mjs'

const state = {
  enabled: store.enabled !== false,
  phase: store.enabled !== false ? 'initializing' : 'disabled',
  toolCount: 0,
  lastError: '',
  mode: 'lazy',
}

const listeners = new Set()

function emit() {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch (e) {
      /* contain listener failures */
    }
  }
}

/** Subscribe to every state change; returns the disposer. */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Detached JSON snapshot of the current state (safe to persist/wire). */
export function snapshot() {
  return {
    enabled: state.enabled,
    phase: state.phase,
    toolCount: state.toolCount,
    lastError: state.lastError,
    mode: state.mode,
  }
}

/**
 * Flip the enable/disable toggle. Persists to the store and moves the phase
 * to 'disabled' when turning off; turning on leaves the phase for the caller's
 * lazy-init kick (orchestration subscribes and starts it).
 * @param value - the next enabled state.
 * @returns whether the state actually changed.
 */
export function setEnabled(value) {
  const next = Boolean(value)
  if (next === state.enabled) return false
  state.enabled = next
  store.enabled = next
  saveStore(store)
  // Turning off parks the plugin; turning on moves to 'initializing' — the
  // orchestration subscription sees the change and starts the lazy init.
  state.phase = next ? 'initializing' : 'disabled'
  emit()
  return true
}

export function isEnabled() {
  return state.enabled
}

export function setPhase(phase) {
  if (state.phase === phase) return
  state.phase = phase
  emit()
}

/** Record an init/run failure: phase -> 'error' and remember the message. */
export function recordError(message) {
  state.lastError = String(message || '')
  state.phase = 'error'
  emit()
}

/** Clear the remembered error after a successful init; caller sets the phase. */
export function clearError() {
  if (!state.lastError) return
  state.lastError = ''
  emit()
}

export function setToolCount(count) {
  const next = Math.max(0, Number(count) || 0)
  if (state.toolCount === next) return
  state.toolCount = next
  emit()
}

/** Raw state access for orchestration (read-only usage). */
export function getState() {
  return state
}