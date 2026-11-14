// dsh-dbhub-live: paths, persistence, small utilities and workspace DSN
// resolution. Pure module — every function takes the services it needs as
// arguments, so this file never imports a Cordis service.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, basename, dirname } from 'node:path'
// i18n.mjs imports nothing (a leaf), so this cannot create a cycle.
import { currentT } from './i18n.mjs'

export function dshHomeDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

export const DATA_DIR = join(dshHomeDir(), 'storages', 'dsh-dbhub-live')
export const STORE_PATH = join(DATA_DIR, 'credentials.json')
export const RUNTIME_DIR = join(DATA_DIR, 'dbhub-runtime')
export const RUNTIME_PATH = join(DATA_DIR, 'runtime.json')
// UI preferences owned by the card (`updateIntervalDays`).
// On dsh >= 0.1.7 there is no settings namespace to keep them in, and the
// profile entry id needed to write the plugin's Config form is deployment
// owned, so the plugin persists them itself; on 0.1.x the settings document
// stays the store and this file is simply unused.
export const PREFS_PATH = join(DATA_DIR, 'prefs.json')
// The pre-4.0 connection store: it was a plaintext TOML document holding the
// connection strings (password included) and NOTHING has read it since 4.0
// replaced it with credentials.json. Upgraded profiles still carry it, so it is
// swept at boot (see sweepLegacyConfigFile). Kept next to the paths it belongs
// with, in the same style as toml.mjs's TMP_DIR.
export const LEGACY_CONFIG_PATH = join(DATA_DIR, 'dbhub.toml')

// ── injectable fs seam (storage writers only) ─────────────────────────────
//
// The storage writers are the SINGLE place that decides the on-disk modes, and
// on Windows those modes are simply ignored — so the only platform-independent
// way to pin "owner-only" is to observe the arguments handed to the primitives.
// Production always uses node:fs; `setFsHooks` swaps individual primitives for a
// recording stub in tests. Nothing else in this module reads the hooks.

const NODE_FS = { writeFileSync, mkdirSync, renameSync, chmodSync }
let fsHooks = NODE_FS

/**
 * Replace a subset of the file primitives used by the storage writers.
 * @param hooks - `{ writeFileSync?, mkdirSync?, renameSync?, chmodSync? }`, or
 *   `null` to restore node:fs. Unlisted primitives keep the real implementation.
 */
export function setFsHooks(hooks) {
  fsHooks = hooks ? { ...NODE_FS, ...hooks } : NODE_FS
}

// Ensure the storage directory exists once at load; every writer below
// (store, runtime, toml, managed dbhub prefix) assumes it is present. The mode
// is owner-only: this directory holds credentials.json (every stored DSN plus
// the SSH secrets), so another account on the same machine must not be able to
// even list it. Windows ignores the mode and relies on the profile ACL.
try {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
} catch (e) {
  /* best-effort */
}

/**
 * Re-apply the owner-only modes to the storage directory and the three JSON
 * documents. `mkdirSync(recursive)` does NOT change the mode of an existing
 * directory and never touches a file, so an UPGRADED profile kept whatever the
 * older build (or the process umask) left behind — a 0755 storage directory
 * next to 0644 DSNs. Best-effort by design: a filesystem that refuses chmod
 * must not break persistence, so a failure is reported once and never retried.
 * Windows has no POSIX mode to enforce (the profile ACL owns access) and the
 * call is skipped there.
 * @returns whether every enforced path now carries its owner-only mode.
 */
export function tightenStorageModes() {
  if (process.platform === 'win32') return true
  let ok = true
  const enforce = (path, mode, tag) => {
    const name = basename(path)
    try {
      if (!existsSync(path)) return
      fsHooks.chmodSync(path, mode)
    } catch (e) {
      ok = false
      warnOnce('mode:' + tag, currentT('log.modeTightenFail', {
        file: name,
        code: String((e && e.code) || 'unknown'),
      }))
    }
  }
  enforce(DATA_DIR, 0o700, 'dir')
  enforce(STORE_PATH, 0o600, 'store')
  enforce(RUNTIME_PATH, 0o600, 'runtime')
  enforce(PREFS_PATH, 0o600, 'prefs')
  return ok
}

// ── persistence (singleton store/runtime, shared by every module) ─────────

function readJsonFile(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (e) {
    return fallback
  }
}

// ── upgrade / robustness ──────────────────────────────────────────────────

const warningOnce = new Set()

/** Log one warning per reason (write failures can repeat on every call). */
export function warnOnce(tag, message) {
  if (warningOnce.has(tag)) return
  warningOnce.add(tag)
  console.warn('[dsh-dbhub-live] ' + message)
}

// One own data property at a time: a JSON key like "__proto__" must never
// mutate the object prototype during normalization.
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Clean one stored display-order array (`order`): strings only, trimmed,
 * de-duplicated, original order kept. Names of environments that no longer exist
 * are NOT dropped here — `workspaceOrderOf` filters those on every read, and the
 * write side replaces the array with a validated permutation.
 */
function normalizeOrderList(raw) {
  const out = []
  if (!Array.isArray(raw)) return out
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * Normalize a credentials document (per-workspace entries + the enabled
 * toggle) so legacy or hand-edited files cannot poison initialization.
 * Store model (v2): each workspace entry is `{ environments: { <env>: {
 * dsn, source?, updatedAt? } } }`; a v1 entry `{ dsn, source?, updatedAt? }`
 * is migrated into `environments.default` automatically. Non-boolean
 * `enabled`, non-object entries, empty-DSN entries and empty environment maps
 * are dropped; DSNs are trimmed. Unknown fields are preserved on BOTH levels
 * (workspace entry and environment entry) so a newer version's writes are never
 * stripped by an older loader (forward compatibility).
 * @param raw - parsed JSON document (any shape).
 * @returns the normalized plain object.
 */
export function normalizeStore(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (typeof raw.enabled === 'boolean') defineOwn(out, 'enabled', raw.enabled)

  const normalizeEnv = (env) => {
    const clean = {}
    if (!env || typeof env !== 'object' || Array.isArray(env)) return
    const dsn = typeof env.dsn === 'string' ? env.dsn.trim() : ''
    if (!dsn) return
    defineOwn(clean, 'dsn', dsn)
    if (typeof env.source === 'string' && env.source) defineOwn(clean, 'source', env.source)
    if (typeof env.updatedAt === 'number' && Number.isFinite(env.updatedAt)) {
      defineOwn(clean, 'updatedAt', env.updatedAt)
    }
    for (const [k, v] of Object.entries(env)) {
      if (k === 'dsn' || k === 'source' || k === 'updatedAt') continue
      defineOwn(clean, k, v) // forward-compatible unknown env fields
    }
    return clean
  }

  for (const [key, entry] of Object.entries(raw)) {
    if (key === 'enabled') continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (Object.prototype.hasOwnProperty.call(entry, 'environments')) {
      // v2: per-environment map
      const environments = {}
      if (entry.environments && typeof entry.environments === 'object' && !Array.isArray(entry.environments)) {
        for (const [env, envEntry] of Object.entries(entry.environments)) {
          const clean = normalizeEnv(envEntry)
          if (clean) defineOwn(environments, env, clean)
        }
      }
      if (Object.keys(environments).length > 0) {
        // Workspace-level unknown fields survive too, exactly like the
        // environment-level ones (see normalizeEnv above): a newer build may keep
        // per-workspace data next to `environments`, and load + one-time rewrite
        // must not strip it. Dropping them here made the writers' preservation
        // pointless — the next boot erased the field anyway.
        //
        // `order` is a KNOWN workspace field now (the display order of the
        // environments). It is cleaned here (strings only, trimmed, de-duplicated)
        // but NOT validated against the environment map: dropping names that no
        // longer exist is the write side's job (`workspaceOrderOf` filters them on
        // every read, `reorderWorkspace` replaces the array wholesale). Keeping the
        // raw entries means a downgrade/re-upgrade cannot silently reshuffle the
        // user's list.
        const clean = {}
        for (const [k, v] of Object.entries(entry)) {
          if (k === 'environments' || k === 'order') continue
          defineOwn(clean, k, v)
        }
        defineOwn(clean, 'environments', environments)
        if (Array.isArray(entry.order)) defineOwn(clean, 'order', normalizeOrderList(entry.order))
        defineOwn(out, key, clean)
      }
    } else {
      // v1 migration: a bare dsn entry becomes the 'default' environment
      const clean = normalizeEnv(entry)
      if (clean) defineOwn(out, key, { environments: { default: clean } })
    }
  }
  return out
}

/**
 * Full display order for one workspace's environments.
 *
 * The stored `order` is a HINT, never an authority: a hand-edited/migrated file
 * may name environments that no longer exist, or none at all. This resolves it to
 * an exact permutation of the CURRENT environment names — stored order first
 * (dropping unknown/duplicate/invalid entries), then every name the order forgot
 * appended in name order. That is also the "old data without order" fallback and
 * why callers never need to write a migration.
 *
 * Pure: takes the environment map and the raw order, returns a new array.
 * @param environments - `{ <env>: {...} }` map (the store's `environments`).
 * @param rawOrder - the stored `order` (any shape).
 * @returns every existing env name exactly once, in display order.
 */
export function workspaceOrderOf(environments, rawOrder) {
  const envs = environments && typeof environments === 'object' && !Array.isArray(environments)
    ? environments
    : {}
  const known = new Set(Object.keys(envs))
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(rawOrder) ? rawOrder : []) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!known.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  // Deterministic fallback for anything the stored order does not name yet.
  for (const name of Object.keys(envs).sort()) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * The current display order of one persisted workspace.
 * @param wsPath - workspace key of the store.
 * @returns every persisted environment name in display order ('' for unknown).
 */
export function workspaceOrder(wsPath) {
  const entry = store[wsPath]
  if (!entry || typeof entry !== 'object') return []
  return workspaceOrderOf(entry.environments, entry.order)
}

/**
 * List every persisted workspace environment as flat rows for the card.
 * Each row also carries the environment's options: `ro` (read-only), `ssh`
 * (the normalized tunnel config, SECRETS INCLUDED — this is host-side data and
 * every model/UI-facing copy goes through `describeEnvOptions`) and `maxRows`
 * (0 = unlimited).
 *
 * `dsnPasswordRef` is host-side too: it names the database password in the DSH
 * credential store (the store keeps no plaintext password for a split row).
 * @param store - the (normalized) credentials store.
 * @returns rows [{ wsPath, env, dsn, dsnPasswordRef?, source?, updatedAt?, ro, ssh, maxRows, persisted: true }].
 */
export function listWorkspaceEnvironments(store) {
  const rows = []
  for (const [wsPath, entry] of Object.entries(store || {})) {
    if (wsPath === 'enabled') continue
    if (!entry || typeof entry !== 'object' || !entry.environments || typeof entry.environments !== 'object') continue
    for (const [env, envEntry] of Object.entries(entry.environments)) {
      if (!envEntry || typeof envEntry.dsn !== 'string' || !envEntry.dsn.trim()) continue
      rows.push({
        wsPath,
        env,
        dsn: envEntry.dsn.trim(),
        ...(isDsnSecretRef(envEntry.dsnPasswordRef) ? { dsnPasswordRef: envEntry.dsnPasswordRef } : {}),
        ...(typeof envEntry.source === 'string' && envEntry.source ? { source: envEntry.source } : {}),
        ...(typeof envEntry.updatedAt === 'number' && Number.isFinite(envEntry.updatedAt) ? { updatedAt: envEntry.updatedAt } : {}),
        ro: readOnlyOf(envEntry),
        ssh: sshOf(envEntry),
        maxRows: maxRowsOf(envEntry),
        persisted: true,
      })
    }
  }
  return rows
}

// ── environment options: read-only + SSH tunnel (store model v3) ──────────
//
// v3 keeps the exact v2 layout and merely adds optional fields to an
// environment entry:
//   { dsn, source, updatedAt, readOnly?: true, ssh?: {…}, maxRows?: N }
//
// `maxRows` is DEPRECATED: it was the per-environment result row cap and is now
// ignored by execution (the cap is the global `options.defaultMaxRows`). It is
// still accepted and preserved so (a) an older file keeps loading unchanged and
// (b) a downgrade does not silently lose the value. THIS BUILD NEVER WRITES IT
// on a new connection — see `applyOptionsOp` / `displayEnvOptions`.
// Compatibility is structural, not versioned: `normalizeStore` already
// preserves unknown env fields (so an older build reading a v3 file keeps the
// new keys instead of stripping them), and a v2 file simply reads back as
// "not read-only, no tunnel".
//
// SSH secrets (`password`, `passphrase`) no longer live in this file when the
// host offers the DSH credentials service: the store keeps only a REFERENCE
// (`passwordRef` / `passphraseRef`, an environment-variable-shaped name) and the
// value itself lives in the DSH-managed credential document (by default
// `$DSH_HOME/.credentials.yaml`). `dsn` keeps its old trust model (same file,
// owner-only mode) — only the SSH tunnel secrets moved.
//
// The plugin NEVER reads or writes that credential document itself: it only
// calls the optional `credentials` Cordis service (`ctx.get('credentials')`,
// resolved fresh on every operation — never cached). When the service is
// unavailable, the writers fall back to the pre-6.0 plaintext layout so an older
// host keeps working; the boot-time migration does the same (skip + warn once).

/** Longest accepted values (a hand-edited file cannot inject a huge blob). */
const SSH_LIMITS = { host: 255, user: 128, keyPath: 1024, secret: 512, proxyJump: 1024 }

/** The env-var-shaped name prefix every SSH secret reference carries. */
export const SSH_SECRET_REF_PREFIX = 'DSH_DBHUB_SSH_'

/** The credential ref must be usable as an environment variable name. */
const SECRET_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Fields whose value is a secret, and the reference that replaces it. */
export const SSH_SECRET_FIELDS = [
  ['password', 'passwordRef'],
  ['passphrase', 'passphraseRef'],
]

/** A fresh reference name: random, workspace-independent, never reused. */
export function newSshSecretRef() {
  // 5 bytes → 10 lowercase hex characters (the documented 8–12 range).
  return SSH_SECRET_REF_PREFIX + randomBytes(5).toString('hex')
}

/** True for a value this build is willing to treat as a credential reference. */
export function isSshSecretRef(value) {
  return typeof value === 'string'
    && value.length > SSH_SECRET_REF_PREFIX.length
    && value.length <= SSH_LIMITS.secret
    && value.startsWith(SSH_SECRET_REF_PREFIX)
    && SECRET_REF_RE.test(value)
}

/** Every credential reference one stored/normalized SSH block carries. */
export function sshSecretRefsOf(ssh) {
  const out = []
  if (!ssh || typeof ssh !== 'object' || Array.isArray(ssh)) return out
  for (const [, refField] of SSH_SECRET_FIELDS) {
    if (isSshSecretRef(ssh[refField]) && out.indexOf(ssh[refField]) < 0) out.push(ssh[refField])
  }
  return out
}

/**
 * The optional DSH credentials service, read fresh from the context.
 *
 * It is a `ctx.get(...)` optional service by contract: a headless/SDK host (or
 * an older DSH) simply has none, and every caller must degrade instead of
 * failing. Never cache the result across operations — DSH re-resolves secrets on
 * every call, and a service can appear after this fiber started.
 */
export function credentialsOf(ctx) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  } catch (e) {
    return undefined
  }
}

