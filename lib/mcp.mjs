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
import { StringDecoder } from 'node:string_decoder'
import {
  store, listWorkspaces, listWorkspaceEnvironments, resolveWorkspaceEnvs,
  slugify, envSlug, shortHash, connLabel, describeEnvOptions, normalizeEnvName, parseMaxRows,
  dsnHasInlinePassword,
} from './config.mjs'
import { currentT } from './i18n.mjs'
import { assignConnectionAliases } from './collect.mjs'
import * as state from './state.mjs'

// ── MCP client (JSON-RPC 2.0 over stdio) ─────────────────────────────────
//
// Request-level budgets. `exec.signal` (user cancel / turn interruption) is the
// only other cancel source, so without a timer a dbhub that is ALIVE but never
// answers hangs the whole conversation round: the request never settles, the
// caller's `finally` is unreachable, and the child plus its temp TOML leak until
// the session ends (measured: still pending after 2.5 s, nothing ever cleaned).

/**
 * Handshake budget: dbhub answers `initialize` from its own bootstrap — no
 * database work — so a silence this long means the process is wedged.
 */
export const MCP_INIT_TIMEOUT_MS = 15000

/**
 * Budget for ONE `tools/call`.
 *
 * This is a HANG DETECTOR, not a query budget: a legitimately slow statement (a
 * big export, a long ANALYZE) may run for minutes and must never be cut by the
 * plugin, so the value sits far above any plausible query and only fires when
 * dbhub has stopped answering altogether.
 */
export const MCP_CALL_TIMEOUT_MS = 120000

/**
 * Cap for ONE unterminated JSON-RPC line (8 MiB). Guards the case that has no
 * newline at all: without it a chatty or broken child grows the buffer until the
 * process dies.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024

/**
 * Cap for everything ONE client accumulates for its answers (64 MiB). A single
 * call's reply is orders of magnitude smaller; exceeding this means the stream is
 * garbage, not a result.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/** A request that never got its answer. The message names the method + budget only. */
function timeoutError(method, ms) {
  const err = new Error('MCP request timed out after ' + ms + 'ms: ' + method)
  err.code = 'MCP_TIMEOUT'
  err.method = method
  err.timeoutMs = ms
  return err
}

/** A response beyond MAX_LINE_BYTES / MAX_RESPONSE_BYTES. Numbers only, never params. */
function tooLargeError(kind, limitBytes) {
  const err = new Error(
    'MCP response too large (' + (kind === 'line' ? 'single line' : 'total stream') +
      ' exceeded ' + limitBytes + ' bytes)',
  )
  err.code = 'MCP_TOO_LARGE'
  err.limitKind = kind
  err.limitBytes = limitBytes
  return err
}

/**
 * JSON-RPC 2.0 client over one parented dbhub process (stdio transport).
 *
 * @param handle - host subprocess handle (`stdin`/`stdout`/`stderr`/`done`).
 * @param onStderr - optional `data` listener for the child's stderr.
 * @param onNotification - optional handler for id-less JSON-RPC notifications.
 * @param opts - `{ requestTimeoutMs }`: default budget for every request that
 *   does not pass its own (0/absent falls back to the per-method constants).
 */
