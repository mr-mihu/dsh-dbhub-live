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
  'log.dshTooOld': 'DSH 版本过旧：本插件需要 DSH {min} 或更高版本（当前 {version}），卡片上会提示用户先升级 DSH；工具仍可使用。',
  'log.loaded': 'dbhub 插件已加载（{n} 个工具）',
  'log.policyRegistered': '模型侧访问策略已注册（system prompt 段 {name}）',
  'log.initFailed': '后台初始化失败（状态卡片可见最近错误）',
  'log.disabledBoot': '插件处于禁用状态（可在 插件 → dsh-dbhub-live → 配置 开启）',
  'log.opSaved': '卡片配置：{title} 环境 {env} 已保存',
  'log.opRemoved': '卡片配置：{title} 环境 {env} 已删除',
  'log.opRenamed': '卡片配置：{title} 环境已重命名 {from} → {to}',
  'log.opRenameMissing': '卡片配置：{title} 没有可重命名的已保存环境 "{env}"',
  'log.opNothing': '卡片配置：{title} 无可删除的环境记录（自动发现项不会持久化）',
  'log.opNoWs': '配置操作失败：找不到工作区 "{ws}"',
  'log.opFailed': '配置操作失败（{op}）：{msg}',
  'log.opBad': '忽略非法的配置操作: {raw}',
  'log.opUnknown': '忽略未知配置操作: {op}',
  'log.syncApplied': '配置已生效：连接摘要已刷新（{n} 个工具声明）',
  'log.stateSyncFail': '状态同步失败: {msg}',
  'log.updateCheckFailed': 'dbhub 自动更新检查失败: {msg}',
  // Plugin self-update check (the card's {op:'updateCheck'} command). Host log
  // only — the browser-side wording lives in lib/client.js.
  'log.appUpdate': '发现新版本：本插件 {current} → {latest}（来源 {source}）',
  'log.appUpToDate': '已是最新版本：本插件 {current}（最新 {latest}，来源 {source}）',
  'log.appUpdateFailed': '插件更新检查失败：{msg}（当前版本 {current}）',
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
  'result.authHint': '提示：可能是凭据不正确或连接信息（主机/端口/库）有误。可调用 dbhub_configure 更新该环境（{src}）的连接——密码通过界面输入，不会经过模型；也可让用户在 插件 → dsh-dbhub-live → 配置 中修改。**不要为了连上这个库改用命令行客户端或脚本直连**（凭据只能由用户在插件里输入）。',
  'result.sourcesIntro': '已注册连接源 {n} 个，分属 {m} 个工作区（仅元数据：类型/主机/端口/库；密码与账号永不显示）。**每条 source 只属于一个工作区，不同工作区的相似连接是不同目标，不要混用。**',
  'result.wsCurrentHead': '【当前工作区】（优先使用这里的 source）：',
  'result.wsGroup': '- {title}（{path}）',
  'result.wsNoCurrent': '当前会话的工作区未在已注册工作区中识别出来；下面是全部工作区的连接，请用完整 source 值显式指定目标。',
  'result.wsOtherHead': '其他工作区（仅当当前工作区没有所需连接时才参考；要复用时先让用户确认，再用 dbhub_configure 的 copyFrom 复制到当前工作区，不要直接用这里的 source 查询）：',
  'result.srcRow': '  - 环境 {env}｜{badge}{ro}｜连接 {conn}｜来源 {src}｜source 值 {srcId}',
  'result.badgeReadOnly': '只读',
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
  // Card commands that were refused. These are the card's ONLY feedback (the
  // browser half does not read op response bodies), so they name the cause and
  // the consequence instead of pretending the click did something.
  'result.wsNotFound': '找不到工作区 "{ws}"（可能已被删除或改名）：本次操作未做任何修改，也不会自动改用其他工作区。请刷新页面后重试，或用工作区路径重新指定。',
  'result.emptyDsn': '保存失败：连接串（DSN）为空，未做任何修改。请在界面里填写连接串后再保存。',
  'result.badSsh': '保存失败：SSH 隧道配置不完整（缺少主机/用户/凭据，或 ProxyJump 超过一跳），未做任何修改。',
  // Environment names are store keys capped at ENV_NAME_MAX, so two DISTINCT long
  // names can collide after truncation. Merging them would silently drop a
  // connection, so the write is refused instead. No name and no DSN is quoted.
  'result.envNameTruncated': '保存失败：环境名超过 {max} 个字符，截断后会与已存在的环境同名，未做任何修改。请改用不超过 {max} 个字符且不重复的环境名，或直接用那个已存在的环境名更新它。',
  'result.renameCollided': '改名未执行：目标环境 {to} 已经存在，覆盖它会丢掉那条连接。请先确认覆盖，或换一个环境名。',
  'result.renameBlankTarget': '改名未执行：目标环境名不能为空（不会自动改成 default，那会覆盖默认环境）。',
  'result.opFailed': '配置操作失败：{msg}',
  'result.copyOverwriteHeader': '复制会覆盖已有环境（{title}）',
  'result.copyOverwriteQ': '目标环境 {env} 已经存在（连接 {conn}）。继续复制会用来源连接覆盖它，并采用来源的只读/隧道设置，确定吗？',
  'result.copyOverwriteOk': '继续复制（覆盖）',
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
  // Scan picker: the ordinal keeps two credentials for ONE database apart (the
  // metadata alone can be identical), and the credential marker says which of the
  // two actually carries a password.
  'result.scanPickRow': '#{n} {loc} → {conn}｜{cred}',
  'result.credHasPassword': '含密码',
  'result.credNoPassword': '无密码',
  // ── 5.1: environment-level read-only mode ──
  'result.readOnlyHint': '提示：该环境已开启**只读模式**（由用户在配置页设置），dbhub 只放行只读语句（MySQL 为 select/with/explain/show/describe/desc，其他连接器略有不同），写操作会被拒绝（READONLY_VIOLATION）。如需写入，请让用户在 **设置 → DBHub 数据库工具**（或插件页该行的「配置」）里关闭只读——模型只能开启，不能自行关闭。**不要改用 psql/mysql 等命令行客户端、临时脚本或任何其它途径绕过本插件完成这次写入（包括换用别的数据库插件）**：只读是用户设定的安全边界，绕过等于自行提权；若这次写入确实必要，把影响与理由告诉用户，由用户决定。',
  'result.readOnlyUserOnly': '出于安全考虑，**关闭只读模式只能由用户操作**（模型只能开启、不能解除，否则等于自行提权）。请让用户在 **设置 → DBHub 数据库工具**（或插件页该行的「配置」）里关闭该环境的只读开关。',
  'result.readOnlyOn': '已开启只读模式（环境 {env}）：写操作会被 dbhub 拒绝（READONLY_VIOLATION）。',
  'result.readOnlyOff': '已关闭只读模式（环境 {env}）。',
  // ── session permission mode (a second, independent write gate) ──
  // The environment read-only switch keeps its own hard refusal; these cover the
  // SESSION modes the user picks in the composer. Refusals say what happened and
  // what to do (never a DSN, a host or an account), and every one of them also
  // closes the "route it around the plugin" exit.
  'result.sessionReadOnly': '写操作已拒绝：当前会话权限为「仅可查看」，写语句不会被发送到数据库（未执行任何语句）。请让用户在输入框里把会话权限切换为「工作区内修改」（写入会弹窗确认）或「完全权限」，或在插件里改用一条可写连接。**不要改用 psql/mysql 等命令行客户端、临时脚本或其它途径完成这次写入。**',
  'result.writeDenied': '写操作已拒绝：本次写入未获授权（用户拒绝或取消了确认，也可能这个会话的策略是「从不询问」——插件侧无法区分这两种情况），未执行任何语句。**不要改用 psql/mysql 等命令行客户端、临时脚本或其它途径完成这次写入**；如确有必要，请把影响与理由告诉用户，由用户决定（或让用户把会话策略改为「询问」后重试）。',
  'result.writeNoApproval': '写操作已拒绝：当前会话无法弹窗确认（没有可用的授权通道，例如策略为「从不询问」），写语句不会被发送到数据库（未执行任何语句）。请让用户改用「完全权限」，或由用户自己执行这次写入。**不要改用 psql/mysql 等命令行客户端、临时脚本或其它途径完成这次写入。**',
  'result.writeApprovalError': '写操作已拒绝：授权请求未能完成（插件内部错误），未执行任何语句。可重试一次；若反复出现，请让用户改用「完全权限」或自行执行这次写入。**不要改用 psql/mysql 等命令行客户端、临时脚本或其它途径完成这次写入。**',
  // The approval dialog's copy. `reason` also lands in the session log, so it
  // carries the source HANDLE, the statement TYPE and a SHORT scrubbed prefix —
  // never the whole statement.
  'approval.writeReason': '允许在 source {src} 上执行写语句（{kind}）吗？语句开头：{head}',
  'log.policyResolveFailed': '读取会话权限模式失败，本次调用未做会话权限拦截（环境只读设置不受影响）',
  'log.approvalRequestFailed': '写入授权请求失败，本次写入已拒绝（不会改用其它途径）',
  // ── 6.1: environment-level result row cap ──
  // The notice is PREPENDED to the receipt (first line), so a capped answer can
  // never be mistaken for a complete one. It names numbers only — no DSN, no
  // host, no account. `maxRows` is the per-CALL override argument.
  'result.rowsTruncated': '[结果已截断] 该环境的最大返回行数为 {cap}：{parts}。本次调用可用 maxRows 参数覆盖（0 = 本次不限）。',
  'result.rowsTruncatedItem': '语句 {n} 共 {total} 行，只显示前 {cap} 行',
  'result.rowsTruncatedSep': '；',
  // Refused card write: the value is never echoed, only the rule and the fact.
  'result.badMaxRows': '保存失败：最大返回行数必须是不小于 0 的整数（0 或留空 = 不限），未做任何修改。',
  // ── query-result export (CSV / JSON) ──
  // The export receipt REPLACES the rows with host-local files, so the summary
  // may only carry the source HANDLE, row counts and the absolute path(s):
  // never a DSN, a host or an account. `exportFailed` is appended to the ordinary
  // inline receipt, which is why it is a suffix and not a prefix.
  'result.exportSingle': '已导出 {rows} 行到 {path}（source {src}）',
  'result.exportJson': '已导出 {rows} 行（{n} 条语句）到 {path}（source {src}）',
  'result.exportMulti': '已导出 {n} 条语句的结果到 {files} 个文件（共 {rows} 行，source {src}）：',
  'result.exportMultiItem': '  - 语句 {n}：{rows} 行 → {path}',
  'result.exportNote': '文件写在宿主机上：模型不要再把行内容贴回对话，需要时请用户按上面的路径读取或下载。',
  'result.exportEmpty': '本次结果没有可导出的语句，未生成文件。',
  'result.exportFailed': '导出失败：{code}，已改为直接返回结果',
  // ── 5.1: SSH tunnel ──
  'result.sshSet': '已配置 SSH 隧道（环境 {env}）：{host}:{port}（用户 {user}，认证方式 {auth}）。',
  'result.sshCleared': '已解除 SSH 隧道（环境 {env}），该连接恢复为直连。',
  'result.sshMissingUser': 'SSH 隧道必须提供主机与用户名（sshHost / sshUser）。',
  'result.sshMissingAuth': 'SSH 隧道缺少凭据：密钥认证需要 sshKeyPath（口令可在弹窗输入），密码认证的密码只能由用户在弹窗输入。',
  'result.sshMultiHopUnsupported': '不支持多跳跳板机（ProxyJump 列表超过一跳）：dbhub 的多跳共用同一份登录凭据，无法表达各跳不同的认证信息。请只填一跳。',
  'result.needConnFirst': '该环境还没有已保存的连接，无法只修改选项。请先提供连接信息（或在配置页添加连接），再设置只读 / SSH 隧道。',
  'result.promotedNotice': '（该环境原本是自动发现、未保存的连接，已在保存选项时一并持久化为已保存连接）',
  'result.dbhubTooOld': '当前 dbhub 版本过旧（{version}），不支持只读 / SSH 隧道所需的 TOML 方言。请升级 dbhub（1.4.0 及以上），或改用插件自动安装的版本。',
  // Request-level robustness (PR-3). The timeout sentence must make clear this is
  // a hang detector, not a query budget: the statement may well still be running
  // on the server, and the plugin ended the CALL, not the query.
  'result.mcpTimeout': 'dbhub 在 {sec} 秒内没有回包，已终止本次调用（这是「挂死探测」而非查询预算；数据库侧可能仍在执行）。如需更长预算，请缩小结果集或改用 where / limit 分批查询。',
  'result.mcpTooLarge': 'dbhub 返回的响应超出上限（{what}超过 {limit}），已终止本次调用并丢弃该响应。请用 where / limit / 只选需要的列把结果缩小后重试。',
  'result.mcpTooLargeLine': '单行输出',
  'result.mcpTooLargeTotal': '累计输出',
  'result.processStillRunning': '本次调用的 dbhub 进程在等待退出时仍未结束，已再次请求终止；临时配置仍会照常清理。若反复出现，请检查该 dbhub 进程是否卡在数据库侧。',
  // Plugin-side runtime failures. These used to be hard-coded Chinese literals in
  // adhoc.mjs, so an English-locale user saw Chinese in the connection-test result.
  // Punctuation is kept byte-identical to the old literals (ASCII colon/parens) so
  // the change is purely a localization fix.
  'result.dbhubFetchFailed': '无法获取 dbhub: {msg}',
  'result.tomlGenFailed': '生成临时 dbhub 配置失败: {msg}',
  'result.dbhubSpawnFailed': '启动临时 dbhub 失败: {msg}',
  'result.unknownConn': '(未知连接)',
  'result.askSshPwdHeader': 'SSH 登录密码（{conn}）',
  'result.askSshPwdQ': '请输入 {host}:{port} 的 SSH 登录密码（只在界面输入，不会发送给模型）：',
  'result.askSshKeyHeader': 'SSH 密钥路径（{conn}）',
  'result.askSshKeyQ': '请输入 SSH 私钥文件路径（如 ~/.ssh/id_ed25519；仅在界面输入，不会发送给模型）：',
  'result.askSshPassphraseHeader': 'SSH 密钥口令（{conn}，可留空）',
  'result.askSshPassphraseQ': '若该私钥有口令，请输入（只在界面输入，不会发送给模型）；没有口令请留空：',
  // ── 5.1: failure attribution + the SSH-only probe ──
  'result.layerSsh': '【SSH 层】隧道未建立：',
  'result.layerDb': '【数据库层】SSH 隧道可能已建立，失败发生在数据库连接/认证（不确定就先点「测试 SSH 隧道」）：',
  'result.layerInternal': '【插件层】未能启动/生成 dbhub 配置：',
  'result.sshTestBadConfig': 'SSH 配置不完整：缺少 {missing}。需要主机、用户与凭据（密钥路径，或由你在弹窗输入的密码）。',
  'result.sshTestNoConfig': '该环境还没有 SSH 隧道配置：请先在上方「高级：SSH 隧道」里填写主机、用户与凭据（密钥路径，或由你在弹窗输入的密码）。',
  'result.sshTestMultiHop': 'SSH 的 ProxyJump 目前只支持**单跳**（如 jump.example.com:2222）：请改成单跳，或让跳板机自己转发。',
  'result.sshTestDefaultKey': '\n（未填密钥路径，已按默认 {path} 尝试；想用别的密钥请在该字段里填写路径。）',
  'field.host': '主机',
  'field.user': '用户',
  'field.authKind': '认证方式',
  'field.keyPath': '密钥路径',
  'field.password': '密码',
  'result.sshTestUnreachable': 'SSH 主机不可达：无法连接 {host}:{port}（{code}）。请检查主机名/IP、端口、网络与防火墙，以及该主机是否允许从本机访问。',
  'result.sshTestKeyMissing': 'SSH 密钥文件不存在或不可读：{path}（请填绝对路径或 ~/ 开头的路径）。',
  'result.sshTestAuthFail': 'SSH 隧道未建立（{host}:{port} 端口可达，但握手/认证失败）：\n{msg}',
  'result.sshTestOk': 'SSH 隧道可用：已连上 {host}:{port} 并通过认证（探测里的"数据库"步骤必然是失败的——这正说明隧道已经把连接带过去了）。',
  'result.sshTestUnknown': 'SSH 层结果无法判定（{host}:{port} 端口可达，但 dbhub 的报错里既没有认证/握手特征、也没有转发目标的特征）：\n{msg}',
  'result.sshTestInternal': '未能完成 SSH 层测试（插件侧问题）：\n{msg}',
  // ── 5.1: card logs (F4 timing + TOML lifecycle) ──
  'log.opOptions': '卡片配置：{title} 环境 {env} 选项已更新（只读={ro}，SSH={ssh}）',
  'log.sshTunnelUp': 'SSH 隧道已启用：{title} 环境 {env} → {host}:{port}（用户 {user}）',
  'log.tomlSwept': '已清理 {n} 个陈旧的临时 dbhub 配置',
  // The pre-4.0 store was a plaintext connection file. It is deleted at boot;
  // the sentence names the FILE only (never a DSN, never a path).
  'log.legacyConfigSwept': '已删除旧版的明文连接文件 dbhub.toml（4.0 之前的版本用它保存连接串，密码以明文落盘，当前版本已不再读取）。如果还需要其中的某个连接，请在「设置 → DBHub 数据库工具」里重新添加。',
  'log.legacyConfigSweptFail': '未能删除旧版的明文连接文件 dbhub.toml（{code}）：该文件内含明文连接串，请手动删除它。',
  // Owner-only modes could not be re-applied on an upgraded profile (POSIX only;
  // Windows has no mode to set). The sentence names the FILE and the error code,
  // never a path and never a credential.
  'log.modeTightenFail': '未能把 {file} 的权限收紧为仅本账号可读写（{code}）：该文件（或目录）内含连接串与 SSH 密码，请手动确认其权限。',
  // SSH tunnel secrets now live in the DSH credential service
  // ($DSH_HOME/.credentials.yaml, managed by DSH). The plugin only stores the
  // reference. These lines never carry a value, only a failure code / the fact.
  'result.sshSecretMissing': '该连接的口令已不在凭据库里，请在卡片里重新输入。',
  'result.dsnSecretMissing': '该连接的数据库口令已不在凭据库里，请在卡片里重新输入连接串或密码。',
  'log.credUnavailable': '凭据服务不可用，SSH 口令与数据库口令仍以明文保存在插件连接文件里（升级 dsh 后可自动改用凭据库）。',
  'log.secretStoreFailed': '未能把 SSH 口令写入 DSH 凭据库（{code}）：本次仍以明文保存在插件连接文件里。',
  'log.secretMigrateFailed': '部分 SSH 口令迁移到 DSH 凭据库失败：这些口令仍以明文保存，连接不受影响。',
  'log.secretReleaseFailed': '未能在 DSH 凭据库里删除不再使用的 SSH 口令引用（{code}）。',
  'log.dsnCredUnavailable': '凭据服务不可用，数据库口令仍以明文保存在插件连接文件里（升级 dsh 后可自动改用凭据库）。',
  'log.dsnSecretStoreFailed': '未能把数据库口令写入 DSH 凭据库（{code}）：本次仍以明文保存在插件连接文件里。',
  'log.dsnSecretMigrateFailed': '部分数据库口令迁移到 DSH 凭据库失败：这些口令仍以明文保存，连接不受影响。',
  'log.dsnUnsplit': '该连接的密码无法安全拆分，仍保存在本地连接文件里。',
  'log.testWalkMs': '连接测试分段计时：解析连接 {ms} ms（来源 {from}）',
  'log.testProbeMs': '连接测试分段计时：探连 {ms} ms',
  'label.conn': '{连接: {src} → {dsn}}',
  'label.adhocConn': '{临时连接: {dsn}}',
}