/**
 * Error for "the reference exists but its value is gone".
 *
 * This must NEVER be downgraded to an empty password: an empty SSH secret turns a
 * missing credential into a misleading "authentication failed" report. Carries
 * `code === 'sshSecretMissing'` so the command layer can answer in the user's
 * language; no payload is attached (a ref is not a secret, but nothing about this
 * failure needs one).
 */
export function sshSecretMissingError() {
  const err = new Error('ssh secret is no longer present in the credential store')
  err.code = 'sshSecretMissing'
  return err
}

/**
 * Replace a secret reference with its real value, for ONE host-side operation.
 *
 * The returned block is a copy; the stored block is never mutated. Plaintext
 * legacy blocks (no ref) pass through untouched, which is what keeps a host
 * without the credentials service fully working.
 *
 * @param creds - the credentials service (or undefined).
 * @param ssh - the stored/normalized SSH block.
 * @returns a new block carrying `password` / `passphrase` values.
 * @throws `code:'sshSecretMissing'` when a ref cannot be resolved.
 */
export async function resolveSshSecrets(creds, ssh) {
  if (!ssh || typeof ssh !== 'object' || Array.isArray(ssh)) return ssh
  const refs = sshSecretRefsOf(ssh)
  if (refs.length === 0) return ssh
  if (!creds || typeof creds.resolve !== 'function') throw sshSecretMissingError()
  const out = { ...ssh }
  for (const [field, refField] of SSH_SECRET_FIELDS) {
    const ref = out[refField]
    if (!isSshSecretRef(ref)) continue
    let resolved
    try {
      resolved = await creds.resolve(ref)
    } catch (e) {
      // A throwing resolve is the same outcome as a missing one: the value is
      // not available, and guessing (empty string) would produce a bogus auth
      // failure instead of an actionable message.
      throw sshSecretMissingError()
    }
    const value = resolved && typeof resolved.value === 'string' ? resolved.value : ''
    if (!value) throw sshSecretMissingError()
    out[field] = value
    delete out[refField]
  }
  return out
}

/**
 * Resolve one connection descriptor `{ dsn, ro, ssh, dsnPasswordRef? }` for
 * execution/probing.
 *
 * The database password is looked up EVERY time (never cached): the credential
 * document may be replaced or deleted between two calls, and a joined DSN is
 * plaintext that must not outlive the operation. The join is byte-exact — the
 * store keeps the DSN with the password taken out, so `dsn` here is exactly what
 * the user originally saved.
 *
 * @throws `code:'sshSecretMissing'` when a tunnel credential cannot be resolved,
 *   `code:'dsnSecretMissing'` when the database password is gone.
 */
export async function resolveEnvSecrets(creds, conn) {
  const c = conn && typeof conn === 'object' ? conn : { dsn: String(conn || '') }
  let dsn = typeof c.dsn === 'string' ? c.dsn.trim() : ''
  const dsnRef = c.dsnPasswordRef
  if (isDsnSecretRef(dsnRef)) {
    if (!creds || typeof creds.resolve !== 'function') throw dsnSecretMissingError()
    let resolved
    try {
      resolved = await creds.resolve(dsnRef)
    } catch (e) {
      // A throwing resolve is the same outcome as a missing one: guessing (an
      // empty password) would turn "the credential was deleted" into a misleading
      // authentication failure.
      throw dsnSecretMissingError()
    }
    const value = resolved && typeof resolved.value === 'string' ? resolved.value : ''
    if (!value) throw dsnSecretMissingError()
    const joined = joinDsnPassword(dsn, value)
    // A reference without a place to put its value means the store row changed
    // under the ref: fail closed instead of spawning without the password.
    if (joined === null) throw dsnSecretMissingError()
    dsn = joined
  }
  const ssh = c.ssh ? await resolveSshSecrets(creds, c.ssh) : null
  return { dsn, ro: c.ro === true, ssh }
}

/**
 * Encrypt any plaintext secret in an SSH block that is about to be stored.
 *
 * Order is the security property: `creds.set(ref, value)` must SUCCEED before the
 * store is allowed to hold only the ref. This helper returns the block to write —
 * the caller writes the store afterwards, so a failed `set` never leaves a ref
 * without a value.
 *
 * When the credentials service is unavailable (or the write throws) the secret is
 * kept as plaintext and the writer proceeds: that is the documented degradation
 * path for hosts without the service, and it must not break a working tunnel.
 * A blank/omitted secret field is left exactly as it is, which is how
 * "blank = keep the stored value" survives: the caller's merge carries the old
 * ref through, so nothing is re-encrypted and nothing is unset here.
 */
export async function encryptSshSecrets(creds, ssh) {
  if (!ssh || typeof ssh !== 'object' || Array.isArray(ssh)) return ssh
  const out = { ...ssh }
  const service = creds && typeof creds.set === 'function' ? creds : null
  for (const [field, refField] of SSH_SECRET_FIELDS) {
    const value = out[field]
    if (typeof value !== 'string' || value === '') continue
    if (!service) {
      warnOnce('cred-unavailable', currentT('log.credUnavailable'))
      continue
    }
    const ref = newSshSecretRef()
    try {
      await service.set(ref, value)
    } catch (e) {
      warnOnce('cred-write-failed', currentT('log.secretStoreFailed', {
        code: String((e && e.code) || 'unknown'),
      }))
      continue
    }
    delete out[field]
    out[refField] = ref
  }
  return out
}

// ── database password: split out of the DSN, stored in the credential service ─
//
// dbhub's TOML has exactly ONE connection field (`dsn`) and `${VAR}` interpolation
// works for ANY value, so this plugin keeps using a DSN — but the password part of
// it moves into the DSH credential store and the store keeps only
// `dsnPasswordRef`. The value is joined back into the DSN for each operation,
// exactly like the SSH secrets (see resolveEnvSecrets).
//
// The split is a PURE, byte-exact operation: `joinDsnPassword(split.dsn,
// split.password)` must reproduce the input exactly. Anything else (an exotic
// dialect, a property string carrying two DIFFERENT passwords, a shape whose
// value cannot be put back verbatim, …) is left ALONE and reported once — a lossy
// split would build a DSN that no longer points at the same target, which is far
// worse than a password that stays in the owner-only connection file.

/** The env-var-shaped prefix every database-password reference carries. */
export const DSN_SECRET_REF_PREFIX = 'DSH_DBHUB_DSN_'

/**
 * Marker that stands where a PROPERTY-style password value used to be. It only
 * ever exists in the stored DSN; `joinDsnPassword` replaces it before the DSN
 * leaves the Host, so it can never reach dbhub (and if it somehow did, dbhub
 * would fail to authenticate — it is not a secret either way).
 */
export const DSN_PASSWORD_PLACEHOLDER = '${DSH_DBHUB_DSN}'

/** A fresh database-password reference: random, workspace-independent, never reused. */
export function newDsnSecretRef() {
  return DSN_SECRET_REF_PREFIX + randomBytes(5).toString('hex')
}

/** True for a value this build is willing to treat as a database-password reference. */
export function isDsnSecretRef(value) {
  return typeof value === 'string'
    && value.length > DSN_SECRET_REF_PREFIX.length
    && value.length <= SSH_LIMITS.secret
    && value.startsWith(DSN_SECRET_REF_PREFIX)
    && SECRET_REF_RE.test(value)
}

/**
 * Error for "the reference exists but its value is gone".
 *
 * NEVER downgraded to an empty password: dbhub would report a misleading
 * authentication failure (or, for a passwordless server, silently connect to the
 * wrong identity) while the real cause — a deleted credential — never surfaces.
 * Carries `code === 'dsnSecretMissing'`; no payload is attached.
 */
export function dsnSecretMissingError() {
  const err = new Error('the database password is no longer present in the credential store')
  err.code = 'dsnSecretMissing'
  return err
}

/** `{ start, end }` of the authority of a URL-shaped DSN (`scheme://…`), or undefined. */
function urlAuthorityOf(raw) {
  const schemeAt = raw.indexOf('://')
  if (schemeAt < 0) return undefined
  const start = schemeAt + 3
  let end = raw.length
  for (const sep of ['/', '?', '#']) {
    const at = raw.indexOf(sep, start)
    if (at >= 0 && at < end) end = at
  }
  return { start, end }
}

/** Index of the `@` that closes the userinfo, or -1. */
function urlUserinfoEnd(raw) {
  const authority = urlAuthorityOf(raw)
  if (!authority) return -1
  const at = raw.lastIndexOf('@', authority.end - 1)
  return at >= authority.start ? at : -1
}

/** Index just past a quoted span starting at `start` (a doubled quote stays inside). */
function skipQuoted(text, start) {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return text.length
}

/**
 * Split the password out of a URL-shaped DSN, RAW (never decode/re-encode).
 *
 * Only the authority's `user:password@` takes part: the user info keeps its user
 * and `@`, the password is the byte sequence between the first `:` of the
 * userinfo and the `@` that closes it. Encoding is preserved verbatim, which is
 * what makes the reverse operation exact.
 * @returns `{ dsn, password }` or `null`.
 */
function splitUrlPassword(raw) {
  const authority = urlAuthorityOf(raw)
  const at = urlUserinfoEnd(raw)
  if (!authority || at < 0) return null
  const colon = raw.indexOf(':', authority.start)
  if (colon < 0 || colon >= at) return null
  const user = raw.slice(authority.start, colon)
  const password = raw.slice(colon + 1, at)
  if (!user || !password) return null
  return { dsn: raw.slice(0, colon) + raw.slice(at), password }
}

/** One property-list split: the replacements and the (single) value. */
function splitPropertyPassword(raw) {
  const spans = []
  let i = 0
  while (i <= raw.length) {
    // One `;`-separated segment (a `;` inside a quoted value does not split).
    let j = i
    while (j < raw.length) {
      const ch = raw[j]
      if (ch === '"' || ch === "'") {
        j = skipQuoted(raw, j)
        continue
      }
      if (ch === ';') break
      j += 1
    }
    let eq = -1
    for (let k = i; k < j; k++) {
      const ch = raw[k]
      if (ch === '"' || ch === "'") {
        k = skipQuoted(raw, k) - 1
        continue
      }
      if (ch === '=') {
        eq = k
        break
      }
    }
    if (eq >= 0) {
      const key = raw.slice(i, eq).trim()
      if (/^(?:password|passwd|pwd)$/i.test(key)) {
        const rawValue = raw.slice(eq + 1, j)
        const token = rawValue.trim()
        // An empty value (or an empty quoted value) is not a secret.
        if (token && token !== '""' && token !== "''") {
          const lead = rawValue.length - rawValue.trimStart().length
          spans.push({ start: eq + 1 + lead, end: eq + 1 + lead + token.length, token })
        }
      }
    }
    i = j + 1
  }
  if (spans.length === 0) return null
  // ONE reference carries ONE value: two credential fields may only share it when
  // they already carry the same bytes. Different values cannot be represented,
  // so the whole split is refused instead of keeping one of them in plaintext.
  const value = spans[0].token
  if (spans.some((span) => span.token !== value)) return null
  let dsn = raw
  for (let k = spans.length - 1; k >= 0; k--) {
    const span = spans[k]
    dsn = dsn.slice(0, span.start) + DSN_PASSWORD_PLACEHOLDER + dsn.slice(span.end)
  }
  return { dsn, password: value }
}

/**
 * Split the password out of one DSN, if that can be done SAFELY.
 *
 * Two supported shapes:
 *   · URL — `scheme://[user[:password]@]host[:port]/db?params`: only the
 *     authority's `user:password@` is touched, raw bytes preserved;
 *   · ADO/JDBC properties — `Server=…;User Id=…;Password=…;Encrypt=true` (also
 *     `pwd` / `passwd`, any case): the password VALUE token is replaced with
 *     `DSN_PASSWORD_PLACEHOLDER`.
 *
 * Deliberately conservative: a DSN that is already split, or a URL that ALSO
 * carries a `;password=` property pair (one reference cannot represent both), or
 * anything whose rejoin is not byte-identical is returned as "no split". Callers
 * keep such a DSN untouched and warn once.
 * @returns `{ dsn, password }` — `dsn` never contains the password — or `null`.
 */
