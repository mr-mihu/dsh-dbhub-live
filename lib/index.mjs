// dsh-dbhub-live v2: PERSISTENT multi-source dbhub manager.
//
// Cordis namespace plugin (named exports, no default export). Installed as a
// dsh profile bundle: `dsh plugin --profile web add dsh-dbhub-live`.
//
// Architecture (B'):
//   - ONE persistent `dbhub --transport stdio --config <generated dbhub.toml>`
//     process, managed by this plugin (idle recycle, respawn on demand).
//   - dbhub.toml is auto-generated from every registered workspace's connection
//     config and hot-reloaded by dbhub itself. Users never maintain it.
//   - Each workspace becomes a dbhub source; tools are registered per-workspace
//     (`dbhub_execute_sql_<slug>` / `dbhub_search_objects_<slug>`) with the
//     connection target (host:port/database, password masked) labeled in the
//     tool description and result — picking a workspace = picking a tool name.
//   - Ad-hoc temporary connections (`dbhub_query`/`dbhub_query_objects`): model
//     passes a full dsn per request; each call is an independent throwaway
//     dbhub, so two calls can query two different databases at once.
//
// Per-workspace connection sources (priority):
//   1. persisted explicit entry (`credentials.json`, user-provided or
//      user-authorized collection)              -> `dbhub_configure` tool
//   2. auto-discovery: `mise env` (mise.toml [env]) -> `.env` (DSN/DB_*)
//      (evaluated at generation time, never persisted)
//   3. none: `dbhub_configure` asks the user, or — ONLY after explicit
//      authorization — scans the workspace's common DB config files and shows
//      candidates for confirmation. Scanning reads files that may contain
//      passwords and costs tokens, so it is never silent.
//
// Data (credentials.json, dbhub.toml) lives in $DSH_HOME/storages/dsh-dbhub-live
// — outside the module tree, since the module may be installed under the
// profile's node_modules (pnpm-managed) which must not be written to.
// The process environment is deliberately NOT consulted for connections.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'dsh-dbhub-live'
// Real-module Guard requires declared injection before touching `ctx.tools`;
// the timer mixin powers idle recycling.
const inject = ['tools', 'timer']

function dshHomeDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(dshHomeDir(), 'storages', 'dsh-dbhub-live')
const STORE_PATH = join(DATA_DIR, 'credentials.json')
const TOML_PATH = join(DATA_DIR, 'dbhub.toml')
const IDLE_MS = 10 * 60 * 1000
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch (e) { /* best-effort */ }

// ── persistence ──────────────────────────────────────────────────────────

function loadStore() {
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8')) || {}
  } catch (e) {
    return {}
  }
}

function saveStore(store) {
  try {
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
  } catch (e) {
    /* best-effort */
  }
}

const store = loadStore()

// ── managed dbhub runtime (auto-install for users without one) ────────────
// When no `dbhub` executable is present (PATH / mise / previous install), the
// plugin installs the MCP server once, on demand, into a private prefix under
// the storage dir, then reuses that binary on every later boot. This is
// deliberately an install-ONCE-at-init design (NOT `npx` on every spawn):
// the ad-hoc tools spawn a fresh dbhub process on EVERY call, so an npx-per-
// call approach would add several hundred ms to every query and break offline.
// The resolved executable path is persisted so later boots skip re-discovery.
const DBHUB_PACKAGE = process.env.DSH_DBHUB_PACKAGE || '@bytebase/dbhub'
// How often the AUTO-INSTALLED copy is refreshed to the latest version.
// Only our own managed install is refreshed — a dbhub the user installed
// himself (PATH / mise) is never touched. Override via DSH_DBHUB_UPDATE_DAYS
// (e.g. "0" disables auto-update; any positive number sets the day interval).
const DBHUB_UPDATE_MS = (() => {
  const raw = process.env.DSH_DBHUB_UPDATE_DAYS
  const n = raw !== undefined && raw !== '' && Number(raw) >= 0 ? Number(raw) : 7
  return n * 24 * 60 * 60 * 1000
})()
const RUNTIME_DIR = join(DATA_DIR, 'dbhub-runtime')
const RUNTIME_PATH = join(DATA_DIR, 'runtime.json')

function loadRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_PATH, 'utf8')) || {}
  } catch (e) {
    return {}
  }
}

function saveRuntime(r) {
  try {
    writeFileSync(RUNTIME_PATH, JSON.stringify(r, null, 2))
  } catch (e) {
    /* best-effort */
  }
}

const runtime = loadRuntime()

// ── small utils ──────────────────────────────────────────────────────────

function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'ws'
}

function tomlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function sessionCwd(agent) {
  try {
    const s = agent && agent.session
    if (!s) return undefined
    const h = s.header
    if (h && typeof h.cwd === 'string' && h.cwd) return h.cwd
    if (typeof s.cwd === 'string' && s.cwd) return s.cwd
    if (s.meta && typeof s.meta.cwd === 'string' && s.meta.cwd) return s.meta.cwd
  } catch (e) {
    /* fall through */
  }
  return undefined
}

