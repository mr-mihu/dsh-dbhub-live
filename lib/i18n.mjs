// dsh-dbhub-live: host-side locale support.
//
// The dsh UI language preference lives in the user settings document under
// the 'locale' namespace ('preference': 'zh' | 'en'; absence delegates to the
// browser and defaults to zh here). Every user/model-facing string the Host
// produces — tool results, error feedback, milestone logs, the status-card
// error source — runs through `currentT` so reports match the dsh UI
// language. Tool SCHEMA descriptions stay pinned Chinese (model-facing
// product copy; they are static per registration).

const ZH = {
  'log.hostApply': 'host apply',
  'log.nsRegistered': '状态命名空间已注册: dsh-dbhub-live',
  'log.loaded': 'dbhub 服务已加载（{n} 个工具）',
  'log.readyNoSources': '插件就绪（暂无工作区数据源，可用 dbhub_configure 配置后自动启动服务）',
  'log.initFailed': '初始化失败（状态卡片可见最近错误），下次调用自动重试',
  'log.disabledBoot': '插件处于禁用状态，未自动初始化（可在 设置 → 插件 → dsh-dbhub-live 开启）',
  'log.opSaved': '卡片配置：{title} 环境 {env} 已保存',
  'log.opRemoved': '卡片配置：{title} 环境 {env} 已删除',
  'log.opNothing': '卡片配置：{title} 无可删除的环境记录（自动发现项不会持久化）',
  'log.opNoWs': '配置操作失败：找不到工作区 "{ws}"',
  'log.opBad': '忽略非法的配置操作: {raw}',
  'log.opUnknown': '忽略未知配置操作: {op}',
  'log.syncApplied': '配置操作已生效：dbhub 工具已重新同步（{n} 个）',
  'log.syncLater': '配置操作后工具重同步失败（下次调用自动重试）: {msg}',
  'log.stateSyncFail': '状态同步失败: {msg}',
  'log.updateCheckFailed': 'dbhub 自动更新检查失败: {msg}',
  'result.disabled': 'dsh-dbhub-live 已禁用：所有 dbhub 工具暂不可用。请在 设置 → 插件 → dsh-dbhub-live 中重新开启。',
  'result.dsnMissing': '缺少 dsn 参数（如 mysql://user:pass@host:3306/db）',
  'result.masked': '检测到脱敏密码 `****`：dbhub_query / dbhub_query_objects 需要真实凭据，打码连接串不能直连。要查询已注册的环境，请改用对应的常驻工具（先用 dbhub_list_sources 查 source 值）；若确需临时直连，请提供真实密码的完整 DSN。',
  'result.noSource': '找不到数据源 "{src}"：请先调用 dbhub_list_sources 查看可用 source 值（如 <工作区> 或 <工作区>_<环境>）。',
  'result.sourcesIntro': '⚠️ 下面每个连接串都是脱敏显示（密码 ****），仅供识别，不要把它们拷进 dbhub_query 直连；查询某环境请用 dbhub_execute_sql / dbhub_search_objects，source 参数取该行的「source 值」。\n已注册连接源 {n} 个（连接为按需建立，列出不代表数据库当前可达）：',
  'result.srcRow': '- {title}（{badge}）｜环境 {env}｜连接 {dsn}（打码，仅显示）｜来源 {src}｜source 值 {srcId}',
  'result.sourcesEmpty': '暂无已注册的连接源（可用 dbhub_configure 或 设置 → 插件 → dsh-dbhub-live → 工作区连接 添加）。',
  'result.badgeSaved': '已保存',
  'result.badgeAuto': '自动',
  'result.savedOk': '已持久化连接并注册工具（{slug}，环境 {env}）。下次可直接使用 dbhub_execute_sql_{tool}。',
  'result.sevSaveFail': '连接已持久化，但 dbhub 服务启动失败（下次调用会自动重试并注册工具）。见 dsh web 日志。',
  'result.serverStartFail': 'dbhub 服务启动失败: {msg}',
  'result.serverUnavailable': 'dbhub 服务不可用',
  'result.noWslabel': '没有可用的工作区',
  'result.modeCanceled': '已取消，未做任何修改',
  'result.noDsn': '未提供 DSN，已取消',
  'result.scanDenied': '未授权扫描，已取消（可改用“输入 DSN”或“填写分项”）',
  'result.scanEmpty': '未找到可扫描的数据库配置文件（已跳过 node_modules/.git/target 等）。可改用“输入 DSN”或“填写分项”。',
  'result.scanNone': '扫描了 {n} 个文件，但未提取到数据库连接。可改用“输入 DSN”或“填写分项”。',
  'result.scanPicked': '已按你的确认持久化连接（来源: 项目文件扫描，环境 {env}）并注册工具（{slug}）。',
  'label.conn': '{连接: {src} → {dsn}}',
  'label.adhocConn': '{临时连接: {dsn}}',
}

