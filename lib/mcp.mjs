// dsh-dbhub-live: persistent multi-source dbhub server + MCP client.
//
// ONE persistent `dbhub --transport stdio --config <generated dbhub.toml>`
// process, managed here: idle recycle, respawn on demand, lazy init. The toml
// is auto-generated from every registered workspace's connection config and
// hot-reloaded by dbhub itself — users never maintain it.
//
// This module also owns the per-workspace tool registrations and their
// disposers (the source of truth for the registered-tool count).

import { statSync } from 'node:fs'
import { join, basename } from 'node:path'
import {
  DATA_DIR, dshHomeDir, STORE_PATH, TOML_PATH,
  store, listWorkspaces, listWorkspaceEnvironments, resolveWorkspaceEnvs,
  slugify, envSlug, shortHash,
  fingerprintOf, generateToml, maskDsn, writeToml,
} from './config.mjs'
import { buildSpawnArgv, resolveDbhubExe } from './runtime.mjs'
import * as options from './options.mjs'
import * as state from './state.mjs'

// ── MCP client (JSON-RPC 2.0 over stdio) ─────────────────────────────────

export function createMcpClient(handle, onStderr, onNotification) {
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

// ── server lifecycle ──────────────────────────────────────────────────────

const server = {
  handle: undefined,
  client: undefined,
  generatedFingerprint: undefined,
  starting: undefined,
}

export function terminateServer() {
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
      clientInfo: { name: 'dsh-dbhub', version: '3.0.0' },
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

// ── per-workspace tool sync ───────────────────────────────────────────────

// Tools sync: register one ctx.tools def per dbhub tool, keyed by raw name.
const toolDisposers = new Map() // modelName -> disposer (server-synced tools)
const coreDisposers = new Map() // modelName -> disposer (plugin-owned tools, never synced away)

/** Total registered dbhub tools (core + per-workspace). */
export function activeToolCount() {
  return coreDisposers.size + toolDisposers.size
}

function refreshToolCount() {
  state.setToolCount(activeToolCount())
}

// Per-source tool naming + connection labeling.
// Each generated source gets its own suffixed tool set (`dbhub_<base>_<slug>`)
// even when dbhub reports single-source bare names, so a workspace's tools are
// never ambiguous. Every tool's description and result carry the masked
// connection target (host:port/database, password hidden), so a user can see
// exactly which environment (test/dev/prod) it points at before querying.

// Fallback tool definitions used while the dbhub server is down or still
// starting: per-workspace tools must EXIST as soon as their source exists, or
// a model session can never discover/call an environment (it then digs into
// config files). A live tools/list later refines schemas/descriptions.
const WS_BASE_DEFAULTS = {
  execute_sql: {
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string', description: '要执行的 SQL（多语句用 ; 分隔）' } },
      required: ['sql'],
    },
    description: '在指定工作区/环境的常驻连接上执行 SQL。',
  },
  search_objects: {
    parameters: {
      type: 'object',
      properties: {
        object_type: { type: 'string', description: '对象类型' },
        pattern: { type: 'string', description: 'LIKE 模式' },
        schema: { type: 'string', description: '限定 schema' },
        table: { type: 'string', description: '限定表（需 schema）' },
        detail_level: { type: 'string', description: '详细程度' },
        limit: { type: 'integer', description: '最大结果数' },
      },
      required: ['object_type'],
    },
    description: '在指定工作区/环境搜索数据库对象（表/视图/列/索引等）。',
  },
}

// dbhub base tool names learned from live tools/list (persists across
// respawns, so a later server outage never narrows the tool set).
const knownBases = new Set()

// modelNames currently registered with a FALLBACK definition (no live schema
// yet); syncing later upgrades exactly these when the server reports them.
const fallbackRegistered = new Set()

async function syncToolsNow(ctx, subprocess, sources) {
  const sourceById = new Map()
  for (const s of sources) sourceById.set(s.id, s)
  // Live list (when connected) refines schemas/descriptions; otherwise the
  // fallback definitions below keep every source's tools registered.
  const liveTools = []
  if (server.client && !server.client.closed) {
    try {
      const res = await server.client.request('tools/list')
      const tools = Array.isArray(res && res.tools) ? res.tools : []
      for (const t of tools) if (t && typeof t.name === 'string') liveTools.push(t)
    } catch (e) {
      console.error('[dsh-dbhub-live] tools/list failed（沿用兜底工具定义）: ' + String((e && e.message) || e))
    }
  }
  // raw base name -> Map<slug, {rawName, dsnMasked, fallback}>
  const bases = new Map()
  for (const t of liveTools) {
    const raw = t.name
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
    knownBases.add(base)
    if (!bases.has(base)) bases.set(base, new Map())
    bases.get(base).set(slug, { rawName: raw, dsnMasked, live: true })
  }
  // Ensure every known (or default) base exists per source even without live
  // data — this is what keeps `dbhub_execute_sql_<slug>` always callable.
  for (const s of sources) {
    const baseNames = knownBases.size > 0 ? [...knownBases] : Object.keys(WS_BASE_DEFAULTS)
    for (const base of baseNames) {
      if (WS_BASE_DEFAULTS[base] === undefined && !knownBases.has(base)) continue
      if (!bases.has(base)) bases.set(base, new Map())
      if (!bases.get(base).has(s.id)) {
        bases.get(base).set(s.id, { rawName: base + '_' + s.id, dsnMasked: maskDsn(s.dsn), fallback: true })
      }
    }
  }
  const seen = new Set()
  const jobs = []
  const inputByLive = new Map(liveTools.map((t) => [t.name, t.inputSchema]))
  const descByLive = new Map(liveTools.map((t) => [t.name, t.description]))
  for (const [base, bySlug] of bases) {
    for (const [slug, info] of bySlug) {
      const modelName = 'dbhub_' + base + '_' + slug
      seen.add(modelName)
      const existing = toolDisposers.get(modelName)
      // Upgrade a fallback registration to the live schema when the server
      // finally reports it (dispose + re-register); otherwise keep as-is.
      if (existing && fallbackRegistered.has(modelName) && liveTools.length > 0 && inputByLive.has(info.rawName)) {
        try {
          existing()
        } catch (e) {
          /* ignore */
        }
        toolDisposers.delete(modelName)
        fallbackRegistered.delete(modelName)
      } else if (existing) {
        continue
      }
      const liveInput = info.fallback ? undefined : inputByLive.get(info.rawName)
      const liveDesc = info.fallback ? undefined : descByLive.get(info.rawName)
      const fallback = WS_BASE_DEFAULTS[base]
      const inputSchema = (liveInput && typeof liveInput === 'object' && liveInput.type === 'object')
        ? liveInput
        : (fallback ? fallback.parameters : { type: 'object', properties: {}, required: [] })
      const description = (liveDesc ? liveDesc + ' ' : (fallback ? fallback.description : '')) +
        '（连接源：' + slug + ' → ' + info.dsnMasked + '；注意：这是该工作区配置的数据库环境，请确认是你要查的那套）'
      jobs.push(
        (async () => {
          try {
            const def = {
              name: modelName,
              description,
              parameters: inputSchema,
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
                return runOnServer(ctx, subprocess, info.rawName, args, exec, '{连接: ' + slug + ' → ' + info.dsnMasked + '}')
              },
            }
            const disposer = ctx.tools.register(def)
            toolDisposers.set(modelName, disposer)
            if (liveInput === undefined) fallbackRegistered.add(modelName)
            else fallbackRegistered.delete(modelName)
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
  return Promise.all(jobs).then(() => {
    refreshToolCount()
  })
}

// ── warm-call fast path & lazy ensure ─────────────────────────────────────

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
  const idleMs = (options.get('idleMinutes') || 10) * 60 * 1000
  idleDispose = ctx.timeout(() => {
    idleDispose = undefined
    console.log('[dsh-dbhub-live] idle — recycling dbhub process')
    terminateServer()
  }, idleMs)
}

// Re-resolve configs only when the durable inputs change (workspace registry
// file, credentials store) — otherwise skip straight to a live-server check.
// Keeps repeated tool calls at ~0 overhead.
let lastInputMtime = 0

// Live connection-row cache: refreshed by every collectSources run so the
// settings publish path can mirror the card without an extra walk.
let lastRowCache = []

/** Masked connection rows for the card (never leaks passwords over the wire). */
export function summarizeRows(rows) {
  return rows.map((r) => ({
    title: r.title,
    path: r.wsPath,
    env: r.env,
    dsn: maskDsn(r.dsn),
    source: r.source,
    persisted: !!r.persisted,
  }))
}

/** The last collected summary set (empty until the first walk). */
export function latestSummaries() {
  return summarizeRows(lastRowCache)
}

/** mtime of the durable config inputs (workspace registry + credentials). */
export function configInputsMtime() {
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

/**
 * Walk every workspace × environment and produce the live connection rows
 * (for the card's masked summaries) and the dbhub source list (for the toml
 * and per-workspace tool names). Shared by `ensureRunning` and the settings
 * publish path so the card always mirrors what the server would load.
 * Environment naming: the 'default' env keeps the legacy bare source id
 * (`<title>_<hash>`); extra environments append `_<envSlug>`.
 * @returns `{ rows, sources }` — rows: [{ wsPath, title, env, dsn, source,
 *   persisted }]; sources: [{ id, dsn }].
 */
export async function collectSources(ctx, subprocess) {
  const rows = []
  const sources = []
  try {
    const workspaces = await listWorkspaces(ctx)
    const persisted = listWorkspaceEnvironments(store)
    const byPath = new Map()
    for (const p of persisted) {
      if (!byPath.has(p.wsPath)) byPath.set(p.wsPath, [])
      byPath.get(p.wsPath).push(p)
    }
    for (const ws of workspaces) {
      const title = ws.title || basename(ws.path)
      const baseId = slugify(title) + '_' + shortHash(ws.path)
      const resolved = await resolveWorkspaceEnvs(subprocess, ctx.get('fs'), ws.path, undefined)
      const persistedEnvs = new Set((byPath.get(ws.path) || []).map((p) => p.env))
      for (const r of resolved) {
        const slug = envSlug(r.env)
        const id = baseId + (slug ? '_' + slug : '')
        rows.push({ wsPath: ws.path, title, env: r.env, dsn: r.dsn, source: r.source, persisted: persistedEnvs.has(r.env) })
        sources.push({ id, dsn: r.dsn })
      }
    }
  } catch (e) {
    console.error('[dsh-dbhub-live] config generation failed: ' + String((e && e.message) || e))
  }
  lastRowCache = rows
  return { rows, sources }
}

/**
 * Make sure the persistent server is up and synced, initializing lazily on
 * first use. Concurrent callers share one in-flight start. Regenerates the
 * toml whenever the workspace set or its resolved DSNs change.
 * @returns a promise settling when the server is ready (never rejects; the
 *   caller reads `server.client` to learn readiness).
 */
export async function ensureRunning(ctx, subprocess) {
  if (!state.isEnabled()) return
  const inputMtime = configInputsMtime()
  const serverUp = server.client && !server.client.closed
  if (serverUp && inputMtime <= lastInputMtime && server.generatedFingerprint !== undefined) {
    resetIdle(ctx)
    return
  }
  const { sources } = await collectSources(ctx, subprocess)
  lastInputMtime = inputMtime
  const fp = fingerprintOf(sources)
  // Never spawn with zero sources: dbhub treats an empty [[sources]] toml as
  // fatal, so without a configured workspace the server must stay down and the
  // fast path above retries as soon as a source appears (mtime/fingerprint).
  if (sources.length === 0) {
    if (fp !== server.generatedFingerprint) {
      console.log('[dsh-dbhub-live] no workspace sources yet — use dbhub_configure')
      server.generatedFingerprint = ''
    }
    if (server.handle) terminateServer()
    return
  }
  if (fp !== server.generatedFingerprint) {
    if (!writeToml(generateToml(sources))) {
      // A blocked/unwritable storage dir is a real init failure: surface it in
      // the state machine (phase 'error' + message) and retry on next call.
      throw new Error('写入 dbhub.toml 失败（配置目录不可写）')
    }
    server.generatedFingerprint = fp
    // config changed while a server is up -> restart is deterministic
    // (dbhub also hot-reloads its config, but a respawn re-syncs cleanly).
    if (server.handle) terminateServer()
  }
  // Register every source's tools NOW, before any spawn attempt: with the
  // fallback definitions per-workspace tools exist even while the server is
  // down or starting, so a session can always call dbhub_execute_sql_<slug>.
  try {
    await syncToolsNow(ctx, subprocess, sources)
  } catch (e) {
    console.warn('[dsh-dbhub-live] 工具预注册失败: ' + String((e && e.message) || e))
  }
  if (server.client && !server.client.closed) {
    resetIdle(ctx)
    return
  }
  if (server.starting) {
    try {
      await server.starting
    } catch (e) {
      /* the owner below recorded the error */
    }
    return
  }
  server.starting = (async () => {
    try {
      state.setPhase('initializing')
      const r = await spawnServer(subprocess, undefined)
      if (r.error) throw new Error(r.error)
      await syncToolsNow(ctx, subprocess, sources)
      state.clearError()
      state.setPhase('running')
      refreshToolCount()
      resetIdle(ctx)
    } catch (e) {
      state.recordError(String((e && e.message) || e))
      throw e
    } finally {
      server.starting = undefined
    }
  })()
  try {
    await server.starting
  } catch (e) {
    /* failure recorded + surfaced through runOnServer's {ok:false} */
  }
}

// ── MCP call over the persistent server ───────────────────────────────────

export async function runOnServer(ctx, subprocess, rawName, args, exec, label) {
  if (!state.isEnabled()) {
    return { ok: false, text: disabledMessage() }
  }
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

// Shared "plugin disabled" copy for every dbhub tool.
export function disabledMessage() {
  return 'dsh-dbhub-live 已禁用：所有 dbhub 工具暂不可用。请在 设置 → 插件 → dsh-dbhub-live 中重新开启。'
}

/** Whether the persistent server currently answers calls. */
export function isServerUp() {
  return !!(server.client && !server.client.closed)
}

export { coreDisposers, refreshToolCount }