function parseEnvFile(text) {
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

function parseEnvOutput(text) {
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
function dsnFromEnv(env) {
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

function dsnFromMap(map) {
  if (map.DSN) return String(map.DSN).trim()
  return dsnFromEnv(map)
}

async function runMiseEnv(subprocess, cwd, signal) {
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

// ── workspaces & config generation ───────────────────────────────────────

// Workspaces: live registry first, then a direct read of the durable
// workspace registry file (robust at boot, when services may not be ready).
async function listWorkspaces(ctx) {
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

async function resolveWorkspaceDsn(subprocess, fs, wsPath, signal) {
  // 1) persisted explicit entry
  const entry = store[wsPath]
  if (entry && entry.dsn && typeof entry.dsn === 'string' && entry.dsn.trim()) {
    return { dsn: entry.dsn.trim(), source: 'persisted(' + (entry.source || 'user') + ')' }
  }
  // 2) auto-discovery: mise env -> .env
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

function fingerprintOf(sources) {
  return sources.map((s) => s.id + '|' + s.dsn).join('\n')
}

function generateToml(sources) {
  const lines = ['# Auto-generated by dsh-dbhub-live — do not edit. Regenerated on demand.']
  for (const s of sources) {
    lines.push('[[sources]]')
    lines.push('id = "' + tomlEscape(s.id) + '"')
    lines.push('dsn = "' + tomlEscape(s.dsn) + '"')
  }
  return lines.join('\n') + '\n'
}

// ── dbhub executable (pin a modern version, prefer 1.2.x) ────────────────

function findDbhubExe() {
  // 1) a previously managed / mise-installed binary is the fastest path
  if (runtime.dbhubExe) {
    try {
      if (existsSync(runtime.dbhubExe) && statSync(runtime.dbhubExe).isFile()) return runtime.dbhubExe
    } catch (e) {
      runtime.dbhubExe = undefined
      saveRuntime(runtime)
    }
  }
  // 2) mise-managed install (`mise x npm:@bytebase/dbhub` or a manual install)
  const dataDir = process.env.MISE_DATA_DIR
  if (dataDir) {
    try {
      const base = join(dataDir, 'npm-bytebase-dbhub')
      const versions = readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      const cmp = (a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
        return 0
      }
      versions.sort(cmp)
      for (let i = versions.length - 1; i >= 0; i--) {
        for (const bin of ['dbhub.cmd', 'dbhub']) {
          const p = join(base, versions[i], 'node_modules', '.bin', bin)
          try {
            if (existsSync(p) && statSync(p).isFile()) {
              runtime.dbhubExe = p
              saveRuntime(runtime)
              return p
            }
          } catch (e) {
            /* keep looking */
          }
        }
      }
    } catch (e) {
      /* fall through */
    }
  }
  return undefined
}

function dbhubExeInDir(dir) {
  if (!dir) return undefined
  for (const bin of ['dbhub.cmd', 'dbhub']) {
    const p = join(dir, 'node_modules', '.bin', bin)
    try {
      if (existsSync(p) && statSync(p).isFile()) return p
    } catch (e) {
      /* keep looking */
    }
  }
  return undefined
}

let installingDbhub // single in-flight install guard

// Install the dbhub MCP server once, into a private prefix under the storage
// dir. Uses `npm install --prefix <RUNTIME_DIR>` (deterministic, offline-safe
// afterwards) rather than `npx <pkg>` per call. Package and version can be
// overridden via DSH_DBHUB_PACKAGE; by default installs the latest.
async function installDbhub(subprocess, signal) {
  if (installingDbhub) return installingDbhub
  if (!subprocess) {
    throw new Error('subprocess 服务不可用，无法自动安装 dbhub')
  }
  installingDbhub = (async () => {
    let npmExe
    try {
      npmExe = await subprocess.resolveExecutable('npm', undefined, signal)
    } catch (e) {
      throw new Error('未找到 npm，无法自动安装 dbhub（请先安装 Node.js/npm，或手动把 dbhub 加入 PATH 后重试）')
    }
    const args = [
      'install',
      DBHUB_PACKAGE,
      '--prefix', RUNTIME_DIR,
      '--no-save', '--no-fund', '--no-audit',
      '--loglevel=error',
    ]
    let handle
    try {
      handle = subprocess.spawn({
        argv: buildSpawnArgv(subprocess, npmExe, args),
        cwd: DATA_DIR,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 180000,
        signal,
      })
    } catch (e) {
      throw new Error('启动 npm 安装失败: ' + String((e && e.message) || e))
    }
    let errTail = ''
    if (handle.stderr) {
      handle.stderr.on('data', (c) => {
        errTail = (errTail + String(c)).slice(-2000)
      })
    }
    try {
      const outcome = await handle.done
      if (outcome.exitCode !== 0 || outcome.signal) {
        throw new Error(
          '自动安装 dbhub 失败 (npm exit ' + outcome.exitCode + ')' + (errTail ? ': ' + errTail : ''),
        )
      }
    } finally {
      try {
        handle.terminate()
      } catch (e) {
        /* ignore */
      }
    }
    const exe = dbhubExeInDir(RUNTIME_DIR)
    if (!exe) {
      throw new Error('npm 安装完成，但未在 ' + RUNTIME_DIR + ' 下找到 dbhub 可执行文件')
    }
    runtime.dbhubInstallAt = Date.now()
    console.log('[dsh-dbhub-live] 已自动安装 dbhub (' + DBHUB_PACKAGE + ') → ' + exe)
    return exe
  })()
  try {
    const exe = await installingDbhub
    return exe
  } finally {
    installingDbhub = undefined
  }
}

// Resolve the dbhub executable: persisted → mise → PATH → install-on-demand.
async function resolveDbhubExe(subprocess, signal) {
  const cached = findDbhubExe()
  if (cached) return cached
  if (subprocess) {
    try {
      const exe = await subprocess.resolveExecutable('dbhub', undefined, signal)
      runtime.dbhubExe = exe
      saveRuntime(runtime)
      return exe
    } catch (e) {
      /* not on PATH — fall through to install */
    }
  }
  const installed = await installDbhub(subprocess, signal)
  runtime.dbhubExe = installed
  saveRuntime(runtime)
  return installed
}

// Is the current executable one WE auto-installed (as opposed to a dbhub the
// user installed himself via PATH / mise)? Only ours is eligible for auto-
// update — we must never silently upgrade a user-managed binary.
function isAutoManagedExe() {
  const exe = runtime.dbhubExe
  if (!exe || typeof exe !== 'string') return false
  const dir = RUNTIME_DIR.replace(/[\\/]+$/, '')
  const e = exe.replace(/[\\/]+$/, '')
  return e.toLowerCase().startsWith(dir.toLowerCase())
}

// Refresh the auto-installed dbhub to the latest version, but only when a
// configured interval has elapsed. Runs `npm install` into the SAME prefix,
// which upgrades the binary in place — the resolved path stays valid, so
// concurrently-running queries keep using a working dbhub throughout.
// Never blocks boot: callers should NOT await it (see apply()).
async function maybeRefreshDbhub(subprocess) {
  if (!isAutoManagedExe()) return
  if (!(runtime.dbhubInstallAt > 0)) return
  if (DBHUB_UPDATE_MS <= 0) return // auto-update disabled
  if (Date.now() - runtime.dbhubInstallAt < DBHUB_UPDATE_MS) return
  try {
    await installDbhub(subprocess, undefined)
    console.log('[dsh-dbhub-live] dbhub 已自动更新到最新版')
  } catch (e) {
    // Non-fatal: keep using the existing (older) binary.
    console.error('[dsh-dbhub-live] dbhub 自动更新失败（沿用现有版本）: ' + String((e && e.message) || e))
  }
}

// ── MCP client (persistent) ──────────────────────────────────────────────

function createMcpClient(handle, onStderr, onNotification) {
  let buf = ''
  let nextId = 1
  let closed = false
  const pending = new Map()
  const settleAll = (err) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  if (handle.stdout) {
    handle.stdout.on('data', (chunk) => {
      buf += String(chunk)
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch (e) {
          continue
        }
        if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error('MCP error: ' + JSON.stringify(msg.error)))
          else p.resolve(msg.result)
        } else if (msg && msg.method && !msg.id && onNotification) {
          try {
            onNotification(msg)
          } catch (e) {
            /* contain listener failures */
          }
        }
      }
    })
  }
  if (handle.stderr && onStderr) handle.stderr.on('data', onStderr)
  handle.done.then((outcome) => {
    closed = true
    settleAll(
      new Error(
        'dbhub exited (code ' + outcome.exitCode + ')' + (outcome.signal ? ', signal ' + outcome.signal : ''),
      ),
    )
  }).catch((err) => {
    closed = true
    settleAll(err instanceof Error ? err : new Error(String(err)))
  })
  return {
    get closed() {
      return closed
    },
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        if (!handle.stdin) {
          reject(new Error('dbhub stdin unavailable'))
          return
        }
        if (closed) {
          reject(new Error('dbhub process is down (will auto-restart on next call)'))
          return
        }
        pending.set(id, { resolve, reject })
        try {
          handle.stdin.write(
            JSON.stringify(
              params === undefined
                ? { jsonrpc: '2.0', id, method }
                : { jsonrpc: '2.0', id, method, params },
            ) + '\n',
          )
        } catch (e) {
          pending.delete(id)
          reject(e)
        }
      })
    },
    notify(method, params) {
      if (!handle.stdin || closed) return
      try {
        handle.stdin.write(
          JSON.stringify(
            params === undefined
              ? { jsonrpc: '2.0', method }
              : { jsonrpc: '2.0', method, params },
          ) + '\n',
        )
      } catch (e) {
        /* ignore */
      }
    },
  }
}

