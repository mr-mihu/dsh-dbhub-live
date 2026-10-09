// dsh-dbhub-live: paths, persistence, small utilities and workspace DSN
// resolution. Pure module — every function takes the services it needs as
// arguments, so this file never imports a Cordis service.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

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

// Ensure the storage directory exists once at load; every writer below
// (store, runtime, toml, managed dbhub prefix) assumes it is present.
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch (e) {
  /* best-effort */
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
 * Normalize a credentials document (per-workspace entries + the enabled
 * toggle) so legacy or hand-edited files cannot poison initialization.
 * Store model (v2): each workspace entry is `{ environments: { <env>: {
 * dsn, source?, updatedAt? } } }`; a v1 entry `{ dsn, source?, updatedAt? }`
 * is migrated into `environments.default` automatically. Non-boolean
 * `enabled`, non-object entries, empty-DSN entries and empty environment maps
 * are dropped; DSNs are trimmed. Unknown fields are preserved so a newer
 * version's writes are never stripped by an older loader (forward
 * compatibility).
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
      if (Object.keys(environments).length > 0) defineOwn(out, key, { environments })
    } else {
      // v1 migration: a bare dsn entry becomes the 'default' environment
      const clean = normalizeEnv(entry)
      if (clean) defineOwn(out, key, { environments: { default: clean } })
    }
  }
  return out
}

/**
 * List every persisted workspace environment as flat rows for the card.
 * Each row also carries the environment's options: `ro` (read-only) and `ssh`
 * (the normalized tunnel config, SECRETS INCLUDED — this is host-side data and
 * every model/UI-facing copy goes through `describeEnvOptions`).
 * @param store - the (normalized) credentials store.
 * @returns rows [{ wsPath, env, dsn, source?, updatedAt?, ro, ssh, persisted: true }].
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
        ...(typeof envEntry.source === 'string' && envEntry.source ? { source: envEntry.source } : {}),
        ...(typeof envEntry.updatedAt === 'number' && Number.isFinite(envEntry.updatedAt) ? { updatedAt: envEntry.updatedAt } : {}),
        ro: readOnlyOf(envEntry),
        ssh: sshOf(envEntry),
        persisted: true,
      })
    }
  }
  return rows
}

// ── environment options: read-only + SSH tunnel (store model v3) ──────────
//
// v3 keeps the exact v2 layout and merely adds two optional fields to an
// environment entry:
//   { dsn, source, updatedAt, readOnly?: true, ssh?: {…} }
// Compatibility is structural, not versioned: `normalizeStore` already
// preserves unknown env fields (so an older build reading a v3 file keeps the
// new keys instead of stripping them), and a v2 file simply reads back as
// "not read-only, no tunnel".
//
// SSH secrets (`password`, `passphrase`) sit next to `dsn` and share its trust
// model (same file, same 0600-by-user-directory guarantee).

/** Longest accepted values (a hand-edited file cannot inject a huge blob). */
const SSH_LIMITS = { host: 255, user: 128, keyPath: 1024, secret: 512, proxyJump: 1024 }

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
 * being preserved from the stored entry.
 *
 * @param raw - `{ host, port?, user, auth, keyPath?, password?, passphrase?, proxyJump? }`.
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
  } else {
    const password = String(raw.password === undefined || raw.password === null ? '' : raw.password)
    if (!password) return null
    out.password = password.slice(0, SSH_LIMITS.secret)
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
 * @param incoming - the block from the card (secrets possibly blank/omitted).
 * @param storedRaw - the stored raw block (or null).
 * @returns the merged raw block (still to be normalized/validated).
 */
export function mergeSshOptions(incoming, storedRaw) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
  const prev = normalizeSshOptions(storedRaw)
  const filled = (v) => v !== undefined && v !== null && String(v).trim() !== ''
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
    const passphrase = filled(incoming.passphrase) ? incoming.passphrase : (sameKind ? prev.passphrase : '')
    if (passphrase) merged.passphrase = passphrase
  } else if (auth === 'password') {
    const sameKind = !!(prev && prev.auth === 'password')
    const password = filled(incoming.password) ? incoming.password : (sameKind ? prev.password : '')
    if (password) merged.password = password
  }
  return merged
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
  const ssh = sshOf(envEntry)
  if (!ssh) return { ro, ssh: null }
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
    ssh: {
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      authKind: ssh.auth,
      hasPassword: !!ssh.password,
      hasPassphrase: !!ssh.passphrase,
      keyReady,
      proxyJump: ssh.proxyJump || '',
    },
  }
}

/**
 * Copy the previous entry's option fields onto a freshly built entry, applying
 * an explicit patch when one is given.
 *
 * Semantics (D4): an OMITTED patch preserves whatever the entry had — a plain
 * `dbhub_configure` DSN update must never silently drop the read-only flag or
 * the tunnel. An explicit `false` / `null` DELETES the field.
 */
