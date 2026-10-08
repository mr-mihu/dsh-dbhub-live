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
 * Canonical source id of one discovered row: `<titleSlug>_<wsPathHash>` for
 * the default environment, plus `_<envSlug>` for a named one. Single source of
 * truth — the list output, the resolver and every tool reply must agree, or
 * the model is handed a handle it cannot resolve back.
 */
export function sourceIdOf(row) {
  const env = envSlug(row.env)
  return slugify(row.title) + '_' + shortHash(row.wsPath) + (env ? '_' + env : '')
}

// One match wins only when it is the current workspace's row or the sole
// candidate; anything else is surfaced as an ambiguity instead of guessing.
function pickBest(candidates, preferredWsPath) {
  if (candidates.length === 1) return candidates[0]
  const local = preferredWsPath ? candidates.filter((k) => k.row.wsPath === preferredWsPath) : []
  if (local.length === 1) return local[0]
  const pool = local.length > 1 ? local : candidates
  return { ambiguous: pool.map((k) => ({ id: k.id, title: k.row.title, path: k.row.wsPath, env: k.row.env })) }
}

/**
 * Resolve a `source` reference (from dbhub_list_sources) to a live source row.
 * Accepts: the exact source id (`<title>_<hash>[_<env>]`), the display forms
 * `<title>` / `<title>_<env>` / `<title> <env>` / `<title>.<env>`, the bare
 * environment name, the workspace path, and the row index.
 *
 * Matching is EXACT-FIRST: a suffix id like `app_ab12_demo` must resolve to the
 * demo row even when the shorter base id `app_ab12` also appears earlier in the
 * list (a prefix substring match must never hijack an exact match — the old
 * `wanted.includes(k.id)` fallback did, sending `…_demo` calls to the default
 * connection). The loose prefix fallback only applies when NO exact candidate
 * exists.
 *
 * Ambiguity is never resolved by luck: a reference that matches rows from
 * several workspaces (same title, or the same environment configured twice)
 * prefers the CURRENT session workspace; when several still match, the result
 * is `{ ambiguous: [...] }` so the caller asks the model for the exact source
 * id rather than silently querying a look-alike connection from another
 * workspace.
 *
 * @param opts.preferredWsPath - current session workspace path (may be '').
 * @returns the matched `{ row, id }`, `{ ambiguous: [{id,title,path,env}] }`,
 *   or `undefined` when nothing matches.
 */
export async function resolveSource(ctx, subprocess, sourceRef, opts) {
  const wanted = String(sourceRef || '').trim().toLowerCase()
  if (!wanted) return undefined
  const preferredWsPath = opts && typeof opts.preferredWsPath === 'string' ? opts.preferredWsPath : ''
  const { rows } = await collectSources(ctx, subprocess)
  const keyed = rows.map((row, i) => {
    const id = sourceIdOf(row)
    const title = slugify(row.title)
    const env = envSlug(row.env)
    const keys = new Set([id.toLowerCase(), title, String(row.wsPath).toLowerCase(), String(i)])
    if (row.env !== 'default') {
      // Display forms the model may echo back: both the ASCII slug and the RAW
      // environment name (a Chinese env must be referable as 线上 as well).
      for (const k of [title + '_' + env, title + '_' + row.env, title + ' ' + row.env, title + '.' + row.env, env, String(row.env)]) {
        keys.add(String(k).toLowerCase())
      }
    }
    return { row, id, keys }
  })
  const exact = keyed.filter((k) => k.id.toLowerCase() === wanted || k.keys.has(wanted))
  if (exact.length > 0) return pickBest(exact, preferredWsPath)
  const prefixed = keyed.filter((k) => wanted.includes(k.id.toLowerCase()))
  if (prefixed.length > 0) return pickBest(prefixed, preferredWsPath)
  return undefined
}

// ── live connection rows & summaries (metadata only) ──────────────────────

// Live connection-row cache: refreshed by every collectSources run so the
// settings publish path can mirror the card without an extra walk. `rowCacheReady`
// distinguishes "walked and found nothing" from "not walked yet" — publishing the
// latter as an empty list would blank the card.
let lastRowCache = []
let rowCacheReady = false

/**
 * Masked→metadata connection rows for the card (passwords and usernames never
 * leave the Host). Each row carries `conn` = host/port/database label only.
 */
export function summarizeRows(rows) {
  return rows.map((r) => {
    return {
      title: r.title,
      path: r.wsPath,
      env: r.env,
      conn: connLabel(r.dsn),
      source: r.source,
      persisted: !!r.persisted,
      srcId: sourceIdOf(r),
    }
  })
}

/** The last collected summary set (empty until the first walk). */
export function latestSummaries() {
  return summarizeRows(lastRowCache)
}

/** Whether a discovery walk has completed at least once in this process. */
export function hasRowCache() {
  return rowCacheReady
}

// Row identity for local patches: one row per workspace path × environment.
const rowKey = (wsPath, env) => String(wsPath) + '\u0000' + String(env)