// ── server lifecycle ─────────────────────────────────────────────────────

const server = {
  handle: undefined,
  client: undefined,
  generatedFingerprint: undefined,
  starting: undefined,
}

function terminateServer() {
  const h = server.handle
  server.handle = undefined
  server.client = undefined
  if (h) {
    try {
      h.terminate()
    } catch (e) {
      /* ignore */
    }
  }
}

function buildSpawnArgv(subprocess, exe, args) {
  if (process.platform !== 'win32') return [exe, ...args]
  if (!/\.(cmd|bat)$/i.test(exe)) return [exe, ...args]
  const quote = (s) => (/[\s&|<>^"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)
  return ['cmd.exe', '/c', [quote(exe), ...args.map(quote)].join(' ')]
}

async function spawnServer(subprocess, signal) {
  let exe
  try {
    exe = await resolveDbhubExe(subprocess, signal)
  } catch (e) {
    return { error: '无法获取 dbhub: ' + String((e && e.message) || e) }
  }
  let handle
  try {
    handle = subprocess.spawn({
      argv: buildSpawnArgv(subprocess, exe, ['--transport', 'stdio', '--config', TOML_PATH]),
      cwd: DATA_DIR,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      signal,
    })
  } catch (e) {
    return { error: '启动 dbhub 失败: ' + String((e && e.message) || e) }
  }
  let stderrTail = ''
  const client = createMcpClient(handle, (c) => {
    stderrTail = (stderrTail + String(c)).slice(-4000)
  }, () => {
    // notifications/tools/list_changed — re-sync happens lazily on next call
    // (the tools already registered stay valid; new ones appear after respawn).
    console.log('[dsh-dbhub-live] tools/list_changed received')
  })
  try {
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dsh-dbhub', version: '2.0.0' },
    })
    client.notify('notifications/initialized')
  } catch (e) {
    let detail = String((e && e.message) || e)
    if (stderrTail) detail += '\n[dbhub stderr] ' + stderrTail
    try {
      handle.terminate()
    } catch (e2) {
      /* ignore */
    }
    return { error: detail }
  }
  server.handle = handle
  server.client = client
  return {}
}

// Tools sync: register one ctx.tools def per dbhub tool, keyed by raw name.
const toolDisposers = new Map() // modelName -> disposer (server-synced tools)
const coreDisposers = new Map() // modelName -> disposer (plugin-owned tools, never synced away)