export function splitDsnPassword(dsn) {
  const raw = String(dsn === undefined || dsn === null ? '' : dsn)
  if (!raw) return null
  // Already split (or a hand-written placeholder): never split twice.
  if (raw.indexOf(DSN_PASSWORD_PLACEHOLDER) >= 0) return null
  const urlAt = raw.indexOf('://')
  const eqAt = raw.indexOf('=')
  const propertyLike = eqAt >= 0 && (urlAt < 0 || eqAt < urlAt)
  let split = null
  if (propertyLike) {
    split = splitPropertyPassword(raw)
  } else if (urlAt >= 0) {
    // A URL whose tail is a property list (`sqlserver://h;user=u;password=p`):
    // the authority and the properties would each need their own secret, which
    // one reference cannot express. Refuse the whole row rather than half of it.
    if (/;\s*(?:password|passwd|pwd)\s*=/i.test(raw)) return null
    split = splitUrlPassword(raw)
  }
  if (!split) return null
  // THE safety gate (D-2): a split that cannot be rejoined byte-for-byte is
  // discarded. Never ship a DSN that is "almost" the one the user saved.
  if (joinDsnPassword(split.dsn, split.password) !== raw) return null
  return split
}

/**
 * Put a stored DSN and its password back together, byte-exactly.
 *
 * Property form: replace every placeholder with the raw value token (the token
 * may be quoted — that is why it is stored verbatim). URL form: insert
 * `:<password>` immediately before the `@` that closes the userinfo, which is the
 * exact position the split removed it from.
 * @returns the full DSN, or `null` when there is nowhere to put the password.
 */
export function joinDsnPassword(dsn, password) {
  const raw = String(dsn === undefined || dsn === null ? '' : dsn)
  const value = String(password === undefined || password === null ? '' : password)
  if (raw.indexOf(DSN_PASSWORD_PLACEHOLDER) >= 0) {
    return raw.split(DSN_PASSWORD_PLACEHOLDER).join(value)
  }
  const at = urlUserinfoEnd(raw)
  if (at < 0) return null
  return raw.slice(0, at) + ':' + value + raw.slice(at)
}

/**
 * True when a DSN STILL carries a database password (i.e. it was never split).
 *
 * Used for two things: deciding whether an unsplittable shape deserves the
 * one-time "cannot be split safely" warning, and flagging the row on the card
 * (a persisted row whose password is still in the connection file must be
 * visible — the user asked for the values to live in the credential store).
 * A placeholder or a password-less DSN is NOT flagged.
 */
export function dsnHasInlinePassword(dsn) {
  const raw = String(dsn === undefined || dsn === null ? '' : dsn)
  if (!raw) return false
  if (raw.indexOf(DSN_PASSWORD_PLACEHOLDER) >= 0) return false
  if (passwordOf(raw) !== undefined) return true
  return /(?:^|;)\s*(?:password|passwd|pwd)\s*=\s*(?!\s*(?:;|$))[^;]+/i.test(raw)
}

/**
 * Split the password out of a DSN that is about to be stored, and move the value
 * into the credential service FIRST.
 *
 * Order is the security property (same as `encryptSshSecrets`): the store may only
 * keep the reference after `creds.set(ref, value)` SUCCEEDED. Returns the DSN to
 * write plus the reference to carry — or the ORIGINAL DSN untouched when the
 * split cannot be done safely or the credential service cannot take the value
 * (the documented degradation: a working connection is never broken).
 *
 * @returns `{ dsn, dsnPasswordRef? }`.
 */
export async function encryptDsnPassword(creds, dsn) {
  const raw = String(dsn === undefined || dsn === null ? '' : dsn)
  const split = splitDsnPassword(raw)
  if (!split) {
    if (dsnHasInlinePassword(raw)) warnOnce('dsn-unsplit', currentT('log.dsnUnsplit'))
    return { dsn: raw }
  }
  const service = creds && typeof creds.set === 'function' ? creds : null
  if (!service) {
    warnOnce('dsn-cred-unavailable', currentT('log.dsnCredUnavailable'))
    return { dsn: raw }
  }
  const ref = newDsnSecretRef()
  try {
    await service.set(ref, split.password)
  } catch (e) {
    warnOnce('dsn-cred-write-failed', currentT('log.dsnSecretStoreFailed', {
      code: String((e && e.code) || 'unknown'),
    }))
    return { dsn: raw }
  }
  return { dsn: split.dsn, dsnPasswordRef: ref }
}

// Boot-time migration: plaintext secrets written by older builds move into the
// credential service. TWO kinds are migrated, independently:
//   · SSH login passwords / key passphrases (live under `row.ssh`);
//   · a database password still embedded in `row.dsn` (5.x / 6.0.0-dev rows —
//     before D-1 the DSN carried it exactly like the old SSH fields did).
// Idempotent by construction — a row that already carries the corresponding ref
// is skipped, so a second run performs no `set` and rewrites nothing. Any failure
// (service missing, `set` throwing) keeps the plaintext and only warns once: a
// working connection must never be broken by a migration. ORDER: `creds.set`
// succeeds first, the live store row is rewritten afterwards.

/** Every credential reference the CURRENT store still references. */
function storedSecretRefs() {
  const refs = new Set()
  for (const row of listWorkspaceEnvironments(store)) {
    for (const ref of sshSecretRefsOf(row.ssh)) refs.add(ref)
    if (isDsnSecretRef(row.dsnPasswordRef)) refs.add(row.dsnPasswordRef)
  }
  return refs
}

/**
 * Drop references that no stored row uses any more (best effort).
 *
 * Called AFTER the store write that replaced/removed the row: a ref that is still
 * shared by another row (copyFrom shares, it never duplicates) is kept, and a ref
 * that cannot be unset only produces one warning. The secret VALUE is never
 * logged; the ref name is metadata and may appear.
 * @param creds - the credentials service (or undefined).
 * @param refs - one reference or a list of them.
 */
export async function releaseSecretRefs(creds, refs) {
  const list = Array.isArray(refs) ? refs : [refs]
  const wanted = new Set(list.filter((ref) => isSshSecretRef(ref) || isDsnSecretRef(ref)))
  if (wanted.size === 0) return
  const service = creds && typeof creds.unset === 'function' ? creds : null
  if (!service) return
  const inUse = storedSecretRefs()
  for (const ref of wanted) {
    if (inUse.has(ref)) continue
    try {
      await service.unset(ref)
    } catch (e) {
      warnOnce('cred-unset-failed', currentT('log.secretReleaseFailed', {
        code: String((e && e.code) || 'unknown'),
      }))
    }
  }
}

/**
 * Drop the SSH references of the blocks a write replaced/removed.
 * @param creds - the credentials service (or undefined).
 * @param blocks - one SSH block, or a list of them.
 */
export async function releaseSshSecrets(creds, blocks) {
  const list = Array.isArray(blocks) ? blocks : [blocks]
  const refs = []
  for (const block of list) for (const ref of sshSecretRefsOf(block)) refs.push(ref)
  await releaseSecretRefs(creds, refs)
}

/**
 * Drop one database-password reference when no stored row uses it any more.
 * @param creds - the credentials service (or undefined).
 * @param ref - the reference of the row that was replaced/removed.
 */
export async function releaseDsnSecret(creds, ref) {
  if (!isDsnSecretRef(ref)) return
  await releaseSecretRefs(creds, [ref])
}

let secretMigrationInFlight
// A boot-time migration that ran before DSH mounted `credentials` used to be the
// last word: nothing polled, so an upgraded install kept its old plaintext rows
// inline while NEW writes got references (a mixed store — caught by the
// cross-version upgrade tier). The skipped run leaves a flag instead, and the
// host re-attempts the same idempotent migration the next time it already has a
// reason to run (a card write, a state publish). No timer: a budget-timer guard
// forbids unref'd timers in this module, and a referenced one would hold the
// process open for no benefit.
let secretMigrationSkipped = false
/**
 * Whether a skipped migration is still waiting for the credentials service.
 * @returns true until one run actually reached the service.
 */
export function secretMigrationPending() {
  return secretMigrationSkipped
}

/**
 * Move secrets written by older builds into the DSH credential service.
 * @param creds - the credentials service (or undefined when DSH has not mounted it yet).
 */
export function migrateSecrets(creds) {
  if (secretMigrationInFlight) return secretMigrationInFlight
  const run = (async () => {
    const service = creds && typeof creds.set === 'function' ? creds : null
    if (service) secretMigrationSkipped = false
    if (!service) {
      warnOnce('cred-unavailable', currentT('log.credUnavailable'))
      secretMigrationSkipped = true
      return { migrated: 0, migratedDsn: 0, skipped: true }
    }
    let migrated = 0
    let migratedDsn = 0
    let failed = false
    let failedDsn = false
    let unsplit = false
    for (const wsPath of Object.keys(store)) {
      if (wsPath === 'enabled') continue
      const entry = store[wsPath]
      const environments = entry && typeof entry === 'object' ? entry.environments : undefined
      if (!environments || typeof environments !== 'object') continue
      for (const env of Object.keys(environments)) {
        // ── SSH login password / key passphrase ──
        const row = environments[env]
        const ssh = row && typeof row === 'object' ? row.ssh : undefined
        if (ssh && typeof ssh === 'object' && !Array.isArray(ssh)) {
          for (const [field, refField] of SSH_SECRET_FIELDS) {
            const value = ssh[field]
            if (typeof value !== 'string' || value === '') continue
            if (isSshSecretRef(ssh[refField])) continue // already migrated: skip
            const ref = newSshSecretRef()
            try {
              await service.set(ref, value)
            } catch (e) {
              failed = true
              continue
            }
            // Re-read the LIVE row after the await: a concurrent card write may have
            // replaced the entry, and it must not be overwritten with a stale copy.
            const liveEntry = store[wsPath] && typeof store[wsPath] === 'object' ? store[wsPath].environments : undefined
            const live = liveEntry && typeof liveEntry === 'object' ? liveEntry[env] : undefined
            const liveSsh = live && typeof live === 'object' ? live.ssh : undefined
            if (!liveSsh || typeof liveSsh !== 'object' || liveSsh[field] !== value) continue
            delete liveSsh[field]
            liveSsh[refField] = ref
            migrated++
          }
        }
        // ── database password still inside the DSN ──
        const liveRow = store[wsPath] && typeof store[wsPath] === 'object'
          ? store[wsPath].environments[env]
          : undefined
        if (!liveRow || typeof liveRow !== 'object') continue
        if (typeof liveRow.dsn !== 'string' || !liveRow.dsn.trim()) continue
        if (isDsnSecretRef(liveRow.dsnPasswordRef)) continue // already migrated: skip
        const originalDsn = liveRow.dsn
        const split = splitDsnPassword(originalDsn)
        if (!split) {
          if (dsnHasInlinePassword(originalDsn)) unsplit = true
          continue
        }
        const ref = newDsnSecretRef()
        try {
          await service.set(ref, split.password)
        } catch (e) {
          failedDsn = true
          continue
        }
        // Same live re-read as above: an in-flight card write wins.
        const afterEnvs = store[wsPath] && typeof store[wsPath] === 'object' ? store[wsPath].environments : undefined
        const after = afterEnvs && typeof afterEnvs === 'object' ? afterEnvs[env] : undefined
        if (!after || typeof after !== 'object' || after.dsn !== originalDsn) continue
        after.dsn = split.dsn
        after.dsnPasswordRef = ref
        migratedDsn++
      }
    }
    if (migrated > 0 || migratedDsn > 0) saveStore(store)
    if (failed) warnOnce('secret-migrate-failed', currentT('log.secretMigrateFailed'))
    if (failedDsn) warnOnce('dsn-migrate-failed', currentT('log.dsnSecretMigrateFailed'))
    if (unsplit) warnOnce('dsn-unsplit', currentT('log.dsnUnsplit'))
    return { migrated, migratedDsn, skipped: false }
  })()
  secretMigrationInFlight = run.finally(() => {
    secretMigrationInFlight = undefined
  })
  return secretMigrationInFlight
}

/**
 * Backwards-compatible name for `migrateSecrets` (the boot migration used to move
 * SSH secrets only, and older call sites/tests still use this name).
 */
export function migrateSshSecrets(creds) {
  return migrateSecrets(creds)
}

function sshText(value, max) {
  const raw = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!raw) return ''
  return raw.slice(0, max)
}

/** Integer port in 1..65535, or the default. */
function sshPort(value, fallback) {
  const n = Number(String(value === undefined || value === null ? '' : value).trim())
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback
  return n
}

/**
 * Number of hops a ProxyJump list names. dbhub's `ssh_proxy_jump` is a
 * comma-separated ProxyJump list that SHARES one credential set across every
 * hop, so a real multi-hop route (different credentials per jump host) cannot
 * be expressed — this plugin supports single-hop only and says so.
 */
export function sshProxyJumpHops(value) {
  const raw = sshText(value, SSH_LIMITS.proxyJump)
  if (!raw) return 0
  return raw.split(',').map((s) => s.trim()).filter(Boolean).length
}

/**
 * Normalize one SSH tunnel block. Returns `null` for anything that cannot be
 * used (missing host/user, unknown auth kind, a missing credential for the
 * chosen kind, a multi-hop ProxyJump, …) — the caller turns that into a
 * localized, actionable message.
 *
 * Secrets are carried verbatim: they were either typed in the UI dialog or are
 * being preserved from the stored entry. A stored entry may instead carry a
 * credential REFERENCE (`passwordRef` / `passphraseRef`) — the value then lives
 * in the DSH credential service and is resolved only for the operation that needs
 * it (see `resolveSshSecrets`).
 *
 * @param raw - `{ host, port?, user, auth, keyPath?, password?, passphrase?, passwordRef?, passphraseRef?, proxyJump? }`.
 * @returns the normalized block, or `null`.
 */
