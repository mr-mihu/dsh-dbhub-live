// dsh-dbhub-live v4.0: STATELESS zero-knowledge dbhub executor + live status UI.
//
// Cordis namespace plugin (named exports, no default export). Installed as a
// dsh profile bundle: `dsh plugin --profile web add dsh-dbhub-live`.
//
// Architecture:
//   - NO resident dbhub server. Every tool call (dbhub_execute_sql /
//     dbhub_search_objects) spawns its OWN throwaway `dbhub --transport stdio
//     --dsn <dsn>` process and kills it after the call — execution is
//     stateless, concurrent (process-per-call) and fault-isolated. There is no
//     toml, no fingerprint, no idle recycle, no orphan cleanup, and no port to
//     collide on across DSH instances.
//   - Zero-knowledge model contract: the model only ever sees source handles
//     (`<workspace>[_<env>]`) and METADATA (type/host/port/database). DSNs,
//     usernames and passwords live host-side and never reach the model;
//     dbhub_configure collects the password through a UI question
//     (askUser), not through a tool argument.
//   - Config is the asset: credentials.json (workspace × environment → DSN)
//     + mise/.env auto-discovery + authorized project-file scan + the
//     settings card. Every write is atomic (tmp+rename).
//   - Lazy nothing: tools register immediately; the dbhub executable resolves
//     (persisted → mise → PATH → auto-install) on first execution.
//   - Live status: the host publishes ONE view (enabled toggle + options +
//     metadata-only workspace summaries) and fans it out to every active
//     channel. dsh <= 0.1.6 gets the settings namespace it always had; every
//     line (including 0.2.x, which removed that namespace and the browser's
//     `settingsScope` reader) gets the authenticated `connection.fetch` bridge
//     at /api/dsh-dbhub-live/*. The browser half reads whichever exists.
//
// Data (credentials.json, runtime.json, dbhub-runtime/) lives in
// $DSH_HOME/storages/dsh-dbhub-live — outside the module tree, since the
// module may be installed under the profile's node_modules (pnpm-managed)
// which must not be written to. The process environment is deliberately NOT
// consulted for connections.

import {
  maybeRefreshDbhub,
} from './runtime.mjs'
import {
  activeToolCount, refreshToolCount,
  collectSources, latestSummaries, hasRowCache, createRowMirror,
} from './mcp.mjs'
import { registerCoreTools } from './tools.mjs'
import { probeConnection } from './adhoc.mjs'
import { createBridgeRoutes, BRIDGE_BASE } from './bridge.mjs'
import {
  listWorkspaces, setWorkspaceEnv, removeWorkspaceEnv, renameWorkspaceEnv, normalizeEnvName,
} from './config.mjs'
import { setLocaleProvider, currentT } from './i18n.mjs'
import * as state from './state.mjs'
import * as options from './options.mjs'

export const name = 'dsh-dbhub-live'
// Real-module Guard requires declared injection before touching `ctx.tools`;
// the timer mixin powers idle recycling.
export const inject = ['tools', 'timer']

// ── settings namespace: live status mirror + configurable options ─────────

// The namespace must match the settings-namespace pattern
// (^[a-z][a-z0-9-]*$) — derived from @deepseek-ai/dsh-settings'
// `settingsNamespace()` brand without importing it, so a plugin installed as a
// local-directory link (whose bare imports resolve from the source tree) can
// never fail to boot over a settings accessory.
const STATUS_NS = 'dsh-dbhub-live'

const STATUS_DEFAULTS = {
  enabled: true,
  phase: 'running',
  toolCount: 0,
  lastError: '',
  mode: 'oneshot',
  updateIntervalDays: 7,
  // Whether the browser half contributes its own sidebar entry; the settings
  // page renders the switch (the page itself is a settings section and the
  // plugin's row on the Plugins page, so hiding the entry never locks anyone
  // out of the configuration).
  showSidebarEntry: true,
  // Workspace-connection summaries ride as a JSON string so the schema never
  // has to validate their arbitrary shape; `configOp` is the one-way command
  // channel from the card (host consumes it and republishes without it).
  workspaces: '[]',
  configOp: '',
  // Transient feedback for connection tests ({op:'test'} commands): a JSON
  // string {nonce, ok, message} the host sets when a test finishes. Never
  // persisted anywhere — the card only shows it while its own pending nonce
  // matches (a reload drops the pending map, so the result cannot stick).
  testResult: '',
}

