// dsh-dbhub-live v3: PERSISTENT multi-source dbhub manager + live status UI.
//
// Cordis namespace plugin (named exports, no default export). Installed as a
// dsh profile bundle: `dsh plugin --profile web add dsh-dbhub-live`.
//
// Architecture:
//   - ONE persistent `dbhub --transport stdio --config <generated dbhub.toml>`
//     process, managed by this plugin (idle recycle, respawn on demand).
//   - dbhub.toml is auto-generated from every registered workspace's connection
//     config and hot-reloaded by dbhub itself. Users never maintain it.
//   - Each workspace becomes a dbhub source; tools are registered per-workspace
//     (`dbhub_execute_sql_<slug>` / `dbhub_search_objects_<slug>`) with the
//     connection target (host:port/database, password masked) labeled in the
//     tool description and result.
//   - Ad-hoc temporary connections (`dbhub_query`/`dbhub_query_objects`): model
//     passes a full dsn per request; each call is an independent throwaway
//     dbhub, so two calls can query two different databases at once.
//   - Lazy init: boot never blocks on dbhub; tools register immediately and the
//     environment initializes on first use (queries wait for readiness).
//   - Live status: a settings namespace (dsh-dbhub-live) mirrors the plugin
//     state (enabled toggle / phase / tool count / last error / mode), and the
//     browser half renders it as a status card in Settings → Plugins.
//
// Data (credentials.json, dbhub.toml) lives in $DSH_HOME/storages/dsh-dbhub-live
// — outside the module tree, since the module may be installed under the
// profile's node_modules (pnpm-managed) which must not be written to.
// The process environment is deliberately NOT consulted for connections.

import {
  cleanupOrphans, maybeRefreshDbhub,
} from './runtime.mjs'
import {
  ensureRunning, terminateServer, isServerUp, activeToolCount, refreshToolCount,
  collectSources, latestSummaries, configInputsMtime,
} from './mcp.mjs'
import { registerCoreTools } from './tools.mjs'
import {
  listWorkspaces, setWorkspaceEnv, removeWorkspaceEnv,
} from './config.mjs'
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
  phase: 'initializing',
  toolCount: 0,
  lastError: '',
  mode: 'lazy',
  updateIntervalDays: 7,
  idleMinutes: 10,
  // Workspace-connection summaries ride as a JSON string so the schema never
  // has to validate their arbitrary shape; `configOp` is the one-way command
  // channel from the card (host consumes it and republishes without it).
  workspaces: '[]',
  configOp: '',
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
    idleMinutes: z.number().min(0).default(STATUS_DEFAULTS.idleMinutes),
    workspaces: z.string().default(STATUS_DEFAULTS.workspaces),
    configOp: z.string().default(STATUS_DEFAULTS.configOp),
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

// Resolve a workspace selector (path or title) from the card ops.
async function resolveWorkspaceRef(ref) {
  const workspaces = await listWorkspaces(undefined)
  const wanted = String(ref || '').trim()
  if (wanted) {
    const byPath = workspaces.find((w) => w.path === wanted)
    if (byPath) return byPath
    const byTitle = workspaces.find((w) => w.title === wanted)
    if (byTitle) return byTitle
  }
  return undefined
}

// One card command: { op: 'add'|'remove', workspace, env, dsn? }
async function handleConfigOp(rawOp, ctx, subprocess) {
  let op
  try {
    op = JSON.parse(String(rawOp || ''))
  } catch (e) {
    console.warn('[dsh-dbhub-live] 忽略非法的配置操作: ' + String(rawOp))
    return
  }
  if (!op || typeof op !== 'object') return
  const ws = await resolveWorkspaceRef(op.workspace)
  if (!ws) {
    console.warn('[dsh-dbhub-live] 配置操作失败：找不到工作区 "' + String(op.workspace || '') + '"')
    return
  }
  try {
    if (op.op === 'add' || op.op === 'set') {
      const dsn = typeof op.dsn === 'string' ? op.dsn.trim() : ''
      if (!dsn) throw new TypeError('DSN 不能为空')
      const envName = setWorkspaceEnv(ws.path, op.env, dsn, op.source === 'collected' ? 'collected' : 'user')
      console.log('[dsh-dbhub-live] 卡片配置：' + ws.title + ' 环境 ' + envName + ' 已保存')
    } else if (op.op === 'remove') {
      const removed = removeWorkspaceEnv(ws.path, op.env)
      if (!removed) console.log('[dsh-dbhub-live] 卡片配置：' + ws.title + ' 无可删除的环境记录（自动发现项不会持久化）')
      else console.log('[dsh-dbhub-live] 卡片配置：' + ws.title + ' 环境 ' + String(op.env || 'default') + ' 已删除')
    } else {
      console.warn('[dsh-dbhub-live] 忽略未知配置操作: ' + String(op.op))
    }
  } catch (e) {
    console.warn('[dsh-dbhub-live] 配置操作失败: ' + String((e && e.message) || e))
  }
  // Refresh the summaries cache AND make the running server re-sync its tool
  // registrations NOW (the credentials mtime changed, the toml regenerates,
  // the server restarts and every per-environment tool — including a newly
  // added `_<env>` name — registers immediately). Without this, a card edit
  // would only surface as a tool on the next unrelated call.
  await collectSources(ctx, subprocess)
  try {
    await ensureRunning(ctx, subprocess)
    console.log('[dsh-dbhub-live] 配置操作已生效：dbhub 工具已重新同步（' + activeToolCount() + ' 个）')
  } catch (e) {
    console.warn('[dsh-dbhub-live] 配置操作后工具重同步失败（下次调用自动重试）: ' + String((e && e.message) || e))
  }
  refreshToolCount()
}