// Per-source tool naming + connection labeling.
// Each generated source gets its own suffixed tool set (`dbhub_<base>_<slug>`)
// even when dbhub reports single-source bare names, so a workspace's tools are
// never ambiguous. Every tool's description and result carry the masked
// connection target (host:port/database, password hidden), so a user can see
// exactly which environment (test/dev/prod) it points at before querying.
function syncToolsNow(ctx, subprocess, sources) {
  if (!server.client) return Promise.resolve()
  const sourceById = new Map()
  for (const s of sources) sourceById.set(s.id, s)
  return server.client.request('tools/list').then((res) => {
    const tools = Array.isArray(res && res.tools) ? res.tools : []
    // raw base name -> list of {slug, dbhubRawName, maskedDsn}
    const bases = new Map() // base -> Map<slug, {rawName, dsnMasked}>
    for (const t of tools) {
      const raw = t && t.name
      if (!raw || typeof raw !== 'string') continue
      // split off a per-source slug suffix (dbhub suffix = our source id)
      let base = raw
      let slug
      for (const id of sourceById.keys()) {
        if (raw === id) { slug = id } else if (raw.endsWith('_' + id)) {
          base = raw.slice(0, raw.length - id.length - 1)
          slug = id
        }
      }
      if (slug === undefined && sources.length === 1) {
        // single source: dbhub emits bare names -> attribute to the only source
        slug = sources[0].id
      }
      if (slug === undefined) continue
      const src = sourceById.get(slug)
      const dsnMasked = src ? maskDsn(src.dsn) : slug
      if (!bases.has(base)) bases.set(base, new Map())
      bases.get(base).set(slug, { rawName: raw, dsnMasked })
    }
    const seen = new Set()
    const jobs = []
    const inputByRaw = new Map(tools.map((t) => [t.name, t.inputSchema]))
    const descByRaw = new Map(tools.map((t) => [t.name, t.description]))
    for (const [base, bySlug] of bases) {
      for (const [slug, info] of bySlug) {
        const modelName = 'dbhub_' + base + '_' + slug
        seen.add(modelName)
        if (toolDisposers.has(modelName)) continue
        const rawName = info.rawName
        const dsnMasked = info.dsnMasked
        const inputSchema = inputByRaw.get(rawName)
        const desc = descByRaw.get(rawName)
        jobs.push(
          (async () => {
            try {
              const def = {
                name: modelName,
                description: (desc ? desc + ' ' : '') +
                  '（连接源：' + slug + ' → ' + dsnMasked + '；注意：这是该工作区配置的数据库环境，请确认是你要查的那套）',
                parameters: (inputSchema && typeof inputSchema === 'object' && inputSchema.type === 'object')
                  ? inputSchema
                  : { type: 'object', properties: {}, required: [] },
                timeoutMs: 60000,
                output: {
                  schema: {},
                  render: (_args, value) => [
                    {
                      type: 'text',
                      text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)),
                    },
                  ],
                },
                async execute(args, exec) {
                  return runOnServer(ctx, subprocess, rawName, args, exec, '{连接: ' + slug + ' → ' + dsnMasked + '}')
                },
              }
              const disposer = ctx.tools.register(def)
              toolDisposers.set(modelName, disposer)
            } catch (e) {
              console.error('[dsh-dbhub-live] register failed for ' + modelName + ': ' + String((e && e.message) || e))
            }
          })(),
        )
      }
    }
    // unregister tools whose source vanished
    for (const [modelName, disposer] of [...toolDisposers]) {
      if (!seen.has(modelName)) {
        try {
          disposer()
        } catch (e) {
          /* ignore */
        }
        toolDisposers.delete(modelName)
      }
    }
    return Promise.all(jobs).then(() => {})
  }).catch((e) => {
    console.error('[dsh-dbhub-live] tools/list failed: ' + String((e && e.message) || e))
  })
}

let idleDispose
function resetIdle(ctx) {
  if (idleDispose) {
    try {
      idleDispose()
    } catch (e) {
      /* ignore */
    }
    idleDispose = undefined
  }
  if (!server.handle) return
  idleDispose = ctx.timeout(() => {
    idleDispose = undefined
    console.log('[dsh-dbhub-live] idle — recycling dbhub process')
    terminateServer()
  }, IDLE_MS)
}

// Warm-call fast path: re-resolve configs only when the durable inputs change
// (workspace registry file, credentials store) — otherwise skip straight to a
// live-server check. Keeps repeated tool calls at ~0 overhead.
let lastInputMtime = 0

function configInputsMtime() {
  let max = 0
  for (const p of [join(dshHomeDir(), 'storages', 'workspace.json'), STORE_PATH]) {
    try {
      const m = statSync(p).mtimeMs
      if (m > max) max = m
    } catch (e) {
      /* missing file is fine */
    }
  }
  return max
}

async function ensureRunning(ctx, subprocess) {
  const inputMtime = configInputsMtime()
  const serverUp = server.client && !server.client.closed
  if (serverUp && inputMtime <= lastInputMtime && server.generatedFingerprint !== undefined) {
    resetIdle(ctx)
    return
  }
  // Regenerate config when the workspace set or its resolved DSNs change.
  let sources = []
  try {
    const workspaces = await listWorkspaces(ctx)
    for (const ws of workspaces) {
      const resolved = await resolveWorkspaceDsn(subprocess, ctx.get('fs'), ws.path, undefined)
      if (resolved && resolved.dsn) {
        sources.push({ id: slugify(ws.title) + '_' + shortHash(ws.path), dsn: resolved.dsn })
      }
    }
  } catch (e) {
    console.error('[dsh-dbhub-live] config generation failed: ' + String((e && e.message) || e))
  }
  lastInputMtime = inputMtime
  const fp = fingerprintOf(sources)
  if (fp !== server.generatedFingerprint) {
    if (sources.length === 0) {
      // No source yet — do NOT write an empty [[sources]] toml (dbhub treats
      // it as fatal). Wait for dbhub_configure; the fast path above then retries.
      console.log('[dsh-dbhub-live] no workspace sources yet — use dbhub_configure')
      server.generatedFingerprint = fp
      if (server.handle) terminateServer()
      return
    }
    writeFileSync(TOML_PATH, generateToml(sources))
    server.generatedFingerprint = fp
    // config changed while a server is up -> restart is deterministic
    // (dbhub also hot-reloads its config, but a respawn re-syncs cleanly).
    if (server.handle) terminateServer()
  }
  if (server.client && !server.client.closed) {
    resetIdle(ctx)
    return
  }
  if (server.starting) return server.starting
  server.starting = (async () => {
    try {
      const r = await spawnServer(subprocess, undefined)
      if (r.error) throw new Error(r.error)
      await syncToolsNow(ctx, subprocess, sources)
      resetIdle(ctx)
    } finally {
      server.starting = undefined
    }
  })()
  return server.starting
}

function shortHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function runOnServer(ctx, subprocess, rawName, args, exec, label) {
  try {
    await ensureRunning(ctx, subprocess)
  } catch (e) {
    return { ok: false, text: 'dbhub 服务启动失败: ' + String((e && e.message) || e) }
  }
  if (!server.client) return { ok: false, text: 'dbhub 服务不可用' }
  try {
    const res = await server.client.request('tools/call', { name: rawName, arguments: args || {} })
    const textOf = (r) => {
      if (r && Array.isArray(r.content)) {
        const parts = []
        for (const b of r.content) if (b && typeof b.text === 'string') parts.push(b.text)
        return parts.join('\n')
      }
      return JSON.stringify(r)
    }
    resetIdle(ctx)
    const prefix = label ? label + '\n' : ''
    if (res && res.isError) return { ok: false, text: 'dbhub 执行错误: ' + textOf(res) }
    if (res && res.structuredContent !== undefined) {
      return { ok: true, text: prefix + JSON.stringify(res.structuredContent, null, 2) }
    }
    return { ok: true, text: prefix + textOf(res) }
  } catch (e) {
    return { ok: false, text: String((e && e.message) || e) }
  }
}

// ── ad-hoc temporary connection ──────────────────────────────────────────
// Each call spawns a fresh throwaway `dbhub --transport stdio --dsn <dsn>`,
// runs one MCP tools/call against an ad-hoc target (ip/account/password/db
// supplied by the model per request), then kills it. Independent per call, so
// two parallel calls can query two different databases at once. Nothing is
// persisted and the persistent multi-source server is untouched.
async function runAdhoc(subprocess, dsn, rawName, mcpArgs, exec) {
  if (!dsn || typeof dsn !== 'string' || !dsn.trim()) {
    return { ok: false, text: '缺少 dsn 参数（如 mysql://user:pass@host:3306/db）' }
  }
  let exe
  try {
    exe = await resolveDbhubExe(subprocess, exec.signal)
  } catch (e) {
    return { ok: false, text: '无法获取 dbhub: ' + String((e && e.message) || e) }
  }
  let handle
  try {
    handle = subprocess.spawn({
      argv: buildSpawnArgv(subprocess, exe, ['--transport', 'stdio', '--dsn', dsn.trim()]),
      cwd: DATA_DIR,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      signal: exec.signal,
    })
  } catch (e) {
    return { ok: false, text: '启动临时 dbhub 失败: ' + String((e && e.message) || e) }
  }
  let stderrTail = ''
  try {
    const client = createMcpClient(handle, (c) => {
      stderrTail = (stderrTail + String(c)).slice(-2000)
    })
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dsh-dbhub-adhoc', version: '1.0.0' },
    })
    client.notify('notifications/initialized')
    const res = await client.request('tools/call', { name: rawName, arguments: mcpArgs })
    const textOf = (r) => {
      if (r && Array.isArray(r.content)) {
        const parts = []
        for (const b of r.content) if (b && typeof b.text === 'string') parts.push(b.text)
        return parts.join('\n')
      }
      return JSON.stringify(r)
    }
    const prefix = '{临时连接: ' + maskDsn(dsn) + '}\n'
    if (res && res.isError) return { ok: false, text: '临时连接执行错误: ' + textOf(res) }
    if (res && res.structuredContent !== undefined) {
      return { ok: true, text: prefix + JSON.stringify(res.structuredContent, null, 2) }
    }
    return { ok: true, text: prefix + textOf(res) }
  } catch (e) {
    let detail = String((e && e.message) || e)
    if (stderrTail) detail += '\n[dbhub stderr] ' + stderrTail
    return { ok: false, text: detail }
  } finally {
    try {
      handle.terminate()
    } catch (e) {
      /* ignore */
    }
    try {
      await handle.waitForExit(exec.signal)
    } catch (e) {
      /* ignore */
    }
  }
}

// ── authorized collection (tier 3) ───────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.idea', '.vscode', 'venv', '.venv', '__pycache__', '.dsh', '.mise', '.opencode', '.codex'])
const FILE_PATTERNS = [/\.env([.\w-]*)?$/, /application[-.\w]*\.(yml|yaml|properties)$/, /docker-compose[-.\w]*\.(yml|yaml)$/, /dbconfig\.properties$/, /jdbc\.properties$/, /database\.properties$/, /bootstrap[-.\w]*\.(yml|yaml)$/]

function walkForCandidates(root, budget) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 2 || found.length >= 30 || budget.count >= 200) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const en of entries) {
      if (budget.count >= 200) return
      budget.count++
      if (SKIP_DIRS.has(en.name)) continue
      const full = join(dir, en.name)
      let isFile = en.isFile()
      if (!isFile && en.isSymbolicLink()) {
        try {
          isFile = statSync(full).isFile()
        } catch (e) {
          continue
        }
      }
      if (isFile) {
        if (FILE_PATTERNS.some((p) => p.test(en.name))) found.push(full)
      } else if (en.isDirectory() || en.isSymbolicLink()) {
        walk(full, depth + 1)
      }
    }
  }
  walk(root, 0)
  return found
}

