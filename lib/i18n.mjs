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
  'log.disabledBoot': '插件处于禁用状态（可在 插件 → dsh-dbhub-live → 配置 开启）',
  'log.opSaved': '卡片配置：{title} 环境 {env} 已保存',
  'log.opRemoved': '卡片配置：{title} 环境 {env} 已删除',
  'log.opRenamed': '卡片配置：{title} 环境已重命名 {from} → {to}',
  'log.opRenameMissing': '卡片配置：{title} 没有可重命名的已保存环境 "{env}"',
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
  'result.disabled': 'dsh-dbhub-live 已禁用：所有 dbhub 工具暂不可用。请在 插件 → dsh-dbhub-live → 配置 中重新开启。',
  'result.dsnMissing': '缺少 dsn 参数（内部错误；连接串由插件在宿主侧解析）',
  'result.noSource': '找不到数据源 "{src}"：请先调用 dbhub_list_sources 查看可用 source 值（结果按工作区分组，标出【当前工作区】）。',
  'result.ambiguousSource': '数据源 "{src}" 同时匹配多个工作区的连接，无法确定目标（不同工作区的相似连接是不同目标）。请改用下面其中一个完整 source 值重试；若你其实想用别的工作区的连接，请先让用户确认，再用 dbhub_configure 的 copyFrom 复制到当前工作区：\n{list}',
  'result.candidateRow': '- source 值 {srcId}｜工作区 {title}（{path}）｜环境 {env}',
  'result.needWorkspace': '当前会话的工作区不在已注册工作区列表中，无法确定要在哪个工作区配置连接。请让用户确认后用 workspace 参数显式指定（路径或标题）：\n{list}',
  'result.unknownWorkspace': '找不到工作区 "{ws}"（不会自动改用其他工作区，以免配置到错误的位置）。可用的工作区：\n{list}',
  'result.noDsnViaModel': '出于安全原因，不能把密码/完整连接串作为 dbhub_configure 的参数传入（否则会进入模型上下文）。插件会在界面弹出密码输入框——请引导用户输入，或让用户在 插件 → dsh-dbhub-live → 配置 中修改。',
  'result.authHint': '提示：可能是凭据不正确或连接信息（主机/端口/库）有误。可调用 dbhub_configure 更新该环境（{src}）的连接——密码通过界面输入，不会经过模型；也可让用户在 插件 → dsh-dbhub-live → 配置 中修改。',
  'result.sourcesIntro': '已注册连接源 {n} 个，分属 {m} 个工作区（仅元数据：类型/主机/端口/库；密码与账号永不显示）。**每条 source 只属于一个工作区，不同工作区的相似连接是不同目标，不要混用。**',
  'result.wsCurrentHead': '【当前工作区】（优先使用这里的 source）：',
  'result.wsGroup': '- {title}（{path}）',
  'result.wsNoCurrent': '当前会话的工作区未在已注册工作区中识别出来；下面是全部工作区的连接，请用完整 source 值显式指定目标。',
  'result.wsOtherHead': '其他工作区（仅当当前工作区没有所需连接时才参考；要复用时先让用户确认，再用 dbhub_configure 的 copyFrom 复制到当前工作区，不要直接用这里的 source 查询）：',
  'result.srcRow': '  - 环境 {env}｜{badge}｜连接 {conn}｜来源 {src}｜source 值 {srcId}',
  'result.sourcesEmpty': '暂无已注册的连接源（可用 dbhub_configure 或 插件 → dsh-dbhub-live → 配置 添加）。',
  'result.badgeSaved': '已保存',
  'result.badgeAuto': '自动',
  'result.savedOk': '已持久化连接（工作区 {slug}，环境 {env}）。查询时用 dbhub_execute_sql，source 值 = {srcId}。',
  'result.autoOk': '已自动校验并持久化连接（工作区 {slug}，环境 {env}）：{conn} ✅ 可连通。直接使用 dbhub_execute_sql / dbhub_search_objects，source 值 = {srcId}。',
  'result.renameOk': '已重命名环境（工作区 {title}）：{from} → {to}。连接与凭据原样保留（{conn}，未重新测试）。新的 source 值 = {srcId}。',
  'result.renameNoop': '环境名未变化（{env}），未做修改。source 值 = {srcId}。',
  'result.renameMissing': '工作区 {title} 没有名为 "{env}" 的已保存环境，无法改名。当前已保存的环境：{list}（自动发现的环境不是持久化记录，不能改名）',
  'result.renameOverwriteHeader': '重命名会覆盖已有环境（{title}）',
  'result.renameOverwriteQ': '目标环境 {to} 已经存在（连接 {conn}）。继续改名会用 {from} 的连接覆盖它，确定吗？',
  'result.renameOverwriteOk': '继续改名（覆盖）',
  'result.copiedOk': '已把连接从「{fromTitle} / {fromEnv}」复制到工作区 {title} 的环境 {env}（{conn}，密码未经过模型）。查询时用 dbhub_execute_sql，source 值 = {srcId}。',
  'result.copySelf': '来源与目标相同（工作区 {title} 环境 {env}），无需复制。',
  'result.argConflict': 'renameFrom 与 copyFrom 不能同时使用：改名只动本工作区的名字，复制会新建一条连接。请分两次调用。',
  'result.noWslabel': '没有可用的工作区',
  'result.modeCanceled': '已取消，未做任何修改',
  'result.noDsn': '未提供密码/DSN，已取消',
  'result.confQ': '怎么提供连接信息？（密码/连接串只在界面输入，不会发送给模型）',
  'result.confExistingBroken': '该工作区 {env} 环境已有连接记录（{conn}），但连接校验未通过（{msg}）。可直接「使用现有连接」继续（不修改配置），或更新凭据：',
  'result.existingOk': '该工作区 {env} 环境已配置且连接校验通过（{conn}），无需重新填写。直接使用 dbhub_execute_sql / dbhub_search_objects，source 值 = {srcId}。',
  'result.useExisting': '仍用现有连接（不修改配置）',
  'result.useExistingDesc': '字面沿用现有配置；不会补填缺失字段（如账号/密码），按其现状使用',
  'result.askCredMoreHeader': '连接信息有误？',
  'result.askCredMoreQ': '如果这条连接的信息本身不对（不是这个库/主机/端口），改用其他方式提供：',
  'result.askCredMore': '这个连接的信息不对，改用其他方式（完整 DSN / 填写分项 / 扫描）',
  'result.askCredMoreDesc': '回到完整选项，重新提供连接信息（密码仍在界面输入）',
  'result.useExistingOk': '已确认使用现有连接（{env}：{conn}，source 值 = {srcId}），未做任何修改。若连接仍失败，可再调用本工具更新凭据。',
  'result.probeFailNote': '（自动试连未成功：{msg}。可改用下列方式重新提供连接信息）',
  'result.askAccountHeader': '账号（{conn}）',
  'result.askAccountQ': '连接 {conn} 尚未提供用户名。请输入账号（只在界面输入，可留空）：',
  'result.askAccountRequiredQ': '连接 {conn} 因空账号被拒（Access denied for user \'\'）。该连接必须填写账号（只在界面输入）：',
  'result.askAccountRequired': '无法保存：该连接需要账号（空账号会被数据库拒绝）。请重新调用本工具并填写账号+密码，或改用「输入完整 DSN / 填写分项」。',
  'result.askPwdHeader': '密码（{conn}）',
  'result.askPwdQ': '请输入 {conn} 的密码（只在界面输入，不会发送给模型）：',
  'result.askHost': '主机地址（当前：{cur}，可修改；留空默认 localhost）',
  'result.askPort': '端口（当前：{cur}，可修改；可留空）',
  'result.askUserField': '账号（当前：{cur}，可修改；可留空）',
  'result.askDatabase': '库名（当前：{cur}，可修改；可留空）',
  'result.savedProbeOk': '连接校验：✅ 可连通',
  'result.savedProbeFail': '连接校验：⚠️ 失败（{msg}）。可重试或检查信息',
  'result.noPasswordInDsn': '（提示：该连接串未包含密码；若库需要密码，插件会在后续调用配置时只问「账号+密码」，或直接在 设置 → 插件 → 工作区连接 修改）',
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
  'log.disabledBoot': 'plugin disabled (enable it in Plugins → dsh-dbhub-live → Configure)',
  'log.opSaved': 'card config: {title} environment {env} saved',
  'log.opRemoved': 'card config: {title} environment {env} removed',
  'log.opRenamed': 'card config: {title} environment renamed {from} → {to}',
  'log.opRenameMissing': 'card config: {title} has no persisted environment "{env}" to rename',
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
  'result.disabled': 'dsh-dbhub-live is disabled: dbhub tools are unavailable. Re-enable it in Plugins → dsh-dbhub-live → Configure.',
  'result.dsnMissing': 'missing dsn argument (internal error; connection strings are resolved host-side)',
  'result.noSource': 'source "{src}" not found: run dbhub_list_sources first to see the available source values (the list is grouped by workspace and marks the CURRENT workspace).',
  'result.ambiguousSource': 'source "{src}" matches connections in more than one workspace, so the target is ambiguous (look-alike connections in different workspaces are different targets). Retry with one of these full source values; if you actually mean another workspace\u2019s connection, confirm with the user first and then copy it here with dbhub_configure\'s copyFrom:\n{list}',
  'result.candidateRow': '- source value {srcId} | workspace {title} ({path}) | env {env}',
  'result.needWorkspace': 'The session workspace is not among the registered workspaces, so the target workspace is unknown. Ask the user, then pass workspace explicitly (path or title):\n{list}',
  'result.unknownWorkspace': 'workspace "{ws}" not found (the plugin will NOT silently switch to another workspace and configure the wrong place). Available workspaces:\n{list}',
  'result.noDsnViaModel': 'For security, a password or full DSN cannot be passed as a dbhub_configure argument (it would land in the model context). The plugin prompts for the password in the UI — ask the user to enter it, or have them edit it in Plugins → dsh-dbhub-live → Configure.',
  'result.authHint': 'Hint: the credentials are likely incorrect, or the connection details (host/port/database) are wrong. You can run dbhub_configure to update this source ({src}) — the password is entered in the UI, never through the model; the user can also edit it in Plugins → dsh-dbhub-live → Configure.',
  'result.sourcesIntro': 'Registered source(s): {n} across {m} workspace(s) (metadata only — type/host/port/database; passwords and usernames are never shown). **Every source belongs to exactly ONE workspace; look-alike connections in different workspaces are different targets — never treat them as the same.**',
  'result.wsCurrentHead': '[CURRENT WORKSPACE] (prefer the sources here):',
  'result.wsGroup': '- {title} ({path})',
  'result.wsNoCurrent': 'The session workspace was not recognized among the registered workspaces; below are all workspaces\u2019 connections — name the exact source value to pick a target.',
  'result.wsOtherHead': 'OTHER WORKSPACES (consult only when the current workspace has no suitable connection; to reuse one, confirm with the user first and copy it here with dbhub_configure\'s copyFrom — do NOT query these sources directly):',
  'result.srcRow': '  - env {env} | {badge} | connection {conn} | source {src} | source value {srcId}',
  'result.sourcesEmpty': 'no registered sources yet (add one with dbhub_configure or Plugins → dsh-dbhub-live → Configure).',
  'result.badgeSaved': 'saved',
  'result.badgeAuto': 'auto',
  'result.savedOk': 'connection persisted (workspace {slug}, env {env}). Query with dbhub_execute_sql; source value = {srcId}.',
  'result.autoOk': 'Connection persisted automatically after a successful probe (workspace {slug}, env {env}): {conn} ✅ reachable. Query with dbhub_execute_sql / dbhub_search_objects directly; source value = {srcId}.',
  'result.renameOk': 'environment renamed (workspace {title}): {from} → {to}. The connection and its credentials are unchanged ({conn}, not re-tested). New source value = {srcId}.',
  'result.renameNoop': 'the environment name did not change ({env}) — nothing to do. source value = {srcId}.',
  'result.renameMissing': 'workspace {title} has no saved environment named "{env}" to rename. Currently saved: {list} (an auto-discovered environment is not a stored record and cannot be renamed)',
  'result.renameOverwriteHeader': 'renaming would overwrite an existing environment ({title})',
  'result.renameOverwriteQ': 'The target environment {to} already exists (connection {conn}). Continue and let {from}\u2019s connection overwrite it?',
  'result.renameOverwriteOk': 'Rename and overwrite',
  'result.copiedOk': 'copied the connection from "{fromTitle} / {fromEnv}" into workspace {title}, env {env} ({conn}; the password never passed through the model). Query with dbhub_execute_sql; source value = {srcId}.',
  'result.copySelf': 'source and target are the same (workspace {title}, env {env}) — nothing to copy.',
  'result.argConflict': 'renameFrom and copyFrom cannot be combined: a rename only changes a name inside this workspace, a copy creates a new connection. Call the tool twice.',
  'result.noWslabel': 'no workspace available',
  'result.modeCanceled': 'cancelled — nothing changed',
  'result.noDsn': 'no password/DSN provided — cancelled',
  'result.confQ': 'How would you like to provide the connection info? (password/DSN is entered in the UI only, never sent to the model)',
  'result.confExistingBroken': 'This workspace\u2019s {env} environment already has a connection ({conn}), but the check just failed ({msg}). You can "use the existing connection" as-is (no config change) or update the credentials:',
  'result.existingOk': 'This workspace\u2019s {env} environment is already configured and the connection check passed ({conn}) — nothing to re-enter. Use dbhub_execute_sql / dbhub_search_objects directly; source value = {srcId}.',
  'result.useExisting': 'Use the existing connection as-is (no changes)',
  'result.useExistingDesc': 'Literal reuse of the current config; missing fields (e.g. account/password) are NOT filled in',
  'result.askCredMoreHeader': 'Connection info wrong?',
  'result.askCredMoreQ': 'If this connection\u2019s details are wrong (not this database/host/port), provide it differently:',
  'result.askCredMore': 'This connection\u2019s details are wrong — use another way (full DSN / fill in fields / scan)',
  'result.askCredMoreDesc': 'Return to the full options and provide the connection info again (password still entered in the UI)',
  'result.useExistingOk': 'Confirmed using the existing connection ({env}: {conn}, source value = {srcId}) — nothing was changed. If it still fails, call this tool again to update the credentials.',
  'result.probeFailNote': '({msg} — the auto probe did not succeed; provide the connection info differently below)',
  'result.askAccountHeader': 'Account ({conn})',
  'result.askAccountQ': 'The connection {conn} has no username yet. Enter the account (UI only; may be left blank):',
  'result.askAccountRequiredQ': 'The connection {conn} was rejected because of an empty account (Access denied for user \'\'). An account is required for this connection (UI only):',
  'result.askAccountRequired': 'Cannot save: this connection requires an account (an empty account is rejected by the database). Call this tool again and enter account + password, or use "enter full DSN / fill in fields".',
  'result.askPwdHeader': 'Password ({conn})',
  'result.askPwdQ': 'Enter the password for {conn} (UI only, never sent to the model):',
  'result.askHost': 'Host (currently {cur}, editable; empty defaults to localhost)',
  'result.askPort': 'Port (currently {cur}, editable; may be empty)',
  'result.askUserField': 'Username (currently {cur}, editable; may be empty)',
  'result.askDatabase': 'Database (currently {cur}, editable; may be empty)',
  'result.savedProbeOk': 'connection check: ✅ reachable',
  'result.savedProbeFail': 'connection check: ⚠️ failed ({msg}). Retry or double-check the details',
  'result.noPasswordInDsn': '(note: this DSN carries no password; if the database needs one, the plugin will ask only for account+password on the next configuration call, or edit it in Settings → Plugins → Workspace connections)',
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