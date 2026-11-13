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
//
// `exportDir` is where query-result exports are written. '' = the default
// (`$DSH_HOME/storages/dsh-dbhub-live/exports`); anything else is a directory the
// user names (`~/…` expands, a RELATIVE path resolves against $DSH_HOME). Unlike
// the other options it is NOT just stored: a save PROVES the directory is
// writable (create + probe file) and refuses otherwise, because "configured but
// unwritable" would only surface much later, in the middle of a query.
//
// `defaultMaxRows` is the ONE result row cap now: a global integer (0 =
// unlimited). The per-environment `maxRows` of earlier builds is deprecated — it
// is still read back from the store so old files stay compatible, but it no
// longer decides anything. A tool call's own `maxRows` still wins over this
// global default.
//
// `batchConcurrency` (1..8, default 2) is how many throwaway dbhub processes the
// card's batch connection test runs at once. It replaced a hard-coded 2 in the
// browser bundle; the Host owns the value so the page and any future caller
// agree.

import { loadPrefs, savePrefs } from './config.mjs'
import { currentT } from './i18n.mjs'
import { prepareExportDir } from './export.mjs'

const BUILTIN_DEFAULTS = {
  dbhubPackage: '@bytebase/dbhub',
  updateIntervalDays: 7,
  showSidebarEntry: true,
  announceAccessPolicy: true,
  exportDir: '',
  defaultMaxRows: 0,
  batchConcurrency: 2,
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
  exportDir: persisted.exportDir !== undefined
    ? persisted.exportDir
    : BUILTIN_DEFAULTS.exportDir,
  defaultMaxRows: persisted.defaultMaxRows !== undefined
    ? persisted.defaultMaxRows
    : BUILTIN_DEFAULTS.defaultMaxRows,
  batchConcurrency: persisted.batchConcurrency !== undefined
    ? persisted.batchConcurrency
    : BUILTIN_DEFAULTS.batchConcurrency,
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
 * `exportDir` is included: the card shows the configured directory in its input
 * and the `/state` view needs it to prefill that input. `defaultMaxRows` (0 =
 * unlimited) and `batchConcurrency` (1..8) are the two numeric settings the card
 * renders and the tools/batch runner read.
 */
export function snapshot() {
  return {
    updateIntervalDays: options.updateIntervalDays,
    showSidebarEntry: options.showSidebarEntry,
    announceAccessPolicy: options.announceAccessPolicy,
    exportDir: options.exportDir,
    defaultMaxRows: options.defaultMaxRows,
    batchConcurrency: options.batchConcurrency,
  }
}

/**
 * Read one option by id ('dbhubPackage' is internal-only).
 * @param id - 'dbhubPackage' | 'updateIntervalDays' | 'showSidebarEntry' |
 *   'announceAccessPolicy' | 'exportDir' | 'defaultMaxRows' | 'batchConcurrency'.
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
  exportDir: (v) => typeof v === 'string',
  // Integers only: a fractional/negative/NaN cap would silently mean something
  // else (0 is "unlimited", so a coerced -1 must be refused, not rounded).
  defaultMaxRows: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
  batchConcurrency: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 8,
}

/** A typed business refusal (code + already-localized message). */
function optionRefusal(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Validate the two NUMERIC settings before a user save is written. THROWS
 * `code:'badMaxRows'` / `code:'badConcurrency'` (message already localized) for a
 * value that failed its validator, and returns quietly otherwise.
 *
 * `exportDir` is deliberately NOT checked here: proving a directory writable is
 * an fs operation and lives in `applyPatch` (`validateExportDir`), which runs
 * BEFORE any field is touched. A caller receiving a mixed patch must call
 * `validatePatch` first and then `applyPatch`; neither writes anything when
 * either refuses.
 */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return
  if (patch.defaultMaxRows !== undefined && !VALIDATORS.defaultMaxRows(patch.defaultMaxRows)) {
    throw optionRefusal('badMaxRows', currentT('result.badMaxRows'))
  }
  if (patch.batchConcurrency !== undefined && !VALIDATORS.batchConcurrency(patch.batchConcurrency)) {
    throw optionRefusal('badConcurrency', currentT('result.badConcurrency'))
  }
}

/**
 * Validate one `exportDir` value and return the value to store (trimmed; '' means
 * "the default directory"). THROWS a localized `code:'badExportDir'` refusal when
 * the directory cannot be created or written.
 *
 * The probe is deliberate: saving an unwritable directory and only discovering it
 * at export time would report the failure in the middle of a query, far from the
 * field the user typed. Probing here keeps the two facts (accepted / rejected) in
 * the same interaction.
 */
function validateExportDir(raw) {
  const refuse = (code, path) => {
    const err = new Error(currentT('result.badExportDir', { code: String(code), path: String(path || '') }))
    err.code = 'badExportDir'
    err.detail = String(code)
    return err
  }
  if (typeof raw !== 'string') throw refuse('EINVAL', '-')
  const text = raw.trim()
  try {
    prepareExportDir(text)
  } catch (e) {
    throw refuse((e && e.detail) || 'unknown', (e && e.path) || text || '-')
  }
  return text
}

/**
 * Apply a validated patch onto the options.
 *
 * `exportDir` is validated BEFORE anything is written: it is the one option whose
 * value must be proven usable (see `validateExportDir`), and a refusal must leave
 * every other field of the same patch untouched. A refusal is a BUSINESS failure
 * (`code:'badExportDir'`, already-localized message) — the bridge answers it as
 * `{ok:false,error}` so the card can show the reason, while an unexpected
 * exception still becomes a 500.
 *
 * @param patch - partial option values.
 * @param opts - `persist: true` writes the resulting values to prefs.json;
 *   used for user-driven writes only (a boot-time layer must not claim fields).
 * @returns whether any option actually changed.
 * @throws `code:'badExportDir'` when the requested directory is not writable.
 */
export function applyPatch(patch, opts) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false
  const nextExportDir = patch.exportDir === undefined ? undefined : validateExportDir(patch.exportDir)
  let changed = false
  for (const [key, validator] of Object.entries(VALIDATORS)) {
    if (key === 'exportDir') continue
    const value = patch[key]
    if (value === undefined) continue
    if (!validator(value)) continue
    const next = key === 'dbhubPackage' ? String(value).trim() : value
    if (next === options[key]) continue
    options[key] = next
    changed = true
  }
  if (nextExportDir !== undefined && nextExportDir !== options.exportDir) {
    options.exportDir = nextExportDir
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