// Prefer the real schemastery schema (standard path, present in every dsh
// deployment); fall back to a minimal schema object with the same contract
// (`schema(value)` resolves defaults, `schema.toJSON()` feeds describe()) when
// the package is not importable — e.g. a dev install via `dsh plugin add <dir>`
// where the source tree sits outside the profile's node_modules chain.
let STATUS_SCHEMA
// The plugin's own Config: the two UI options, declared as `.volatile()` fields
// so dsh 0.1.7+/0.2.x serves them in the official Plugins form and commits edits
// straight into live references. `undefined` when schemastery is unavailable —
// the Loader skips validation for a plugin without a Config, which is exactly
// the old behaviour.
let CONFIG_SCHEMA
try {
  const z = (await import('@deepseek-ai/schemastery')).default
  STATUS_SCHEMA = z.object({
    enabled: z.boolean().default(STATUS_DEFAULTS.enabled),
    phase: z.string().default(STATUS_DEFAULTS.phase),
    toolCount: z.number().min(0).default(STATUS_DEFAULTS.toolCount),
    lastError: z.string().default(STATUS_DEFAULTS.lastError),
    mode: z.string().default(STATUS_DEFAULTS.mode),
    updateIntervalDays: z.number().min(0).default(STATUS_DEFAULTS.updateIntervalDays),
    showSidebarEntry: z.boolean().default(STATUS_DEFAULTS.showSidebarEntry),
    workspaces: z.string().default(STATUS_DEFAULTS.workspaces),
    configOp: z.string().default(STATUS_DEFAULTS.configOp),
    testResult: z.string().default(STATUS_DEFAULTS.testResult),
  })
  // schemastery 3.18.2 (shipped with dsh 0.1.6) has no `.volatile()`; the guard
  // keeps the declaration valid there, where the fields arrive as plain values.
  const volatileField = (field) => (typeof field.volatile === 'function' ? field.volatile() : field)
  // No defaults on purpose: an unset field must be distinguishable from an
  // explicit choice, so `configValuesOf` can tell "the operator pinned this"
  // from "nobody said anything".
  CONFIG_SCHEMA = z.object({
    updateIntervalDays: volatileField(z.number().min(0)),
    showSidebarEntry: volatileField(z.boolean()),
  })
} catch (e) {
  const fallbackSchema = (value) => {
    const out = {}
    for (const key of Object.keys(STATUS_DEFAULTS)) {
      out[key] = value && value[key] !== undefined && value[key] !== null ? value[key] : STATUS_DEFAULTS[key]
    }
    return out
  }
  fallbackSchema.toJSON = () => ({ type: 'object', properties: {} })
  STATUS_SCHEMA = fallbackSchema
  console.warn('[dsh-dbhub-live] @deepseek-ai/schemastery 不可解析，使用内置最小状态 schema（状态卡片功能不受影响）')
}

// Declared Config (named export read by the Loader). Volatile on 0.1.7+/0.2.x,
// plain on 0.1.6, absent when schemastery could not be imported.
export const Config = CONFIG_SCHEMA

// The plugin's own Loader entry id — the key every settings form is addressed
// by (`settings.update(id, …)`, `ctx.configForms.get(id)`). Read from the
// running fiber so a deployment that mounts this package under a different row
// id still works; `undefined` on a fiber with no entry (and on any runtime that
// predates `fiber.entry`).
function entryIdOf(ctx) {
  try {
    const entry = ctx && ctx.fiber ? ctx.fiber.entry : undefined
    const id = entry && entry.options ? entry.options.id : entry ? entry.id : undefined
    return typeof id === 'string' && id ? id : undefined
  } catch (e) {
    return undefined
  }
}