export function normalizeSshOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const host = sshText(raw.host, SSH_LIMITS.host)
  const user = sshText(raw.user, SSH_LIMITS.user)
  if (!host || !user) return null
  const auth = raw.auth === 'password' ? 'password' : raw.auth === 'key' ? 'key' : ''
  if (!auth) return null
  const out = { host, port: sshPort(raw.port, 22), user, auth }
  const proxyJump = sshText(raw.proxyJump, SSH_LIMITS.proxyJump)
  if (sshProxyJumpHops(proxyJump) > 1) return null
  if (proxyJump) out.proxyJump = proxyJump
  if (auth === 'key') {
    const keyPath = sshText(raw.keyPath, SSH_LIMITS.keyPath)
    if (!keyPath) return null
    out.keyPath = keyPath
    const passphrase = String(raw.passphrase === undefined || raw.passphrase === null ? '' : raw.passphrase)
    if (passphrase) out.passphrase = passphrase.slice(0, SSH_LIMITS.secret)
    else if (isSshSecretRef(raw.passphraseRef)) out.passphraseRef = raw.passphraseRef
  } else {
    const password = String(raw.password === undefined || raw.password === null ? '' : raw.password)
    if (password) out.password = password.slice(0, SSH_LIMITS.secret)
    else if (isSshSecretRef(raw.passwordRef)) out.passwordRef = raw.passwordRef
    else return null
  }
  return out
}

/** The stored read-only flag of one environment entry (`false` when unset). */
export function readOnlyOf(envEntry) {
  return !!(envEntry && typeof envEntry === 'object' && envEntry.readOnly === true)
}

/** The stored, normalized SSH block of one environment entry (or null). */
export function sshOf(envEntry) {
  if (!envEntry || typeof envEntry !== 'object') return null
  return normalizeSshOptions(envEntry.ssh)
}

/**
 * Strict integer parse of a caller-supplied row cap.
 *
 * `undefined` means "not a usable value": negative, fractional, `NaN`, a
 * non-numeric string, or anything past the safe-integer range. An OMITTED value
 * is also `undefined` — the CALLER owns the difference between "keep what is
 * stored" (field absent) and "clear it" (`0`), exactly like `readOnly` / `ssh`.
 *
 * Numeric strings are accepted because the card's input is text and a
 * hand-written `/op` payload may carry `"200"`; nothing else is coerced.
 * @returns a non-negative integer, or `undefined` when unusable.
 */
export function parseMaxRows(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^\d+$/.test(text)) return undefined
    const n = Number(text)
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined
  }
  return undefined
}

/**
 * The stored maximum-row cap of one environment entry.
 *
 * DEPRECATED: execution no longer consults this value (the cap is the global
 * `options.defaultMaxRows`). It is still reported so an old file stays readable
 * and a downgrade keeps its value; `0` means "no cap" — and that is ALSO where a
 * hand-edited/invalid stored value degrades, because an unusable cap must never
 * become a one-row result.
 */
export function maxRowsOf(envEntry) {
  const cap = parseMaxRows(envEntry && typeof envEntry === 'object' ? envEntry.maxRows : undefined)
  return cap === undefined ? 0 : cap
}

/**
 * The identity file an SSH client falls back to when none is given — the same
 * value the UI shows as the key-path placeholder.
 */
export const DEFAULT_SSH_KEY_PATH = '~/.ssh/id_ed25519'

/**
 * Fill the conventional identity path into a key-auth block that names none.
 *
 * Without this a key-auth tunnel with a blank path is simply UNUSABLE
 * (`normalizeSshOptions` rejects it), so the placeholder the field shows would be
 * a promise the plugin never keeps. Applied at the last step of a merge and right
 * before an SSH-layer test, never to a block that already names a path.
 * @returns the same object when nothing was filled (identity check is meaningful).
 */
export function withDefaultSshKey(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block
  if (block.auth !== 'key') return block
  const named = block.keyPath !== undefined && block.keyPath !== null && String(block.keyPath).trim() !== ''
  if (named) return block
  return Object.assign({}, block, { keyPath: DEFAULT_SSH_KEY_PATH })
}

/**
 * Merge an incoming tunnel block with the stored one, implementing the
 * "blank secret = keep the stored value" rule for the BROWSER path.
 *
 * The UI can never echo a secret back (the mirror only carries
 * `hasPassword`/`hasPassphrase`/`keyReady`), so a user who edits only the host —
 * or presses "test the tunnel" on a saved row — sends a block without a
 * password. Normalizing that directly would reject it, which is why the COMMAND
 * layer merges first (the model path does the same in `tools.mjs`).
 *
 * Non-secret fields overwrite (a blank one falls back to the stored value so the
 * merge cannot produce an unusable block); switching the auth kind drops the
 * other kind's secret.
 *
 * A stored secret may be plaintext (legacy) or a credential reference
 * (`passwordRef` / `passphraseRef`). Either form is carried through when the
 * caller leaves the field blank, so "blank = keep the stored value" keeps working
 * after the secret moved into the credential service — and nothing is re-encrypted
 * or unset by a merge.
 *
 * @param incoming - the block from the card (secrets possibly blank/omitted).
 * @param storedRaw - the stored raw block (or null).
 * @returns the merged raw block (still to be normalized/validated).
 */
export function mergeSshOptions(incoming, storedRaw) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
  const prev = normalizeSshOptions(storedRaw)
  const filled = (v) => v !== undefined && v !== null && String(v).trim() !== ''
  /** Carry a secret: typed value > typed ref > stored value > stored ref. */
  const secretOf = (field, refField, sameKind, target) => {
    if (filled(incoming[field])) target[field] = incoming[field]
    else if (filled(incoming[refField])) target[refField] = incoming[refField]
    else if (sameKind && filled(prev[field])) target[field] = prev[field]
    else if (sameKind && filled(prev[refField])) target[refField] = prev[refField]
  }
  const auth = incoming.auth === 'password' || incoming.auth === 'key'
    ? incoming.auth
    : (prev ? prev.auth : '')
  const merged = {
    host: filled(incoming.host) ? incoming.host : (prev ? prev.host : ''),
    port: filled(incoming.port) ? incoming.port : (prev ? prev.port : 22),
    user: filled(incoming.user) ? incoming.user : (prev ? prev.user : ''),
    auth,
    proxyJump: incoming.proxyJump !== undefined && incoming.proxyJump !== null
      ? incoming.proxyJump
      : (prev ? prev.proxyJump || '' : ''),
  }
  if (auth === 'key') {
    const sameKind = !!(prev && prev.auth === 'key')
    const keyPath = filled(incoming.keyPath) ? incoming.keyPath : (sameKind ? prev.keyPath : '')
    if (keyPath) merged.keyPath = keyPath
    secretOf('passphrase', 'passphraseRef', sameKind, merged)
  } else if (auth === 'password') {
    const sameKind = !!(prev && prev.auth === 'password')
    secretOf('password', 'passwordRef', sameKind, merged)
  }
  return withDefaultSshKey(merged)
}

/** Expand a leading `~/` the way dbhub does, for local key-existence checks. */
export function expandHome(p) {
  const raw = String(p || '')
  if (!raw.startsWith('~/') && !raw.startsWith('~\\')) return raw
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) return raw
  return join(home, raw.slice(2))
}

/**
 * Secret-free description of an environment's options. This is the ONLY shape
 * the browser mirror and the model-facing surface may see: booleans for "does a
 * secret exist" and never the secret itself, and never the key PATH either
 * (only whether it resolves to a readable file).
 */
export function describeEnvOptions(envEntry) {
  const ro = readOnlyOf(envEntry)
  // The row cap is configuration, not a secret: the card needs the value to
  // prefill its input, and `0` is the documented "unlimited" default.
  const maxRows = maxRowsOf(envEntry)
  const ssh = sshOf(envEntry)
  if (!ssh) return { ro, ssh: null, maxRows }
  let keyReady = false
  if (ssh.auth === 'key') {
    try {
      keyReady = !!ssh.keyPath && existsSync(expandHome(ssh.keyPath))
    } catch (e) {
      keyReady = false
    }
  }
  return {
    ro,
    maxRows,
    ssh: {
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      authKind: ssh.auth,
      // A credential may be plaintext (legacy) or a reference to the DSH
      // credential service; both mean "a secret is stored" and neither is echoed.
      hasPassword: !!ssh.password || !!ssh.passwordRef,
      hasPassphrase: !!ssh.passphrase || !!ssh.passphraseRef,
      keyReady,
      proxyJump: ssh.proxyJump || '',
    },
  }
}

/**
 * Error for an SSH block that cannot be used. Carries `code === 'badSsh'` so the
 * command layer can attribute the failure instead of blaming the workspace (the
 * old behaviour was to drop the tunnel silently, which lost a working route).
 */
function badSshError() {
  const err = new TypeError('invalid SSH tunnel options')
  err.code = 'badSsh'
  return err
}

/**
 * Error for a row cap the caller got wrong (negative, fractional, non-numeric).
 * Carries `code === 'badMaxRows'` so the command layer can answer in the user's
 * language; no payload is attached, because the offending value is never echoed.
 */
function badMaxRowsError() {
  const err = new TypeError('invalid maxRows option')
  err.code = 'badMaxRows'
  return err
}

/**
 * Error for a display-order write that is not a permutation of the workspace's
 * environment names (missing, unknown, duplicated or non-string entries).
 * Carries `code === 'badOrder'`; nothing is echoed back — the payload is a list
 * of names, and the caller answers with a fixed sentence.
 */
function badOrderError() {
  const err = new TypeError('order is not a permutation of the workspace environments')
  err.code = 'badOrder'
  return err
}

/**
 * Error for a drag/copy addressed at an environment that no longer exists
 * (deleted in another tab, or only auto-discovered). Carries `code === 'unknownEnv'`
 * and the (non-secret) environment name as detail.
 */
function unknownEnvError(detail) {
  const err = new TypeError('environment not found')
  err.code = 'unknownEnv'
  err.detail = String(detail || '')
  return err
}

/**
 * Error for a move/copy whose target name is already taken in the target
 * workspace. Never auto-renamed (the user must rename one of them first).
 * Carries `code === 'envCollision'` and the (non-secret) name as detail.
 */
function envCollisionError(detail) {
  const err = new TypeError('environment name already exists in the target workspace')
  err.code = 'envCollision'
  err.detail = String(detail || '')
  return err
}

/**
 * Error for a write whose environment name was TRUNCATED onto a different row.
 * `normalizeEnvName` caps names at `ENV_NAME_MAX`, so two DISTINCT long names
 * share one store key: silently merging them keeps one connection and silently
 * drops the other (the survivor then answers for the environment it is not).
 * Carries `code === 'envNameTruncated'` so the command layer can attribute it,
 * and only the cap as a detail — never a name, never a DSN.
 */
function envNameTruncatedError() {
  const err = new TypeError('environment name exceeds ENV_NAME_MAX and collides with an existing entry')
  err.code = 'envNameTruncated'
  err.detail = String(ENV_NAME_MAX)
  return err
}

/**
 * Refuse a write that only reaches an existing row THROUGH the length cap.
 *
 * Only truncation is guarded, and only when the truncated key is already taken.
 * A name that merely normalizes (trim / control characters / case) onto an
 * existing key is the documented "same row" write and must keep working — the
 * card sends back the name it displays, which is the stored (already capped) one.
 *
 * @param environments - the workspace's environment map before the write.
 * @param requested - the name the caller asked for (raw, before normalization).
 */
function assertNameNotTruncated(environments, requested) {
  if (!truncatesOnto(environments, requested)) return
  throw envNameTruncatedError()
}

/**
 * True when `requested` is a DIFFERENT name only through the ENV_NAME_MAX cap and
 * its truncated form is already a key of `environments`.
 */
function truncatesOnto(environments, requested) {
  const full = rawEnvName(requested)
  if (!full || full.length <= ENV_NAME_MAX) return false
  if (!environments || typeof environments !== 'object') return false
  return Object.prototype.hasOwnProperty.call(environments, full.slice(0, ENV_NAME_MAX))
}

/**
 * The same predicate, answered against one workspace of the store.
 *
 * Exported for the MODEL-facing path: `dbhub_configure` normalizes the requested
 * environment name before it writes, so by the time the store guard runs the raw
 * text is gone. Asking first lets that path refuse an over-long name (instead of
 * silently updating whichever row happens to share the capped key) and report it
 * in the caller's language. The writers remain the authority.
 * @param wsPath - workspace key of the store.
 * @param requested - the raw environment name as the caller sent it.
 */
export function envNameTruncatesOntoExisting(wsPath, requested) {
  const entry = store[wsPath]
  const environments = entry && typeof entry === 'object' && entry.environments && typeof entry.environments === 'object'
    ? entry.environments
    : {}
  return truncatesOnto(environments, requested)
}

/**
 * Apply an options patch to a freshly built entry, IN PLACE.
 *
 * Semantics (D4): an OMITTED patch preserves whatever the entry had — a plain
 * `dbhub_configure` DSN update must never silently drop the read-only flag or
 * the tunnel. An explicit `false` / `null` DELETES the field.
 *
 * The caller spreads the PREVIOUS entry into `target` first (unknown fields must
 * survive a write), so "delete" cannot be expressed by simply not assigning:
 * an explicit `false` / `null` removes the key the spread just restored.
 *
 * An explicit `ssh` block that cannot be normalized THROWS (`code: 'badSsh'`):
 * silently saving the row without its tunnel turned a typo into a lost bastion
 * route (and a probe that no longer matched what execution would do).
 *
 * `maxRows` follows the SAME explicit-delete rule as `readOnly`: `0` (or `null`)
 * removes the field, a positive integer stores it, and anything unusable THROWS
 * (`code: 'badMaxRows'`) instead of being silently rounded or dropped — a bad
 * value must not turn into "unlimited" behind the user's back.
 */