function applyEnvOptions(target, previous, opts) {
  if (!opts || typeof opts !== 'object') {
    if (previous && previous.readOnly === true) target.readOnly = true
    const ssh = sshOf(previous)
    if (ssh) target.ssh = ssh
    return target
  }
  if (opts.readOnly === true) target.readOnly = true
  else if (opts.readOnly === undefined && previous && previous.readOnly === true) target.readOnly = true
  if (opts.ssh !== undefined) {
    const ssh = opts.ssh === null ? null : normalizeSshOptions(opts.ssh)
    if (ssh) target.ssh = ssh
  } else {
    const ssh = sshOf(previous)
    if (ssh) target.ssh = ssh
  }
  return target
}

/**
 * Persist one workspace environment (creates or overwrites). The workspace
 * entry becomes `{ environments: { <env>: { dsn, source, updatedAt, … } } }`.
 *
 * `opts` = `{ readOnly?: boolean|null, ssh?: object|null }`. When it is
 * OMITTED the entry's existing read-only / tunnel options are PRESERVED (a
 * DSN-only update must not clear a user's safety switch); `readOnly: false` and
 * `ssh: null` delete the field.
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
  const previous = environments[name]
  const next = { dsn: cleanDsn, source: String(source || 'user'), updatedAt: Date.now() }
  applyEnvOptions(next, previous, opts)
  environments[name] = next
  store[wsPath] = { environments }
  saveStore(store)
  return name
}

/**
 * Change ONLY the options of an existing environment — the DSN, its source and
 * its updatedAt are left exactly as they were (the UI's "toggle read-only" and
 * "configure the tunnel" writes have no connection data to offer, and requiring
 * one would make the user re-type a password to flip a checkbox).
 *
 * @param patch - `{ readOnly?: boolean, ssh?: object|null }` (only the keys
 *   present are touched).
 * @returns the environment name, or `undefined` when no such persisted row
 *   exists (the caller decides whether to promote an auto-discovered row).
 */
export function setWorkspaceEnvOptions(wsPath, env, patch) {
  const entry = store[wsPath]
  if (!entry || typeof entry !== 'object' || !entry.environments || typeof entry.environments !== 'object') return undefined
  const name = normalizeEnvName(env)
  const current = entry.environments[name]
  if (!current || typeof current.dsn !== 'string' || !current.dsn.trim()) return undefined
  const environments = { ...entry.environments }
  const next = { ...current, updatedAt: Date.now() }
  if (patch && typeof patch === 'object') {
    if (patch.readOnly === true) next.readOnly = true
    else if (patch.readOnly === false) delete next.readOnly
    if (patch.ssh !== undefined) {
      if (patch.ssh === null) delete next.ssh
      else {
        const ssh = normalizeSshOptions(patch.ssh)
        if (!ssh) return undefined
        next.ssh = ssh
      }
    }
  }
  environments[name] = next
  store[wsPath] = { environments }
  saveStore(store)
  return name
}


/**
 * Rename one persisted environment IN PLACE: the DSN, its source provenance
 * and the connection itself move with the name, so no credential is ever
 * re-entered (and never crosses the model). Renaming onto an existing
 * environment overwrites that entry — callers that can be reached by the
 * model must confirm first. Only persisted rows can be renamed; the
 * auto-discovered 'default' is not a stored row and is never renamed.
 * @returns the resulting environment name, or undefined when there is
 *   nothing to rename.
 */
export function renameWorkspaceEnv(wsPath, from, to) {
  const entry = store[wsPath]
  if (!entry || typeof entry !== 'object' || !entry.environments || typeof entry.environments !== 'object') return undefined
  const oldName = normalizeEnvName(from)
  const newName = normalizeEnvName(to)
  const current = entry.environments[oldName]
  if (!current || typeof current.dsn !== 'string' || !current.dsn.trim()) return undefined
  if (oldName === newName) return newName
  const environments = { ...entry.environments }
  delete environments[oldName]
  environments[newName] = { ...current, dsn: current.dsn.trim(), updatedAt: Date.now() }
  store[wsPath] = { environments }
  saveStore(store)
  return newName
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
  const name = normalizeEnvName(env)
  if (!Object.prototype.hasOwnProperty.call(entry.environments, name)) return false
  const environments = { ...entry.environments }
  delete environments[name]
  if (Object.keys(environments).length === 0) delete store[wsPath]
  else store[wsPath] = { environments }
  saveStore(store)
  return true
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
    mkdirSync(DATA_DIR, { recursive: true })
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
 * Recreates the directory first. Never throws; returns whether it succeeded.
 */
function writeJsonFile(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, path)
    return true
  } catch (e) {
    warnOnce('write:' + path,
      '写入 ' + path + ' 失败（运行目录被删除或写入被拦截），本项仅在内存中生效：' + String((e && e.message) || e))
    return false
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
export function normalizeEnvName(env) {
  const raw = String(env === undefined || env === null ? '' : env)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!raw) return 'default'
  return raw.slice(0, ENV_NAME_MAX)
}