// Resolve a workspace selector (path or title) from the card ops. An EMPTY
// selector means "the current workspace" (the card leaves the field blank by
// default): fall back to the first registered workspace instead of dropping
// the op — a blank-workspace add/remove/test was silently discarded before.
//
// The SAME listing the discovery walk uses (`listWorkspaces(ctx)`, which prefers
// the live workspace registry) resolves the card's selector, so a row written by
// the card is keyed by the path the walk will look it up under. Resolving it from
// a different source left rows that only the card could see.
async function resolveWorkspaceRef(ref, ctx) {
  const workspaces = await listWorkspaces(ctx)
  const wanted = String(ref || '').trim()
  if (wanted) {
    const byPath = workspaces.find((w) => w.path === wanted)
    if (byPath) return byPath
    const byTitle = workspaces.find((w) => w.title === wanted)
    if (byTitle) return byTitle
  }
  return workspaces[0] || undefined
}

// Hard cap for one card connection test (the probe is a throwaway dbhub +
// SELECT 1; the timeout also kills the spawned process when it fires). Must be
// comfortably BELOW the client-side watchdog so the {nonce, ok, message}
// report always wins the race against "测试超时未返回" (15s == 15s lost races).
const TEST_TIMEOUT_MS = 25000

// Backstop: even if the underlying dbhub spawn never settles (subprocess-
// service hiccup), the card ALWAYS receives a report inside the probe budget
// instead of letting the browser-side watchdog answer with a bare timeout.
//
// The backstop timer stays REFERENCED (an `unref()`ed one is not a backstop:
// with nothing else pending the loop drains and the process exits before it can
// fire) and is cleared as soon as the race settles, so a fast probe never leaves
// a live timer behind.
function withProbeTimeout(promise, ms) {
  let timer
  const backstop = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, message: currentT('result.testTimeout') }), ms + 500)
  })
  return Promise.race([promise, backstop]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// One card connection test: { op: 'test', workspace, env, nonce }. Resolves
// the REAL DSN host-side (the card only ever holds the masked summary), then
// probes it through an isolated ad-hoc connection — the persistent server is
// never restarted or otherwise touched, and a failure only ever means a red
// line on the card. The compact {nonce, ok, message} report goes back through
// `reportTest` (the transient namespace `testResult` field); nothing is
// persisted.
async function handleTestOp(op, ctx, subprocess, ws, reportTest) {
  const nonce = typeof op.nonce === 'string' ? op.nonce : ''
  const report = (ok, message) => {
    if (typeof reportTest !== 'function') return
    try {
      reportTest(JSON.stringify({ nonce, ok: ok === true, message: String(message || '') }))
    } catch (e) {
      /* the callback is ours; never let reporting break the op chain */
    }
  }
  try {
    // Pre-save validation path: {op:'test', dsn, nonce, workspace, env} — the
    // card gates the "add/save" button on a live probe, so an unpersisted DSN
    // can be tested without writing to the store first.  When `dsn` is given
    // we skip the persisted-row lookup entirely and probe the raw string the
    // user typed (the masked-card flow still works: `dsn` is left blank and
    // we look up the row by workspace + env like before).
    const inlineDsn = typeof op.dsn === 'string' && op.dsn.trim() ? op.dsn.trim() : ''
    if (inlineDsn) {
      if (!ws) {
        report(false, currentT('log.opNoWs', { ws: String(op.workspace || '') }))
        return
      }
      const envName = String(op.env == null ? '' : op.env).trim() || 'default'
      console.log('[dsh-dbhub-live] ' + currentT('log.testStart', { title: ws.title, env: envName }) + ' (预校验)')
      const res = await withProbeTimeout(probeConnection(subprocess, inlineDsn, TEST_TIMEOUT_MS), TEST_TIMEOUT_MS)
      report(res.ok, res.message)
      if (!res.ok) console.error('[dsh-dbhub-live] ' + currentT('log.testDone', { title: ws.title, env: envName, result: 'FAIL(预校验) — ' + res.message }))
      else console.log('[dsh-dbhub-live] ' + currentT('log.testDone', { title: ws.title, env: envName, result: 'OK — ' + res.message }))
      return
    }
    if (!ws) {
      report(false, currentT('log.opNoWs', { ws: String(op.workspace || '') }))
      return
    }
    const envName = String(op.env == null ? '' : op.env).trim() || 'default'
    console.log('[dsh-dbhub-live] ' + currentT('log.testStart', { title: ws.title, env: envName }))
    const { rows } = await collectSources(ctx, subprocess)
    const row = rows.find((r) => r.wsPath === ws.path && r.env === envName)
    if (!row) {
      report(false, currentT('result.testNoRow'))
      console.log('[dsh-dbhub-live] ' + currentT('log.testDone', { title: ws.title, env: envName, result: 'FAIL — ' + currentT('result.testNoRow') }))
      return
    }
    const res = await withProbeTimeout(probeConnection(subprocess, row.dsn, TEST_TIMEOUT_MS), TEST_TIMEOUT_MS)
    report(res.ok, res.message)
    if (!res.ok) console.error('[dsh-dbhub-live] ' + currentT('log.testDone', { title: ws.title, env: envName, result: 'FAIL — ' + res.message }))
    else console.log('[dsh-dbhub-live] ' + currentT('log.testDone', { title: ws.title, env: envName, result: 'OK — ' + res.message }))
  } catch (e) {
    console.error('[dsh-dbhub-live] 卡片连接测试异常: ' + String((e && e.stack) || e))
    report(false, String((e && e.message) || e))
  }
}

// One card command: { op: 'add'|'remove', workspace, env, dsn? } or
// { op: 'test', workspace, env, nonce } (connection probe, zero side effects).
// `publishFast` mirrors a completed write from the cached rows right away; the
// caller publishes the walked result afterwards. Returns the applied patches
// (empty for a probe or a no-op) so the caller can mirror them immediately too.
// `rawOp` is the encoded command the settings-document channel carries and the
// decoded object the HTTP bridge carries.
async function handleConfigOp(rawOp, ctx, subprocess, reportTest, publishFast) {
  const patches = []
  let op
  try {
    op = typeof rawOp === 'string' ? JSON.parse(String(rawOp || '')) : rawOp
  } catch (e) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opBad', { raw: String(rawOp) }))
    return patches
  }
  if (!op || typeof op !== 'object') return patches
  const ws = await resolveWorkspaceRef(op.workspace, ctx)
  if (op.op === 'test') {
    await handleTestOp(op, ctx, subprocess, ws, reportTest)
    return patches
  }
  if (!ws) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opNoWs', { ws: String(op.workspace || '') }))
    return patches
  }
  try {
    if (op.op === 'add' || op.op === 'set') {
      const dsn = typeof op.dsn === 'string' ? op.dsn.trim() : ''
      if (!dsn) throw new TypeError('DSN 不能为空')
      // An edit that also renamed the environment: move the row in place first
      // so the new DSN lands on the new name and the old name is not left
      // behind. One op = one namespace command (two would race on the single
      // `configOp` field).
      const renameFrom = typeof op.renameFrom === 'string' && op.renameFrom.trim() ? op.renameFrom.trim() : ''
      if (renameFrom && renameFrom !== String(op.env == null ? '' : op.env).trim()) {
        const moved = renameWorkspaceEnv(ws.path, renameFrom, op.env)
        if (moved) {
          patches.push({ op: 'rename', path: ws.path, env: moved, from: renameFrom })
          console.log('[dsh-dbhub-live] ' + currentT('log.opRenamed', { title: ws.title, from: renameFrom, to: moved }))
        }
      }
      const source = op.source === 'collected' ? 'collected' : 'user'
      const envName = setWorkspaceEnv(ws.path, op.env, dsn, source)
      patches.push({ op: 'add', path: ws.path, title: ws.title, env: envName, dsn, source })
      console.log('[dsh-dbhub-live] ' + currentT('log.opSaved', { title: ws.title, env: envName }))
    } else if (op.op === 'rename') {
      const from = op.env
      const to = op.newEnv
      const renamed = renameWorkspaceEnv(ws.path, from, to)
      if (!renamed) console.log('[dsh-dbhub-live] ' + currentT('log.opRenameMissing', { title: ws.title, env: String(from || 'default') }))
      else {
        patches.push({ op: 'rename', path: ws.path, env: renamed, from: normalizeEnvName(from) })
        console.log('[dsh-dbhub-live] ' + currentT('log.opRenamed', { title: ws.title, from: String(from || 'default'), to: renamed }))
      }
    } else if (op.op === 'remove') {
      const removed = removeWorkspaceEnv(ws.path, op.env)
      if (!removed) console.log('[dsh-dbhub-live] ' + currentT('log.opNothing', { title: ws.title }))
      else {
        patches.push({ op: 'remove', path: ws.path, env: normalizeEnvName(op.env) })
        console.log('[dsh-dbhub-live] ' + currentT('log.opRemoved', { title: ws.title, env: String(op.env || 'default') }))
      }
    } else {
      console.warn('[dsh-dbhub-live] ' + currentT('log.opUnknown', { op: String(op.op) }))
    }
  } catch (e) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opNoWs', { ws: String((e && e.message) || e) }))
    return []
  }
  // Mirror the write IMMEDIATELY from the cached rows (the card shows the result
  // before the caller's discovery walk finishes). The walk itself is the caller's
  // job: it is single-flight, and it re-applies any patch that landed while it was
  // running, so no walk can publish a list without this write.
  publishFast(patches)
  console.log('[dsh-dbhub-live] ' + currentT('log.syncApplied', { n: activeToolCount() }))
  refreshToolCount()
  return patches
}