export function createMcpClient(handle, onStderr, onNotification, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const defaultTimeoutMs = Number.isFinite(o.requestTimeoutMs) && o.requestTimeoutMs > 0 ? o.requestTimeoutMs : 0
  const decoder = handle && handle.stdout ? new StringDecoder('utf8') : null
  let nextId = 1
  let closed = false
  let fatal = null // stream became unusable (oversized response): every later request fails
  // The unterminated line is held as PIECES plus a byte count instead of one
  // growing string: `buf +=` re-copies the whole backlog on every chunk, which is
  // quadratic (a 32 MiB single line cost 3.6 s of pure synchronous time — every
  // session stalled meanwhile).
  let lineParts = []
  let lineBytes = 0
  let totalBytes = 0
  const pending = new Map() // String(id) -> { resolve, reject, timer, method }

  const clearTimer = (p) => {
    if (p && p.timer) {
      clearTimeout(p.timer)
      p.timer = null
    }
  }
  const settleAll = (err) => {
    for (const p of pending.values()) {
      clearTimer(p)
      p.reject(err)
    }
    pending.clear()
  }
  const halt = (err) => {
    if (fatal || closed) return
    fatal = err
    settleAll(err)
  }

  /** Dispatch one complete line (already decoded, newline excluded). */
  const handleLine = (lineText) => {
    const line = lineText.trim()
    if (!line) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch (e) {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const hasId = msg.id !== undefined && msg.id !== null
    if (hasId) {
      // Ids are matched as STRINGS: dbhub may answer `"3"` for the request `3`,
      // and a `typeof msg.id === 'number'` gate silently dropped that reply — the
      // request stayed pending forever (only the request timeout made it visible).
      const key = String(msg.id)
      const p = pending.get(key)
      if (p) {
        pending.delete(key)
        clearTimer(p)
        if (msg.error) p.reject(new Error('MCP error: ' + JSON.stringify(msg.error)))
        else p.resolve(msg.result)
        return
      }
    }
    if (msg.method && !hasId && onNotification) {
      try {
        onNotification(msg)
      } catch (e) {
        /* contain listener failures */
      }
    }
  }

  const pushPiece = (text) => {
    if (!text) return
    lineParts.push(text)
    lineBytes += Buffer.byteLength(text, 'utf8')
    if (lineBytes > MAX_LINE_BYTES) halt(tooLargeError('line', MAX_LINE_BYTES))
  }

  const takeLine = () => {
    const line = lineParts.length === 1 ? lineParts[0] : lineParts.join('')
    lineParts = []
    lineBytes = 0
    return line
  }

  /** Split a decoded block into lines without ever concatenating the backlog. */
  const feed = (text) => {
    let rest = text
    while (!fatal) {
      const idx = rest.indexOf('\n')
      if (idx < 0) {
        pushPiece(rest)
        return
      }
      pushPiece(rest.slice(0, idx))
      if (fatal) return
      handleLine(takeLine())
      rest = rest.slice(idx + 1)
    }
  }

  const onData = (chunk) => {
    if (fatal || closed) return
    // Decode through a StringDecoder: `String(chunk)` decoded every 64 KiB block
    // on its own, so a multi-byte character split across a block boundary became
    // U+FFFD inside the reply ("中文结果" → "���文结果"). Only complete lines are
    // parsed; the decoder keeps the incomplete tail for the next block.
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (!text) return
    totalBytes += Buffer.byteLength(text, 'utf8')
    if (totalBytes > MAX_RESPONSE_BYTES) {
      halt(tooLargeError('total', MAX_RESPONSE_BYTES))
      return
    }
    feed(text)
  }

  if (handle && handle.stdout) handle.stdout.on('data', onData)
  if (handle.stderr && onStderr) handle.stderr.on('data', onStderr)
  // Writing into a pipe the child already closed surfaces asynchronously as an
  // `'error'` event; with no listener an EventEmitter `'error'` is an uncaught
  // exception. Treat it exactly like process death.
  if (handle.stdin && typeof handle.stdin.on === 'function') {
    handle.stdin.on('error', (err) => {
      closed = true
      settleAll(err instanceof Error ? err : new Error(String(err)))
    })
  }
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
    /**
     * Send one request and wait for its answer.
     * @param method - JSON-RPC method (`initialize` / `tools/call`).
     * @param params - request params (never logged, never put in an error).
     * @param reqOpts - `{ timeoutMs }`; `<= 0` disables the timer for this call.
     * @returns a promise of the JSON-RPC `result`.
     */
    request(method, params, reqOpts) {
      const explicit = reqOpts && Number.isFinite(reqOpts.timeoutMs) ? reqOpts.timeoutMs : undefined
      const timeoutMs = explicit !== undefined
        ? explicit
        : (defaultTimeoutMs || (method === 'initialize' ? MCP_INIT_TIMEOUT_MS : MCP_CALL_TIMEOUT_MS))
      return new Promise((resolve, reject) => {
        if (fatal) {
          reject(fatal)
          return
        }
        if (!handle.stdin) {
          reject(new Error('dbhub stdin unavailable'))
          return
        }
        if (closed) {
          reject(new Error('dbhub process is down'))
          return
        }
        const id = nextId++
        const key = String(id)
        const entry = { resolve, reject, timer: null, method }
        pending.set(key, entry)
        if (timeoutMs > 0) {
          // The timer stays REFERENCED on purpose: an unref'd budget never fires
          // when this request is the only pending work (the process would drain
          // and exit before it could fire).
          entry.timer = setTimeout(() => {
            const live = pending.get(key)
            if (!live) return
            pending.delete(key)
            clearTimer(live)
            reject(timeoutError(method, timeoutMs))
          }, timeoutMs)
        }
        try {
          handle.stdin.write(
            JSON.stringify(
              params === undefined
                ? { jsonrpc: '2.0', id, method }
                : { jsonrpc: '2.0', id, method, params },
            ) + '\n',
          )
        } catch (e) {
          pending.delete(key)
          clearTimer(entry)
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
 *
 * The id must also be INJECTIVE within one workspace: two rows sharing an id
 * make `resolveSource` answer `{ambiguous}` forever, i.e. neither connection is
 * reachable. `envSlug` therefore hashes every environment name whose ASCII
 * projection is lossy (`PROD`/`Prod`/`dev!`/`!!!`) and leaves the historical
 * readable handles (bare default, pure lowercase ASCII) byte-identical.
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
 * Matching is EXACT: the canonical source id (`<slug>_<hash>[_<envSlug>]`), the
 * display forms the list output prints (`<title>`, `<title>_<env>`,
 * `<title> <env>`, `<title>.<env>`), the bare environment name, the workspace
 * path and the row index. A suffix id like `app_ab12_demo` therefore resolves to
 * the demo row and NOT to the shorter base id `app_ab12`.
 *
 * There is deliberately NO substring/prefix fallback (`wanted.includes(k.id)`):
 * a misspelled handle — `app_ab12_dmeo`, one wrong character in the hash,
 * `<base>_<no-such-env>` — used to match the BASE row and silently return the
 * DEFAULT connection's DSN. A near miss is an unknown handle, and the caller
 * answers "not found" instead of querying a connection the model did not name.
 * The only suffix accepted besides the exact id is `<baseId>_<envSlug>` for an
 * environment that really exists on that row.
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
  const keyedOf = (rows) => rows.map((row, i) => {
    const id = sourceIdOf(row)
    const title = slugify(row.title)
    const env = envSlug(row.env)
    const baseId = title + '_' + shortHash(row.wsPath)
    const keys = new Set([id.toLowerCase(), title, String(row.wsPath).toLowerCase(), String(i)])
    // `<baseId>_<envSlug>` names an environment that EXISTS on this row (it is
    // the canonical id for a named environment, and the readable handle a model
    // tends to reconstruct). It is explicit, not a prefix match: `base_dmeo`
    // names nothing.
    if (env) keys.add((baseId + '_' + env).toLowerCase())
    if (row.env !== 'default') {
      // Display forms the model may echo back: both the ASCII slug and the RAW
      // environment name (a Chinese env must be referable as 线上 as well).
      for (const k of [title + '_' + env, title + '_' + row.env, title + ' ' + row.env, title + '.' + row.env, env, String(row.env)]) {
        keys.add(String(k).toLowerCase())
      }
    }
    return { row, id, keys }
  })
  const match = (keyed) => {
    const exact = keyed.filter((k) => k.id.toLowerCase() === wanted || k.keys.has(wanted))
    if (exact.length > 0) return pickBest(exact, preferredWsPath)
    return undefined
  }
  // Fast path (T2B.5): the card mirror already holds the rows the model was just
  // shown, so a handle that matches one of them EXACTLY is answered without
  // re-walking every workspace (each walk spawns `mise env` for every workspace
  // without a persisted default). Ambiguity handling is never bypassed, and a
  // handle that misses the cache falls through to a real walk — a connection
  // added since the last walk must still resolve.
  if (hasRowCache()) {
    const hit = match(keyedOf(lastRowCache))
    if (hit) return hit
  }
  const { rows } = await collectSources(ctx, subprocess)
  return match(keyedOf(rows))
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
 * leave the Host). Each row carries `conn` = host/port/database label only, the
 * read-only flag, and the SECRET-FREE tunnel metadata from
 * `describeEnvOptions` — never the tunnel password, passphrase or key path.
 *
 * Each row also carries `alias`, the short display name the composer's `@`
 * menu and the policy catalog use. It is assigned over the WHOLE row set (see
 * `assignConnectionAliases`), because uniqueness is a property of the set, not
 * of one row.
 */
export function summarizeRows(rows) {
  const aliases = assignConnectionAliases(rows)
  return rows.map((r, i) => {
    const opts = describeEnvOptions({ readOnly: r.ro === true, ssh: r.ssh || null, maxRows: r.maxRows })
    return {
      title: r.title,
      path: r.wsPath,
      env: r.env,
      alias: aliases[i],
      conn: connLabel(r.dsn),
      source: r.source,
      persisted: !!r.persisted,
      srcId: sourceIdOf(r),
      // Per-row edit stamp for the card's "recently updated" sort. Not a secret
      // and not a path: a millisecond number.
      updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
      ro: opts.ro,
      ssh: opts.ssh,
      // 0 = unlimited. Configuration metadata only — the model never sees a
      // result whose cap it cannot name, and the card needs it to prefill.
      maxRows: opts.maxRows,
      // A persisted row whose DSN still contains its password: the split was
      // refused/failed, so the value lives in the connection file instead of the
      // credential store. A boolean STATUS — never the password, never the ref —
      // so the card can say so in the row tooltip. Auto-discovered rows are not
      // flagged: their DSN comes from the project's own env file, not this store.
      ...(r.persisted && dsnHasInlinePassword(r.dsn) ? { passwordUnsplit: true } : {}),
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

/**
 * Shallow copy of the live row cache (host-side rows WITH their DSNs — never
 * handed to the browser or the model). Used by the connection-test fast path:
 * the row the card is currently showing is exactly what the user asked to test.
 */
export function cachedRows() {
  return lastRowCache.slice()
}

/**
 * Which connection a `{op:'test'}` should probe, resolved WITHOUT walking the
 * workspaces when that is sound (F4). Decision order:
 *   ① a persisted row — the store is authoritative for it, so testing it can
 *      never be "less accurate" than a fresh walk;
 *   ② a row the card is already displaying — precisely the row the user clicked,
 *      so a cold-cache re-discovery could only disagree with the screen;
 *   ③ neither → `null`, and the CALLER must `await` a real walk (this is the
 *      auto-discovered, never-walked case: only a walk can tell whether a
 *      connection exists at all).
 * Pure: takes the three inputs and returns a description, never touches the
 * walk itself.
 * @returns `{ dsn, ro, ssh, dsnPasswordRef?, from: 'store'|'cache' }` or `null`.
 */
export function resolveTestDsn(input) {
  const { storeRows, cachedRows: cached, hasCache } = input || {}
  const wsPath = String((input && input.wsPath) || '')
  const env = normalizeEnvName(input && input.env)
  const pick = (rows, from) => {
    if (!Array.isArray(rows)) return null
    const row = rows.find((r) => String(r.wsPath) === wsPath && normalizeEnvName(r.env) === env)
    if (!row || !row.dsn) return null
    return {
      dsn: row.dsn,
      ro: row.ro === true,
      ssh: row.ssh || null,
      // The probe resolves this like execution does; dropping it here would make
      // "test this saved connection" fail with a missing-password error.
      ...(typeof row.dsnPasswordRef === 'string' ? { dsnPasswordRef: row.dsnPasswordRef } : {}),
      from,
    }
  }
  return pick(storeRows, 'store') || (hasCache ? pick(cached, 'cache') : null)
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
  if (patch.op !== 'add' && patch.op !== 'set' && patch.op !== 'options') return list
  if (patch.op === 'options') {
    // Options-only write (read-only switch / SSH tunnel): the DSN and the row's
    // identity are untouched. Idempotent by construction — the same patch
    // applied twice yields the same row.
    const at = list.findIndex((r) => rowKey(r.wsPath, r.env) === rowKey(path, env))
    if (at < 0) return list
    const next = { ...list[at] }
    if (patch.ro !== undefined) next.ro = patch.ro === true
    if (patch.ssh !== undefined) next.ssh = patch.ssh || null
    // The card writes the row cap through the same `options` patch: mirror it so
    // the next render shows the value that was actually stored (0 = unlimited).
    if (patch.maxRows !== undefined) next.maxRows = parseMaxRows(patch.maxRows) || 0
    list[at] = next
    return list
  }
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
    ro: patch.ro === true,
    ssh: patch.ssh || null,
    maxRows: parseMaxRows(patch.maxRows) || 0,
    // Host-side only (the mirror patch is hydrated from the store): the row must
    // keep the reference its password lives under, or a test fired right after
    // the write would probe without it.
    ...(typeof patch.dsnPasswordRef === 'string' ? { dsnPasswordRef: patch.dsnPasswordRef } : {}),
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

// One in-flight walk, shared by every concurrent caller (see collectSources).
let walkInFlight = null

/**
 * Walk every workspace × environment and produce the live connection rows
 * (metadata for the card) and the resolved DSNs (host-side only — the tools
 * resolve `source` against these rows). Shared by dbhub_list_sources and the
 * settings publish path so the card always mirrors what the tools would use.
 *
 * A walk is EXPENSIVE (it spawns `mise env` for every workspace without a
 * persisted `default`), so concurrent callers — a card publish, a model list and
 * a connection test can all land in the same second — share ONE in-flight walk
 * instead of each running its own. Pass `{ force: true }` for a deliberate
 * rescan. A failed walk is never cached: the next caller really retries.
 *
 * Environment naming: the 'default' env keeps the legacy bare source id
 * (`<title>_<hash>`); extra environments append `_<envSlug>`.
 * @returns `{ rows }` — rows: [{ wsPath, title, env, dsn, source, persisted, ro, ssh }].
 */
export async function collectSources(ctx, subprocess, opts) {
  const force = !!(opts && opts.force)
  const inFlight = walkInFlight
  if (inFlight && !force) return inFlight
  const run = walkSources(ctx, subprocess)
  walkInFlight = run
  try {
    return await run
  } finally {
    if (walkInFlight === run) walkInFlight = null
  }
}

async function walkSources(ctx, subprocess) {
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
            out.push({
              wsPath: ws.path,
              title,
              env: r.env,
              dsn: r.dsn,
              // Host-side: keep the database-password reference with the row so a
              // copy/test can resolve the same secret the store names.
              ...(typeof r.dsnPasswordRef === 'string' ? { dsnPasswordRef: r.dsnPasswordRef } : {}),
              source: r.source,
              persisted: persistedEnvs.has(r.env),
              ro: r.ro === true,
              ssh: r.ssh || null,
              maxRows: r.maxRows || 0,
              updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
            })
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