function extractDsnCandidates(filePath, text) {
  const out = []
  const push = (dsn, via) => {
    let d = dsn
    if (d && typeof d === 'string') d = d.trim().replace(/^postgresql:\/\//i, 'postgres://')
    if (d && /^[a-z]+:\/\//i.test(d) && !out.some((o) => o.dsn === d)) {
      out.push({ dsn: d, via })
    }
  }
  for (const m of String(text).matchAll(/(?:jdbc:mysql|jdbc:postgresql|jdbc:sqlserver|jdbc:mariadb)[^"'\s,;)]*/gi)) {
    push(m[0].replace(/^jdbc:/i, ''), 'jdbc url')
  }
  for (const m of String(text).matchAll(/url\s*[:=]\s*["']?(jdbc:[^"'\s]+)["']?/gi)) {
    push(m[1].replace(/^jdbc:/i, ''), 'url=')
  }
  for (const m of String(text).matchAll(/datasource\.url\s*[:=]\s*["']?([^"'\s]+)["']?/gi)) {
    push(m[1], 'datasource.url')
  }
  for (const m of String(text).matchAll(/\b(mysql|postgres|postgresql|mariadb|sqlserver|sqlite)(?:\+ssl)?:\/\/[^"'\s,;)]+/gi)) {
    push(m[0], 'dsn')
  }
  const map = parseEnvFile(text)
  const grouped = dsnFromMap(map)
  if (grouped) push(grouped, 'env 变量组')
  const mysqlGroup = {
    DB_TYPE: map.MYSQL_TYPE || map.DB_TYPE,
    DB_HOST: map.MYSQL_HOST || map.PGHOST || map.DB_HOST,
    DB_PORT: map.MYSQL_PORT || map.PGPORT || map.DB_PORT,
    DB_USER: map.MYSQL_USER || map.PGUSER || map.DB_USER,
    DB_PASSWORD: map.MYSQL_PASSWORD || map.PGPASSWORD || map.DB_PASSWORD,
    DB_NAME: map.MYSQL_DATABASE || map.PGDATABASE || map.DB_NAME,
  }
  const g2 = dsnFromEnv(mysqlGroup)
  if (g2) push(g2, 'MYSQL_*/PG* 变量组')
  return out.slice(0, 6)
}

async function askUser(userQuestions, agent, signal, questions) {
  if (!userQuestions || typeof userQuestions.ask !== 'function') return undefined
  try {
    return await userQuestions.ask({
      questions,
      ...(agent ? { agent } : {}),
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    return undefined
  }
}

function answerItemOf(ans, id) {
  if (!ans || !Array.isArray(ans.answers)) return undefined
  return ans.answers.find((a) => a && a.id === id)
}

// ── dbhub_configure tool body ────────────────────────────────────────────

async function runConfigure(ctx, subprocess, args, exec) {
  const userQuestions = ctx.get('userQuestions')
  const workspaces = await listWorkspaces(ctx)
  const currentCwd = sessionCwd(exec.agent)
  let target = workspaces.find((w) => w.path === (args.workspace || currentCwd))
  if (!target) {
    const byTitle = workspaces.find((w) => w.title === args.workspace)
    target = byTitle || (workspaces.find((w) => w.path === currentCwd) || workspaces[0])
  }
  if (!target) return { ok: false, text: '没有可用的工作区' }
  const wsPath = target.path
  const slug = slugify(target.title) + '_' + shortHash(wsPath)

  // 1) explicit dsn argument
  if (typeof args.dsn === 'string' && args.dsn.trim() !== '') {
    store[wsPath] = { dsn: args.dsn.trim(), source: 'user', updatedAt: Date.now() }
    saveStore(store)
    await ensureRunning(ctx, subprocess)
    return { ok: true, text: '已持久化连接并注册工具（' + slug + '）。下次可直接使用 dbhub_execute_sql_' + slug + '。' }
  }

  const ans = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'mode',
      header: '配置工作区数据库连接：' + target.title,
      question: '未检测到自动配置（mise env/.env）。怎么提供连接信息？',
      options: [
        { label: '输入完整 DSN', description: '如 mysql://user:pass@host:3306/db' },
        { label: '填写分项（类型/主机/端口/账号/密码/库名）' },
        { label: '扫描项目配置文件（需授权，可能读取含密码的文件）' },
        { label: '取消' },
      ],
    },
  ])
  const mode = answerItemOf(ans, 'mode')
  const chosen = mode && mode.selected && mode.selected[0]
  if (!chosen || chosen === '取消') return { ok: false, text: '已取消，未做任何修改' }

  if (chosen === '输入完整 DSN') {
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, [
      {
        id: 'dsn',
        header: '完整 DSN',
        question: '请输入数据库连接串',
      },
    ])
    const dsn = answerItemOf(ans2, 'dsn')
    const text = dsn && dsn.custom && dsn.custom.trim()
    if (!text) return { ok: false, text: '未提供 DSN，已取消' }
    store[wsPath] = { dsn: text, source: 'user', updatedAt: Date.now() }
    saveStore(store)
    await ensureRunning(ctx, subprocess)
    return { ok: true, text: '已持久化并注册工具（' + slug + '）。' }
  }

  if (chosen === '填写分项（类型/主机/端口/账号/密码/库名）') {
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, [
      {
        id: 'type',
        header: '类型',
        question: '数据库类型',
        options: [{ label: 'mysql' }, { label: 'postgres' }, { label: 'mariadb' }, { label: 'sqlite' }, { label: 'sqlserver' }],
      },
      { id: 'host', header: '主机', question: '主机地址', options: [{ label: '留空（默认 localhost）' }] },
      { id: 'port', header: '端口', question: '端口（可留空）', options: [{ label: '留空' }] },
      { id: 'user', header: '账号', question: '用户名（可留空）', options: [{ label: '留空' }] },
      { id: 'password', header: '密码', question: '密码（可留空）', options: [{ label: '留空' }] },
      { id: 'db', header: '库名', question: '数据库名（可留空）', options: [{ label: '留空' }] },
    ])
    const val = (id) => {
      const item = answerItemOf(ans2, id)
      if (item && item.custom && item.custom.trim()) return item.custom.trim()
      if (item && item.selected && item.selected[0]) {
        const s = item.selected[0]
        return s.startsWith('留空') ? '' : s
      }
      return ''
    }
    const type = (val('type') || 'mysql').toLowerCase()
    const host = val('host')
    const port = val('port')
    const user = val('user')
    const password = val('password')
    const database = val('db')
    let dsn
    if (type === 'sqlite') dsn = 'sqlite:///' + (host || 'test.db')
    else dsn = type + '://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@' + (host || 'localhost') + (port ? ':' + port : '') + '/' + encodeURIComponent(database)
    store[wsPath] = { dsn, source: 'user', updatedAt: Date.now() }
    saveStore(store)
    await ensureRunning(ctx, subprocess)
    return { ok: true, text: '已持久化并注册工具（' + slug + '）。' }
  }

  // scan path: authorization gate FIRST
  const auth = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'auth',
      header: '授权扫描',
      question: '将扫描工作区项目中的常见数据库配置文件（.env / application*.yml / docker-compose / jdbc.properties 等）' +
        '并读取其中的连接信息（可能包含账号密码）。此操作会读取敏感文件且消耗较多 token，是否授权？',
      options: [
        { label: '授权扫描', description: '扫描后列出候选供你确认，确认才持久化' },
        { label: '取消' },
      ],
    },
  ])
  const authChosen = answerItemOf(auth, 'auth')
  const authOk = authChosen && authChosen.selected && authChosen.selected[0] === '授权扫描'
  if (!authOk) return { ok: false, text: '未授权扫描，已取消（可改用“输入 DSN”或“填写分项”）' }

  const budget = { count: 0 }
  const files = walkForCandidates(wsPath, budget)
  if (files.length === 0) return { ok: false, text: '未找到可扫描的数据库配置文件（已跳过 node_modules/.git/target 等）。可改用“输入 DSN”或“填写分项”。' }
  const candidates = []
  for (const f of files) {
    let text
    try {
      const st = statSync(f)
      if (st.size > 64 * 1024) continue
      text = readFileSync(f, 'utf8')
    } catch (e) {
      continue
    }
    for (const c of extractDsnCandidates(f, text)) {
      const rel = f.replace(wsPath, '.').replace(/\\/g, '/')
      candidates.push({ label: rel + ' → ' + maskDsn(c.dsn), dsn: c.dsn, via: c.via })
    }
  }
  if (candidates.length === 0) return { ok: false, text: '扫描了 ' + files.length + ' 个文件，但未提取到数据库连接。可改用“输入 DSN”或“填写分项”。' }
  const pick = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'pick',
      header: '选择连接',
      question: '扫描到以下候选（密码已打码），选择要使用的：',
      options: candidates.map((c) => ({ label: c.label, description: '来源: ' + c.via })),
    },
  ])
  const picked = answerItemOf(pick, 'pick')
  const label = picked && picked.selected && picked.selected[0]
  if (!label) return { ok: false, text: '未选择，已取消' }
  const match = candidates.find((c) => c.label === label)
  if (!match) return { ok: false, text: '选择无效' }
  store[wsPath] = { dsn: match.dsn, source: 'collected', updatedAt: Date.now() }
  saveStore(store)
  await ensureRunning(ctx, subprocess)
  return { ok: true, text: '已按你的确认持久化连接（来源: 项目文件扫描）并注册工具（' + slug + '）。' }
}