// ── live host core: one merged view, fanned out to every active channel ───
//
// Publishing is channel-independent: the 0.1.x settings namespace and the HTTP
// bridge are adapters over the SAME walk / row-mirror / command core, so the
// two channels cannot drift apart. `view()` is the object the settings
// namespace used to carry, field for field.
function createHostCore(ctx) {
  // Resolved per call: `subprocess` is an optional service and may arrive after
  // this fiber has started.
  const subprocessOf = () => ctx.get('subprocess')
  // Transient connection-test report (in-memory only): every publish carries
  // the latest one; the card surfaces it only for a nonce it itself dispatched,
  // so a page reload silently drops any stale report.
  let lastTestResult = ''
  // The card's own writes are held here until a walk that started after them
  // lands (see createRowMirror): a slow walk that began before a write would
  // otherwise publish a list without it, which reads as "the row appeared and
  // then vanished".
  const mirror = createRowMirror()
  const sinks = new Set()

  const view = () => ({
    ...state.snapshot(),
    ...options.snapshot(),
    workspaces: JSON.stringify(latestSummaries()),
    testResult: lastTestResult,
    // The browser half needs this to address the plugin's own settings form
    // (`ctx.configForms.get(entryId)`) for option writes; '' when the entry
    // cannot be resolved, in which case it falls back to POST /options.
    entryId: entryIdOf(ctx) || '',
  })

  /** Subscribe one channel sink; returns the disposer. */
  const onPublish = (sink) => {
    sinks.add(sink)
    return () => sinks.delete(sink)
  }

  // Mirror the CURRENT cache without walking. Cheap and synchronous: used
  // after a card op patched the cache (so the row appears/disappears the
  // moment the Host handles the click) and after a walk that already
  // refreshed it.
  const publishMirror = () => {
    const merged = view()
    for (const sink of [...sinks]) {
      try {
        sink(merged)
      } catch (e) {
        console.warn('[dsh-dbhub-live] 状态同步失败: ' + String((e && e.message) || e))
      }
    }
  }
  // Publish a card write immediately, from the walk result cached in mcp, so
  // the card never waits for the (potentially multi-second, `mise env`-heavy)
  // discovery walk. Skipped before the first walk: an unfinished cache would be
  // published as "no connections at all".
  const publishFast = (patches) => {
    if (!Array.isArray(patches) || patches.length === 0) return false
    if (!hasRowCache()) return false
    try {
      for (const patch of patches) mirror.patch(patch)
      publishMirror()
      return true
    } catch (e) {
      console.warn('[dsh-dbhub-live] 状态快照补丁失败: ' + String((e && e.message) || e))
      return false
    }
  }
  // ONE walk at a time: overlapping walks used to race on the shared row
  // cache, and whichever finished last won — a walk started before a write
  // could therefore overwrite the row that write had just published. Extra
  // requests coalesce into a single follow-up walk.
  let walking = false
  let walkRequested = false
  const runWalk = () => {
    const startedWith = mirror.beginWalk()
    walking = true
    const settle = () => {
      mirror.endWalk(startedWith)
      publishMirror()
    }
    collectSources(ctx, subprocessOf()).then(settle, settle).finally(() => {
      walking = false
      if (walkRequested) {
        walkRequested = false
        runWalk()
      }
    })
  }
  // Every publish re-walks the connection rows, so ANY config change —
  // including one made through dbhub_configure in the chat, which writes the
  // store without touching the state machine — shows up on the card on the next
  // publish (the walk is cheap: registry + env files).
  const publish = () => {
    if (walking) {
      walkRequested = true
      return
    }
    runWalk()
  }
  const reportTest = (reportJson) => {
    lastTestResult = reportJson
    // A probe changes NO rows: mirror it, do not re-walk the workspaces.
    publishMirror()
  }
  // One card command, from whichever channel carried it. The caller owns the
  // follow-up republish; a write is already mirrored by publishFast.
  const runOp = async (rawOp) => {
    const patches = await handleConfigOp(rawOp, ctx, subprocessOf(), reportTest, publishFast)
    if (Array.isArray(patches) && patches.length > 0) publish()
    else publishMirror()
    return patches
  }

  return { view, onPublish, publish, publishMirror, publishFast, reportTest, runOp }
}

