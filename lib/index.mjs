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
//   - Live status: a settings namespace (dsh-dbhub-live) mirrors the plugin
//     state (enabled toggle + summaries), and the browser half renders it as a
//     status card in Settings → Plugins.
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
  collectSources, latestSummaries,
} from './mcp.mjs'
import { registerCoreTools } from './tools.mjs'
import { probeConnection } from './adhoc.mjs'
import {
  listWorkspaces, setWorkspaceEnv, removeWorkspaceEnv,
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
try {
  const z = (await import('@deepseek-ai/schemastery')).default
  STATUS_SCHEMA = z.object({
    enabled: z.boolean().default(STATUS_DEFAULTS.enabled),
    phase: z.string().default(STATUS_DEFAULTS.phase),
    toolCount: z.number().min(0).default(STATUS_DEFAULTS.toolCount),
    lastError: z.string().default(STATUS_DEFAULTS.lastError),
    mode: z.string().default(STATUS_DEFAULTS.mode),
    updateIntervalDays: z.number().min(0).default(STATUS_DEFAULTS.updateIntervalDays),
    workspaces: z.string().default(STATUS_DEFAULTS.workspaces),
    configOp: z.string().default(STATUS_DEFAULTS.configOp),
    testResult: z.string().default(STATUS_DEFAULTS.testResult),
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

// Resolve a workspace selector (path or title) from the card ops. An EMPTY
// selector means "the current workspace" (the card leaves the field blank by
// default): fall back to the first registered workspace instead of dropping
// the op — a blank-workspace add/remove/test was silently discarded before.
async function resolveWorkspaceRef(ref) {
  const workspaces = await listWorkspaces(undefined)
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
function withProbeTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, message: currentT('result.testTimeout') }), ms + 500)
      if (t && typeof t.unref === 'function') t.unref()
    }),
  ])
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
async function handleConfigOp(rawOp, ctx, subprocess, reportTest) {
  let op
  try {
    op = JSON.parse(String(rawOp || ''))
  } catch (e) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opBad', { raw: String(rawOp) }))
    return
  }
  if (!op || typeof op !== 'object') return
  const ws = await resolveWorkspaceRef(op.workspace)
  if (op.op === 'test') {
    await handleTestOp(op, ctx, subprocess, ws, reportTest)
    return
  }
  if (!ws) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opNoWs', { ws: String(op.workspace || '') }))
    return
  }
  try {
    if (op.op === 'add' || op.op === 'set') {
      const dsn = typeof op.dsn === 'string' ? op.dsn.trim() : ''
      if (!dsn) throw new TypeError('DSN 不能为空')
      const envName = setWorkspaceEnv(ws.path, op.env, dsn, op.source === 'collected' ? 'collected' : 'user')
      console.log('[dsh-dbhub-live] ' + currentT('log.opSaved', { title: ws.title, env: envName }))
    } else if (op.op === 'remove') {
      const removed = removeWorkspaceEnv(ws.path, op.env)
      if (!removed) console.log('[dsh-dbhub-live] ' + currentT('log.opNothing', { title: ws.title }))
      else console.log('[dsh-dbhub-live] ' + currentT('log.opRemoved', { title: ws.title, env: String(op.env || 'default') }))
    } else {
      console.warn('[dsh-dbhub-live] ' + currentT('log.opUnknown', { op: String(op.op) }))
    }
  } catch (e) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opNoWs', { ws: String((e && e.message) || e) }))
  }
  // Refresh the summaries cache so the card and the NEXT tool call resolve the
  // updated store immediately (tools resolve `source` → DSN at call time, so
  // no server restart or tool resync is needed).
  await collectSources(ctx, subprocess)
  console.log('[dsh-dbhub-live] ' + currentT('log.syncApplied', { n: activeToolCount() }))
  refreshToolCount()
}