function maskDsn(dsn) {
  try {
    const u = new URL(dsn.replace(/^jdbc:/i, ''))
    if (u.password) u.password = '****'
    return u.href
  } catch (e) {
    return dsn.replace(/(:\/\/[^:/@]+:)[^@]+(@)/, '$1****$2')
  }
}

// ── tool builders ────────────────────────────────────────────────────────

function buildConfigureTool(ctx, subprocess) {
  return {
    name: 'dbhub_configure',
    description:
      '配置某个工作区的数据库连接（持久化）。参数：workspace（工作区路径或标题，默认当前会话工作区）、dsn（完整连接串，可选）。' +
      '未提供 dsn 时会询问用户：输入 DSN / 填写分项 / 授权扫描项目配置文件（读取 .env、application*.yml、docker-compose、jdbc.properties 等并列出候选供确认）。' +
      '配置后自动生成 dbhub.toml、重启常驻 dbhub 服务并注册该工作区的工具（dbhub_execute_sql_<工作区> 等）。' +
      '每个工作区只需配置一次，之后自动持久化；有 mise env/.env 自动配置的工作区无需调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: '工作区路径或标题；默认当前会话工作区' },
        dsn: { type: 'string', description: '完整数据库连接串；省略则询问用户或扫描' },
      },
      required: [],
    },
    timeoutMs: 120000,
    output: {
      schema: {},
      render: (_args, value) => [
        {
          type: 'text',
          text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)),
        },
      ],
    },
    async execute(args, exec) {
      return runConfigure(ctx, subprocess, args, exec)
    },
  }
}

