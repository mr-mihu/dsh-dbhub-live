// dsh-dbhub-live: paths, persistence, small utilities and workspace DSN
// resolution. Pure module — every function takes the services it needs as
// arguments, so this file never imports a Cordis service.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

export function dshHomeDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

export const DATA_DIR = join(dshHomeDir(), 'storages', 'dsh-dbhub-live')
export const STORE_PATH = join(DATA_DIR, 'credentials.json')
export const RUNTIME_DIR = join(DATA_DIR, 'dbhub-runtime')
export const RUNTIME_PATH = join(DATA_DIR, 'runtime.json')

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
 * @param store - the (normalized) credentials store.
 * @returns rows [{ wsPath, env, dsn, source?, updatedAt?, persisted: true }].
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
        persisted: true,
      })
    }
  }
  return rows
}

/**
 * Persist one workspace environment (creates or overwrites). The workspace
 * entry becomes `{ environments: { <env>: { dsn, source, updatedAt } } }`.
 * @returns the stored environment name ('default' when blank).
 */
export function setWorkspaceEnv(wsPath, env, dsn, source) {
  const entry = store[wsPath] && typeof store[wsPath] === 'object' && !Array.isArray(store[wsPath])
    ? store[wsPath]
    : {}
  const environments = entry.environments && typeof entry.environments === 'object' && !Array.isArray(entry.environments)
    ? { ...entry.environments }
    : {}
  const name = env === undefined || env === null || String(env).trim() === ''
    ? 'default'
    : String(env).trim()
  const cleanDsn = String(dsn).trim()
  if (!cleanDsn) throw new TypeError('DSN 不能为空')
  environments[name] = { dsn: cleanDsn, source: String(source || 'user'), updatedAt: Date.now() }
  store[wsPath] = { environments }
  saveStore(store)
  return name
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
  const name = env === undefined || env === null || String(env).trim() === '' ? 'default' : String(env).trim()
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

export const store = loadStore()
export const runtime = loadRuntime()

// ── small utils ───────────────────────────────────────────────────────────

export function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'ws'
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
 * stderr tails, error messages): replaces the known DSN's password and full
 * DSN occurrences, plus generic `password=` / `passwd=` tokens, so a leak from
 * the MCP server can never reach the model. Passwords and usernames never
 * cross.
 */
export function scrubSecrets(text, dsn) {
  let out = String(text || '')
  const pass = dsnPassword(dsn)
  if (pass && pass !== '****') {
    out = out.split(pass).join('****')
    out = out.replace(/(:\/\/[^:/@]+:)[^@]+(@)/g, '$1****$2')
  }
  out = out.replace(/(password|passwd|pwd)\s*(:|=)\s*["']?[^"'\s,;]+/gi, '$1$2****')
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

export async function runMiseEnv(subprocess, cwd, signal) {
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
  try {
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return undefined
    return parseEnvOutput(out)
  } catch (e) {
    return undefined
  } finally {
    try {
      handle.terminate()
    } catch (e) {
      /* ignore */
    }
  }
}

// Auto-discovery (mise env -> .env) supplies the workspace's 'default'
// environment only. Never consults the process environment.
async function resolveAutoDsn(subprocess, fs, wsPath, signal) {
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
      out.push({ env, dsn: envEntry.dsn.trim(), source: 'persisted(' + (envEntry.source || 'user') + ')' })
    }
  }
  if (!Object.prototype.hasOwnProperty.call(persisted, 'default')) {
    const auto = await resolveAutoDsn(subprocess, fs, wsPath, signal)
    if (auto) out.push({ env: 'default', dsn: auto.dsn, source: auto.source })
  }
  return out
}

/** Environment slug for tool/source naming; 'default' stays bare. */
export function envSlug(env) {
  return env === 'default' ? '' : slugify(env) || 'env'
}