function applyEnvOptions(target, opts) {
  if (!opts || typeof opts !== 'object') return target
  if (opts.readOnly === true) target.readOnly = true
  else if (opts.readOnly === false) delete target.readOnly
  if (opts.maxRows !== undefined) {
    if (opts.maxRows === null) delete target.maxRows
    else {
      const cap = parseMaxRows(opts.maxRows)
      if (cap === undefined) throw badMaxRowsError()
      if (cap > 0) target.maxRows = cap
      else delete target.maxRows
    }
  }
  if (opts.ssh !== undefined) {
    if (opts.ssh === null) {
      delete target.ssh
      return target
    }
    // `withDefaultSshKey` first: a key-auth block with a blank path means the
    // conventional identity file (what the field's placeholder shows), and it must
    // SAVE the same way it TESTS — otherwise a successful tunnel test is followed
    // by a silent save that drops the tunnel. A blank path is only ever filled
    // when the merge had no stored path to keep (see `mergeSshOptions`).
    const ssh = normalizeSshOptions(withDefaultSshKey(opts.ssh))
    if (!ssh) throw badSshError()
    target.ssh = ssh
  }
  return target
}

/**
 * Persist one workspace environment (creates or overwrites). The workspace
 * entry becomes `{ environments: { <env>: { dsn, source, updatedAt, … } } }`.
 *
 * `opts` = `{ readOnly?: boolean|null, ssh?: object|null, maxRows?: number|null,
 * dsnPasswordRef?: string|null }`.
 * When it is OMITTED the entry's existing read-only / tunnel / row-cap options
 * are PRESERVED (a DSN-only update must not clear a user's safety switch);
 * `readOnly: false`, `ssh: null` and `maxRows: 0` delete the field.
 *
 * Unknown fields survive on BOTH levels: the workspace entry is rebuilt from the
 * stored one (`...entry`) and the environment entry is rebuilt from its previous
 * row (`...previous`), so a field written by a newer build is not stripped by
 * this one. `normalizeStore` promises the same forward compatibility on load;
 * without the spreads a single write undid it.
 *
 * `opts.dsnPasswordRef` decides what happens to the database-password reference:
 *   · a valid `DSN_DBHUB_DSN_*` name → stored (the value is already in the
 *     credential service — the command layer wrote it FIRST);
 *   · `null` → removed (the new DSN carries no reference);
 *   · OMITTED → kept only when the DSN itself is byte-identical. A CHANGED DSN
 *     must never inherit the old reference: joining the old password into the new
 *     connection would authenticate against the wrong target with a valid-looking
 *     secret, and the user would never learn which of the two is wrong.
 *
 * @returns the stored environment name ('default' when blank).
 */
export function setWorkspaceEnv(wsPath, env, dsn, source, opts) {
  const entry = store[wsPath] && typeof store[wsPath] === 'object' && !Array.isArray(store[wsPath])
    ? store[wsPath]
    : {}
  const environments = entry.environments && typeof entry.environments === 'object' && !Array.isArray(entry.environments)
    ? { ...entry.environments }
    : {}
  const name = normalizeEnvName(env)
  const cleanDsn = String(dsn).trim()
  if (!cleanDsn) throw new TypeError('DSN 不能为空')
  assertNameNotTruncated(environments, env)
  const previous = environments[name]
  const next = { ...previous, dsn: cleanDsn, source: String(source || 'user'), updatedAt: Date.now() }
  applyEnvOptions(next, opts)
  if (opts && typeof opts === 'object' && Object.prototype.hasOwnProperty.call(opts, 'dsnPasswordRef')) {
    if (isDsnSecretRef(opts.dsnPasswordRef)) next.dsnPasswordRef = opts.dsnPasswordRef
    else delete next.dsnPasswordRef
  } else if (!previous || previous.dsn !== cleanDsn) {
    // A changed (or brand-new) DSN can never keep the previous password reference.
    delete next.dsnPasswordRef
  }
  // New names go to the END of the display order; an existing name keeps its
  // position. The order is always written in full, so a workspace created by an
  // older build stops being "name-sorted" as soon as the user touches it.
  // Computed BEFORE the new row is inserted: `workspaceOrderOf` sorts the names
  // the order does not mention yet, and a brand-new name must be appended, never
  // slotted into that sorted tail.
  const order = workspaceOrderOf(environments, entry.order)
  environments[name] = next
  if (order.indexOf(name) < 0) order.push(name)
  store[wsPath] = { ...entry, environments, order }
  saveStore(store)
  return name
}

/**
 * Change ONLY the options of an existing environment — the DSN, its source and
 * its updatedAt are left exactly as they were (the UI's "toggle read-only" and
 * "configure the tunnel" writes have no connection data to offer, and requiring
 * one would make the user re-type a password to flip a checkbox).
 *
 * @param patch - `{ readOnly?: boolean, ssh?: object|null, maxRows?: number|null }`
 *   (only the keys present are touched; `0` clears the cap).
 * @returns the environment name, or `undefined` when no such persisted row
 *   exists (the caller decides whether to promote an auto-discovered row).
 */
export function setWorkspaceEnvOptions(wsPath, env, patch) {
  const entry = store[wsPath]
  if (!entry || typeof entry !== 'object' || !entry.environments || typeof entry.environments !== 'object') return undefined
  // Same gate as the DSN writer, BEFORE anything is computed: an options write
  // addressed with a 65-character name whose 64-character cap is already a stored
  // row would otherwise flip that OTHER environment's read-only flag / tunnel —
  // the exact data-safety defect `setWorkspaceEnv` refuses (PR-5), reachable here
  // through the read-only chip.
  assertNameNotTruncated(entry.environments, env)
  const name = normalizeEnvName(env)
  const current = entry.environments[name]
  if (!current || typeof current.dsn !== 'string' || !current.dsn.trim()) return undefined
  const environments = { ...entry.environments }
  const next = { ...current, updatedAt: Date.now() }
  if (patch && typeof patch === 'object') {
    if (patch.readOnly === true) next.readOnly = true
    else if (patch.readOnly === false) delete next.readOnly
    if (patch.maxRows !== undefined) {
      if (patch.maxRows === null) delete next.maxRows
      else {
        const cap = parseMaxRows(patch.maxRows)
        if (cap === undefined) throw badMaxRowsError()
        if (cap > 0) next.maxRows = cap
        else delete next.maxRows
      }
    }
    if (patch.ssh !== undefined) {
      if (patch.ssh === null) delete next.ssh
      else {
        const ssh = normalizeSshOptions(withDefaultSshKey(patch.ssh))
        if (!ssh) return undefined
        next.ssh = ssh
      }
    }
  }
  environments[name] = next
  store[wsPath] = { ...entry, environments }
  saveStore(store)
  return name
}


/**
 * Rename one persisted environment IN PLACE: the DSN, its source provenance
 * and the connection itself move with the name, so no credential is ever
 * re-entered (and never crosses the model).
 *
 * Renaming onto an existing environment REPLACES that entry, so the collision is
 * reported instead of performed silently: the write only happens when the caller
 * passes `{ confirm: true }` (after asking the user), and every other caller gets
 * `{ renamed: false, collided: true }` back so it can refuse loudly. Only
 * persisted rows can be renamed; the auto-discovered 'default' is not a stored
 * row and is never renamed.
 *
 * @param wsPath - workspace key of the store.
 * @param from - current environment name.
 * @param to - target environment name.
 * @param opts - `{ confirm?: boolean }` — permit overwriting an existing target.
 * @returns `{ name, collided, renamed }`, or `undefined` when there is nothing
 *   to rename.
 */
export function renameWorkspaceEnv(wsPath, from, to, opts) {
  const entry = store[wsPath]
  if (!entry || typeof entry !== 'object' || !entry.environments || typeof entry.environments !== 'object') return undefined
  const oldName = normalizeEnvName(from)
  const newName = normalizeEnvName(to)
  const current = entry.environments[oldName]
  if (!current || typeof current.dsn !== 'string' || !current.dsn.trim()) return undefined
  if (oldName === newName) return { name: newName, collided: false, renamed: false }
  // A target that only exists through the length cap is NOT "an existing
  // environment to overwrite" — merging two distinct long names would silently
  // lose the connection that already sat there. Refused before the collision
  // question, so a confirmed overwrite cannot be granted for it either.
  assertNameNotTruncated(entry.environments, to)
  const collided = Object.prototype.hasOwnProperty.call(entry.environments, newName)
  if (collided && !(opts && opts.confirm === true)) {
    // Nothing is written: the caller must ask first (the card shows its own
    // warning card, the model path asks through `askUser`).
    return { name: newName, collided: true, renamed: false }
  }
  const environments = { ...entry.environments }
  delete environments[oldName]
  // `...current` keeps the moved row's unknown fields as well as its options.
  environments[newName] = { ...current, dsn: current.dsn.trim(), updatedAt: Date.now() }
  // The renamed row keeps its POSITION in the display order (the old name is
  // replaced in place); a confirmed overwrite must not leave a duplicate entry.
  const order = workspaceOrderOf(entry.environments, entry.order)
  const at = order.indexOf(oldName)
  const nextOrder = order.filter((n) => n !== oldName && n !== newName)
  if (at < 0) nextOrder.push(newName)
  else nextOrder.splice(Math.min(at, nextOrder.length), 0, newName)
  store[wsPath] = { ...entry, environments, order: nextOrder }
  saveStore(store)
  return { name: newName, collided, renamed: true }
}

/**
 * Remove one persisted workspace environment; when it was the last one the
 * whole workspace entry is dropped. Removing an auto-derived 'default' (which
 * is never persisted) is a no-op.
 * @returns whether anything was removed.
 */
export function removeWorkspaceEnv(wsPath, env) {
  const entry = store[wsPath]
  if (!entry || typeof entry !== 'object' || !entry.environments || typeof entry.environments !== 'object') return false
  // A 65-character name that truncates onto a stored 64-character row used to
  // DELETE that other environment (same class as the options path above, and the
  // same refusal `renameWorkspaceEnv` already makes before its own write).
  assertNameNotTruncated(entry.environments, env)
  const name = normalizeEnvName(env)
  if (!Object.prototype.hasOwnProperty.call(entry.environments, name)) return false
  const environments = { ...entry.environments }
  delete environments[name]
  if (Object.keys(environments).length === 0) delete store[wsPath]
  else {
    // `...entry` keeps the workspace-level unknown fields (see `setWorkspaceEnv`),
    // and the removed name leaves the display order with the row.
    const order = workspaceOrderOf(entry.environments, entry.order).filter((n) => n !== name)
    store[wsPath] = { ...entry, environments, order }
  }
  saveStore(store)
  return true
}

// ── display order, cross-workspace moves, copy (drag & drop backend) ───────
//
// The store's `order` array is the ONLY persisted notion of "display order".
// These writers keep it in step with the environment map:
//   · `reorderWorkspace` replaces it with a validated permutation;
//   · `moveWorkspaceEnv` removes a row from one workspace and inserts it into
//     another (or repositions it inside the same one) and rewrites BOTH orders in
//     ONE store write;
//   · `copyWorkspaceEnv` clones a row right after its source and shares every
//     credential reference (a copy names the same secret; it never stores it).
// Any refusal throws BEFORE the first mutation (or before `saveStore`), so a
// rejected drag/copy is a zero-write command.

/** Clamp a drag target index into `[0, len]`; a missing/invalid index means "append". */
function clampIndex(value, len) {
  if (value === undefined || value === null || value === '') return len
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return len
  return Math.max(0, Math.min(len, n))
}

/**
 * Generate a non-colliding copy name for `copy` (the UI's explicit-name case is
 * NOT auto-renamed — it is refused with `envCollision`).
 *
 * The suffix is built from a stem short enough to survive `ENV_NAME_MAX`, so a
 * 64-character source name still yields a DISTINCT candidate (plain
 * `name + '-copy-1'` would be truncated back onto the source and loop forever).
 */
function uniqueCopyName(environments, baseName) {
  const base = normalizeEnvName(baseName)
  for (let n = 1; n <= 1000; n++) {
    const suffix = '-copy-' + n
    const room = Math.max(0, ENV_NAME_MAX - suffix.length)
    const candidate = normalizeEnvName(base.slice(0, room) + suffix)
    if (candidate === base) continue
    if (!Object.prototype.hasOwnProperty.call(environments, candidate)) return candidate
  }
  throw envCollisionError(base)
}

/**
 * Replace one workspace's display order.
 *
 * `order` must be an exact permutation of the workspace's CURRENT persisted
 * environment names (same length, every name present exactly once). Anything else
 * — a missing/extra/duplicate name, a non-string, a name that no longer exists —
 * throws `code:'badOrder'` with ZERO writes: a partial order would silently drop
 * rows from the user's list until the next write fixed it.
 *
 * A workspace with no persisted environments has exactly one valid order (`[]`);
 * it is accepted as a no-op (there is no workspace entry to store it on).
 * @returns the stored order array.
 */
export function reorderWorkspace(wsPath, order) {
  const entry = store[wsPath]
  const environments = entry && typeof entry === 'object'
    && entry.environments && typeof entry.environments === 'object' && !Array.isArray(entry.environments)
    ? entry.environments
    : {}
  const names = Object.keys(environments)
  const submitted = Array.isArray(order) ? order : null
  let clean = null
  if (submitted && submitted.length === names.length) {
    const known = new Set(names)
    const seen = new Set()
    clean = submitted.map((n) => (typeof n === 'string' ? n.trim() : null))
    for (const n of clean) {
      if (n === null || !known.has(n) || seen.has(n)) {
        clean = null
        break
      }
      seen.add(n)
    }
  }
  if (!clean) throw badOrderError()
  if (names.length === 0) return []
  store[wsPath] = { ...entry, environments, order: clean }
  saveStore(store)
  return clean
}

