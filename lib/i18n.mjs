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
  'log.loaded': 'dbhub 插件已加载（{n} 个工具）',
  'log.initFailed': '后台初始化失败（状态卡片可见最近错误）',
  'log.disabledBoot': '插件处于禁用状态（可在 设置 → 插件 → dsh-dbhub-live 开启）',
  'log.opSaved': '卡片配置：{title} 环境 {env} 已保存',
  'log.opRemoved': '卡片配置：{title} 环境 {env} 已删除',
  'log.opNothing': '卡片配置：{title} 无可删除的环境记录（自动发现项不会持久化）',
  'log.opNoWs': '配置操作失败：找不到工作区 "{ws}"',
  'log.opBad': '忽略非法的配置操作: {raw}',
  'log.opUnknown': '忽略未知配置操作: {op}',
  'log.syncApplied': '配置已生效：连接摘要已刷新（{n} 个工具声明）',
  'log.stateSyncFail': '状态同步失败: {msg}',
  'log.updateCheckFailed': 'dbhub 自动更新检查失败: {msg}',
  'log.testStart': '卡片连接测试：{title} 环境 {env}',
  'log.testDone': '卡片连接测试完成：{title} 环境 {env} → {result}',
  'result.testOk': '连接成功（SELECT 1，{ms} ms）',
  'result.testFail': '连接失败（{ms} ms）：{msg}',
  'result.testNoDetail': '未知连接错误',
  'result.testNoRow': '未找到该工作区环境的连接（可能已被删除或自动发现已变化）',
  'result.testTimeout': '连接测试内部超时（未收到 dbhub 响应），请重试；若仍失败请查看 dsh web 日志中的「卡片连接测试」行',
  'result.confirmBad': '连接测试失败，是否仍要保存？',
  'result.confirmSave': '仍要保存',
  'result.disabled': 'dsh-dbhub-live 已禁用：所有 dbhub 工具暂不可用。请在 设置 → 插件 → dsh-dbhub-live 中重新开启。',
  'result.dsnMissing': '缺少 dsn 参数（内部错误；连接串由插件在宿主侧解析）',
  'result.noSource': '找不到数据源 "{src}"：请先调用 dbhub_list_sources 查看可用 source 值（如 <工作区> 或 <工作区>_<环境>）。',
  'result.noDsnViaModel': '出于安全原因，不能把密码/完整连接串作为 dbhub_configure 的参数传入（否则会进入模型上下文）。插件会在界面弹出密码输入框——请引导用户输入，或让用户在 设置 → 插件 → 工作区连接 中修改。',
  'result.authHint': '提示：可能是凭据不正确或连接信息（主机/端口/库）有误。可调用 dbhub_configure 更新该环境（{src}）的连接——密码通过界面输入，不会经过模型；也可让用户在 设置 → 插件 → 工作区连接 中修改。',
  'result.sourcesIntro': '已注册连接源 {n} 个（仅元数据：类型/主机/端口/库；密码与账号永不显示；每次调用为独立一次性连接，多任务并发互不影响）：',
  'result.srcRow': '- {title}（{badge}）｜环境 {env}｜连接 {conn}｜来源 {src}｜source 值 {srcId}',
  'result.sourcesEmpty': '暂无已注册的连接源（可用 dbhub_configure 或 设置 → 插件 → dsh-dbhub-live → 工作区连接 添加）。',
  'result.badgeSaved': '已保存',
  'result.badgeAuto': '自动',
  'result.savedOk': '已持久化连接（{slug}，环境 {env}）。查询时用 dbhub_execute_sql，source 值 = {srcId}。',
  'result.noWslabel': '没有可用的工作区',
  'result.modeCanceled': '已取消，未做任何修改',
  'result.noDsn': '未提供密码/DSN，已取消',
  'result.confQ': '怎么提供连接信息？（密码/连接串只在界面输入，不会发送给模型）',
  'result.confQWithPwd': '怎么提供密码？类型/主机/库名/账号已具备，可选择只填密码（只问一次，不会重复）。',
  'result.confExistingBroken': '该工作区 {env} 环境已有连接记录（{conn}），但连接校验未通过（{msg}）。可直接「使用现有连接」继续（不修改配置），或更新凭据：',
  'result.existingOk': '该工作区 {env} 环境已配置且连接校验通过（{conn}），无需重新填写。直接使用 dbhub_execute_sql / dbhub_search_objects，source 值 = {srcId}。',
  'result.useExisting': '使用现有连接（不重新输入）',
  'result.useExistingDesc': '跳过，直接用现有配置查询',
  'result.useExistingOk': '已确认使用现有连接（{env}：{conn}，source 值 = {srcId}），未做任何修改。若连接仍失败，可再调用本工具用「仅填写密码」或「输入完整 DSN」更新凭据。',
  'result.savedProbeOk': '连接校验：✅ 可连通',
  'result.savedProbeFail': '连接校验：⚠️ 失败（{msg}）。可重试或检查信息',
  'result.noPasswordInDsn': '（提示：该连接串未包含密码；若确认需要密码，请用 dbhub_configure 的「填写分项」或「仅填写密码」补充）',
  'result.scanDenied': '未授权扫描，已取消（可改用“输入 DSN”或“填写分项”）',
  'result.scanEmpty': '未找到可扫描的数据库配置文件（已跳过 node_modules/.git/target 等）。可改用“输入 DSN”或“填写分项”。',
  'result.scanNone': '扫描了 {n} 个文件，但未提取到数据库连接。可改用“输入 DSN”或“填写分项”。',
  'result.scanPicked': '已按你的确认持久化连接（来源: 项目文件扫描，环境 {env}）。查询时用 dbhub_execute_sql，source 值 = {srcId}。',
  'label.conn': '{连接: {src} → {dsn}}',
  'label.adhocConn': '{临时连接: {dsn}}',
}

