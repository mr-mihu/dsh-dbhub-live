// dsh-dbhub-live: deployment-tunable options.
//
// Editable through the Settings -> DBHub page and the Plugins row card. One
// precedence ladder for both real sources, lowest layer first:
//   built-in default < process environment < this plugin's own prefs.json
// The declared Config is a write channel (a cordis.yml pin or a save from the
// official Plugins form) that lands in prefs.json, not a third layer: the page
// and the standard form therefore converge on one value. The 0.1.x settings
// document is gone with 0.1.x itself.
//
// `showSidebarEntry` is the USER's choice to hide the shortcut while the plugin
// keeps working. It is ANDed with the plugin's enabled state on the client (a
// disabled plugin contributes no entry at all), because the two switches mean
// different things: "hide the entry" versus "turn the plugin off".
//
// `announceAccessPolicy` is the USER's choice to let the plugin contribute its
// database-access policy to the system prompt. Default ON: an installed plugin
// should be the route database work takes, and the policy is what keeps a model
// from following a shell-level "recipe" around the read-only gate. Turning it
// off removes that text only — every tool keeps working (the tool descriptions
// and the read-only receipt still mention the boundary), so this is a prompt
// preference, not a capability switch.

import { loadPrefs, savePrefs } from './config.mjs'

const BUILTIN_DEFAULTS = {
  dbhubPackage: '@bytebase/dbhub',
  updateIntervalDays: 7,
  showSidebarEntry: true,
  announceAccessPolicy: true,
}

function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// The card's own layer, read once at load so the first render already shows the
// user's choice instead of the environment seed.
const persisted = loadPrefs()

const options = {
  dbhubPackage: process.env.DSH_DBHUB_PACKAGE || BUILTIN_DEFAULTS.dbhubPackage,
  updateIntervalDays: persisted.updateIntervalDays !== undefined
    ? persisted.updateIntervalDays
    : envNumber('DSH_DBHUB_UPDATE_DAYS', BUILTIN_DEFAULTS.updateIntervalDays),
  showSidebarEntry: persisted.showSidebarEntry !== undefined
    ? persisted.showSidebarEntry
    : BUILTIN_DEFAULTS.showSidebarEntry,
  announceAccessPolicy: persisted.announceAccessPolicy !== undefined
    ? persisted.announceAccessPolicy
    : BUILTIN_DEFAULTS.announceAccessPolicy,
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

/** Subscribe to option changes; returns the disposer. */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Detached JSON snapshot of the settings-exposed options. `dbhubPackage` is
 * deliberately excluded: the auto-install package stays an environment-seeded
 * internal knob (DSH_DBHUB_PACKAGE / built-in default), not a settings field.
 */
export function snapshot() {
  return {
    updateIntervalDays: options.updateIntervalDays,
    showSidebarEntry: options.showSidebarEntry,
    announceAccessPolicy: options.announceAccessPolicy,
  }
}

/**
 * Read one option by id ('dbhubPackage' is internal-only).
 * @param id - 'dbhubPackage' | 'updateIntervalDays' | 'showSidebarEntry' |
 *   'announceAccessPolicy'.
 * @returns the current value.
 */
export function get(id) {
  return options[id]
}

// Per-field validators for the settings-exposed options; 'dbhubPackage' is
// deliberately not patchable (it stays an env/internal knob).
const VALIDATORS = {
  updateIntervalDays: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  showSidebarEntry: (v) => typeof v === 'boolean',
  announceAccessPolicy: (v) => typeof v === 'boolean',
}

/**
 * Apply a validated patch onto the options.
 * @param patch - partial option values (already-validated fields only).
 * @param opts - `persist: true` writes the resulting values to prefs.json;
 *   used for user-driven writes only (a boot-time layer must not claim fields).
 * @returns whether any option actually changed.
 */
export function applyPatch(patch, opts) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false
  let changed = false
  for (const [key, validator] of Object.entries(VALIDATORS)) {
    const value = patch[key]
    if (value === undefined) continue
    if (!validator(value)) continue
    const next = key === 'dbhubPackage' ? String(value).trim() : value
    if (next === options[key]) continue
    options[key] = next
    changed = true
  }
  if (changed) {
    if (opts && opts.persist === true) savePrefs(snapshot())
    emit()
  }
  return changed
}

/**
 * Read the plugin's declared Config fields.
 *
 * The UI options are declared as `.volatile()` fields, so the Loader hands back
 * live references (`{ get() }`) that change in place when the official Plugins
 * form (or a cordis.yml edit) commits a new value; a plain-value shape is read
 * too. Anything that is absent or fails its validator is skipped — the field
 * simply keeps its current layer.
 * @param config - the second `apply()` argument, possibly undefined.
 * @returns a validated partial option patch.
 */
export function configValuesOf(config) {
  const out = {}
  if (!config || typeof config !== 'object') return out
  for (const [key, validator] of Object.entries(VALIDATORS)) {
    const field = config[key]
    const raw = field && typeof field.get === 'function' ? field.get() : field
    if (raw === undefined || raw === null) continue
    if (!validator(raw)) continue
    out[key] = raw
  }
  return out
}