const EN = {
  'log.hostApply': 'host apply',
  'log.dshTooOld': 'unsupported DSH version: this plugin needs DSH {min} or later (running {version}); the card tells the user to upgrade, and the tools keep working.',
  'log.loaded': 'dbhub plugin loaded ({n} tools)',
  'log.policyRegistered': 'model-facing access policy registered (system prompt section {name})',
  'log.initFailed': 'background init failed (see the recent error on the status card)',
  'log.disabledBoot': 'plugin disabled (enable it in Plugins → dsh-dbhub-live → Configure)',
  'log.opSaved': 'card config: {title} environment {env} saved',
  'log.opRemoved': 'card config: {title} environment {env} removed',
  'log.opRenamed': 'card config: {title} environment renamed {from} → {to}',
  'log.opRenameMissing': 'card config: {title} has no persisted environment "{env}" to rename',
  'log.opNothing': 'card config: {title} has no persisted environment to remove (auto-discovered rows are not persisted)',
  'log.opNoWs': 'config operation failed: workspace "{ws}" not found',
  'log.opFailed': 'config operation failed ({op}): {msg}',
  'log.opBad': 'ignoring invalid config operation: {raw}',
  'log.opUnknown': 'ignoring unknown config operation: {op}',
  'log.syncApplied': 'config applied: connection summaries refreshed ({n} tool declarations)',
  'log.stateSyncFail': 'status sync failed: {msg}',
  'log.updateCheckFailed': 'dbhub auto-update check failed: {msg}',
  'log.appUpdate': 'update available: plugin {current} -> {latest} (source {source})',
  'log.appUpToDate': 'plugin is up to date: {current} (latest {latest}, source {source})',
  'log.appUpdateFailed': 'plugin update check failed: {msg} (current {current})',
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
  'result.authHint': 'Hint: the credentials are likely incorrect, or the connection details (host/port/database) are wrong. You can run dbhub_configure to update this source ({src}) — the password is entered in the UI, never through the model; the user can also edit it in Plugins → dsh-dbhub-live → Configure. **Do not switch to a command-line client or script to reach this database** — credentials are entered by the user in the plugin, never by the model.',
  'result.sourcesIntro': 'Registered source(s): {n} across {m} workspace(s) (metadata only — type/host/port/database; passwords and usernames are never shown). **Every source belongs to exactly ONE workspace; look-alike connections in different workspaces are different targets — never treat them as the same.**',
  'result.wsCurrentHead': '[CURRENT WORKSPACE] (prefer the sources here):',
  'result.wsGroup': '- {title} ({path})',
  'result.wsNoCurrent': 'The session workspace was not recognized among the registered workspaces; below are all workspaces\u2019 connections — name the exact source value to pick a target.',
  'result.wsOtherHead': 'OTHER WORKSPACES (consult only when the current workspace has no suitable connection; to reuse one, confirm with the user first and copy it here with dbhub_configure\'s copyFrom — do NOT query these sources directly):',
  'result.srcRow': '  - env {env} | {badge}{ro} | connection {conn} | source {src} | source value {srcId}',
  'result.badgeReadOnly': 'read-only',
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
  // Refusals of card commands (the card has no other feedback channel).
  'result.wsNotFound': 'workspace "{ws}" not found (deleted or renamed?): nothing was changed, and the plugin never falls back to another workspace. Reload the page and retry, or pick the workspace by its path.',
  'result.emptyDsn': 'Save failed: the connection string (DSN) is empty — nothing was changed. Fill in the connection string and save again.',
  'result.badSsh': 'Save failed: the SSH tunnel configuration is incomplete (missing host/user/credential, or a multi-hop ProxyJump) — nothing was changed.',
  'result.envNameTruncated': 'Save failed: the environment name is longer than {max} characters and would collide with an existing environment once truncated — nothing was changed. Use a distinct name of at most {max} characters, or update that existing environment under its own name.',
  'result.renameCollided': 'Rename not applied: the target environment {to} already exists, and overwriting it would drop that connection. Confirm the overwrite first, or choose another name.',
  'result.renameBlankTarget': 'Rename not applied: the target environment name cannot be empty (it is not turned into "default" — that would overwrite the default environment).',
  'result.opFailed': 'config operation failed: {msg}',
  'result.copyOverwriteHeader': 'copying would overwrite an existing environment ({title})',
  'result.copyOverwriteQ': 'The target environment {env} already exists (connection {conn}). Continue and let the source connection overwrite it, adopting the source\u2019s read-only/tunnel settings?',
  'result.copyOverwriteOk': 'Copy and overwrite',
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
  'result.scanPickRow': '#{n} {loc} → {conn} | {cred}',
  'result.credHasPassword': 'has a password',
  'result.credNoPassword': 'no password',
  // ── 5.1: environment-level read-only mode ──
  'result.readOnlyHint': 'Note: this environment has **read-only mode** enabled (set by the user on the configuration page). dbhub only allows read statements (on MySQL: select/with/explain/show/describe/desc; other connectors differ slightly) and rejects writes with READONLY_VIOLATION. To write, ask the user to turn read-only off in **Settings → DBHub Database Tools** (or the Configure action on that Plugins row) — the model may enable it but must never disable it. **Never route this write around the plugin** through a psql/mysql-style command-line client, a throwaway script, or any other path (including another database plugin): read-only is the user safety boundary, and working around it is self-granted privilege escalation. If the write is genuinely required, tell the user what it does and why, and let them decide.',
  'result.readOnlyUserOnly': 'For safety, **disabling read-only mode is a user-only action** (the model may enable it, never lift it — that would be self-escalation). Ask the user to clear that environment\u2019s read-only switch in **Settings → DBHub Database Tools** (or the Configure action on that Plugins row).',
  'result.readOnlyOn': 'read-only mode enabled (env {env}): writes are rejected by dbhub (READONLY_VIOLATION).',
  'result.readOnlyOff': 'read-only mode disabled (env {env}).',
  // ── session permission mode (a second, independent write gate) ──
  'result.sessionReadOnly': 'Write rejected: this session\u2019s permission mode is "Read Only", so the statement is never sent to the database (nothing was executed). Ask the user to switch the session permission in the composer to "Workspace Write" (writes then ask for confirmation) or "Full access", or to use a writable connection. **Do not route this write through a psql/mysql-style command-line client, a throwaway script, or any other path.**',
  'result.writeDenied': 'Write rejected: this write was not authorized (the user declined or cancelled the confirmation, or this session\u2019s approval policy is "never ask" \u2014 the plugin cannot tell those apart), and nothing was executed. **Do not route it through a psql/mysql-style command-line client, a throwaway script, or any other path**; if it is genuinely required, explain the impact to the user and let them decide (or ask them to switch the session policy back to asking and retry).',
  'result.writeNoApproval': 'Write rejected: this session cannot show an approval prompt (no approval channel is available, e.g. the policy is "never ask"), so the statement is never sent to the database (nothing was executed). Ask the user to switch to "Full access", or to run this write themselves. **Do not route this write through a psql/mysql-style command-line client, a throwaway script, or any other path.**',
  'result.writeApprovalError': 'Write rejected: the approval request could not be completed (plugin-side error) and nothing was executed. Retry once; if it keeps happening, ask the user to switch to "Full access" or run the write themselves. **Do not route this write through a psql/mysql-style command-line client, a throwaway script, or any other path.**',
  'approval.writeReason': 'Allow a write statement ({kind}) on source {src}? Statement starts with: {head}',
  'log.policyResolveFailed': 'could not read the session permission mode; this call had no session-permission gate (the per-environment read-only setting is unaffected)',
  'log.approvalRequestFailed': 'the write approval request failed, so this write was refused (no other route will be tried)',
  // ── 6.1: environment-level result row cap ──
  'result.rowsTruncated': '[result truncated] this environment caps rows at {cap}: {parts}. Pass maxRows on this call to override (0 = unlimited this time).',
  'result.rowsTruncatedItem': 'statement {n} has {total} row(s), only the first {cap} are shown',
  'result.rowsTruncatedSep': '; ',
  'result.badMaxRows': 'Save failed: the maximum row count must be a whole number of 0 or more (0 or blank = unlimited) — nothing was changed.',
  // ── query-result export (CSV / JSON) ──
  'result.exportSingle': 'exported {rows} row(s) to {path} (source {src})',
  'result.exportJson': 'exported {rows} row(s) across {n} statement(s) to {path} (source {src})',
  'result.exportMulti': 'exported the result of {n} statement(s) to {files} file(s) ({rows} rows in total, source {src}):',
  'result.exportMultiItem': '  - statement {n}: {rows} row(s) → {path}',
  'result.exportNote': 'The files are on the host: do not paste the rows back into the conversation — the user can read or download them from the paths above.',
  'result.exportEmpty': 'this result has no statement to export, so no file was written.',
  'result.exportFailed': 'export failed ({code}); the result is returned inline instead',
  // ── 5.1: SSH tunnel ──
  'result.sshSet': 'SSH tunnel configured (env {env}): {host}:{port} (user {user}, auth {auth}).',
  'result.sshCleared': 'SSH tunnel removed (env {env}); this connection goes direct again.',
  'result.sshMissingUser': 'An SSH tunnel needs both a host and a user (sshHost / sshUser).',
  'result.sshMissingAuth': 'The SSH tunnel has no credentials: key auth needs sshKeyPath (a passphrase can be entered in the dialog), and a password may only be entered by the user in the dialog.',
  'result.sshMultiHopUnsupported': 'Multi-hop bastions are not supported (ProxyJump list longer than one hop): dbhub shares ONE credential set across every hop, so per-hop logins cannot be expressed. Provide a single hop.',
  'result.needConnFirst': 'This environment has no saved connection yet, so options alone cannot be changed. Provide the connection first (or add it on the configuration page), then set read-only / the SSH tunnel.',
  'result.promotedNotice': '(this environment was auto-discovered and unsaved; saving the options also persisted it as a saved connection)',
  'result.dbhubTooOld': 'The installed dbhub is too old ({version}) for the TOML dialect that read-only / SSH tunnels require. Upgrade dbhub (1.4.0 or newer), or use the version this plugin installs automatically.',
  // Request-level robustness (PR-3): this is a hang detector, not a query budget.
  'result.mcpTimeout': 'dbhub did not answer within {sec} s, so this call was terminated (this is a HANG DETECTOR, not a query budget — the database may still be executing). For a longer budget, narrow the result with where / limit and query in batches.',
  'result.mcpTooLarge': 'dbhub returned an oversized response ({what} exceeded {limit}); this call was terminated and the response discarded. Narrow the result with where / limit / only the columns you need and retry.',
  'result.mcpTooLargeLine': 'a single line of output ',
  'result.mcpTooLargeTotal': 'the accumulated output ',
  'result.processStillRunning': 'The dbhub process for this call had not finished when it was waited on, so termination was requested again; the temporary config is still cleaned up. If this repeats, check whether that dbhub process is stuck on the database side.',
  // Plugin-side runtime failures (see the zh dictionary for why these moved here).
  'result.dbhubFetchFailed': 'Cannot fetch dbhub: {msg}',
  'result.tomlGenFailed': 'Failed to generate the temporary dbhub config: {msg}',
  'result.dbhubSpawnFailed': 'Failed to start the temporary dbhub process: {msg}',
  'result.unknownConn': '(unknown connection)',
  'result.askSshPwdHeader': 'SSH login password ({conn})',
  'result.askSshPwdQ': 'Enter the SSH login password for {host}:{port} (UI only, never sent to the model):',
  'result.askSshKeyHeader': 'SSH key path ({conn})',
  'result.askSshKeyQ': 'Enter the SSH private key file path (e.g. ~/.ssh/id_ed25519; UI only, never sent to the model):',
  'result.askSshPassphraseHeader': 'SSH key passphrase ({conn}, may be blank)',
  'result.askSshPassphraseQ': 'If the private key has a passphrase, enter it (UI only, never sent to the model); leave blank when it has none:',
  // ── 5.1: failure attribution + the SSH-only probe ──
  'result.layerSsh': '[SSH layer] the tunnel was not established: ',
  'result.layerDb': '[database layer] the SSH tunnel is probably up and the failure is in the database connect/auth (press "Test SSH tunnel" when unsure): ',
  'result.layerInternal': '[plugin layer] could not start dbhub / generate its config: ',
  'result.sshTestBadConfig': 'Incomplete SSH configuration: missing {missing}. A host, a user and credentials (a key path, or a password you enter in the dialog) are required.',
  'result.sshTestNoConfig': 'This environment has no SSH tunnel configured yet: fill in the host, user and credentials (a key path, or a password you enter in the dialog) under "Advanced: SSH tunnel" above.',
  'result.sshTestMultiHop': 'ProxyJump currently supports a **single hop** only (e.g. jump.example.com:2222): use one hop, or let the jump host forward onward.',
  'result.sshTestDefaultKey': '\n(no key path was given, so the default {path} was tried; put a path in that field to use another key.)',
  'field.host': 'host',
  'field.user': 'user',
  'field.authKind': 'auth method',
  'field.keyPath': 'key path',
  'field.password': 'password',
  'result.sshTestUnreachable': 'SSH host unreachable: cannot connect to {host}:{port} ({code}). Check the hostname/IP, the port, the network/firewall, and whether that host accepts connections from this machine.',
  'result.sshTestKeyMissing': 'SSH key file missing or unreadable: {path} (use an absolute path or one starting with ~/).',
  'result.sshTestAuthFail': 'SSH tunnel NOT established ({host}:{port} is reachable, but the handshake/authentication failed):\n{msg}',
  'result.sshTestOk': 'SSH tunnel works: connected to {host}:{port} and authenticated (the probe\'s "database" step is SUPPOSED to fail — that proves the tunnel carried the connection).',
  'result.sshTestUnknown': 'The SSH layer could not be classified ({host}:{port} is reachable, but dbhub\'s error carries neither an authentication/handshake signature nor the forwarded target):\n{msg}',
  'result.sshTestInternal': 'The SSH-layer test could not run (plugin-side problem):\n{msg}',
  // ── 5.1: card logs (F4 timing + TOML lifecycle) ──
  'log.opOptions': 'card config: {title} environment {env} options updated (read-only={ro}, ssh={ssh})',
  'log.sshTunnelUp': 'SSH tunnel enabled: {title} env {env} → {host}:{port} (user {user})',
  'log.tomlSwept': 'swept {n} stale temporary dbhub config(s)',
  // Plaintext connection file from pre-4.0 builds; file name only, no DSN.
  'log.legacyConfigSwept': 'removed the legacy plaintext connection file dbhub.toml (pre-4.0 builds stored connection strings there — password included — and it is no longer read). Re-add any connection you still need in Settings → DBHub.',
  'log.legacyConfigSweptFail': 'could not remove the legacy plaintext connection file dbhub.toml ({code}); it holds plaintext connection strings, so delete it by hand.',
  // Owner-only modes could not be re-applied on an upgraded profile (POSIX only;
  // Windows has no mode to set). File name and error code only.
  'log.modeTightenFail': 'could not tighten {file} to owner-only access ({code}); that document (or directory) holds connection strings and SSH passwords — check its permissions by hand.',
  // SSH tunnel secrets live in the DSH credential service (managed by DSH); the
  // plugin stores only a reference. No value, no path.
  'result.sshSecretMissing': 'The password for this connection is no longer in the credential store — re-enter it on the card.',
  'result.dsnSecretMissing': 'The database password for this connection is no longer in the credential store — re-enter the connection string or password on the card.',
  'log.credUnavailable': 'the credentials service is unavailable, so SSH secrets and the database password are still stored in plaintext in the plugin connection file (upgrade dsh to use the credential store).',
  'log.secretStoreFailed': 'could not write the SSH secret to the DSH credential store ({code}); this time it stays in plaintext in the plugin connection file.',
  'log.secretMigrateFailed': 'some SSH secrets could not be migrated to the DSH credential store: they stay in plaintext and the connections are unaffected.',
  'log.secretReleaseFailed': 'could not remove an unused SSH secret reference from the DSH credential store ({code}).',
  'log.dsnCredUnavailable': 'the credentials service is unavailable, so the database password is still stored in plaintext in the plugin connection file (upgrade dsh to use the credential store).',
  'log.dsnSecretStoreFailed': 'could not write the database password to the DSH credential store ({code}); this time it stays in plaintext in the plugin connection file.',
  'log.dsnSecretMigrateFailed': 'some database passwords could not be migrated to the DSH credential store: they stay in plaintext and the connections are unaffected.',
  'log.dsnUnsplit': 'the password of this connection cannot be split out safely, so it stays in the local connection file.',
  'log.testWalkMs': 'connection test timing: connection resolution {ms} ms (source {from})',
  'log.testProbeMs': 'connection test timing: probe {ms} ms',
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