const EN = {
  'log.hostApply': 'host apply',
  'log.nsRegistered': 'settings namespace registered: dsh-dbhub-live',
  'log.loaded': 'dbhub server loaded ({n} tools)',
  'log.readyNoSources': 'ready (no workspace sources yet — configure one with dbhub_configure)',
  'log.initFailed': 'init failed (see the recent error on the status card); retried on next call',
  'log.disabledBoot': 'plugin disabled — not initialized (enable it in Settings → Plugins → dsh-dbhub-live)',
  'log.opSaved': 'card config: {title} environment {env} saved',
  'log.opRemoved': 'card config: {title} environment {env} removed',
  'log.opNothing': 'card config: {title} has no persisted environment to remove (auto-discovered rows are not persisted)',
  'log.opNoWs': 'config operation failed: workspace "{ws}" not found',
  'log.opBad': 'ignoring invalid config operation: {raw}',
  'log.opUnknown': 'ignoring unknown config operation: {op}',
  'log.syncApplied': 'config applied: dbhub tools re-synced ({n})',
  'log.syncLater': 'tool re-sync failed after config (auto-retried on next call): {msg}',
  'log.stateSyncFail': 'status sync failed: {msg}',
  'log.updateCheckFailed': 'dbhub auto-update check failed: {msg}',
  'result.disabled': 'dsh-dbhub-live is disabled: dbhub tools are unavailable. Re-enable it in Settings → Plugins → dsh-dbhub-live.',
  'result.dsnMissing': 'missing dsn argument (e.g. mysql://user:pass@host:3306/db)',
  'result.masked': 'masked password `****` detected: dbhub_query / dbhub_query_objects need real credentials. To query a registered environment use the persistent tools (run dbhub_list_sources for the source value); for a one-off connection pass a full DSN with the real password.',
  'result.noSource': 'source "{src}" not found: run dbhub_list_sources first to see the available source values (e.g. <workspace> or <workspace>_<env>).',
  'result.sourcesIntro': '⚠️ Every DSN below is masked (password ****) and only for identification — do not copy one into dbhub_query. To query an environment use dbhub_execute_sql / dbhub_search_objects with the row\u2019s source value.\n{n} registered source(s) (connections are lazy — being listed does not mean the database is currently reachable):',
  'result.srcRow': '- {title} ({badge}) | env {env} | dsn {dsn} (masked) | source {src} | source value {srcId}',
  'result.sourcesEmpty': 'no registered sources yet (add one with dbhub_configure or Settings → Plugins → dsh-dbhub-live → Workspace connections).',
  'result.badgeSaved': 'saved',
  'result.badgeAuto': 'auto',
  'result.savedOk': 'connection persisted and tools registered ({slug}, env {env}). Next time use dbhub_execute_sql_{tool}.',
  'result.sevSaveFail': 'connection persisted but the dbhub server failed to start (auto-retried and re-registered on next call). See the dsh web log.',
  'result.serverStartFail': 'dbhub server failed to start: {msg}',
  'result.serverUnavailable': 'dbhub server unavailable',
  'result.noWslabel': 'no workspace available',
  'result.modeCanceled': 'cancelled — nothing changed',
  'result.noDsn': 'no DSN provided — cancelled',
  'result.scanDenied': 'scan not authorized — cancelled (use "enter DSN" or "fill in fields" instead)',
  'result.scanEmpty': 'no database config files found (node_modules/.git/target etc. are skipped). Use "enter DSN" or "fill in fields" instead.',
  'result.scanNone': 'scanned {n} files but extracted no database connection. Use "enter DSN" or "fill in fields" instead.',
  'result.scanPicked': 'connection persisted from your selection (source: project file scan, env {env}) and tools registered ({slug}).',
  'label.conn': '{connection: {src} → {dsn}}',
  'label.adhocConn': '{adhoc: {dsn}}',
}

let localeProvider = () => 'zh'
let cached = { at: 0, value: 'zh' }

/** Install the locale provider (set from apply with the settings service). */
export function setLocaleProvider(fn) {
  localeProvider = fn
  cached = { at: 0, value: 'zh' } // invalidate so the next read refreshes
}

/** Current locale (cached up to 1s; provider errors fall back to zh). */
export function currentLocale() {
  const now = Date.now()
  if (now - cached.at >= 1000) {
    let value = 'zh'
    try {
      value = localeProvider() === 'en' ? 'en' : 'zh'
    } catch (e) {
      value = 'zh'
    }
    cached = { at: now, value }
  }
  return cached.value
}

/** Translate a key for the CURRENT locale; falls back to zh then the key. */
export function currentT(key, params) {
  const dict = currentLocale() === 'en' ? EN : ZH
  let s = dict[key] ?? ZH[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split('{' + k + '}').join(String(v))
    }
  }
  return s
}

/** Translate for an explicit locale (pure — unit-testable). */
export function tFor(locale, key, params) {
  const dict = locale === 'en' ? EN : ZH
  let s = dict[key] ?? ZH[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split('{' + k + '}').join(String(v))
    }
  }
  return s
}