// ── channel 1: the settings namespace (dsh 0.1.6 and older only) ──────────
//
// dsh 0.1.7 replaced this document with Config-derived forms, so
// `settings.register` no longer exists and this channel becomes a no-op. It is
// kept because a 0.1.x deployment still stores the two UI options in that
// document: dropping the channel would silently reset a saved preference.
function wireLegacySettings(ctx, core) {
  ctx.inject(['settings'], (sctx) => {
    if (typeof sctx.settings?.register !== 'function') return
    // The whole callback runs inside one guard: a wiring failure must surface
    // in the log instead of silently killing the status surface.
    const wrap = (fn) => {
      try {
        return fn()
      } catch (e) {
        console.error('[dsh-dbhub-live] 状态接线异常: ' + String((e && e.stack) || e))
        return undefined
      }
    }
    wrap(() => {
      const scope = sctx.settings.register(STATUS_NS, STATUS_SCHEMA, { base: {} })
      console.log('[dsh-dbhub-live] ' + currentT('log.nsRegistered'))
      // The user layer is read BEFORE the first write into the scope, so a saved
      // option can never be clobbered by a built-in default. Our own prefs file
      // outranks it (options.initFromLayers enforces that).
      const legacyUser = (() => {
        try {
          const found = sctx.settings.describe().find((d) => d && d.ns === STATUS_NS)
          return found && found.user && typeof found.user === 'object' ? found.user : {}
        } catch (e) {
          return {}
        }
      })()
      options.initFromLayers({ legacyUser })
      const stopPublish = core.onPublish((next) => {
        scope.replace(next).catch((e) => {
          console.warn('[dsh-dbhub-live] 状态同步失败: ' + String((e && e.message) || e))
        })
      })
      const stopWatch = scope.watch((next) => {
        const value = next && typeof next === 'object' ? next : {}
        if (typeof value.enabled === 'boolean' && value.enabled !== state.isEnabled()) {
          state.setEnabled(value.enabled)
        }
        // Config edits from the card land here; applying them republishes the
        // merged snapshot (the republish is a no-op for unchanged fields).
        if (options.applyPatch(value)) core.publish()
        // One-way workspace-config command.
        if (typeof value.configOp === 'string' && value.configOp.trim() !== '' && value.configOp !== '{}') {
          core.runOp(value.configOp).catch(() => core.publish())
        }
      })
      sctx.effect(() => () => {
        stopPublish()
        stopWatch()
      })
      // Fresh summaries at attach. The walk itself is kicked once by apply().
      core.publishMirror()
    })
  })
}