function registerCoreTools(ctx, subprocess) {
  try {
    const def = buildConfigureTool(ctx, subprocess)
    const disposer = ctx.tools.register(def)
    coreDisposers.set('dbhub_configure', disposer)
  } catch (e) {
    console.error('[dsh-dbhub-live] register dbhub_configure failed: ' + String((e && e.message) || e))
  }
  // Ad-hoc temporary connections: model passes a full dsn per request; each
  // call is an independent throwaway dbhub, so two calls can hit two different
  // databases at once. Independent state -> safe to run concurrently.
  const adhocDefs = [
    {
      name: 'dbhub_query',
      description:
        '临时动态连接任意数据库并执行 SQL（每次调用独立临时连接，可同时查多个不同库）。' +
        '参数 dsn 必填：完整连接串，指定 ip/端口/账号/密码/库（如 mysql://user:pass@host:3306/db）。' +
        '适合一次性排查/对比不同环境；与持久配置的工作区工具互不影响。多语句用 ; 分隔。',
      parameters: {
        type: 'object',
        properties: {
          dsn: { type: 'string', description: '完整数据库连接串，如 mysql://root:pass@192.168.77.6:3306/tx_sd_jinengshu' },
          sql: { type: 'string', description: '要执行的 SQL（多语句用 ; 分隔）' },
        },
        required: ['dsn', 'sql'],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      output: {
        schema: {},
        render: (_args, value) => [
          { type: 'text', text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)) },
        ],
      },
      async execute(args, exec) {
        return runAdhoc(subprocess, args.dsn, 'execute_sql', { sql: args.sql }, exec)
      },
    },
    {
      name: 'dbhub_query_objects',
      description:
        '临时动态连接并搜索数据库对象（表/视图/列/索引等），每次调用独立临时连接。' +
        '注意：dbhub 的 search_objects 仅对 sqlite 开放（🔒），MySQL/PostgreSQL 等请用 dbhub_query 直接查（如 SHOW TABLES）。' +
        '参数 dsn 必填（ip/端口/账号/密码/库）。',
      parameters: {
        type: 'object',
        properties: {
          dsn: { type: 'string', description: '完整数据库连接串，如 mysql://root:pass@192.168.77.6:3306/tx_sd_jinengshu' },
          object_type: { type: 'string', enum: ['schema', 'table', 'view', 'column', 'procedure', 'function', 'index'], description: '对象类型' },
          pattern: { type: 'string', description: 'LIKE 模式' },
          schema: { type: 'string', description: '限定 schema' },
          table: { type: 'string', description: '限定表（需 schema）' },
          detail_level: { type: 'string', enum: ['names', 'summary', 'full'], description: '详细程度' },
          limit: { type: 'integer', description: '最大结果数' },
        },
        required: ['dsn', 'object_type'],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      output: {
        schema: {},
        render: (_args, value) => [
          { type: 'text', text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)) },
        ],
      },
      async execute(args, exec) {
        const mcp = {}
        for (const k of ['object_type', 'pattern', 'schema', 'table', 'detail_level', 'limit']) {
          if (args[k] !== undefined && args[k] !== null) mcp[k] = args[k]
        }
        return runAdhoc(subprocess, args.dsn, 'search_objects', mcp, exec)
      },
    },
  ]
  for (const def of adhocDefs) {
    try {
      const disposer = ctx.tools.register(def)
      coreDisposers.set(def.name, disposer)
    } catch (e) {
      console.error('[dsh-dbhub-live] register ' + def.name + ' failed: ' + String((e && e.message) || e))
    }
  }
}

// ── orphan cleanup ───────────────────────────────────────────────────────

// Best-effort: on startup, kill any dbhub process still pointing at OUR
// dbhub.toml but not owned by this running instance (left over from a
// hard-killed previous dsh where the subprocess service could not dispose).
// Matches only the unique config path, so unrelated dbhub processes are safe.
// Windows-only (dbhub runs as node.exe); non-fatal on failure.
async function cleanupOrphans(subprocess) {
  if (process.platform !== 'win32') return
  let ps
  try {
    ps = await subprocess.resolveExecutable('powershell.exe', undefined, undefined)
  } catch (e) {
    try {
      ps = await subprocess.resolveExecutable('pwsh.exe', undefined, undefined)
    } catch (e2) {
      return
    }
  }
  const script =
    'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and ' +
    '$_.CommandLine -like "*dsh-dbhub-live\\dbhub.toml*" } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  let handle
  try {
    handle = subprocess.spawn({
      argv: [ps, '-NoProfile', '-NonInteractive', '-Command', script],
      cwd: DATA_DIR,
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 5000,
    })
    await handle.done
  } catch (e) {
    console.error('[dsh-dbhub-live] orphan cleanup failed: ' + String((e && e.message) || e))
  }
}

// ── apply ────────────────────────────────────────────────────────────────

async function apply(ctx) {
  const subprocess = ctx.get('subprocess')
  registerCoreTools(ctx, subprocess)
  if (!subprocess) {
    console.error('[dsh-dbhub-live] subprocess unavailable — per-source tools deferred')
    return
  }
  // Fire-and-forget: do NOT block dsh web boot on dbhub init (workspace
  // resolution + spawn). Clean up orphans first, then start the server.
  // dbhub_configure is available immediately.
  (async () => {
    try {
      await cleanupOrphans(subprocess)
    } catch (e) {
      /* contained */
    }
    await ensureRunning(ctx, subprocess)
    console.log('[dsh-dbhub-live] dbhub 服务已加载（' + (coreDisposers.size + toolDisposers.size) + ' 个工具）')
    // Background, non-blocking: refresh the auto-installed dbhub if its update
    // interval has elapsed. Fails silently — the current binary stays in use.
    maybeRefreshDbhub(subprocess).catch((e) => {
      console.error('[dsh-dbhub-live] dbhub 自动更新检查失败: ' + String((e && e.message) || e))
    })
  })().catch((e) => {
    console.error('[dsh-dbhub-live] initial start failed: ' + String((e && e.message) || e))
  })
}

export { name, inject, apply }