export function shortHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Mask the password of a DSN for legacy labels; passwords never leave the
// plugin unmasked in user-visible text. New code should prefer describeConn /
// connLabel (metadata only) so even the username never surfaces.
export function maskDsn(dsn) {
  try {
    const u = new URL(dsn.replace(/^jdbc:/i, ''))
    if (u.password) u.password = '****'
    return u.href
  } catch (e) {
    return dsn.replace(/(:\/\/[^:/@]+:)[^@]+(@)/, '$1****$2')
  }
}

// ── zero-knowledge connection metadata ────────────────────────────────────
//
// The model must NEVER see a DSN (it carries the password). Everything the
// model-facing surface prints — tool descriptions, list rows, result headers,
// card summaries — goes through describeConn/connLabel, which extract ONLY
// db type / host / port / database. Passwords and usernames never cross.

/**
 * Extract NON-SECRET metadata from a DSN. Never returns user or password.
 * @param dsn - a full connection string (kept host-side only).
 * @returns { type, host, port, database } (empty strings when unknown).
 */
export function describeConn(dsn) {
  const out = { type: '', host: '', port: '', database: '' }
  const s = String(dsn || '').trim().replace(/^jdbc:/i, '')
  let u
  try {
    u = new URL(s)
  } catch (e) {
    /* non-URL (bare sqlite path etc.) */
  }
  if (u) {
    let type = (u.protocol || '').replace(/:$/, '').toLowerCase()
    if (type === 'postgresql') type = 'postgres' // normalize to dbhub's scheme
    out.type = type
    if (u.hostname) out.host = u.hostname
    if (u.port) out.port = u.port
    const db = (u.pathname || '').replace(/^\//, '')
    if (db) out.database = decodeURIComponent(db)
  } else {
    const m = s.match(/^sqlite:\/\/(.+)$/i)
    if (m && m[1]) {
      out.type = 'sqlite'
      out.database = m[1]
    }
  }
  return out
}

/**
 * One-line human label for a DSN: `type://host:port/database` — never user,
 * never password. sqlite keeps its file path.
 */
export function connLabel(dsn) {
  const c = describeConn(dsn)
  if (!c.type) return String(dsn || '').trim() || '(未知连接)'
  if (c.type === 'sqlite' && c.database) {
    return 'sqlite:///' + c.database.replace(/\\/g, '/')
  }
  let s = c.type + '://' + (c.host || 'localhost')
  if (c.port) s += ':' + c.port
  s += '/' + c.database
  return s
}

/** Extract the password component of a DSN (or undefined). */
export function dsnPassword(dsn) {
  const s = String(dsn || '')
  try {
    const u = new URL(s.replace(/^jdbc:/i, ''))
    if (u.password) return u.password
  } catch (e) {
    /* fall through */
  }
  const m = s.match(/(:\/\/[^:/@]+:)([^@]+)(@)/)
  return m ? m[2] : undefined
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
  const pass = dsnPassword(dsn)
  if (pass && pass !== '****') out = out.split(pass).join('****')
  const extras = Array.isArray(extraSecrets) ? extraSecrets : []
  for (const secret of extras) {
    const s = String(secret === undefined || secret === null ? '' : secret)
    if (!s) continue
    out = out.split(s).join('****')
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
        source: 'persisted(' + (envEntry.source || 'user') + ')',
        ro: readOnlyOf(envEntry),
        ssh: sshOf(envEntry),
      })
    }
  }
  if (!Object.prototype.hasOwnProperty.call(persisted, 'default')) {
    const auto = await resolveAutoDsn(subprocess, fs, wsPath, signal)
    // An auto-discovered row has no store entry, therefore no options: it is
    // never read-only and never tunnelled until the user (or the model) sets an
    // option, which promotes it to a persisted row (D10).
    if (auto) out.push({ env: 'default', dsn: auto.dsn, source: auto.source, ro: false, ssh: null })
  }
  return out
}

/**
 * Environment slug for source naming. `default` stays bare (the legacy bare
 * source id) and a purely ASCII name keeps its readable slug, so existing
 * handles never move (`test` -> `test`, `dev` -> `dev`).
 *
 * A name containing non-ASCII characters (中文, emoji…) cannot be projected to
 * ASCII without losing the identity that tells environments apart, so it is
 * hashed instead: `线上` -> `env-1a2b`. Before this, EVERY purely non-ASCII
 * name collapsed onto the same slug, so `线上` and `测试` produced the SAME
 * source id and a query for one silently hit the other.
 */
const NON_ASCII_RE = /[^\x20-\x7e]/
export function envSlug(env) {
  if (env === 'default') return ''
  const raw = normalizeEnvName(env)
  if (raw === 'default') return ''
  const base = asciiSlug(raw)
  if (!NON_ASCII_RE.test(raw)) return base || 'env'
  return (base ? base + '-' : 'env-') + shortHash(raw)
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