/**
 * Move one persisted environment (with its whole row: DSN, options and credential
 * REFERENCES) to another workspace, or to another position in its own workspace.
 *
 * ONE `saveStore` for both sides: the source removal and the target insertion are
 * applied to the in-memory store first and persisted together, so a crash/failed
 * write cannot leave the row in both workspaces or in neither. The source
 * workspace entry is dropped when its last environment leaves; the target entry
 * is created on demand.
 *
 * `index` is the position in the target's environment list WITHOUT the moved row
 * (for a same-workspace move that is also the final position). It is clamped to
 * `[0, len]`, and a missing/invalid index appends.
 *
 * @returns `{ name, index }` — the name (normalized) and the clamped index used.
 * @throws `code:'unknownEnv'` when the source row does not exist.
 * @throws `code:'envCollision'` when the target workspace already has that name.
 */
export function moveWorkspaceEnv(fromWsPath, env, toWsPath, index) {
  const name = normalizeEnvName(env)
  const fromEntry = store[fromWsPath]
  const fromEnvs = fromEntry && typeof fromEntry === 'object'
    && fromEntry.environments && typeof fromEntry.environments === 'object' && !Array.isArray(fromEntry.environments)
    ? fromEntry.environments
    : undefined
  const row = fromEnvs && Object.prototype.hasOwnProperty.call(fromEnvs, name) ? fromEnvs[name] : undefined
  if (!row || typeof row !== 'object' || typeof row.dsn !== 'string' || !row.dsn.trim()) {
    throw unknownEnvError(name)
  }
  const fromOrder = workspaceOrderOf(fromEnvs, fromEntry.order).filter((n) => n !== name)
  if (toWsPath === fromWsPath) {
    const at = clampIndex(index, fromOrder.length)
    const order = fromOrder.slice()
    order.splice(at, 0, name)
    store[fromWsPath] = { ...fromEntry, environments: fromEnvs, order }
    saveStore(store)
    return { name, index: at }
  }
  const toRaw = store[toWsPath]
  const toEntry = toRaw && typeof toRaw === 'object' && !Array.isArray(toRaw) ? toRaw : {}
  const toEnvs = toEntry.environments && typeof toEntry.environments === 'object' && !Array.isArray(toEntry.environments)
    ? { ...toEntry.environments }
    : {}
  if (Object.prototype.hasOwnProperty.call(toEnvs, name)) throw envCollisionError(name)
  const nextFromEnvs = { ...fromEnvs }
  delete nextFromEnvs[name]
  toEnvs[name] = row
  const toBase = workspaceOrderOf(toEntry.environments || {}, toEntry.order)
  const at = clampIndex(index, toBase.length)
  const toOrder = toBase.slice()
  toOrder.splice(at, 0, name)
  // ONE write for both workspaces (see the doc comment).
  if (Object.keys(nextFromEnvs).length === 0) delete store[fromWsPath]
  else store[fromWsPath] = { ...fromEntry, environments: nextFromEnvs, order: fromOrder }
  store[toWsPath] = { ...toEntry, environments: toEnvs, order: toOrder }
  saveStore(store)
  return { name, index: at }
}

/**
 * Clone one persisted environment inside its workspace, inserted right AFTER the
 * source row in the display order.
 *
 * The clone shares every credential REFERENCE (`dsnPasswordRef`, the SSH
 * `passwordRef` / `passphraseRef`) with its source — the secret value is never
 * duplicated, and the shared non-`unset` logic in `releaseSecretRefs` keeps the
 * value alive while EITHER row exists. `maxRows` (deprecated) and unknown
 * environment fields are deliberately NOT copied.
 *
 * Naming: an explicit `newEnv` is used as given (normalized by `ENV_NAME_MAX`) and
 * a collision throws `code:'envCollision'` — the UI asks the user to rename
 * first. Without one, `<env>-copy-1`, `-copy-2`, … is generated.
 *
 * @returns `{ name, row }` — the final name and the stored row (host-side).
 * @throws `code:'unknownEnv'` when the source row does not exist.
 * @throws `code:'envCollision'` for an explicit name that is already taken.
 */
export function copyWorkspaceEnv(wsPath, env, newEnv) {
  const name = normalizeEnvName(env)
  const entry = store[wsPath]
  const environments = entry && typeof entry === 'object'
    && entry.environments && typeof entry.environments === 'object' && !Array.isArray(entry.environments)
    ? entry.environments
    : undefined
  const source = environments && Object.prototype.hasOwnProperty.call(environments, name) ? environments[name] : undefined
  if (!source || typeof source !== 'object' || typeof source.dsn !== 'string' || !source.dsn.trim()) {
    throw unknownEnvError(name)
  }
  const given = newEnv === undefined || newEnv === null ? '' : String(newEnv).trim()
  let copyName
  if (given) {
    copyName = normalizeEnvName(given)
    if (Object.prototype.hasOwnProperty.call(environments, copyName)) throw envCollisionError(copyName)
  } else {
    copyName = uniqueCopyName(environments, name)
  }
  // Clone the fields the contract names — a credential REFERENCE is shared, never
  // re-minted; the ssh object is shallow-copied so later per-row edits cannot
  // rewrite the sibling through a shared object.
  const copy = { dsn: source.dsn.trim(), source: 'copy', updatedAt: Date.now() }
  if (isDsnSecretRef(source.dsnPasswordRef)) copy.dsnPasswordRef = source.dsnPasswordRef
  if (source.ssh && typeof source.ssh === 'object' && !Array.isArray(source.ssh)) copy.ssh = { ...source.ssh }
  if (source.readOnly === true) copy.readOnly = true
  const nextEnvs = { ...environments, [copyName]: copy }
  const order = workspaceOrderOf(environments, entry.order)
  const at = order.indexOf(name)
  const nextOrder = order.slice()
  nextOrder.splice(at < 0 ? nextOrder.length : at + 1, 0, copyName)
  store[wsPath] = { ...entry, environments: nextEnvs, order: nextOrder }
  saveStore(store)
  return { name: copyName, row: copy }
}

/** Normalize the runtime document (dbhubExe / dbhubInstallAt) the same way. */
export function normalizeRuntime(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'dbhubExe') {
      if (typeof value === 'string' && value) defineOwn(out, key, value)
    } else if (key === 'dbhubInstallAt') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) defineOwn(out, key, value)
    } else {
      // Preserve unknown fields for forward compatibility.
      defineOwn(out, key, value)
    }
  }
  return out
}

/** Recreate the storage directory after an accidental delete. */
export function ensureStorageDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    // An existing directory keeps its old mode: re-tighten it (best-effort).
    tightenStorageModes()
    return true
  } catch (e) {
    warnOnce('mkdir', '无法创建配置目录 ' + DATA_DIR + '（运行目录被删除或写入被拦截）：' + String((e && e.message) || e))
    return false
  }
}

/**
 * Atomically write a JSON document: write a temp file in the same directory,
 * then rename over the target so a concurrent reader never sees a torn file
 * and concurrent writers never interleave (last writer wins on the rename).
 * Recreates the directory first. NEVER throws; returns whether it succeeded.
 *
 * Owner-only mode (0o600) on the temp file, so the document is unreadable to
 * other accounts from the moment it exists — every document written here holds
 * a credential (credentials.json: all DSNs + SSH secrets; the rest: at least
 * host metadata). Windows ignores the mode and relies on the profile ACL.
 */
function writeJsonFile(path, value) {
  try {
    fsHooks.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = path + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    fsHooks.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fsHooks.renameSync(tmp, path)
    // The rename publishes the temp file's mode, but a platform/network volume
    // may keep the TARGET's attributes: pin the final file too (best-effort, and
    // a no-op on Windows). One warnOnce per document, not one per write.
    tightenStorageModes()
    return true
  } catch (e) {
    warnOnce('write:' + path,
      '写入 ' + path + ' 失败（运行目录被删除或写入被拦截），本项仅在内存中生效：' + String((e && e.message) || e))
    return false
  }
}

// ── legacy plaintext connection file (pre-4.0) ────────────────────────────
//
// Before 4.0 the connection store WAS `$DSH_HOME/storages/dsh-dbhub-live/
// dbhub.toml`: a hand-editable TOML document that carried the raw connection
// strings, password included. 4.0 moved everything into credentials.json and no
// code path reads the old file — which is exactly why it survives on upgraded
// profiles: nothing owns it, so nothing ever removes it, and the profile keeps a
// plaintext DSN store next to the encrypted-by-mode one (D1: delete, warn, done
// — the credentials in it were re-entered through the UI long ago, so a
// migration would only resurrect stale secrets).
//
// The warning names the FILE, never its content: the content is precisely what
// must not be printed.

/**
 * Delete the legacy plaintext connection file when it is still on disk.
 * @returns `{ removed, path }` — `removed: false` when there was nothing to do
 *   (or the unlink failed, which is reported once).
 */
export function sweepLegacyConfigFile() {
  try {
    if (!existsSync(LEGACY_CONFIG_PATH)) return { removed: false, path: LEGACY_CONFIG_PATH }
    unlinkSync(LEGACY_CONFIG_PATH)
    warnOnce('legacy-config-swept', currentT('log.legacyConfigSwept'))
    return { removed: true, path: LEGACY_CONFIG_PATH }
  } catch (e) {
    // Only the error CODE is reported: an fs error message quotes the absolute
    // path, and nothing about this sweep may end up echoing the machine layout.
    warnOnce('legacy-config-sweep-failed', currentT('log.legacyConfigSweptFail', {
      code: String((e && e.code) || 'unknown'),
    }))
    return { removed: false, path: LEGACY_CONFIG_PATH }
  }
}

// ── persistence (singleton store/runtime, shared by every module) ─────────

export function loadStore() {
  const raw = readJsonFile(STORE_PATH, {})
  const normalized = normalizeStore(raw)
  // One-time migration: persist the cleaned document when a legacy layout was
  // loaded, so the next boot starts from a normalized file.
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) writeJsonFile(STORE_PATH, normalized)
  return normalized
}

/** Persist the credentials store atomically; returns whether it succeeded. */
export function saveStore(store) {
  return writeJsonFile(STORE_PATH, store)
}

export function loadRuntime() {
  const raw = readJsonFile(RUNTIME_PATH, {})
  const normalized = normalizeRuntime(raw)
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) writeJsonFile(RUNTIME_PATH, normalized)
  return normalized
}

/** Persist the runtime document atomically; returns whether it succeeded. */
export function saveRuntime(runtime) {
  return writeJsonFile(RUNTIME_PATH, runtime)
}

/**
 * Normalize the preferences document. It holds exactly the two UI options, so
 * anything else (and any value that fails its validator) is dropped here —
 * a hand-edited or truncated file can never seed an invalid option.
 * @param raw - parsed JSON document (any shape).
 * @returns the normalized plain object.
 */
export function normalizePrefs(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const days = raw.updateIntervalDays
  if (typeof days === 'number' && Number.isFinite(days) && days >= 0) defineOwn(out, 'updateIntervalDays', days)
  // The user's own "hide the sidebar entry" preference. It is INDEPENDENT of the
  // plugin's enabled state: hiding the shortcut does not turn the plugin off,
  // and the client ANDs the two (a disabled plugin contributes no entry at all).
  if (typeof raw.showSidebarEntry === 'boolean') defineOwn(out, 'showSidebarEntry', raw.showSidebarEntry)
  // The user's own "announce the database-access policy to the model" preference.
  // Turning it off removes one system-prompt section; no tool changes behavior.
  if (typeof raw.announceAccessPolicy === 'boolean') defineOwn(out, 'announceAccessPolicy', raw.announceAccessPolicy)
  // Where query-result exports go: '' = the plugin's default directory
  // (`exports/` under the data dir). Only the string is normalized here — the
  // directory is PROVEN writable by `options.applyPatch` at save time, so a
  // hand-edited prefs file cannot make an export fail silently later on.
  if (typeof raw.exportDir === 'string') defineOwn(out, 'exportDir', raw.exportDir.trim())
  // The global result row cap (0 = unlimited) and the batch-test concurrency
  // (1..8). Both are integers: a hand-edited file must not seed a fractional or
  // negative value, and `options.validatePatch` refuses those on a user save.
  if (typeof raw.defaultMaxRows === 'number' && Number.isSafeInteger(raw.defaultMaxRows) && raw.defaultMaxRows >= 0) {
    defineOwn(out, 'defaultMaxRows', raw.defaultMaxRows)
  }
  if (typeof raw.batchConcurrency === 'number' && Number.isInteger(raw.batchConcurrency)
    && raw.batchConcurrency >= 1 && raw.batchConcurrency <= 8) {
    defineOwn(out, 'batchConcurrency', raw.batchConcurrency)
  }
  return out
}

/** Load the persisted UI options; a missing or unreadable file is `{}`. */
export function loadPrefs() {
  const raw = readJsonFile(PREFS_PATH, {})
  const normalized = normalizePrefs(raw)
  // One-time migration, mirroring loadStore/loadRuntime: a legacy key (or a
  // hand-edited value that fails its validator) is dropped from DISK on the
  // first boot, so the file never keeps advertising an option this build does
  // not have — a removed `showSidebarEntry` must not look configurable again.
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) writeJsonFile(PREFS_PATH, normalized)
  return normalized
}

/** Persist the UI options atomically; returns whether it succeeded. */
export function savePrefs(prefs) {
  return writeJsonFile(PREFS_PATH, normalizePrefs(prefs))
}

export const store = loadStore()
export const runtime = loadRuntime()

// Upgrade path: the documents above were just read, so this is the only moment
// that can re-tighten a profile created by a build without owner-only modes.
tightenStorageModes()

// ── small utils ───────────────────────────────────────────────────────────

// ASCII projection of a name; '' when nothing survives (a purely non-ASCII
// name). Callers own the fallback because 'ws' (workspace) and 'env'
// (environment) mean different things.
export function asciiSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function slugify(title) {
  return asciiSlug(title) || 'ws'
}

/**
 * Environment-name hygiene. An env name is a store key AND display text, so
 * trim it, drop control characters and cap the length; blank collapses to the
 * reserved 'default'. Non-ASCII names are first-class and pass through
 * unchanged — only the derived source slug is hashed (see `envSlug`).
 */