// ── channel 2: the authenticated HTTP bridge (every supported dsh line) ───
//
// `connection.fetch` inherits Connection's Host/Origin fence and browser
// authentication; a raw `webServer` route would have neither. A host-only
// composition simply never starts this fiber — the tools keep working.
function wireHttpBridge(ctx, core) {
  ctx.inject(['connection'], (sctx) => {
    const face = sctx.connection?.fetch
    if (!face || typeof face.register !== 'function') return
    try {
      const routes = createBridgeRoutes({
        getView: core.view,
        handleOp: core.runOp,
        setEnabled: (value) => {
          state.setEnabled(value)
          core.publish()
        },
        setOptions: (patch) => {
          // A user write claims the field: persist it so the choice survives a
          // restart on a runtime without a settings document.
          if (options.applyPatch(patch, { persist: true })) core.publish()
          else core.publishMirror()
          // Keep the profile patch in step with the page (best effort): the
          // official Plugins form and `dsh --dump-config` must not disagree
          // with what this page just saved.
          void writeOptionsToForm(ctx, patch)
        },
      })
      for (const route of routes) face.register(route)
      console.log('[dsh-dbhub-live] 浏览器桥接已注册: ' + BRIDGE_BASE + '/*')
    } catch (e) {
      console.error('[dsh-dbhub-live] 桥接注册异常: ' + String((e && e.stack) || e))
    }
  })
}

