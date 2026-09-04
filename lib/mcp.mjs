// dsh-dbhub-live: MCP client + source discovery + tool registry.
//
// Architecture (4.0): NO resident dbhub server. Every tool call spawns its
// own throwaway `dbhub --transport stdio --dsn <dsn>` process (see
// adhoc.mjs/runAdhoc), so execution is stateless, concurrent (process-per-
// call) and fault-isolated — a hung/failing query can never take down another
// call or another DSH instance, and there is no orphan/port/toml state to
// fight over. This module owns the MCP JSON-RPC wire client (reused by the
// ad-hoc executor), the workspace×environment source discovery that the
// tools resolve `source` handles against, and the constant tool registry
// (the source of truth for the registered-tool count).

import { basename } from 'node:path'
import {
  store, listWorkspaces, listWorkspaceEnvironments, resolveWorkspaceEnvs,
  slugify, envSlug, shortHash, connLabel,
} from './config.mjs'
import { currentT } from './i18n.mjs'
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
          reject(new Error('dbhub process is down'))
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

// ── tool registry (single-slot, constant count) ───────────────────────────
//
// Context budget: there is exactly ONE set of dbhub tools (4 declarations:
// configure / list_sources / execute_sql / search_objects), period. Workspaces
// × environments are NOT expanded into per-source tools; instead the
// source-parameterized tools dbhub_execute_sql / dbhub_search_objects resolve
// their `source` argument at call time against the live discovery output.
const toolDisposers = new Map() // modelName -> disposer (plugin-owned tools)
const coreDisposers = toolDisposers

/** Total registered dbhub tools (constant set: configure/list/execute/search). */
export function activeToolCount() {
  return coreDisposers.size
}

function refreshToolCount() {
  state.setToolCount(coreDisposers.size)
}

export { coreDisposers, refreshToolCount }

/**
 * Resolve a `source` reference (from dbhub_list_sources) to a live source row.
 * Accepts: the exact source id (`<title>_<hash>[_<env>]`), the display titles
 * `<title>` / `<title> <env>` / `<title>_<env>` / `<title>.<env>`.
 * Matching is EXACT-FIRST: a suffix id like `app_ab12_demo` must resolve to the
 * demo row even when the shorter base id `app_ab12` also appears earlier in the
 * list (a prefix substring match must never hijack an exact match — the old
 * `wanted.includes(k.id)` fallback did, sending `…_demo` calls to the default
 * connection). The loose prefix fallback only applies when NO exact candidate
 * exists, and then prefers the longest (closest) matching id.
 * @returns the matched {@link collectSources} row + its source id, or
 *   `undefined` when nothing matches.
 */
export async function resolveSource(ctx, subprocess, sourceRef) {
  const wanted = String(sourceRef || '').trim().toLowerCase()
  if (!wanted) return undefined
  const { rows } = await collectSources(ctx, subprocess)
  const keyed = rows.map((r, i) => {
    const title = slugify(r.title)
    const env = r.env === 'default' ? '' : envSlug(r.env)
    const id = title + '_' + shortHash(r.wsPath) + (env ? '_' + env : '')
    return { row: r, id, keys: new Set([id, title, env ? title + '_' + env : title, env ? title + ' ' + r.env : title, env ? title + '.' + r.env : title, String(i)]) }
  })
  const exact = keyed.find((k) => k.id === wanted || k.keys.has(wanted))
  if (exact) return exact
  const prefixed = keyed.filter((k) => k.id && k.id !== wanted && wanted.includes(k.id))
  if (prefixed.length === 1) return prefixed[0]
  if (prefixed.length > 1) {
    prefixed.sort((a, b) => b.id.length - a.id.length)
    return prefixed[0]
  }
  return undefined
}

// ── live connection rows & summaries (metadata only) ──────────────────────

// Live connection-row cache: refreshed by every collectSources run so the
// settings publish path can mirror the card without an extra walk.
let lastRowCache = []

/**
 * Masked→metadata connection rows for the card (passwords and usernames never
 * leave the Host). Each row carries `conn` = host/port/database label only.
 */
export function summarizeRows(rows) {
  return rows.map((r) => {
    const srcId = slugify(r.title) + '_' + shortHash(r.wsPath) + (r.env === 'default' ? '' : '_' + envSlug(r.env))
    return {
      title: r.title,
      path: r.wsPath,
      env: r.env,
      conn: connLabel(r.dsn),
      source: r.source,
      persisted: !!r.persisted,
      srcId,
    }
  })
}

/** The last collected summary set (empty until the first walk). */
export function latestSummaries() {
  return summarizeRows(lastRowCache)
}

/**
 * Walk every workspace × environment and produce the live connection rows
 * (metadata for the card) and the resolved DSNs (host-side only — the tools
 * resolve `source` against these rows). Shared by dbhub_list_sources and the
 * settings publish path so the card always mirrors what the tools would use.
 * Environment naming: the 'default' env keeps the legacy bare source id
 * (`<title>_<hash>`); extra environments append `_<envSlug>`.
 * @returns `{ rows, sources }` — rows: [{ wsPath, title, env, dsn, source,
 *   persisted }]; sources: [{ id, dsn }] (dsn kept host-side).
 */
export async function collectSources(ctx, subprocess) {
  const rows = []
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
        rows.push({ wsPath: ws.path, title, env: r.env, dsn: r.dsn, source: r.source, persisted: persistedEnvs.has(r.env) })
      }
    }
  } catch (e) {
    console.error('[dsh-dbhub-live] source discovery failed: ' + String((e && e.message) || e))
  }
  lastRowCache = rows
  return { rows }
}

// Shared "plugin disabled" copy for every dbhub tool (locale-aware).
export function disabledMessage() {
  return currentT('result.disabled')
}