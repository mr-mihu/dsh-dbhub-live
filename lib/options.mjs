// dsh-dbhub-live: deployment-tunable options.
//
// Editable through the Settings -> Plugins -> dsh-dbhub-live card. Precedence:
//   user settings (settings document) > process environment > built-in default
// Environment variables only seed the boot values; once the settings document
// claims a field (first publish writes the section), that field is owned by
// the settings UI until it is unset — so an env change no longer applies to a
// claimed field. This mirrors how the dsh settings system treats user layers.

const BUILTIN_DEFAULTS = {
  dbhubPackage: '@bytebase/dbhub',
  updateIntervalDays: 7,
  idleMinutes: 10,
}

function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const options = {
  dbhubPackage: process.env.DSH_DBHUB_PACKAGE || BUILTIN_DEFAULTS.dbhubPackage,
  updateIntervalDays: envNumber('DSH_DBHUB_UPDATE_DAYS', BUILTIN_DEFAULTS.updateIntervalDays),
  idleMinutes: BUILTIN_DEFAULTS.idleMinutes,
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
    idleMinutes: options.idleMinutes,
  }
}

/**
 * Read one option by id ('dbhubPackage' is internal-only).
 * @param id - 'dbhubPackage' | 'updateIntervalDays' | 'idleMinutes'.
 * @returns the current value.
 */
export function get(id) {
  return options[id]
}

// Per-field validators for the settings-exposed options; 'dbhubPackage' is
// deliberately not patchable (it stays an env/internal knob).
const VALIDATORS = {
  updateIntervalDays: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  idleMinutes: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
}

/**
 * Apply a validated patch onto the options.
 * @param patch - partial option values (prefixes the env seed at boot).
 * @returns whether any option actually changed.
 */
export function applyPatch(patch) {
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
  if (changed) emit()
  return changed
}