// ── the official settings surface (dsh 0.1.7+/0.2.x) ──────────────────────
//
// Two things ride the settings service on those lines:
//   1. the presentation policy — this plugin ships its own page, so it must
//      switch OFF the auto-generated form for its entry (otherwise the Plugins
//      page renders a second, competing editor);
//   2. the option write-through — a page save also lands in the profile patch,
//      which is the store the standard form reads.
// Both are best effort: a deployment without the settings service (or without
// write access to the profile patch) keeps working off prefs.json.

/** Push one option patch into this entry's Config, when that is possible. */
async function writeOptionsToForm(ctx, patch) {
  const id = entryIdOf(ctx)
  if (!id) return false
  const settings = ctx.get('settings')
  if (!settings || typeof settings.update !== 'function') return false
  const clean = {}
  for (const key of Object.keys(options.snapshot())) {
    if (patch && patch[key] !== undefined) clean[key] = patch[key]
  }
  if (Object.keys(clean).length === 0) return false
  try {
    await settings.update(id, clean)
    return true
  } catch (e) {
    // A read-only deployment (or a profile patch this process may not write)
    // must not break the page: prefs.json already holds the value.
    console.warn('[dsh-dbhub-live] 配置表单写入失败（仅本地 prefs 生效）: ' + String((e && e.message) || e))
    return false
  }
}

