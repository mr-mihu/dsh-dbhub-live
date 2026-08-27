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
import { join } from 'node:path'
import {
  DATA_DIR, dshHomeDir, STORE_PATH, TOML_PATH, IDLE_MS,
  store, listWorkspaces, resolveWorkspaceDsn, slugify, shortHash,
  fingerprintOf, generateToml, maskDsn, writeToml,
} from './config.mjs'
import { buildSpawnArgv, resolveDbhubExe } from './runtime.mjs'
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
    return Promise.all(jobs).then(() => {
      refreshToolCount()
    })
  }).catch((e) => {
    console.error('[dsh-dbhub-live] tools/list failed: ' + String((e && e.message) || e))
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
  idleDispose = ctx.timeout(() => {
    idleDispose = undefined
    console.log('[dsh-dbhub-live] idle — recycling dbhub process')
    terminateServer()
  }, IDLE_MS)
}

// Re-resolve configs only when the durable inputs change (workspace registry
// file, credentials store) — otherwise skip straight to a live-server check.
// Keeps repeated tool calls at ~0 overhead.
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