// Mirrors the state machine + configurable options into the settings
// namespace when a settings provider is mounted (the Plugins tab dispatches
// our card from this namespace). The namespace's `enabled` field is how the
// card's toggle writes back, and the config field (`updateIntervalDays`) is
// how the card edits options. The host store remains the authoritative source
// and converges the document at boot. Everything is wired on the injected
// settings fiber so it rolls back with this plugin.
function wireStatusNamespace(ctx) {
  ctx.inject(['settings'], (sctx) => {
    // The whole callback runs inside one guard: a wiring failure must surface
    // in the log instead of silently killing the status surface (bootstrap
    // publishes, configOp commands and live summaries all live here).
    const wrap = (fn) => {
      try {
        return fn()
      } catch (e) {
        console.error('[dsh-dbhub-live] 状态接线异常: ' + String((e && e.stack) || e))
        return undefined
      }
    }
    wrap(() => {
      const subprocess = ctx.get('subprocess')
      const scope = sctx.settings.register(STATUS_NS, STATUS_SCHEMA, { base: {} })
      console.log('[dsh-dbhub-live] ' + currentT('log.nsRegistered'))
      // Precedence: user settings > process environment > built-in defaults.
      // Capture the user layer BEFORE our first publish, so env-seeded options
      // are only overridden by fields the user actually saved.
      const preBootUser = (() => {
        try {
          const found = sctx.settings.describe().find((d) => d && d.ns === STATUS_NS)
          return found && found.user && typeof found.user === 'object' ? found.user : {}
        } catch (e) {
          return {}
        }
      })()
      options.applyPatch(preBootUser)
      // Transient connection-test report (in-memory only): every publish
      // carries the latest one; the card surfaces it only for a nonce it
      // itself dispatched, so a page reload silently drops any stale report.
      let lastTestResult = ''
      // Every publish re-walks the connection rows first, so ANY config change
      // — including one made through dbhub_configure in the chat, which writes
      // the store without touching the state machine — shows up on the card on
      // the next publish (the walk is cheap: registry + env files; it already
      // happened on every card op before).
      const publish = () => {
        collectSources(ctx, subprocess).then(() => {
          const merged = {
            ...state.snapshot(),
            ...options.snapshot(),
            workspaces: JSON.stringify(latestSummaries()),
            testResult: lastTestResult,
          }
          scope.replace(merged).catch((e) => {
            console.warn('[dsh-dbhub-live] 状态同步失败: ' + String((e && e.message) || e))
          })
        }, () => {
          // Discovery walk failed — mirror the cached rows rather than nothing.
          const merged = {
            ...state.snapshot(),
            ...options.snapshot(),
            workspaces: JSON.stringify(latestSummaries()),
            testResult: lastTestResult,
          }
          scope.replace(merged).catch((e) => {
            console.warn('[dsh-dbhub-live] 状态同步失败: ' + String((e && e.message) || e))
          })
        })
      }
      // Fresh summaries at attach, then mirror every state change.
      publish()
      const stopWatch = scope.watch((next) => {
        const value = next && typeof next === 'object' ? next : {}
        if (typeof value.enabled === 'boolean' && value.enabled !== state.isEnabled()) {
          state.setEnabled(value.enabled)
        }
        // Config edits from the card land here; applying them republishes the
        // merged snapshot (the republish is a no-op for unchanged fields).
        if (options.applyPatch(value)) publish()
        // One-way workspace-config command.
        if (typeof value.configOp === 'string' && value.configOp.trim() !== '' && value.configOp !== '{}') {
          const op = value.configOp
          const reportTest = (reportJson) => {
            lastTestResult = reportJson
            publish()
          }
          handleConfigOp(op, ctx, subprocess, reportTest).then(publish, () => publish())
        }
      })
      const stopStatus = state.subscribe(publish)
      const stopOptions = options.subscribe(publish)
      sctx.effect(() => () => {
        stopWatch()
        stopStatus()
        stopOptions()
      })
      publish()
    })
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

export async function apply(ctx) {
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

  wireStatusNamespace(ctx)

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