const EN = {
  'log.hostApply': 'host apply',
  'log.nsRegistered': 'settings namespace registered: dsh-dbhub-live',
  'log.loaded': 'dbhub plugin loaded ({n} tools)',
  'log.initFailed': 'background init failed (see the recent error on the status card)',
  'log.disabledBoot': 'plugin disabled (enable it in Settings → Plugins → dsh-dbhub-live)',
  'log.opSaved': 'card config: {title} environment {env} saved',
  'log.opRemoved': 'card config: {title} environment {env} removed',
  'log.opNothing': 'card config: {title} has no persisted environment to remove (auto-discovered rows are not persisted)',
  'log.opNoWs': 'config operation failed: workspace "{ws}" not found',
  'log.opBad': 'ignoring invalid config operation: {raw}',
  'log.opUnknown': 'ignoring unknown config operation: {op}',
  'log.syncApplied': 'config applied: connection summaries refreshed ({n} tool declarations)',
  'log.stateSyncFail': 'status sync failed: {msg}',
  'log.updateCheckFailed': 'dbhub auto-update check failed: {msg}',
  'log.testStart': 'card connection test: {title} env {env}',
  'log.testDone': 'card connection test finished: {title} env {env} → {result}',
  'result.testOk': 'connection OK (SELECT 1, {ms} ms)',
  'result.testFail': 'connection failed ({ms} ms): {msg}',
  'result.testNoDetail': 'unknown connection error',
  'result.testNoRow': 'no connection found for this workspace environment (deleted, or the auto-discovery changed)',
  'result.testTimeout': 'connection test timed out internally (no dbhub response); retry, and if it keeps failing check the "card connection test" line in the dsh web log',
  'result.confirmBad': 'connection test failed — save anyway?',
  'result.confirmSave': 'save anyway',
  'result.disabled': 'dsh-dbhub-live is disabled: dbhub tools are unavailable. Re-enable it in Settings → Plugins → dsh-dbhub-live.',
  'result.dsnMissing': 'missing dsn argument (internal error; connection strings are resolved host-side)',
  'result.noSource': 'source "{src}" not found: run dbhub_list_sources first to see the available source values (e.g. <workspace> or <workspace>_<env>).',
  'result.noDsnViaModel': 'For security, a password or full DSN cannot be passed as a dbhub_configure argument (it would land in the model context). The plugin prompts for the password in the UI — ask the user to enter it, or have them edit it in Settings → Plugins → Workspace connections.',
  'result.authHint': 'Hint: the credentials are likely incorrect, or the connection details (host/port/database) are wrong. You can run dbhub_configure to update this source ({src}) — the password is entered in the UI, never through the model; the user can also edit it in Settings → Plugins → Workspace connections.',
  'result.sourcesIntro': 'Registered source(s): {n} (metadata only — type/host/port/database; passwords and usernames are never shown; each call is an independent one-shot connection, safe to run in parallel):',
  'result.srcRow': '- {title} ({badge}) | env {env} | connection {conn} | source {src} | source value {srcId}',
  'result.sourcesEmpty': 'no registered sources yet (add one with dbhub_configure or Settings → Plugins → dsh-dbhub-live → Workspace connections).',
  'result.badgeSaved': 'saved',
  'result.badgeAuto': 'auto',
  'result.savedOk': 'connection persisted ({slug}, env {env}). Query with dbhub_execute_sql; source value = {srcId}.',
  'result.noWslabel': 'no workspace available',
  'result.modeCanceled': 'cancelled — nothing changed',
  'result.noDsn': 'no password/DSN provided — cancelled',
  'result.confQ': 'How would you like to provide the connection info? (password/DSN is entered in the UI only, never sent to the model)',
  'result.confQWithPwd': 'How would you like to provide the password? type/host/database/user are already available, so you can enter just the password (asked once, never repeated).',
  'result.confExistingBroken': 'This workspace\u2019s {env} environment already has a connection ({conn}), but the check just failed ({msg}). You can "use the existing connection" as-is (no config change) or update the credentials:',
  'result.existingOk': 'This workspace\u2019s {env} environment is already configured and the connection check passed ({conn}) — nothing to re-enter. Use dbhub_execute_sql / dbhub_search_objects directly; source value = {srcId}.',
  'result.useExisting': 'Use the existing connection (no re-entry)',
  'result.useExistingDesc': 'Skip and query with the current configuration',
  'result.useExistingOk': 'Confirmed using the existing connection ({env}: {conn}, source value = {srcId}) — nothing was changed. If it still fails, call this tool again and pick "password only" or "enter full DSN" to update the credentials.',
  'result.savedProbeOk': 'connection check: ✅ reachable',
  'result.savedProbeFail': 'connection check: ⚠️ failed ({msg}). Retry or double-check the details',
  'result.noPasswordInDsn': '(note: this DSN carries no password; if one is required, use dbhub_configure\u2019s "fill in fields" or "password only" to add it)',
  'result.scanDenied': 'scan not authorized — cancelled (use "enter DSN" or "fill in fields" instead)',
  'result.scanEmpty': 'no database config files found (node_modules/.git/target etc. are skipped). Use "enter DSN" or "fill in fields" instead.',
  'result.scanNone': 'scanned {n} files but extracted no database connection. Use "enter DSN" or "fill in fields" instead.',
  'result.scanPicked': 'connection persisted from your selection (source: project file scan, env {env}). Query with dbhub_execute_sql; source value = {srcId}.',
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

/**
 * Raw dictionary for one locale — used by the zero-knowledge copy gate
 * (asserts no translation embeds a password-carrying DSN). Pure accessor.
 */
export function dictionaryFor(locale) {
  return locale === 'en' ? EN : ZH
}