/**
 * Apply ONE local mutation to a row array — the card's own write, applied to the
 * cached walk result so the mirror can show it immediately. This exists because
 * the authoritative walk re-reads every workspace (spawning `mise env` for each
 * one without a persisted `default`), which is where the card's "I clicked delete
 * and the row took two seconds to go away" latency came from.
 *
 * Pure: it never touches the module cache and never mutates its input.
 * @param rows - live rows ({wsPath,title,env,dsn,source,persisted}).
 * @param patch - `{op:'add'|'remove'|'rename', path, title?, env, dsn?, source?, from?}`.
 * @returns a NEW rows array.
 */
export function applyRowPatch(rows, patch) {
  const list = Array.isArray(rows) ? rows.slice() : []
  if (!patch || typeof patch !== 'object') return list
  const path = String(patch.path || '')
  const env = String(patch.env == null ? '' : patch.env)
  if (patch.op === 'remove') return list.filter((r) => rowKey(r.wsPath, r.env) !== rowKey(path, env))
  if (patch.op === 'rename') {
    const from = rowKey(path, patch.from)
    const to = rowKey(path, env)
    const moved = list.find((r) => rowKey(r.wsPath, r.env) === from)
    // Idempotent: applying the same rename twice must not drop the row. A walk
    // that already saw the rename has no `from` row left, and the patched row
    // must stay put.
    if (!moved) return list
    const out = list.filter((r) => {
      const k = rowKey(r.wsPath, r.env)
      return k !== from && k !== to
    })
    out.push({ ...moved, env })
    return out
  }
  if (patch.op !== 'add' && patch.op !== 'set') return list
  // add / set: the same workspace+env is replaced (that is what the store does)
  const known = list.find((r) => String(r.wsPath) === path)
  const out = list.filter((r) => rowKey(r.wsPath, r.env) !== rowKey(path, env))
  out.push({
    wsPath: path,
    title: String(patch.title || (known ? known.title : '') || ''),
    env,
    dsn: String(patch.dsn || ''),
    source: 'persisted(' + (patch.source === 'collected' ? 'collected' : 'user') + ')',
    persisted: true,
  })
  return out
}

/**
 * Bookkeeping for the card's own writes while an authoritative walk is in
 * flight. Collecting the rows is slow (it spawns `mise env` per auto-discovered
 * workspace) and reads the store while it is still changing, so a walk that
 * started BEFORE a write can finish AFTER it and publish a list without the row
 * the user just saved — the row "appeared and then vanished" and only came back
 * on some later walk.
 *
 * The mirror therefore remembers every patch until a walk that STARTED after it
 * lands (that walk necessarily read the updated store), re-applying anything
 * that arrived while a walk was running.
 * @returns { patch, beginWalk, endWalk } — `patch` returns the fresh summaries.
 */
export function createRowMirror() {
  let pending = []
  return {
    /** Apply one patch immediately and hold it until a later walk lands. */
    patch(patch) {
      pending.push(patch)
      lastRowCache = applyRowPatch(lastRowCache, patch)
      return latestSummaries()
    },
    /** Snapshot taken just before a walk starts. */
    beginWalk() {
      return pending.length
    },
    /** Re-apply the patches that landed during the walk; returns fresh summaries. */
    endWalk(startLength) {
      const start = Number.isFinite(startLength) ? startLength : 0
      const late = pending.slice(start)
      pending = late
      for (const patch of late) lastRowCache = applyRowPatch(lastRowCache, patch)
      return latestSummaries()
    },
    /** Whether any patch is still held (diagnostics/tests). */
    pendingCount() {
      return pending.length
    },
  }
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
    const pending = []
    for (const ws of workspaces) {
      const title = ws.title || basename(ws.path)
      const persistedEnvs = new Set((byPath.get(ws.path) || []).map((p) => p.env))
      pending.push(
        resolveWorkspaceEnvs(subprocess, ctx.get('fs'), ws.path, undefined).then((resolved) => {
          const out = []
          for (const r of resolved) {
            out.push({ wsPath: ws.path, title, env: r.env, dsn: r.dsn, source: r.source, persisted: persistedEnvs.has(r.env) })
          }
          return out
        }),
      )
    }
    // Resolve the workspaces CONCURRENTLY: each one may spawn `mise env` (bounded,
    // see runMiseEnv), and running them in series made one slow directory delay
    // every other workspace — including the model-facing list/execute calls, which
    // walk synchronously and used to be interrupted as "hung".
    const chunks = await Promise.all(pending)
    for (const chunk of chunks) rows.push(...chunk)
  } catch (e) {
    console.error('[dsh-dbhub-live] source discovery failed: ' + String((e && e.message) || e))
  }
  lastRowCache = rows
  rowCacheReady = true
  return { rows }
}

// Shared "plugin disabled" copy for every dbhub tool (locale-aware).
export function disabledMessage() {
  return currentT('result.disabled')
}