export const ENV_NAME_MAX = 64
/** Pre-truncation projection of a raw env name (same hygiene, no length cap). */
function rawEnvName(env) {
  return String(env === undefined || env === null ? '' : env)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
}
export function normalizeEnvName(env) {
  const raw = rawEnvName(env)
  if (!raw) return 'default'
  return raw.slice(0, ENV_NAME_MAX)
}

export function shortHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// ── zero-knowledge connection metadata ────────────────────────────────────
//
// The model must NEVER see a DSN (it carries the password). Everything the
// model-facing surface prints — tool descriptions, list rows, result headers,
// card summaries — goes through describeConn/connLabel, which extract ONLY
// db type / host / port / database. Passwords and usernames never cross.

/**
 * Percent-decode one URL component, falling back to the RAW text when it is not
 * valid percent-encoding.
 *
 * `decodeURIComponent('bad%zz')` throws `URIError`, and this runs on every listed
 * row: one malformed DSN in the store (nothing validates a DSN written by
 * `setWorkspaceEnv`) used to make the WHOLE `dbhub_list_sources` receipt throw,
 * so the "unparsable ⇒ placeholder" contract never got a chance to apply. A raw
 * segment is not a secret by itself — the caller's gates decide whether it is
 * printable at all.
 */
function safeDecode(value) {
  const raw = String(value === undefined || value === null ? '' : value)
  if (!raw) return raw
  try {
    return decodeURIComponent(raw)
  } catch (e) {
    return raw
  }
}

/** `k=v` pairs inside one path/property segment (ADO / JDBC / Go shapes). */
const KV_PAIR_RE = /(?:^|[\s;&])([A-Za-z_][\w.-]*)\s*=\s*[^&;\s]+/g
/** Keys that name a credential, whatever a dialect calls them. */
const CREDENTIAL_KEY_RE = /pass|pwd|secret|token|auth|cred/i

/**
 * True when a metadata field carries a credential instead of an endpoint.
 *
 * Structural on purpose: `@` can only ever be userinfo, and a `k=v` pair whose
 * KEY names a credential is a property-style connection string that landed in
 * the path (`Server=…;Database=…;pass=…`). The previous rule was a keyword list
 * of password spellings (`password|passwd|pwd`), so every other spelling —
 * `pass=`, `Pass=`, `authToken=` — walked straight through it.
 */
function carriesCredential(value) {
  if (!value) return false
  const text = String(value)
  if (text.includes('@')) return true
  for (const match of text.matchAll(KV_PAIR_RE)) {
    if (CREDENTIAL_KEY_RE.test(match[1])) return true
  }
  return false
}

/**
 * Structural parse of a connection string: the metadata plus the TRUST bit.
 *
 * `parsed` is true only when `new URL()` accepted the value, i.e. the fields are
 * components of a real URL instead of slices of free text. `connLabel` refuses
 * every unparsed shape; the metadata is still produced here because
 * `describeConn` has callers that only need a best-effort type.
 */
function parseConnOf(dsn) {
  const meta = { type: '', host: '', port: '', database: '' }
  const s = String(dsn || '').trim().replace(/^jdbc:/i, '')
  let u
  try {
    u = new URL(s)
  } catch (e) {
    /* non-URL (bare sqlite path, ADO/property string, Go-style DSN, …) */
  }
  if (u) {
    let type = (u.protocol || '').replace(/:$/, '').toLowerCase()
    if (type === 'postgresql') type = 'postgres' // normalize to dbhub's scheme
    meta.type = type
    if (u.hostname) meta.host = u.hostname
    if (u.port) meta.port = u.port
    const db = (u.pathname || '').replace(/^\//, '')
    if (db) meta.database = safeDecode(db)
    return { meta, parsed: true }
  }
  const m = s.match(/^sqlite:\/\/(.+)$/i)
  if (m && m[1]) {
    meta.type = 'sqlite'
    meta.database = safeDecode(m[1])
  }
  return { meta, parsed: false }
}

/**
 * Extract NON-SECRET metadata from a DSN. Never returns user or password.
 * Best-effort by contract: `connLabel` is what decides whether the result may
 * be printed at all (see `connLabel`).
 * @param dsn - a full connection string (kept host-side only).
 * @returns { type, host, port, database } (empty strings when unknown).
 */
export function describeConn(dsn) {
  return parseConnOf(dsn).meta
}

/**
 * One-line human label for a DSN: `type://host:port/database` — never user,
 * never password. sqlite keeps its file path.
 *
 * A connection string that CANNOT be parsed into trusted metadata yields the
 * localized "unknown connection" placeholder — never the input. Echoing the raw
 * string was a real leak: `describeConn` derives `database` from the URL path,
 * so a malformed string such as `mysql:/u:<password>@host:3306/db` (one slash —
 * the userinfo lands in the PATH, not in an authority) came back as
 * `mysql://localhost/u:<password>@host:3306/db`. ADO / JDBC-property / Go-style
 * strings (`Server=…;pass=…;`, `host=… password=…`) are not URLs at all. This
 * label is what `dbhub_list_sources`, the ad-hoc result header, the scan
 * candidates and the browser mirror `w.conn` all show, so an echo becomes a
 * zero-knowledge breach on all four surfaces.
 *
 * The gate is STRUCTURAL, not a keyword list:
 *   1. only a value `new URL()` really accepted is trusted at all — a shape that
 *      merely looks like a DSN never contributes metadata;
 *   2. an unparsed value, or a parsed one with no authority (no host), is the
 *      placeholder (sqlite is the one host-less dialect that is legitimate);
 *   3. the remaining fields must be endpoint text: no `@` (userinfo), and no
 *      `k=v` pair whose key names a credential.
 * So a NEW malformed dialect can never turn into an echo, and no real label is
 * lost to a coincidental substring (a password that happens to equal the
 * database name is no longer a reason to hide a connection).
 */
export function connLabel(dsn) {
  const unknown = () => currentT('result.unknownConn')
  // Belt and braces: the whole label is a model-facing string, so any future
  // surprise inside the parse collapses onto the placeholder instead of throwing
  // into a list receipt (one bad row must never fail the whole listing).
  try {
    const raw = String(dsn || '').trim()
    if (!raw) return unknown()
    const { meta, parsed } = parseConnOf(raw)
    if (!parsed || !meta.type) return unknown()
    // No authority = the "authority" was really path text (`mysql:/u:…@host`).
    if (!meta.host && meta.type !== 'sqlite') return unknown()
    if (meta.host && carriesCredential(meta.host)) return unknown()
    if (meta.port && carriesCredential(meta.port)) return unknown()
    if (meta.database && carriesCredential(meta.database)) return unknown()
    let label
    if (meta.type === 'sqlite' && meta.database) {
      label = 'sqlite:///' + meta.database.replace(/\\/g, '/')
    } else {
      label = meta.type + '://' + (meta.host || 'localhost')
      if (meta.port) label += ':' + meta.port
      label += '/' + meta.database
    }
    return label
  } catch (e) {
    return unknown()
  }
}

/**
 * The password component of a DSN, in BOTH spellings, or undefined.
 * `password` is percent-DECODED: that is the form the rest of the module works
 * in (`describeConn` decodes the database too), and returning the raw encoding
 * made `dsnPassword` and the metadata disagree about the same DSN.
 */
function passwordOf(dsn) {
  const s = String(dsn || '')
  try {
    const u = new URL(s.replace(/^jdbc:/i, ''))
    if (u.password) return { raw: u.password, value: safeDecode(u.password) }
  } catch (e) {
    /* fall through */
  }
  const m = s.match(/(:\/\/[^:/@]+:)([^@]+)(@)/)
  return m ? { raw: m[2], value: safeDecode(m[2]) } : undefined
}

/** Extract the (decoded) password component of a DSN (or undefined). */
export function dsnPassword(dsn) {
  const found = passwordOf(dsn)
  return found ? found.value : undefined
}

/**
 * Host-side username extraction (like dsnPassword): the username is a
 * NON-secret connection field that may be used to rebuild a DSN inside the
 * Host — it never crosses to the model on its own. Returns undefined when the
 * DSN carries no userinfo.
 */
export function dsnUser(dsn) {
  const s = String(dsn || '')
  try {
    const u = new URL(s.replace(/^jdbc:/i, ''))
    if (u.username) return decodeURIComponent(u.username)
  } catch (e) {
    /* fall through */
  }
  const m = s.match(/:\/\/([^:/@]+)(?::[^@]*)?@/)
  return m ? decodeURIComponent(m[1]) : undefined
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace ONE known secret with `****`, but only where it stands as its own
 * token.
 *
 * A bare `text.split(secret).join('****')` self-destructed on short secrets: with
 * a 1-character DSN password the literal `password=` became `p****ssword`, so the
 * `password=` rule below no longer matched and the REAL value it was meant to
 * mask (and every later secret) leaked through. The boundary classes keep the
 * secret from being found inside an identifier — a one-character password `a` is
 * still a substring of `password` — while a standalone occurrence is replaced.
 *
 * Short passwords stay covered even when the boundary rule skips them: the
 * unconditional userinfo collapse at the end of `scrubSecrets` folds the whole
 * `://user:pass@` segment, which is where dbhub actually prints it.
 */
function scrubSecret(text, secret) {
  const s = String(secret === undefined || secret === null ? '' : secret)
  if (!s || s === '****') return text
  const re = new RegExp('(?<![\\w@:/.-])' + escapeRegExp(s) + '(?![\\w@:/.])', 'g')
  return text.replace(re, '****')
}

/**
 * Defense-in-depth scrubber for text that originates from dbhub (results,
 * stderr tails, error messages): replaces the known DSN's password and the
 * userinfo of every URL-shaped DSN occurrence, plus generic `password=` /
 * `passwd=` tokens, so a leak from the MCP server can never reach the model.
 * Passwords AND usernames never cross.
 *
 * dbhub's own startup banner prints the DSN with only the password masked
 * (`mysql://root:****@host:3306/db`), which is exactly the text that lands in a
 * connection-test diagnostic — hence the userinfo is collapsed as a whole, not
 * just the password.
 *
 * `extraSecrets` carries the secrets a generated TOML put in the child
 * environment (the SSH login password / key passphrase): dbhub may echo them in
 * its own diagnostics, so they are replaced like the DSN password.
 */
export function scrubSecrets(text, dsn, extraSecrets) {
  let out = String(text || '')
  const pass = passwordOf(dsn)
  if (pass) {
    // Both spellings: the decoded form is what the rest of the module works in,
    // and the raw (percent-encoded) form is what a DSN-shaped echo may print.
    out = scrubSecret(out, pass.value)
    if (pass.raw !== pass.value) out = scrubSecret(out, pass.raw)
  }
  const extras = Array.isArray(extraSecrets) ? extraSecrets : []
  for (const secret of extras) {
    out = scrubSecret(out, secret)
  }
  out = out.replace(/(password|passwd|pwd)\s*(:|=)\s*["']?[^"'\s,;]+/gi, '$1$2****')
  // Userinfo of a URL-shaped connection string: `://user:pass@` and `://user@`.
  // Runs LAST so it also covers a DSN that arrived through an `extraSecrets`
  // replacement, and it is unconditional because the username is a secret too.
  out = out.replace(/(:\/\/)[^/@\s]+@/g, '$1****:****@')
  return out
}

// ── env parsing ───────────────────────────────────────────────────────────

export function parseEnvFile(text) {
  const map = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (!key) continue
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    map[key] = value
  }
  return map
}

export function parseEnvOutput(text) {
  const map = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:\$Env:|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'])*'|[^ ]*)/)
    if (!m) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    map[m[1]] = value
  }
  return map
}

// DB_* individual variables -> a DSN string (or undefined).
export function dsnFromEnv(env) {
  const has = (k) => env[k] !== undefined && env[k] !== null && String(env[k]).trim() !== ''
  if (!has('DB_HOST') || !has('DB_USER') || !has('DB_NAME')) return undefined
  const type = (has('DB_TYPE') ? String(env.DB_TYPE).trim() : 'mysql').toLowerCase()
  const host = String(env.DB_HOST).trim()
  const port = has('DB_PORT') ? String(env.DB_PORT).trim() : ''
  const user = String(env.DB_USER).trim()
  const password = has('DB_PASSWORD') ? String(env.DB_PASSWORD).trim() : ''
  const database = String(env.DB_NAME).trim()
  const enc = (s) => encodeURIComponent(s)
  if (type === 'sqlite') return 'sqlite:///' + host
  return type + '://' + enc(user) + ':' + enc(password) + '@' + host + (port ? ':' + port : '') + '/' + enc(database)
}

export function dsnFromMap(map) {
  if (map.DSN) return String(map.DSN).trim()
  return dsnFromEnv(map)
}

// ── workspace discovery & DSN resolution ─────────────────────────────────

// Workspaces: live registry first, then a direct read of the durable
// workspace registry file (robust at boot, when services may not be ready).
export async function listWorkspaces(ctx) {
  if (ctx) {
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      try {
        const list = await registry.list()
        if (Array.isArray(list) && list.length > 0) {
          return list.filter((w) => w && w.path).map((w) => ({ path: w.path, title: w.title || basename(w.path) }))
        }
      } catch (e) {
        /* fall through */
      }
    }
  }
  try {
    const wsFile = join(dshHomeDir(), 'storages', 'workspace.json')
    const data = JSON.parse(readFileSync(wsFile, 'utf8'))
    const table = data && data.tables && data.tables.workspaces
    if (table) {
      const out = []
      for (const id of Object.keys(table)) {
        const w = table[id]
        if (w && w.path) out.push({ path: w.path, title: w.title || basename(w.path) })
      }
      if (out.length > 0) return out
    }
  } catch (e) {
    /* fall through */
  }
  try {
    const cwd = process.cwd()
    if (cwd) return [{ path: cwd, title: basename(cwd) }]
  } catch (e) {
    /* fall through */
  }
  return []
}