function wireSettingsPolicy(ctx) {
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings
    if (!settings || typeof settings.configure !== 'function') return
    try {
      // `auto: false` = "this plugin draws its own page" (the plugins.row.config
      // card, the settings.section page and the sidebar panel all read the same
      // face). Without it the Plugins page also renders a generated form for the
      // same entry. Re-running after an HMR reload throws, hence the guard.
      sctx.effect(() => settings.configure({ auto: false }, ctx.fiber))
      console.log('[dsh-dbhub-live] 配置表单策略已注册: auto=false')
    } catch (e) {
      console.warn('[dsh-dbhub-live] 配置表单策略注册失败: ' + String((e && e.message) || e))
    }
  })
}

// ── background boot ────────────────────────────────────────────────────────

let bootInFlight

// Fire-and-forget one bookkeeping run: mark the plugin 'running' (there is no
// server to start — each tool call spawns its own disposable dbhub), refresh
// the tool count, and check for a dbhub auto-update in the background (fails
// silently; the current binary stays in use). Concurrent calls share the
// in-flight run. Failures land in the state machine, never block boot.
function startBackgroundBoot(ctx, subprocess) {
  if (!state.isEnabled() || !subprocess) return undefined
  if (bootInFlight) return bootInFlight
  bootInFlight = (async () => {
    try {
      state.clearError()
      state.setPhase('running')
      refreshToolCount()
      console.log('[dsh-dbhub-live] ' + currentT('log.loaded', { n: activeToolCount() }))
      maybeRefreshDbhub(subprocess).catch((e) => {
        console.error('[dsh-dbhub-live] ' + currentT('log.updateCheckFailed', { msg: String((e && e.message) || e) }))
      })
    } catch (e) {
      state.recordError(String((e && e.message) || e))
      console.error('[dsh-dbhub-live] ' + currentT('log.initFailed') + ': ' + String((e && e.message) || e))
    } finally {
      bootInFlight = undefined
    }
  })()
  return bootInFlight
}

// ── apply ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  console.log('[dsh-dbhub-live] ' + currentT('log.hostApply'))
  // Host-side feedback follows the dsh UI language (settings.locale.preference).
  setLocaleProvider(() => {
    try {
      const settings = ctx.get('settings')
      if (!settings) return 'zh'
      const entry = settings.describe().find((d) => d && d.ns === 'locale')
      const preference = entry && entry.value && entry.value.preference
      return preference === 'en' ? 'en' : 'zh'
    } catch (e) {
      return 'zh'
    }
  })
  const subprocess = ctx.get('subprocess')
  registerCoreTools(ctx, subprocess)
  refreshToolCount()

  // One core, two channels: every state/option change replays the walk, and
  // the walk's result is fanned out to whichever channel is active. Order
  // matters only in that the legacy channel seeds the 0.1.x option layer before
  // it writes anything back into the settings document.
  const core = createHostCore(ctx)
  ctx.effect(() => {
    const stops = [state.subscribe(core.publish), options.subscribe(core.publish)]
    return () => {
      for (const stop of stops) stop()
    }
  })
  // Config is a write channel, not a second store: whatever it carries — a
  // cordis.yml pin, or a commit from the official Plugins form — is adopted
  // into the effective options and persisted, so the page and the standard form
  // converge on one value instead of drifting apart.
  const adoptConfig = () => {
    const patch = options.configValuesOf(config)
    if (Object.keys(patch).length === 0) return
    if (options.applyPatch(patch, { persist: true })) core.publish()
  }
  ctx.on('loader/volatile-update', adoptConfig)
  wireSettingsPolicy(ctx)
  wireLegacySettings(ctx, core)
  wireHttpBridge(ctx, core)
  // Adopt before the first publish, so a pinned value is what the page opens on.
  adoptConfig()
  core.publish()

  if (!subprocess) {
    console.error('[dsh-dbhub-live] subprocess unavailable — 工具已注册；dbhub 首次执行时若有需要会延迟解析（需 subprocess 服务）')
    return
  }
  if (state.isEnabled()) {
    startBackgroundBoot(ctx, subprocess).catch(() => {
      /* recorded in state */
    })
  } else {
    console.log('[dsh-dbhub-live] ' + currentT('log.disabledBoot'))
  }
}