// Mirrors the state machine + configurable options into the settings
// namespace when a settings provider is mounted (the Plugins tab dispatches
// our card from this namespace). The namespace's `enabled` field is how the
// card's toggle writes back, and the config fields (`dbhubPackage`,
// `updateIntervalDays`, `idleMinutes`) are how the card edits options. The
// host store remains the authoritative source and converges the document at
// boot. Everything is wired on the injected settings fiber so it rolls back
// with this plugin.
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
      console.log('[dsh-dbhub-live] 状态命名空间已注册: ' + STATUS_NS)
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
      const publish = () => {
        const merged = {
          ...state.snapshot(),
          ...options.snapshot(),
          serverUp: isServerUp(),
          workspaces: JSON.stringify(latestSummaries()),
        }
        scope.replace(merged).catch((e) => {
          console.warn('[dsh-dbhub-live] 状态同步失败: ' + String((e && e.message) || e))
        })
      }
      // Fresh summaries at attach, then mirror every state change.
      collectSources(ctx, subprocess).then(publish, () => publish())
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
          handleConfigOp(op, ctx, subprocess).then(publish, () => publish())
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

// ── lazy init orchestration ───────────────────────────────────────────────

let initInFlight

// Fire-and-forget one full initialization (orphan cleanup -> server start ->
// tool sync). Never blocks boot; concurrent calls share the in-flight run.
// Failures land in the state machine (`phase: 'error'`, `lastError`) and are
// retried on the next tool call.
function startLazyInit(ctx, subprocess) {
  if (!state.isEnabled() || !subprocess) return undefined
  if (initInFlight) return initInFlight
  initInFlight = (async () => {
    try {
      await cleanupOrphans(subprocess).catch(() => {
        /* contained */
      })
      state.setPhase('initializing')
      await ensureRunning(ctx, subprocess)
      if (isServerUp()) {
        state.clearError()
        state.setPhase('running')
        refreshToolCount()
        console.log('[dsh-dbhub-live] dbhub 服务已加载（' + activeToolCount() + ' 个工具）')
        // Background, non-blocking: refresh the auto-installed dbhub if its
        // update interval has elapsed. Fails silently — the current binary
        // stays in use.
        maybeRefreshDbhub(subprocess).catch((e) => {
          console.error('[dsh-dbhub-live] dbhub 自动更新检查失败: ' + String((e && e.message) || e))
        })
      } else if (state.getState().phase !== 'error') {
        // No workspace data source yet (or the server was recycled): the
        // plugin is healthy and waiting — mark it running, not initializing.
        state.clearError()
        state.setPhase('running')
        console.log('[dsh-dbhub-live] 插件就绪（暂无工作区数据源，可用 dbhub_configure 配置后自动启动服务）')
      } else {
        // A real start failure was already recorded into the state machine;
        // the next tool call retries automatically.
        console.error('[dsh-dbhub-live] 初始化失败（状态卡片可见最近错误），下次调用自动重试')
      }
    } catch (e) {
      state.recordError(String((e && e.message) || e))
      console.error('[dsh-dbhub-live] 初始化失败: ' + String((e && e.message) || e))
    } finally {
      initInFlight = undefined
    }
  })()
  return initInFlight
}

// ── apply ─────────────────────────────────────────────────────────────────

export async function apply(ctx) {
  console.log('[dsh-dbhub-live] host apply')
  const subprocess = ctx.get('subprocess')
  registerCoreTools(ctx, subprocess)
  refreshToolCount()

  // Status surface: publish every state change; react to the enable/disable
  // toggle by (re)starting or shutting down the persistent server.
  let prevEnabled = state.isEnabled()
  const unsubscribe = state.subscribe(() => {
    const enabled = state.isEnabled()
    if (enabled !== prevEnabled) {
      prevEnabled = enabled
      if (enabled) {
        startLazyInit(ctx, subprocess).catch(() => {
          /* recorded in state */
        })
      } else {
        terminateServer()
      }
    }
  })
  ctx.effect(() => () => {
    unsubscribe()
  }, 'dsh-dbhub-live.state')

  wireStatusNamespace(ctx)

  if (!subprocess) {
    console.error('[dsh-dbhub-live] subprocess unavailable — dbhub 服务延迟到可用时自动初始化（核心工具已注册）')
    return
  }
  // Lazy boot: register tools immediately, initialize dbhub in the background.
  // dbhub tools are available at once and wait for readiness on first use.
  if (state.isEnabled()) {
    startLazyInit(ctx, subprocess).catch(() => {
      /* recorded in state */
    })
  } else {
    console.log('[dsh-dbhub-live] 插件处于禁用状态，未自动初始化（可在 设置 → 插件 → dsh-dbhub-live 开启）')
  }
}