// Auto-discovery budgets. One workspace's `mise env` must never be able to hang
// the discovery walk (the walk is what the card mirror AND the model-facing
// tools both run), and a directory's answer is reused for a short window so
// repeated walks do not re-spawn it.
const MISE_ENV_TIMEOUT_MS = 2500
const AUTO_DSN_TTL_MS = 10000
const autoDsnCache = new Map()

export async function runMiseEnv(subprocess, cwd, signal, timeoutMs) {
  if (!subprocess || !cwd) return undefined
  let exe
  try {
    exe = await subprocess.resolveExecutable('mise', undefined, signal)
  } catch (e) {
    return undefined
  }
  let handle
  try {
    handle = subprocess.spawn({
      argv: [exe, 'env'],
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
      graceMs: 5000,
      signal,
    })
  } catch (e) {
    return undefined
  }
  let out = ''
  if (handle.stdout) {
    handle.stdout.on('data', (c) => {
      out = (out + String(c)).slice(-131072)
    })
  }
  // Hard budget. `graceMs` above only bounds SIGTERM -> SIGKILL; without this a
  // `mise env` that never exits (a hung tool install, a trust prompt, a slow
  // config) blocked the WHOLE discovery walk forever — and because
  // dbhub_list_sources walks synchronously, the model's call hung with it and
  // was reported as "Interrupted" while the card still showed its cached rows.
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : MISE_ENV_TIMEOUT_MS
  let timer
  try {
    const done = handle.done.then((outcome) => outcome, () => 'error')
    // NOTE: the budget timer must stay REFERENCED. An `unref()`ed timer is not a
    // budget: when this probe is the only pending work (a bare process, or the
    // test that guards this path), the event loop drains and the process exits
    // before the timer can fire — the walk then never gets its answer. The timer
    // cannot outlive the call: `finally` clears it on both paths.
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget)
    })
    const outcome = await Promise.race([done, timedOut])
    if (outcome === 'timeout') {
      warnOnce('mise-env-timeout', 'mise env 未在 ' + budget + 'ms 内返回，已放弃自动发现（cwd=' + cwd + '）')
      return undefined
    }
    if (outcome === 'error' || !outcome || outcome.exitCode !== 0) return undefined
    return parseEnvOutput(out)
  } catch (e) {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
    try {
      handle.terminate()
    } catch (e) {
      /* ignore */
    }
  }
}

// Auto-discovery (mise env -> .env) supplies the workspace's 'default'
// environment only. Never consults the process environment.
//
// Results (including "found nothing") are cached for a short window: every
// publish and every model-facing list/execute walks the workspaces, and spawning
// `mise env` — which may be slow, or need the timeout above — for the same
// directory over and over was the dominant cost of both. A config file edited by
// hand is picked up again after at most AUTO_DSN_TTL_MS.
//
// The cache stores RESULTS, so an in-flight probe must ALSO be de-duplicated:
// the card's publish, the model's list and a connection test can all request the
// same directory within the same second, and each one used to spawn its own
// `mise env`. A rejection is deliberately NOT cached — the next caller must be
// able to really retry.
const autoDsnInFlight = new Map()

async function resolveAutoDsn(subprocess, fs, wsPath, signal) {
  const cached = autoDsnCache.get(wsPath)
  if (cached && Date.now() - cached.at < AUTO_DSN_TTL_MS) return cached.value
  const inFlight = autoDsnInFlight.get(wsPath)
  if (inFlight) return inFlight
  const run = probeAutoDsn(subprocess, fs, wsPath, signal).then(
    (value) => {
      autoDsnCache.set(wsPath, { at: Date.now(), value })
      return value
    },
  )
  autoDsnInFlight.set(wsPath, run)
  try {
    return await run
  } finally {
    // Clear the in-flight handle on BOTH paths: a cached rejection would turn
    // every later call into "the connection was never discovered".
    if (autoDsnInFlight.get(wsPath) === run) autoDsnInFlight.delete(wsPath)
  }
}

/** Forget every cached auto-discovery result (tests, and explicit rescans). */
export function resetAutoDsnCache() {
  autoDsnCache.clear()
  autoDsnInFlight.clear()
}

async function probeAutoDsn(subprocess, fs, wsPath, signal) {
  const miseMap = await runMiseEnv(subprocess, wsPath, signal)
  if (miseMap) {
    const dsn = dsnFromMap(miseMap)
    if (dsn) return { dsn, source: '工作区 mise env' }
  }
  try {
    const target = await fs.resolve('.env', { cwd: wsPath, signal })
    const map = parseEnvFile(await fs.readText(target, signal))
    const dsn = dsnFromMap(map)
    if (dsn) return { dsn, source: '工作目录 .env' }
  } catch (e) {
    /* no .env */
  }
  return undefined
}

/**
 * Resolve one workspace's connection rows, one per environment: every
 * persisted environment (v2 `environments.<env>`) plus, when no persisted
 * `default` overrides it, the auto-discovered 'default'. Auto-discovery is
 * never persisted — it is re-evaluated at every resolve (the card marks it
 * as such).
 * @returns rows [{ env, dsn, source }].
 */
export async function resolveWorkspaceEnvs(subprocess, fs, wsPath, signal) {
  const entry = store[wsPath]
  const persisted = entry && entry.environments && typeof entry.environments === 'object'
    ? entry.environments
    : {}
  const out = []
  for (const [env, envEntry] of Object.entries(persisted)) {
    if (envEntry && typeof envEntry.dsn === 'string' && envEntry.dsn.trim()) {
      out.push({
        env,
        dsn: envEntry.dsn.trim(),
        // Host-side only: the database password lives in the credential store.
        ...(isDsnSecretRef(envEntry.dsnPasswordRef) ? { dsnPasswordRef: envEntry.dsnPasswordRef } : {}),
        source: 'persisted(' + (envEntry.source || 'user') + ')',
        ro: readOnlyOf(envEntry),
        ssh: sshOf(envEntry),
        maxRows: maxRowsOf(envEntry),
        // The card's "recently updated" sort needs a per-ROW stamp; dropping it
        // here left every row without one and the sort silently fell back to
        // name order. Auto-discovered rows have no edit, so they stay 0.
        updatedAt: Number.isFinite(envEntry.updatedAt) ? envEntry.updatedAt : 0,
      })
    }
  }
  if (!Object.prototype.hasOwnProperty.call(persisted, 'default')) {
    const auto = await resolveAutoDsn(subprocess, fs, wsPath, signal)
    // An auto-discovered row has no store entry, therefore no options: it is
    // never read-only, never tunnelled and uncapped until the user (or the
    // model) sets an option, which promotes it to a persisted row (D10).
    if (auto) out.push({ env: 'default', dsn: auto.dsn, source: auto.source, ro: false, ssh: null, maxRows: 0 })
  }
  return out
}

/**
 * Environment slug for source naming. `default` stays bare (the legacy bare
 * source id) and a purely lowercase ASCII name IS its own slug, so existing
 * handles never move (`test` -> `test`, `dev` -> `dev`, `prod` -> `prod`).
 *
 * A name containing non-ASCII characters (中文, emoji…) cannot be projected to
 * ASCII without losing the identity that tells environments apart, so it is
 * hashed instead: `线上` -> `env-1a2b`. Before this, EVERY purely non-ASCII
 * name collapsed onto the same slug, so `线上` and `测试` produced the SAME
 * source id and a query for one silently hit the other.
 *
 * Every other name is projected too, because the projection itself is LOSSY:
 * `PROD` / `Prod` both slug to `prod`, `!!!` slugs to the empty string (which
 * used to fall back to `env`, the slug of a real environment named `env`), and a
 * name that only survives the `ENV_NAME_MAX` cap truncated can equal another
 * name's cap. Two rows sharing one source id is not a cosmetic problem:
 * `resolveSource` answers `{ambiguous}` for it forever, so the model cannot
 * reach that workspace's connection at all. Such names therefore carry
 * `shortHash(originalName)`, which keeps the readable prefix AND separates them
 * from the plain-ASCII handle (`prod` never equals `prod-<hash>`).
 */
const NON_ASCII_RE = /[^\x20-\x7e]/
export function envSlug(env) {
  if (env === 'default') return ''
  // Truncation is part of the projection: hash the name the caller asked for, so
  // two long names that differ only past the cap still get different handles.
  const full = rawEnvName(env)
  const raw = full.slice(0, ENV_NAME_MAX)
  if (!raw || raw === 'default') return ''
  const base = asciiSlug(raw)
  if (NON_ASCII_RE.test(raw)) return (base ? base + '-' : 'env-') + shortHash(raw)
  const slug = base || 'env'
  // The historical, readable handle: pure lowercase ASCII that IS its own slug.
  // Byte-identical on purpose — every already-published source id in this class
  // must keep resolving.
  if (slug === raw && raw === full) return slug
  return slug + '-' + shortHash(full)
}

// ── connection-failure classification (pure, shared by tools/card) ────────

// Failure kinds that warrant "check the credentials/connection" guidance.
export const AUTH_ERROR_RE = /access denied|ER_ACCESS_DENIED|28000|authentication|invalid (user|password)|password (incorrect|wrong|mismatch)|ECONNREFUSED|connection refused|SOURCE_UNREACHABLE|failed to connect|认证失败|连接被拒|无法连接/i

/** True when the (already scrubbed) text looks like an auth/connect problem. */
export function likelyAuthOrConnError(text) {
  return AUTH_ERROR_RE.test(String(text || ''))
}

// Failure text that proves the EMPTY account caused the rejection (MySQL
// "Access denied for user ''@host", Postgres `user ""`, etc.). Used to make
// the account field required in the minimal credentials dialog instead of
// offering an "empty account" choice that would re-create the failing DSN.
export const EMPTY_USER_RE = /user\s*(''|"")/i

/** True when the diagnostic blames an EMPTY account — the account must then
 * be entered, not left blank. */
export function emptyUserDenied(text) {
  return EMPTY_USER_RE.test(String(text || ''))
}

/**
 * Assemble a DSN from NON-SECRET fields plus a UI-entered password. The
 * password is only ever supplied here from a user-typed dialog, never from a
 * tool argument. Mirrors the module's legacy DSN builders so every entry path
 * (credentials dialog, field form, auto-probe candidate) produces the same
 * string. Portals: sqlite treats `host` as the file path; non-sqlite defaults
 * host to localhost and keeps an empty port/database verbatim.
 */
export function buildDsnFromParts(parts) {
  const p = parts || {}
  const type = String(p.type || '').trim().toLowerCase() || 'mysql'
  if (type === 'sqlite') return 'sqlite:///' + (String(p.host || '').trim() || 'test.db')
  const host = String(p.host || '').trim() || 'localhost'
  const port = String(p.port || '').trim()
  const user = String(p.user || '').trim()
  const password = String(p.password || '')
  const database = String(p.database || '').trim()
  const enc = (s) => encodeURIComponent(s)
  return type + '://' + enc(user) + ':' + enc(password) + '@' + host + (port ? ':' + port : '') + '/' + enc(database)
}

/**
 * True when the model's configure arguments name a DIFFERENT endpoint than an
 * existing row's metadata (any of type/host/port/database differs; blank args
 * are ignored). A changed endpoint means the old row is superseded for this
 * call — the plugin must re-run the probe-first loop against the NEW target
 * instead of verifying the old one.
 * @param args - the configure tool arguments.
 * @param existingMeta - `describeConn` output of the existing row (or empty).
 */
export function argsChangedEndpoint(args, existingMeta) {
  const meta = existingMeta || {}
  return ['type', 'host', 'port', 'database'].some((k) => {
    const v = typeof (args && args[k]) === 'string' ? String(args[k]).trim() : ''
    if (!v) return false
    return v.toLowerCase() !== String(meta[k] || '').trim().toLowerCase()
  })
}

/**
 * Decide the next step of dbhub_configure — pure decision helper so the
 * probe-first interaction is unit-testable without services:
 *  - 'existing-ok'      a stored row exists AND its real DSN (incl. password)
 *                       probes OK → confirm and return, no dialog.
 *  - 'ask-credentials'  only the credentials are missing/stale (probe failed
 *                       with an auth-style error) → ONE minimal account+password
 *                       dialog, everything else already known.
 *  - 'persist-direct'   no stored row, non-secret fields are complete, and the
 *                       candidate DSN (empty password) probes OK → persist with
 *                       NO dialog at all (password-less connections).
 *  - 'ask-mode'         everything else (info incomplete, non-auth failure,
 *                       sqlite) → the mode-selection dialog.
 * @returns {{kind: 'existing-ok'|'ask-credentials'|'persist-direct'|'ask-mode', failed?: boolean, emptyUserDenied?: boolean}}
 */
export function decideConfigureStep({ existingRow, existingCheck, prefill, candidateCheck }) {
  if (existingRow) {
    if (existingCheck && existingCheck.ok) return { kind: 'existing-ok' }
    if (existingCheck && likelyAuthOrConnError(existingCheck.message)) {
      return { kind: 'ask-credentials', emptyUserDenied: emptyUserDenied(existingCheck.message) }
    }
    return { kind: 'ask-mode', failed: true }
  }
  const pf = prefill || {}
  const type = String(pf.type || '').toLowerCase()
  const essentialsComplete = !!(type && pf.host && pf.database)
  if (essentialsComplete && type !== 'sqlite' && candidateCheck) {
    if (candidateCheck.ok) return { kind: 'persist-direct' }
    if (likelyAuthOrConnError(candidateCheck.message)) {
      return { kind: 'ask-credentials', emptyUserDenied: emptyUserDenied(candidateCheck.message) }
    }
    return { kind: 'ask-mode', failed: true }
  }
  return { kind: 'ask-mode', failed: !!(candidateCheck && !candidateCheck.ok) }
}