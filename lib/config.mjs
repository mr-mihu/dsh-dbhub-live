// dsh-dbhub-live: paths, persistence, small utilities and workspace DSN
// resolution. Pure module — every function takes the services it needs as
// arguments, so this file never imports a Cordis service.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

export function dshHomeDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

export const DATA_DIR = join(dshHomeDir(), 'storages', 'dsh-dbhub-live')
export const STORE_PATH = join(DATA_DIR, 'credentials.json')
export const TOML_PATH = join(DATA_DIR, 'dbhub.toml')
export const RUNTIME_DIR = join(DATA_DIR, 'dbhub-runtime')
export const RUNTIME_PATH = join(DATA_DIR, 'runtime.json')
export const IDLE_MS = 10 * 60 * 1000

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
 * toggle) so legacy or hand-edited files cannot poison initialization:
 * non-boolean `enabled`, non-object entries and empty-DSN entries are
 * dropped; the authoritative `dsn` is trimmed. Unknown entry fields are
 * preserved so a newer version's writes are never stripped by an older
 * loader (forward compatibility).
 * @param raw - parsed JSON document (any shape).
 * @returns the normalized plain object.
 */
export function normalizeStore(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (typeof raw.enabled === 'boolean') defineOwn(out, 'enabled', raw.enabled)
  for (const [key, entry] of Object.entries(raw)) {
    if (key === 'enabled') continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const dsn = typeof entry.dsn === 'string' ? entry.dsn.trim() : ''
    if (!dsn) continue
    defineOwn(out, key, { ...entry, dsn })
  }
  return out
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

/** Write a JSON document, recreating the directory first. Never throws. */
function writeJsonFile(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2))
  } catch (e) {
    warnOnce('write:' + path,
      '写入 ' + path + ' 失败（运行目录被删除或写入被拦截），本项仅在内存中生效：' + String((e && e.message) || e))
  }
}

/** Write the generated dbhub.toml; the caller treats false as an init error. */
export function writeToml(text) {
  if (!ensureStorageDir()) return false
  try {
    writeFileSync(TOML_PATH, text)
    return true
  } catch (e) {
    warnOnce('write:' + TOML_PATH, '写入 dbhub.toml 失败：' + String((e && e.message) || e))
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

export function saveStore(store) {
  writeJsonFile(STORE_PATH, store)
}

export function loadRuntime() {
  const raw = readJsonFile(RUNTIME_PATH, {})
  const normalized = normalizeRuntime(raw)
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) writeJsonFile(RUNTIME_PATH, normalized)
  return normalized
}

export function saveRuntime(runtime) {
  writeJsonFile(RUNTIME_PATH, runtime)
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

export function tomlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

export function shortHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Mask the password of a DSN for labels/results; passwords never leave the
// plugin unmasked in user-visible text.
export function maskDsn(dsn) {
  try {
    const u = new URL(dsn.replace(/^jdbc:/i, ''))
    if (u.password) u.password = '****'
    return u.href
  } catch (e) {
    return dsn.replace(/(:\/\/[^:/@]+:)[^@]+(@)/, '$1****$2')
  }
}

export function fingerprintOf(sources) {
  return sources.map((s) => s.id + '|' + s.dsn).join('\n')
}

export function generateToml(sources) {
  const lines = ['# Auto-generated by dsh-dbhub-live — do not edit. Regenerated on demand.']
  for (const s of sources) {
    lines.push('[[sources]]')
    lines.push('id = "' + tomlEscape(s.id) + '"')
    lines.push('dsn = "' + tomlEscape(s.dsn) + '"')
  }
  return lines.join('\n') + '\n'
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

// Resolve one workspace's DSN: persisted explicit entry first, then
// auto-discovery (mise env -> .env). Never consults the process environment.
export async function resolveWorkspaceDsn(subprocess, fs, wsPath, signal) {
  const entry = store[wsPath]
  if (entry && entry.dsn && typeof entry.dsn === 'string' && entry.dsn.trim()) {
    return { dsn: entry.dsn.trim(), source: 'persisted(' + (entry.source || 'user') + ')' }
  }
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