# AGENTS.md — dsh-dbhub-live 开发与调试说明

> 本文件面向在本仓库上继续开发/调试本插件的 AI 与人。业务需求见 [doc/REQUIREMENTS.md](doc/REQUIREMENTS.md)，用户安装使用见 [README.md](README.md)。

## 一句话定位

DSH host 插件（Node ESM）+ Web client 插件（浏览器半）：把 dbhub（Bytebase 的数据库 MCP 服务器）接入 DSH。**零知识凭据管理 + 一次性进程执行**——DSN/密码只在宿主侧，模型只见 source 句柄与元数据；每次调用 spawn 一条独立 `dbhub --dsn` 进程跑完即杀，无常驻服务。附配置页（设置 → DBHub 数据库工具 / 侧边栏 / 插件页「配置」）：状态 + 连接管理（启用禁用、增删改查、改名、连接测试、**SSH 层独立测试**、**环境级只读**、**手动 SSH 隧道**）；5.2 起三套布局（弹窗 / 宽屏 / 小屏）+ 页头版本/升级提示 + 版本检查。

## 目录结构

```
lib/
  index.mjs    入口：name/inject/apply、Config(volatile 选项见「可配置参数」条)、发布核心(createHostCore：walk / row-mirror / runOp / view)、双通道接线(0.1.x settings 命名空间 / connection.fetch HTTP 桥)、settings 表单策略与选项写回、连接测试诊断分层(尾部 600 字符 + 【SSH 层】/【数据库层】前缀)
  meta.mjs     版本与兼容门（纯函数，5.2）：插件版本（读 package.json）、DSH 运行时版本探测、semver 比较、dshModern 门（>= 0.2.1，含预发布版）
  update.mjs   最新版本检查（5.2）：npm registry 为主 → GitHub Releases 兜底，内存节流、force 强制刷新、绝不抛错（失败只回 error 字段）
  bridge.mjs   HTTP 桥（纯函数）：/api/dsh-dbhub-live 四条 exact Fetch 路由的请求/响应编解码
  config.mjs   路径/原子持久化(store,runtime,prefs)/DSN 解析/工作区发现/**环境选项(readOnly + normalizeSshOptions/sshOf/withDefaultSshKey/DEFAULT_SSH_KEY_PATH/describeEnvOptions)**/零知识助手(describeConn,connLabel,scrubSecrets；**scrubSecrets 折叠任意 URL 连接串的整个 userinfo**)/小工具
  state.mjs    运行时状态机：enabled/phase/toolCount/lastError/mode + 订阅发布（无服务器生命周期）
  options.mjs  可配置参数：updateIntervalDays、**showSidebarEntry**（用户「隐藏快捷入口」，默认 true，客户端与 enabled 取交决定侧边栏入口）、**announceAccessPolicy**（策略段注入开关，默认 true）；层叠 Config 采纳 > prefs.json > 0.1.x 设置文档 > 环境变量 > 内置默认
  runtime.mjs  dbhub 可执行文件发现、按需自动安装、定期自动更新（已删除孤儿进程清理）
  capability.mjs 上游能力/版本探测（文件级，不 spawn）：`[[tools]] readonly` 与 `ssh_*` 需要 1.4.0+，低于 1.0.0 明确拒绝
  toml.mjs     唯一的一次性 dbhub TOML 生成器：buildDbhubToml/writeTempToml/removeTempToml/sweepTempToml（**文本绝不含秘密**）
  mcp.mjs      MCP JSON-RPC 客户端 + 工具注册表 + 工作区×环境来源发现（collectSources/resolveSource）+ 摘要缓存 + 测试快路径(resolveTestDsn/cachedRows)
  adhoc.mjs    唯一执行引擎：每次调用一条一次性 dbhub 进程（描述符 {dsn,ro,ssh}、--dsn 或一次性 TOML、零知识标签 + stderr 清洗）+ **SSH 层独立探测(probeSshTunnel：withDefaultSshKey 补默认密钥路径 → TCP 可达 + 私钥文件 + 以 127.0.0.1:1 为目标的隧道尝试；判定顺序固定 = SSH 层特征(SSH_LAYER_RE) 单独定案 → 数据库层证据(DB_LAYER_RE) → 指名转发目标 → 都没有才如实 unknown)** + **诊断尾部与分层(diagnosticTail、DIAG_TAIL_MAX=600、丢掉 at 栈帧及折行残片、按行边界截断、failureLayerOf)**
  collect.mjs  授权扫描项目配置文件并提取 DSN 候选（含 askUser 桥接）
  tools.mjs    host 自有工具定义与注册：恒定 4 个（configure/list_sources/execute_sql/search_objects）；configure 探连优先（见零知识契约 5）
  policy.mjs   模型侧访问策略：唯一的 system prompt 段（order 8900，见「模型侧访问策略」条）
  client.js    Web 半（手写 lazy-CJS bundle）：配置页 = `settings.section` 一级设置页 + 侧边栏面板（**`enabled && showSidebarEntry`**）+ `plugins.row.config`（summary/page 两视图）；host face 按运行时探测（settingsScope 或 HTTP 桥）；环境级只读开关 + 高级 SSH 折叠区（含「测试 SSH 隧道」）+ 设置条侧边栏开关
test/          node:test 单元测试（纯逻辑 + bridge 契约 + client bundle 格式契约 + 零知识泄漏门）
scripts/       仓库维护脚本：desensitize.config.mjs（**脱敏槽位表 = 单一事实源**）、desensitize-check.mjs（脱敏门禁）、render-check.mjs（客户端布局离屏渲染/交互门禁，无需 React 依赖）
.github/       CI：push/PR 跑语法检查 + 脱敏门禁 + 单测
doc/           REQUIREMENTS.md（业务需求，进 git 与 npm 包）+ images/（README 截图）+ 本地开发文档（PLAN-5.1-*.md、implementation-notes.md：`.gitignore` 排除，不进 git/npm 包）
.env           本地脱敏黑名单（DSH_DBHUB_DESENSITIZE_RE），gitignore 排除、不进 npm 包——**唯一允许存放真实标识的地方**
cordis.patch.yml   bundle patch：`name: dsh-dbhub-live` 挂载本包
```

## 关键架构事实

- **模块依赖只进不出（防环）**：`config ← state ← mcp`；`config ← runtime ← adhoc`；`config ← toml ← adhoc`；`config ← capability ← adhoc`；`mcp ← tools ← index`；`adhoc ← tools`；`collect ← tools`；`state`/`options ← policy ← index`；`meta`/`update` 是**叶子模块**（只被 `index` 引用；`client.js` 不 import lib，只消费 view）。禁止反向/循环 import（HMR/装载顺序依赖它）。零知识助手（describeConn/connLabel/scrubSecrets）在 `config.mjs`，任何模块不得把裸 DSN 拼进用户可见文本。
- **无常驻 dbhub 服务器**：`dbhub_execute_sql` / `dbhub_search_objects` 调用时把 `source` 经 `resolveSource` 解成真实 DSN（宿主侧），再走 `runAdhoc`（`dbhub --transport stdio --dsn <dsn>` 一次性进程，跑完 terminate）。**没有**常驻服务、指纹、mtime 监听、空闲回收、respawn、孤儿清理、配置变更重启。执行天然并发（进程级隔离）、故障隔离（一条进程挂只坏它自己）、多实例安全（无共享端口/toml/误杀）。**不要把常驻服务器装回来。**
- **唯一允许的 TOML = 每次调用生成的一次性 TOML（5.1 迭代）**：`--dsn` 与 `--config` 互斥，而**只有 TOML 方言**能表达环境级只读（`[[tools]] readonly`）与 SSH 隧道（`ssh_*`）。因此 `ro===true || ssh!=null` 的环境走 `--config <临时文件>`，其余环境**逐字节保持** `--dsn` 路径。四条硬约束：
  1. **文件里绝不含秘密**：`dsn`/`ssh_password`/`ssh_passphrase` 一律写成 `${DSH_DBHUB_SEC_*}` 占位符，真值经 `subprocess.spawn({ env: { ...process.env, ...built.env } })` 进子进程环境（`buildDbhubToml` 返回 `{text, env}`）。残留无害，但**引用的每个变量都必须注入值**（dbhub 取不到会把 `${VAR}` 原样留下且不报错 → `test/toml.test.mjs` 有"引用集合 == env 键集合"的双向断言）。
  2. **`[[tools]]` 是白名单不是补丁**：某 source 只要出现任意 `[[tools]]`，dbhub 就不再自动挂 `execute_sql`+`search_objects`。因此**只读必须写两条**，否则该环境的 `dbhub_search_objects` 直接坏掉（`Tool search_objects not found`）。生成器强制两条 + 单测守护。
  3. **生命周期**：`$DSH_HOME/storages/dsh-dbhub-live/tmp/`，`finally` 尽力删（Windows 上 dbhub 正 watch 该文件，可能 EBUSY），`startBackgroundBoot` 跑一次 `sweepTempToml()` 清崩溃残留。
  4. **版本门槛**：`[[tools]] readonly` / `ssh_*` 在 1.4.0 实测；`<1.0.0` 明确拒绝（`result.dbhubTooOld`），`1.0.0–1.3.x` 放行但 warning。**绝不生成未实测的旧写法**——`read_only`（source 级）会被静默忽略，比报错危险得多。
  **禁止**把常驻 toml / 热重载 / 指纹 / 多源配置装回来；普通行仍走 `--dsn`（DB 密码仍在 argv，与 5.0.1 一致）。
- **零知识模型契约（红线）**：
  1. 工具**参数**：`source`/`sql`/`object_type` 等 + configure 的非密预填（type/host/port/database/user）。**任何工具都不得声明 `dsn` 参数**（模型传 DSN 会把密码带进上下文）；configure 收到 `args.dsn` 直接拒绝（`result.noDsnViaModel`）。`dbhub_query`/`dbhub_query_objects` 已删除，勿恢复。
  2. 工具**输出**：结果/列表/标签一律 `connLabel(dsn)`（`type://host:port/db`）或 i18n 模板，密码与用户名永不出现；`dbhub` 返回的文本（含 stderr）进模型前必须过 `scrubSecrets(text, dsn)`——**清洗还要折叠任意 URL 形态连接串的整个 userinfo**（`://user:pass@`、`://user@` → `://****:****@`）：dbhub 横幅只掩密码不掩用户名，而连接测试诊断正是这段文本。
  3. **密码只在界面输入**：configure 的密码/完整 DSN 一律经 `askUser`（用户敲键盘，不经模型上下文）；配置页 add/edit 的 DSN 走 `configOp` 通道（浏览器→Host），同样不进模型上下文。
  4. **鉴权/连接失败闭环**：`likelyAuthOrConnError` 命中时在错误文本后附 `result.authHint`（引导 `dbhub_configure` 或配置页修改，密码由用户输入）。
  5. **configure 探连优先（交互红线）**：`dbhub_configure` 收到非敏感预填（type/host/database 齐备、非 sqlite）先宿主侧试连候选 DSN（空密码）：可连通 → 直接持久化、**零弹窗**；需凭据 → 只弹「账号（未知时）+ 密码」最小框（`result.ask-*`），其余沿用；不完整或非鉴权失败 → 才弹完整选项（DSN/分项/扫描）。已配置行先探真实 DSN，通过即 `existing-ok` 零输入；**模型参数改了端点（`argsChangedEndpoint`）视为新目标，重跑试连循环**。凭据弹窗带诊断 `detail` 与逃生口（`result.askCredMore` 回完整选项，防死循环；保存后再探失败附 `result.authHint`）。模式菜单**不再有「仅填写密码」**（最小框取代）；「仍用现有连接」是字面沿用（`result.useExisting*` 已澄清）；分项表单带入已知值（`result.askHost/askPort/askUserField/askDatabase`）。**试连诊断指向「空账号被拒」（`emptyUserDenied`）时账号必填**：不提供留空选项，提交空账号拒绝保存（`result.askAccountRequired*`）。决策逻辑收敛在 `config.mjs` 的 `decideConfigureStep`/`argsChangedEndpoint`/`emptyUserDenied`（纯函数，`util.test` 覆盖）。
  6. **零密码泄漏门**：`test/zero-knowledge.test.mjs` 断言 summarizeRows 无 dsn 字段、无工具声明 `dsn` 参数、描述/i18n 文案不含真实形态 DSN；`util.test` 断言 scrubSecrets/connLabel/buildDsnFromParts/decideConfigureStep 行为。改模型可见文案时这些测试必须保持绿。
- **模型侧访问策略（5.1.1）**：`lib/policy.mjs` 贡献唯一 system prompt 段（`plugin:dsh-dbhub-live:access-policy`，order 8900）：**已配置的连接**一律走 dbhub_*（按作用域声明，不写「本机唯一途径」）、禁止 CLI/脚本/驱动/其它 MCP/**其它数据库插件**绕过、工作区直连「配方」不构成授权、只读被拒后不得换途径（含换插件）；**不支持的库显式让给用户其它插件**，同一库两处都配默认用本插件、判不准先问——**不压制同类插件**。`text` 在禁用**或关掉 `announceAccessPolicy`**（设置条开关，默认开，R72）时为空；注册走 `ctx.inject(['systemPrompt'], …)`+`sctx.effect`（同名重复注册抛错、`apply()` 会重跑），无该服务自动降级。回归门 `test/policy.test.mjs`；需求 R71/R72。
- **状态通道（双栈，5.0 迭代）**：Host 只有**一个**发布核心（`index.mjs` 的 `createHostCore`：walk / row-mirror / `runOp` / `view()`），由**两条通道**适配浏览器：① **0.1.x settings 命名空间**（`ctx.inject(['settings'])` + `settings.register(…, STATUS_SCHEMA, {base})` → `scope.replace/watch`，仅 `settings.register` 存在时启用）；② **鉴权 HTTP 桥**（`ctx.inject(['connection'])` → `connection.fetch.register` 注册 `/api/dsh-dbhub-live/{state,enabled,options,op}` 四条 exact Fetch 路由，两条 dsh 线都有）。dsh 0.1.7 用 Config 表单取代 settings 命名空间，0.2.x 又删掉浏览器侧 `settingsScope`——**5.0 移植的根因**：旧客户端 `inject: ['slots','settingsScope']` 永远等不到服务，整个浏览器半区 pending（页面/侧边栏/卡片静默消失、无报错）。因此客户端**只 inject `slots`**，host face 用 `ctx.get('settingsScope')` 探测：有则 legacy，无则 `httpFace()`；写路由继承 connection 的 Host/Origin 围栏与浏览器鉴权（无 cookie 的 `/api/dsh-dbhub-live/*` 返回 401，实测）。编解码在纯函数 `lib/bridge.mjs`（`test/bridge.test.mjs`）。Web 端三个入口同一页面：**`settings.section`（id `dbhub`，主入口）**、**侧边栏面板**（`sidebar.panellist` + `main`，**`enabled && showSidebarEntry` 同时成立才显示**——隐藏入口 ≠ 禁用）、**`plugins.row.config`**（键 `<包名>#<行 id>`，`props.view === 'summary' | 'page'`，仅在官方插件页浏览器半区活跃时存在）。**dsh 0.1.6 已删除 `settings.plugin.item`**：注册不存在的 slot 被静默忽略——「配置页消失」就是它，不要改回去。**两条通道发布同一个 view**：`{enabled, phase, toolCount(恒定4), lastError, mode('oneshot')}` + `{updateIntervalDays, showSidebarEntry, capabilities(上游能力 JSON)}` + `{workspaces(JSON 元数据：title/path/env/conn/source/persisted/srcId)}` + `{testResult}`（一次性回执，仅内存）；legacy 额外 `{configOp}`（主机消费后下一次发布清空，天然防环），HTTP 桥换成 `POST /op` 请求体——**DSN 只从浏览器流向 Host，永不进模型上下文**。**注入回调是独立作用域：需要的服务（如 `subprocess`）必须 `ctx.get('subprocess')` 就地获取，绝不引用 `apply()` 局部变量——否则 ReferenceError 静默杀死发布/配置链路（页面只剩静态值）**；发布核心收敛在 `subprocessOf()`。legacy 回调整体 `wrap()` 防护，异常必须打日志。
- **版本与更新检查（5.2 迭代）**：`lib/meta.mjs`（纯函数）：插件版本（读 `package.json`）、DSH 运行时版本探测、semver 比较、**`dshModern` 门**（DSH >= 0.2.1，预发布版也算；**运行版本无法解析时回退为 desktop 运行时 true、web 运行时 false**——旧 web 线保持 legacy 界面）；`lib/update.mjs` 查最新版本（**npm registry 为主 → GitHub Releases 兜底**，内存节流、`force` 强制刷新、**绝不抛错**，失败只回 `error`）。view 字段 `{pluginVersion, dshVersion, dshModern, runtime, update(JSON 字符串)}`。宿主 op **`{op:'updateCheck', force?}`** 在 `createHostCore().runOp` 中**先于 `handleConfigOp` 拦截**：只触发检查后重新发布，**不改行、不写 store**（同 `test` op）。回归门 `test/meta.test.mjs` / `test/update.test.mjs`。
- **可配置参数（三条通道，一个有效值）**：`options.mjs` 是唯一持有部署开关处：`updateIntervalDays`、**`showSidebarEntry`**（默认 true；与 `enabled` 取交决定侧边栏入口，见 F0）与 **`announceAccessPolicy`**（策略注入，默认 true，R72）；`dbhubPackage` 仅环境变量/内部。三条通道汇到同一有效值：① **`Config`**（named export，`.volatile()` 字段同上）——0.1.7+/0.2.x 官方「插件」表单与 cordis.yml 写入口，**无默认值**（未设置 = `undefined`）；② **`prefs.json`**（页面写入落点）；③ **0.1.x 设置文档**（boot 时只补 prefs 未认领字段）。层叠低→高：内置默认 < 环境变量 < 0.1.x 设置文档 < prefs.json；**显式 Config 值在 boot 与 `loader/volatile-update` 被采纳**（`options.configValuesOf(config)` → `applyPatch(..., {persist:true})`），官方表单与插件页面双向即时可见（页面写入 → `settings.update(entryId, …)` 真实改写 profile patch）。`apply(ctx, config)` 第二参即此 Config；`entryIdOf(ctx)` 用 `ctx.fiber.entry.options.id` 运行时解析（**别写死行 id**）。**已删除 `idleMinutes`**；不要绕过 `applyPatch` 直接改 `options`。
- **工作区连接管理（configOp 通道）**：store v2 = `{ [wsPath]: { environments: { [env]: {dsn, source, updatedAt} } } }`（v1 单 dsn 自动迁移进 `environments.default`）。环境名一律过 `normalizeEnvName`（trim、去控制字符、限长、空值→`default`），**中文环境名是一等公民**。页面只见**元数据**摘要（`collectSources` → `latestSummaries`，密码/用户名永不出 Host）；增/改/删/改名经 `configOp` 单向命令下发，`index.mjs` 用 `setWorkspaceEnv`/`removeWorkspaceEnv`/`renameWorkspaceEnv` 落盘后重扫发布（随发布清空，天然防环）。`add`/`set` 可带 `renameFrom`（「改名 + 改连接」**单条原子命令**；`configOp` 是单字段，拆两次会互相覆盖）；纯改名 `{op:'rename', workspace, env, newEnv}`。自动发现（mise/.env）只提供未覆盖的 `default`，不持久化。**连接测试（`{op:'test', workspace, env, nonce}`）**：`handleTestOp` 用摘要背后的真实 DSN 调 `adhoc.probeConnection`（一次性 dbhub + `SELECT 1`，Host 30s 兜底），结果经 `testResult` 回推 `{nonce, ok, message}`；失败只是行内一次性提示，**不得写 store/lastError/phase**。**SSH 层独立测试**是 `{op:'test', kind:'ssh'}` 分支（「测试 SSH 隧道」）：只验 SSH 层、独立回执，秘密按「留空 = 沿用已存值」合并。**诊断分层**：`message` 取 dbhub 输出**尾部**（`diagnosticTail` / `DIAG_TAIL_MAX = 600`，保留换行、**丢掉 `at …` 栈帧及折行残片、按行边界截断**）——致命行在末尾，取开头只有启动横幅；隧道在配时按 `failureLayerOf` 前缀 `【SSH 层】/【数据库层】/【插件层】`（db 层措辞谨慎：只有独立 SSH 测试能证明隧道起来了）；文本过 `scrubSecrets`，连接串呈 `mysql://****:****@host:3306/db`。页面只认自己派发的 nonce，展示 ~10s 消退，刷新即失。**覆盖门（`requestWrite`/`envCollision`）**：`setWorkspaceEnv` 是**无条件写入**，新增/改名落到已存在环境会静默替换原连接；客户端**先问后写**（比较前必过 `normalizeEnvForCompare`，镜像宿主 `normalizeEnvName`，否则「prod 」与「prod」这种同键异写漏判），命中弹 `dbh-warncard`（`role="alert"`，取消/覆盖），**确认后才 `dispatchPretest`**，取消则零 op 且保留表单内容；仅「改同一环境」不设门。局限：workspace 留空时无法知道宿主选哪个工作区（`resolveWorkspaceRef` 回退 `workspaces[0]`），只能取「第一行所属工作区」近似，不确定时显示 `ovr.bodyAmbiguous`；精确判定需宿主预检 op（暂不做）。回归门：`check:ui` 15/16 组。**即时回推 + 扫描串行化（`createRowMirror`/`publishFast`）**：`collectSources` 每次重扫全部工作区（无持久化 `default` 的工作区各起一次 `mise env`），过去一次写入要等 1–2s，且**并发扫描互相覆盖**（探针回执触发的扫描可能在写入前开始、写入后结束，把新行刷掉——「立刻出现又消失」）。规则：① `handleConfigOp` **返回本次补丁列表**（`add`/`set`/`rename`/`remove`；`test` 与失败为 `[]`）并立刻 `publishFast`（补丁套进缓存后同步 `scope.replace`，仅 `hasRowCache()` 为真时）；② **`reportTest` 只 `publishMirror()` 不再扫描**（探针不改行）；③ 扫描**单飞**（`runWalk`：进行中记 `walkRequested`，结束后补跑一次），补丁**持有到「其后开始的那次扫描」落地**（`beginWalk`/`endWalk` 重放扫描期间到达的补丁），任何扫描都不能发布缺该写入的列表；④ `applyRowPatch` 的 `rename` 必须**幂等**（`from` 不存在时返回原列表而非删 `to` 行），否则重放丢行。一次点击 = 1 次扫描 + 2 次纯内存镜像（原 3 次）。补丁行的 `dsn` 只在宿主内存，`summarizeRows` 只输出 `conn`。回归门：`check:ui` 15/16/17 + `node test/row-cache.test.mjs`（重放/幂等/扫描期间补丁重放）。
- **环境级选项：只读模式 + SSH 隧道（5.1 迭代）**：store 从 v2 长成 v3——同一份 `credentials.json`、同一结构，只在 env 条目上多两个**可选**字段：`{ dsn, source, updatedAt, readOnly?: true, ssh?: {host,port,user,auth,keyPath?,passphrase?,password?,proxyJump?} }`。兼容性是结构性的、**没有版本号也没有迁移函数**：`normalizeStore` 早就保留未知 env 字段（旧版读 v3 不会丢新字段），v2 文件读回来就是"无只读、无隧道"。
  - **`setWorkspaceEnv(ws, env, dsn, source, opts?)`**：`opts` **缺省时保留**既有 `readOnly`/`ssh`（`dbhub_configure` 只更新 DSN 时绝不能把用户的安全开关清掉）；`{readOnly:false}` / `{ssh:null}` 才是显式删除。**`setWorkspaceEnvOptions(ws, env, patch)`** 只改选项、不碰 DSN（行不存在返回 `undefined`）。
  - **模型面向的安全不对称（D7，红线）**：`dbhub_configure` 传 `readOnly:true` 允许（收窄权限），传 `readOnly:false` **拒绝**（`result.readOnlyUserOnly`）——否则模型能自行解除用户设的限制。**拦截点在工具路径（`runConfigure`），不在 store 层**：浏览器 `configOp` 必须能自由关，不然用户永远关不掉。
  - **命令表（`handleConfigOp`）**：`add`/`set`（带 `readOnly`/`ssh`，与 DSN 一次原子写）、`rename`、`remove`、`test`（可带未保存的 `dsn`/`readOnly`/`ssh` 做保存前预校验），以及**新增 `options`**（`{op:'options', workspace, env, readOnly?, ssh?, newEnv?}` —— 只改选项、可顺带改名，`newEnv` 是为了让"改名 + 改选项"仍是一条原子命令；行不存在时按 D10 用自动发现的 DSN **提升为持久化行**（`source:'promoted'`）并回 `result.promotedNotice`，提升只发生在显式操作上）。实现收敛在可单测的 `applyOptionsOp(op, ws, lookupAuto)`（`lib/index.mjs` 导出）。
  - **"留空 = 保持原值"只对秘密字段生效**（`password`/`passphrase` 缺省或空串、`auth==='key'` 时 `keyPath` 为空 → 沿用已存值）。**已存密钥路径也没有时才落到默认**：`withDefaultSshKey`（`config.mjs`，常量 `DEFAULT_SSH_KEY_PATH = '~/.ssh/id_ed25519'`，与界面该字段的占位符同值）在 `mergeSshOptions` 末尾、`applyEnvOptions` / `setWorkspaceEnvOptions` 的 `normalizeSshOptions` 之前各调一次，因此"密钥认证 + 路径留空"**测试与保存同规则**（修复前保存会静默丢掉隧道）；它只认 `auth==='key'` 且路径为空的块，填了路径绝不覆盖、密码认证不受影响。浏览器半的 `connDraftOf(form)` 就按这条产出 `{readOnly, ssh?}`，秘密为空时**整个键都不发**；Host 侧合并（`mergeSsh` 语义在 `setWorkspaceEnvOptions`/`applyEnvOptions`）。
  - **执行侧**：`lib/adhoc.mjs` 每个入口收**连接描述符** `{dsn, ro, ssh}`（也接受裸 DSN = 无选项）。`needsToml(conn)` 为真走一次性 TOML（见上），ssh 秘密放进**子进程 env**、并入 `scrubSecrets(text, dsn, extraSecrets)` 替换表——dbhub 自己回显的日志也不能带出隧道密码。`probeConnection(subprocess, conn, timeoutMs?)` 同样吃描述符 → 「测试」验证的是**有效连接**（含隧道）；`probeSshTunnel(subprocess, ssh, timeoutMs?)` 只验 **SSH 层**（withDefaultSshKey 补默认路径 + TCP 可达 ~5s + 密钥文件存在可读 + 以 `127.0.0.1:1` 为目标尝试；判定顺序固定不得颠倒：`SSH_LAYER_RE` → 隧道断；否则 `DB_LAYER_RE`（`PROTOCOL_CONNECTION_LOST`/`Connection lost`/`server closed the connection`/`SSH tunnel closed`/`Access denied`/`Unknown database`/`ER_*`/`ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`EHOSTUNREACH`）或指名转发目标 → **隧道可用**；都没有 → 如实 unknown 附尾部），它**证明不了隧道后面有真库**（UI 文案必须写明）。探连预算：`PROBE_TIMEOUT_MS` 25s / `PROBE_TIMEOUT_SSH_MS` 45s，**必须严格低于**客户端看门狗（`client.js` 30s / SSH 档 60s）——`test/adhoc-toml.test.mjs` 断言。
- **连接测试快路径（F4，5.1）**：过去点 ▶ 要重扫全部工作区才拿到该行 DSN（无持久化 `default` 的工作区各起一次 `mise env`），模型侧却因 10s 自动发现缓存显得很快——「测试比 AI 慢」即此。现在 `handleTestOp` 按**三档**解析（`lib/mcp.mjs` 纯函数 `resolveTestDsn({wsPath, env, storeRows, cachedRows, hasCache})`）：① 持久化行直接读 store（**权威值，不 walk**）→ ② 宿主内存中卡片显示的那行（`cachedRows()`）→ ③ 都没有才 `await collectSources()`。**语义不变**（持久化行 store 权威；自动发现行测屏幕上的那条），▶ 与模型侧一起变快（`resolveSource` 也先查缓存，未命中才 walk；**歧义判定 `pickBest` 绝不被吞**）。在途去重：`resolveAutoDsn` 复用同一在途 Promise（**不缓存 rejection**，失败可重试）、`collectSources` 共享一次在途 walk（`{force:true}` 供显式重扫）。耗时打 `log.testWalkMs` / `log.testProbeMs`。
- **自动发现的代价与边界（4.2 迭代，别退回「每次同步阻塞探测」）**：`collectSources` 会对**没有持久化 `default`** 的工作区逐个 `runMiseEnv`（spawn `mise env`）。三条硬约束：① **每次探测必须有总超时**（`MISE_ENV_TIMEOUT_MS`，`Promise.race` + `terminate()`），`graceMs` 只是 SIGTERM→SIGKILL 宽限、**不是超时**——曾有一个不退出的 `mise env` 让整轮扫描永不返回，而 `dbhub_list_sources` 正走这条同步路径，模型侧看到 `Interrupted`；② **探测结果（含「什么都没发现」）按工作区路径短期缓存**（`AUTO_DSN_TTL_MS`，`resetAutoDsnCache()` 供测试/显式重扫），否则每次发布、列源、执行都要重新 spawn；③ **工作区之间并发**（`Promise.all`），慢目录不得串行拖累。回归门：`node test/auto-dsn.test.mjs`（限时放弃并 terminate、拒绝可执行文件、TTL 复用、有持久化 default 不探测）。另：`resolveWorkspaceRef(ref, ctx)` 必须用**与扫描同一个** `listWorkspaces(ctx)` 解析，否则 store key 与扫描 key 拼写不一致 → 「设置里有、模型看不到」。
  - **预算计时器绝不 `unref()`**（`runMiseEnv` 总超时、`withProbeTimeout` 兜底都是）：unref 计时器在「它是唯一待办」时不触发——事件循环排空、进程先退，超时**形同虚设**；竞速结束要 `.finally(() => clearTimeout(t))`。该缺陷**只在 Linux CI 暴露**（`Promise resolution is still pending…`，整文件 cancelled），本地 Windows 会侥幸通过——别拿本地绿灯当证据，改后必须看 CI。
- **工具声明数量恒定（上下文预算红线）**：恒定 4 个（configure / list_sources / execute_sql / search_objects），**绝不为每个工作区 × 环境注册独有工具**；曾实现过的 per-source 注册与 `dbhub_query` 已移除，勿恢复。
- **工作区语义（模型契约，勿退化）**：**每条 source 只属于一个工作区**，看起来相同的跨工作区连接也是不同目标。`sourceIdOf(row)` 是 source 值的**唯一**构造点（`<标题slug>_<工作区路径哈希>[_<环境slug>]`），列表/解析器/回执必须都调它。`envSlug`：`default` 裸值、纯 ASCII 保持原 slug（既有 source 不变）、非 ASCII 名取 `env-<shortHash>`——**旧实现让所有纯中文名共用一个 slug**（`线上`/`测试` 曾静默查错库），回归红线。`resolveSource(ctx, sub, ref, {preferredWsPath})` 精确优先，其次按**当前会话工作区**（`currentWorkspace`：cwd 精确匹配 → 最长包含路径）筛选，仍多条返回 `{ambiguous:[…]}` 由 `result.ambiguousSource` 澄清——**绝不按列表顺序猜**。`dbhub_configure` 的工作区解析**不回退 `workspaces[0]`**：显式 workspace 必须匹配否则 `result.unknownWorkspace`；未给则用当前工作区，解析不出 `result.needWorkspace`。跨工作区复用一律 `copyFrom`（宿主侧复制，零知识不破）。`dbhub_list_sources` 按工作区分组并标【当前工作区】（`result.wsCurrentHead`/`wsOtherHead`/`wsGroup`）。
- **schema 弹性依赖**：优先 `@deepseek-ai/schemastery` 真实 schema（`await import`）；解析失败降级为 `lib/index.mjs` 内建最小 callable schema（合默认值 + `toJSON()`），保证**链路安装（`dsh plugin add <本地目录>`）下照样启动、卡片照常工作**。tarball/npm 安装走真实 schemastery 路径。**不要改回静态顶层 import**——会重新引入链路安装启动失败。
- **执行时机**：`apply()` 只注册核心工具 + 后台 bookkeeping（`startBackgroundBoot`：置 phase running、刷新工具数、非阻塞检查 dbhub 更新）；真正的 dbhub 解析（persisted → mise → PATH → 自动安装）在**每次调用**（`resolveDbhubExe` 有 runtime.json 缓存）。**无工作区数据源时一切照常**——工具正常注册，list_sources 空、execute 返回 noSource，不拉起任何进程。
- **启用/禁用**：`state.setEnabled` 持久化到 `credentials.json`（权威值）；禁用时所有工具 execute 首行返回「插件已禁用」（无进程可停，无需清理）；重新启用即恢复。

## 存储与容错（初始化即处理）

- **实例隔离**：所有持久化都在 `$DSH_HOME/storages/dsh-dbhub-live/`（`credentials.json` 凭据+enabled、`prefs.json` 选项、`runtime.json`、`dbhub-runtime/` 自动安装前缀）。隔离粒度 = `DSH_HOME`（同 home 多 profile 共享，同 dsh 自身 workspace.json 约定）；执行进程/状态机/工具注册按进程隔离。**进程环境变量不参与连接解析**。无 dbhub.toml；同 home 并发多实例残余共享只余 `credentials.json`/`prefs.json`（低频用户写，已原子化）。
- **原子写**：`writeJsonFile` 一律 tmp+rename（同目录写临时文件再改名覆盖），读者永不见半个文件、写者末写覆盖不交错；目录被删先 `mkdirSync` 重建。写入失败**不抛致命**，`warnOnce` 告警并继续内存态（`saveStore`/`saveRuntime` 返回 false）。
- **升级/手改遗留兼容**：`loadStore`/`loadRuntime`/`loadPrefs` 先用 `normalizeStore`/`normalizeRuntime`/`normalizePrefs` 清洗：丢弃非布尔 `enabled`、非对象/空 dsn 条目、非法 `dbhubExe`/`dbhubInstallAt`；`dsn` trim；v1 单 dsn 自动迁移为 `environments.default`；**未知字段保留**。清洗结果与原文不同时**一次性回写迁移**（prefs 保留 `updateIntervalDays` 与 `showSidebarEntry`——后者 5.1.0-dev.3 重新生效，布尔读回、其余丢弃不回写）。
- **空值安全**：解析器对缺失/空值全部有兜底（`resolveWorkspaceEnvs` 判空、`describeConn` 兜底、状态 schema 默认值、`enabled` 只认布尔），清洗后无半吊子条目。

## 调试方法（不影响正在运行的 Harness）

DSH 启动是 fail-loud：任一插件激活失败整树拒绝启动、GUI 打不开。因此**永远不要在配置/源码上直接动主实例**，按下面阶梯来：

1. **静态校验（30 秒，零风险）** — `npm run check`（node --check 全部 lib）→ 逐个跑单测（沙箱下 `node --test` 的 runner 子进程会被 EPERM 挡，按本文件惯例**逐个文件**跑：`node test/x.test.mjs`）。单测会自己建临时 `DSH_HOME`，不会碰真实 store。
   - 只读/隧道两条新路径的静态旁路验证（不需要 Harness）：`node -e "…"` 调 `buildDbhubToml({dsn,ro:true,ssh:{…}})` 打印文本，确认**两条 `[[tools]]` 都在、文本里没有密码**，且 `env` 覆盖了文本里引用的每个 `${VAR}`（`test/toml.test.mjs` 已自动断言，手工复核用于排查现场）。
   - 真 dbhub 冒烟（不经插件）：把生成的 TOML 落临时目录，`dbhub --transport stdio --config <file>` 喂 `initialize`/`tools/list`/`tools/call`（命令见 `doc/PLAN-5.1-readonly-and-ssh-tunnel.md` 附录 A，本地文档、不进包）：只读环境 `INSERT`/`CREATE` 应回 `READONLY_VIOLATION`，`SELECT 1` 与 `search_objects` 应成功（**只写一条 `[[tools]]` 会让 `search_objects` 消失**），`--config` 与 `--dsn` 同给必 fatal。
2. **会话内跑通逻辑（不重启）** — 用动态插件工具（`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine`）：把纯逻辑（如 configure 流程、scrubSecrets）以无 import 的 Host 代码贴进动态包跑，`cordis_stop` 即清场；只活在内存 + 当前会话，不影响主进程。动态 Host 代码不能用 `import`，带 `@deepseek-ai/schemastery` 的 `lib/index.mjs` 不能整文件贴；只做纯逻辑验证。
3. **冷启动验证（隔离实例）** — 用独立 `DSH_HOME` 起测试实例。本机备有独立测试 home：`.dsh-a`（`deepseek-harness/mise.toml` 把 `DSH_HOME` 指向它）。两条可用路径：
   - **源码实例（`mise r dsh …`，走 tsx）**：`cd D:\my\app\dsh\plugin\deepseek-harness` 后 `mise r dsh web --port 3082 --no-open`。`pnpm dsh` 会先跑依赖校验，node_modules 不同步时想重装并因无 TTY 中止——直接 `node --import tsx/esm apps/cli/src/bin.ts …` 跳过；esbuild spawn 在沙箱下 EPERM（沙箱边界，别绕）。
   - **已安装实例（推荐，无 esbuild/pnpm）**：直接用 npm 安装版 CLI：`$env:DSH_HOME='D:/my/app/dsh/plugin/.dsh-a'`，**清掉继承的 `DSH_PROFILE`/`DSH_PROFILE_DIR`**（指向主 profile 会污染/参数冲突），然后 `node <dsh 安装目录>/lib/bin.js web --port 3082 --no-open`。`dsh web` 自带 `web` profile，**不要再传 `--profile web`**（报「select a profile only once」）。
   ```powershell
   # 装包：pnpm 需要可写 store（默认 store 在 workspace 外会被沙箱拒绝）
   $env:npm_config_store_dir='D:/my/app/dsh/plugin/.pnpm-store'; pnpm pack
   node <dsh>/lib/bin.js plugin --profile web add D:/path/to/dsh-dbhub-live-<ver>.tgz
   # 沙箱内 pnpm 可能事先被别处 store 链接过而报 UNEXPECTED_STORE；此时可手工替换
   # .dsh-a/profiles/web/node_modules/dsh-dbhub-live/ 的目录内容（file: 依赖就是普通目录，
   # 不写 store、不动 lockfile），仅用于验证，不要当成发布流程。
   # 验证清单（0.2.x）：
   #   日志：`[dsh-dbhub-live] host apply` + `dbhub 插件已加载（4 个工具）` + `模型侧访问策略已注册（system prompt 段 …）` + `浏览器桥接已注册: /api/dsh-dbhub-live/*`
   #   取 token（启动日志里的 ?token=…）→ GET /?token=… 拿会话 cookie →
   #     GET  /api/dsh-dbhub-live/state                     # 200 + {ok,value}；不带 cookie 必须 401
   #     POST /api/dsh-dbhub-live/options {"updateIntervalDays":3}   # 200，且 $DSH_HOME/storages/dsh-dbhub-live/prefs.json 落盘
   #     POST /api/dsh-dbhub-live/op {"op":{"op":"nope"}}    # 200 + patches: []
   #   volatile Config 通道（0.1.7+/0.2.x）：
   #     在 profile 的 cordis.patch.yml 里钉 `- id: <行 id>` + `config: {updateIntervalDays: 5}` → 重启后
   #     视图与 prefs.json 都应变 5（采纳），日志出现「配置表单策略已注册: auto=false」；
   #     再 POST /options {"updateIntervalDays":9} → **profile patch 文件本身**应被改写成 9（写回），
   #     视图里的 entryId 应等于该行 id（不是包名）。
   #   客户端包：/plugins/??dsh-dbhub-live/client.js&rev=<index HTML 里的 rev>   # 200（**必须带 rev，单斜杠路径一律 404**）
   #   浏览器：http://127.0.0.1:3082 侧边栏出现「DBHub 数据库工具」、设置里出现同名一级页面，行内显示连接元数据
   ```
   **取 bundle URL 的正确方式**：index HTML 里的模块清单 JSON（`{"id":"dsh-dbhub-live","url":"/plugins/??…&rev=<rev>"}`），**rev 带 `-<n>` 后缀**（如 `d4aeeae7c6c2a859-55`，每次渲染会变）；用正则截 rev 会截断后缀而 404，必须整段取出该 `url` 再请求。
   **0.1.x 线（双栈的另一半）**：另起一个 scratch home 装 0.1.6 的 CLI 跑一遍即可，`dsh web` 会自己初始化 web 模板：
   ```powershell
   # 用 0.1.6 的 CLI 初始化 DSH_HOME=.dsh-b，然后把包目录拷进 profiles/web/node_modules/
   # 并在 package.json 的 dsh.profile.bundles 里加上 dsh-dbhub-live（bundle 的 patch 会自行插入插件行）
   # 期望日志：`host apply` + `dbhub 插件已加载（4 个工具）` + `状态命名空间已注册: dsh-dbhub-live`
   #           + `浏览器桥接已注册: /api/dsh-dbhub-live/*`（0.1.6 没有 settings.configure，故没有"配置表单策略"那行）
   # 期望接口：/api/dsh-dbhub-live/state 带 cookie 200、不带 401；view 里 entryId=行 id；bundle 200
   ```
   `mise r dsh plugin … ls` 只用于核对安装版本；沙箱里 pnpm 的 store 可能不可写，见上面手工路径。
   **开发版试装与桌面端**：测试 dev 包时**只装进隔离的 `DSH_HOME`（如上 `.dsh-a`）**，绝不碰用户自己的 profile（主实例 fail-loud）；**桌面端不做本地自动验证**——由用户经可视化「插件」页安装/更新/卸载后人工确认（见 README「更新」）。
4. **在位热更新（有失败保护，谨慎）** — 主实例的 `cordis.patch.yml` 支持 HMR，读取/解析失败时保留最后一个可用树，GUI 不会挂。但 HMR 不监听插件源码，只适合挂载/卸载验证，代码迭代请用 1/2/3。
5. **安全网** — `$DSH_SNAPSHOT=replay` 可从 `cordis.snapshot.yml` 启动回放点；改动主 profile 前先备份 `cordis.patch.yml`。

## 修改 client 半（lib/client.js）

`lib/client.js` 是**手写 lazy-CJS bundle**，DSH client 模块系统按 `dsh.client` 声明 + `exports["./client"]` 直接服务它，**没有构建步骤**。遵守以下契约（改完跑 `node test/client-format.test.mjs` 守护）：

- 必须以 `window.__ModuleLoader__.load({ id: "dsh-dbhub-live", factory: (require) => { … } })` 注册；
- `id` 必须等于 Loader entry 名（`dsh-dbhub-live`，见 cordis.patch.yml 的 `name`），不是行 id；
- factory 只允许 `require("react")` 等 baseline 模块；不 import 其他插件的值（bundle-purity）；
- 导出 `name/inject/apply`，结尾 `return module.exports`；
- 注册的 slot 必须是 `plugins.row.config`（key = `dsh-dbhub-live#dbhub-live`；见「状态通道」条），组件同时服务 `props.view === 'summary'`（一行摘要）与 `'page'`（完整表单，自画标题/图标/面包屑）；**另外必须注册 `settings.section`（id `dbhub`，order 40）作为主入口**——设置面板是核心 shell，任何部署都在，用户也在那里找连接管理；`plugins.row.config` 只在官方插件页浏览器半区活跃时存在，不能当唯一入口。侧边栏快捷入口（`sidebar.panellist` id `dbhub` + `main` key `dbhub`，`PanelIcon`/`ConfigPanel`）由**两个条件同时成立**决定（F0）：`sidebarWanted()` = `view.enabled !== false && view.showSidebarEntry !== false`，`syncSidebar()` 挂 `face.subscribe` 按 view 即时 register/dispose。**「隐藏入口」≠「禁用插件」**：关开关只是不显示入口、插件照常工作（工具仍可用）；禁用则一律不贡献入口。两种状态都**不得自锁**：`settings.section` 与 `plugins.row.config` **始终注册**。**`showSidebarEntry` 全链路已恢复**（options 默认 true/snapshot/VALIDATORS、`normalizePrefs` 布尔读回、`STATUS_DEFAULTS`/`STATUS_SCHEMA`/`Config` volatile、字典与设置条开关、draft），默认开启，0.1.7+ 同样作为声明式配置暴露。**开关回来时必须同步翻转 `scripts/render-check.mjs` 里 F0 时代的断言 `strip no longer carries a sidebar switch`（改成「设置条重新带开关」），否则 `check:ui` 直接红。** 回归门：`npm run check:ui` 第 19 组（启用 ∧ 开关 / 禁用一律隐藏 / 设置页始终在）+ `node test/options.test.mjs`。**HTTP 通道轮询是「按订阅」的**：只有渲染中页面用 `props.subscribe(fn, { live: true })` 起 1.5s 轮询（`document.hidden` 跳过），插件作用域订阅（`face.subscribe(syncSidebar)`）只做一次性拉取——空闲 GUI 不得持续轮询（否则 `check:ui` 因残留 interval 挂住不退出）。
- **host face 的探测与写回（源代码级契约，别退回 inject）**：`export const inject` 只能有 `["slots"]`；`legacyFace(scope)` 与 `httpFace()` 实现同一接口（`getSnapshot/subscribe/setEnabled/saveConfig/configOp`，快照 `{ status, value }`），`ctx.get('settingsScope')` 有则优先 legacy。HTTP face 四个入口 `GET /state`、`POST /enabled`、`POST /options`、`POST /op`，写完用响应 view 直接刷新快照（不等轮询）；`configOp` 的 `{op: …}` 直接 POST。**选项写入优先走官方 settings 表单**：Host 发布 `entryId`，客户端有 `ctx.configForms` 且 entryId 非空时 `configForms.get(entryId).set(field, value)`，失败/解析不到才回退 `POST /options`（0.1.x 与无 settings 客户端走这条）。回归门：`node test/client-format.test.mjs` + `check:ui` 第 18 组（无 settingsScope 时走桥接、四个写入口、`configForms` 优先与回退、轮询可回收）。
- 组件不得接触 `ctx`，数据/回调一律通过注册时的 `inject: () => face` 传入 props；**样式改为 `apply()` 里 `ensureStyle()` 注入一份作用域样式表（`#dsh-dbhub-live-style`，类名前缀 `dbh-`）**——悬浮/焦点态是伪类，内联样式表达不了；颜色一律用 `--dsw-alias-*` 主题 token + 中性兜底（深色/skin 切换不串色），只在动态取值时用内联样式。**不要把样式退回成一堆内联对象。**
- **`apply()` 必须能被重复执行（客户端 HMR 会重跑整个 bundle）**：`localeSvc.register(NS, …)` **不是幂等**——同 namespace+locale 再注册抛 `locale namespace … already has locale zh`，客户端半区整块同步失败。因此：① 捕获 disposer 用 `ctx.effect(() => dispose, …)` 挂在插件作用域；② 注册失败 **降级到 `localTranslator(localeSvc)`**（读本 bundle 字典 + `localeSvc.getLocale().active`），绝不打断整个插件半；③ 新增/改动 `apply()` 注册都要问「reload 第二次还会成功吗」。回归门：`check:ui` 第 14 组（重复注册 + dispose 后再注册 + 降级后文案仍本地化）。
- 配置页渲染的 `workspaces` 行只显示 `w.conn`（元数据标签），**不得显示/回显 DSN**；改名走 `configOp({op:'rename'})`，改名+改连接走**一条** `{op:'add', renameFrom}`（`configOp` 是单字段，连续两次写会互相覆盖）。
- **布局契约（4.2 迭代沉淀，别再退回「每行三到四行 + 常显表单」）**：
  - **按 `path` 分组**（`groupRows`，标题不是身份：同名工作区是不同目标，同名组头用路径消歧），`layoutModeOf` **无阈值**判定：所有工作区都只有 1 个环境 → **平铺网格**（`dbh-tiles`，`minmax(280px,1fr)` + 内容列 `max-width:960px` 自然封顶 3 列）；只要有任一工作区是多环境 → **分组折叠**（`dbh-group` + 可点击组头 `aria-expanded`）。判定必须是纯函数，改判定先改 `scripts/render-check.mjs` 的断言。
  - **每个连接只占一行**：`环境 chip（窄、淡） · 🔒 连接元数据 · source chip · [▶][✏][🗑] 图标按钮`。三条硬规则：
    ① 行内操作**只允许图标**（`primitives` 的 `IconPlayOutline16` / `IconEditOutline16` / `IconCloseOutline16` / `IconTrashOutline16`，无边框 24px，label 走 `title`/`aria-label`）——文字按钮一放上来就吃掉半行，这是被用户点名过的；
    ② `source` 句柄做成**可复制 chip**（`sourceChip`）：虚线边框 + 复制图标 + **短句柄**（`shortHandle`：≤14 字全显，否则保留"工作区哈希 + 环境段"两段），让人一眼看出"这是 id、点了复制"，而不是"复制整行连接串"；全文与用途进 tooltip（`ws.srcHint`），复制走 `primitives.writeClipboard`（自带 execCommand 兜底）；
    ③ 连接元数据用 `connLabelView` 拆成 `前缀(type://host:port/) + 库名`，**前缀可截断、库名绝不截断**（`dbh-conn-pre` 省略号 / `dbh-conn-db` 不收缩）——"窄行里看不到库名"是最常见的抱怨。**现代面连接串前不再加 🔒**（会被误读成"需要密码"，且与只读 chip 的锁冲突）；legacy 保留原 `🔒` 标记。
    行内只允许出现 `w.conn`，`srcId` 只是句柄、绝不回显 DSN。**「来源」（手填/扫描/复制/自动发现）不得做成行内徽章**——它几乎每行都一样、却是最抢眼的元素；改为环境名 chip 的 tooltip（`originTitle`），只有"自动发现且未持久化"这一例外在 tooltip 里显式点名。
  - **层级**：工作区分组是 level-1（边框卡片 + 极淡阴影），环境行是 level-2（缩进 + 左侧引导竖线，见 `dbh-groupbody{border-left}`）；两层绝不能长得像同一层。
  - **主题适配（红线）**：样式表**只允许 `--dsw-alias-*` token**，兜底值必须中性且半透明（`rgba(127,127,127,.3)`、`transparent`），**禁止任何不透明色字面量**（`#ffffff`/`#f6f8fa`/`#1f2328`/品牌色…）——用户会装主题/皮肤插件（本机就有 skin-center，且背景可能是半透明的），写死白底或固定浅灰字会直接看不清；`test/client-format.test.mjs` 有"tokens only"断言门禁。对比度：正文及以上用 `label-primary`/`label-secondary`，`label-dimmed` 只留给极次要说明。
  - **默认展开**：单个工作区自动展开；多工作区时展开「最近活跃工作区」（由 `useWorkspaces` 的 `WorkspaceSnapshot.updatedAt` 推出，设置面板是全局的，拿不到当前会话选中态，别猜）；取不到快照全折叠。另有「全部展开/折叠」总控。展开态/添加面板/设置条存模块级 `uiMemory`（同页面会话内跨重挂载保留，**不持久化**——视图状态不是配置）。
  - **顶部只留一行（legacy 0.1.x 形态）**：状态徽章 + 工具数 + 设置条摘要 + `[⚙ 设置]` + `[启用/禁用]`；自动更新间隔与**「在侧边栏显示入口」复选框**一起收进默认收起的设置条（入口显隐 = `enabled && showSidebarEntry`，见 F0）。现代面（≥0.2.1）按「三面布局契约」：标题+版本+升级链接、状态行只留状态与连接数、设置用 DSH 行样式、长说明进折叠区。**添加连接默认收起**：「＋ 添加连接」（全局，工作区用 `<datalist id="dbh-ws-list">` 给已有工作区）/ 分组头「＋ 环境」（工作区自动带入，少一个字段）；保存仍走原有「试连 → 失败才确认」门禁。
  - **环境选项的落点（5.1，遵守既有布局红线）**：只读是**逐行不同**且改语义的属性 → 环境 chip 内 `span.dbh-ro`（`只读`/`RO`），说明并入 chip `title`；SSH 只影响路由，**不做徽章**，只进同一 tooltip（`ro.sshTitle`）。开关是 `.dbh-checkbox` 复选框（**不用 `.dbh-input`、不包进 `.dbh-field`**），故 `render-check` 的 `dbh-field === 3` 与 `typeWithin('dbh-addpanel',0..2)` 索引不变；SSH 高级区 `.dbh-adv` 折叠面板**必须排在 DSN 输入之后**，折叠态放 `uiMemory.advOpen`；区内「测试该配置」旁是**「测试 SSH 隧道」**（独立按钮/回执，只验 SSH 层，见 adhoc 条与 R64）。秘密输入 `type="password"`、占位符写明「留空 = 保持原值」，**编辑态绝不回显已存密码/口令/密钥路径**（镜像行只给 `authKind`/`hasPassword`/`hasPassphrase`/`keyReady` 布尔）。回归门：`check:ui` 20/21/23 组（23 = SSH 层独立测试按钮：载荷形状、自带 nonce、不带 dsn、计时、二次点击忽略、dispose 清看门狗）。
  - **写入载荷统一走 `connDraftOf(form)` / `withConnDraft(op, form)`**：只读开关与隧道随 `add`/`test`/`options` 三种 op 一起发出，绝不单独再发一条（`configOp` 在 legacy 通道是单字段，两次写会互相覆盖）。表单对象在产生 op 时会带 `_draft` 指回原始草稿，别绕过这两个函数手拼 `readOnly`/`ssh`。
  - **测试中显示已耗时**：`startTest` 记 `startedAt`，`testing` 态渲染 `test.elapsed`（`测试中… Xs`），1s 计时器**只在有行处于 testing 时存在**（effect 依赖 `anyTesting`，cleanup 清掉）——空闲不轮询、不残留 interval 是硬红线，`check:ui` 会因残留 interval 挂住不退出（第 22 组就是这个门）。看门狗按是否隧道分档（30s/60s），必须高于宿主预算。
  - 布局/交互改动的验收 = `npm run check:ui`（离屏渲染 + 点击交互，涵盖模式判定、默认展开、全部展开/折叠、添加面板、复制按钮、中英 i18n 覆盖率）全绿 + `node test/client-format.test.mjs`。
  - **复制必须给出干净字符串**：连接串拆成两个 flex item 后，浏览器复制序列化会在块级子元素间插分隔符（粘进 DSN 就成 `…3306/ app`）。因此 `connLabelView` 的元素自己接管 `onCopy`（`e.clipboardData.setData('text/plain', w.conn)` + `preventDefault()`）——挂在**连接串元素**而非整行，复制环境名不受影响；`w.conn` 是元数据，不涉凭据。回归门：`check:ui` 第 17 组。
  - **等待态不给二次提交**：`pendingPretest` 期间保存/添加按钮 `disabled`，避免重复派发同一测试。探测要几秒（spawn dbhub），但**写入结果必须立刻可见**——靠宿主 `publishFast` 即时回推，不要改回「等整轮扫描」。
- **三面布局契约（5.2，`dshModern` 门）**：同一组件的**三个面由 slot + 实测宽度决定**——`settings.section`（弹窗，窄列）、主面板（左侧菜单 DBHub 入口）与 `plugins.row.config` 的 `page` 视图（**宽屏整页**）、`<~700px`（**手机小屏**：堆叠紧凑、触摸尺寸）。**新界面必须挂在 `view.dshModern` 下**；`dshModern === false`（DSH 0.1.x）必须渲染**与旧版逐字兼容的 DOM**（含旧页头 `4 个工具（固定）`、⚙ 设置条、`dbh-checkbox`），否则 `scripts/render-check.mjs` 既有断言会红——旧断言不动，新断言由 harness 另行扩展。现代面设计（5.2 重构后的硬约定）：① 页头 = 标题 + 灰色版本号 + 一行「↑ 可升级到 x」文字链接（点击才展开中性说明面板；**禁止红底/红框/error 色**）+ 图标式 ↻；② 状态行只显示「运行中/已停用 · N 个连接」，工具数/一次性模式/dbhub 版本进页面底部「ⓘ 说明与技术详情」折叠区（默认收起）；③ 设置 = **所有非弹窗、非手机页面（宽屏页 / 插件页 / 窄桌面列）一律一行紧凑设置条**（窄列自动加 `.dbh-barnarrow` 隐藏标题与状态词、收窄间距，**不得退回竖排设置行**；弹窗与手机才用竖排）；宽屏条（`.dbh-settingsbar`：标签 + 状态词 + `primitives.Switch` + 更新输入/保存同排，开关 `scale(.85)`），弹窗/手机为紧凑设置行（13px 标题、8px padding、开关 `scale(.8–.9)`）——**字号与控件刻意弱化，连接列表才是主体**；开关必须用 `primitives.Switch`（缺失时才回退 `.dbh-fbswitch`），状态词统一为 `启用/停用`、`显示/隐藏`、`开启/关闭`；更新间隔输入 + 天 + 保存必须在同一行不换行；④ **行内只读 chip（`.dbh-rochip`）在弹窗/宽屏/手机三种布局都出现**，点击发 `{op:'options', readOnly}`（无 DSN），编辑表单里的勾选保留；chip 必须用**开锁+「可写」/闭锁+「只读」**（同一 16px 线性图标风格），否则两个灰色「只读」会被新用户误读成都是只读；⑤ 弹窗面的设置收进状态行「设置」折叠，宽屏面直接展开。
- 若本包脱离仓库（发布 npm），`dsh.client` 与 `exports["./client"]` 必须保留，否则 client-modules 扫描会启动报错。

## 质量门

```bash
npm run check        # 全部 lib 语法
npm run check:secrets  # 脱敏门禁（槽位表 + 通用兜底 + 本地 denylist，见下）
npm run check:ui     # 客户端布局：离屏渲染 + 点击交互门禁（自带极简 React shim，无依赖）
# 单测：沙箱内逐个文件跑（node --test 的 runner 子进程在沙箱下 EPERM）
node test/util.test.mjs && node test/state.test.mjs && node test/options.test.mjs \
  && node test/init.test.mjs && node test/i18n.test.mjs \
  && node test/resolve-source.test.mjs && node test/resolve-workspace.test.mjs \
  && node test/row-cache.test.mjs && node test/auto-dsn.test.mjs \
  && node test/bridge.test.mjs \
  && node test/toml.test.mjs && node test/capability.test.mjs && node test/env-options.test.mjs \
  && node test/adhoc-toml.test.mjs && node test/configure-options.test.mjs \
  && node test/configure-ssh.test.mjs && node test/copy-from.test.mjs \
  && node test/test-op-fastpath.test.mjs && node test/ssh-probe.test.mjs \
  && node test/client-format.test.mjs && node test/zero-knowledge.test.mjs && node test/policy.test.mjs \
  && node test/meta.test.mjs && node test/update.test.mjs
```

**CI（`.github/workflows/quality.yml`，job `gate`）**：`push` 到 `main`/`dev`、所有 PR 与 `workflow_dispatch` 都跑同一 job（`ubuntu-latest` + Node 22），六步 = 语法检查 → 脱敏门禁 → 客户端布局门禁 → 逐个单测（CI 用 `for f in test/*.test.mjs`，新增测试自动纳入；5.2 新增 `test/meta.test.mjs` 与 `test/update.test.mjs`）。`main` 分支保护把 `gate` 设为必需检查。**CI 是真实执行**：它在 5.0.0 上真的跑挂过（`test/auto-dsn.test.mjs` 全部 cancelled）——**本地 Windows 会掩盖只影响 Linux 的缺陷**（见 `unref` 教训），「本地全绿」不能当发布依据，必须看 CI。

### 脱敏门禁（`npm run check:secrets`）

真实主机/账号/密码/库名/项目名只允许存在于两处：`$DSH_HOME/storages/dsh-dbhub-live/credentials.json`（仓库外）与本地 `.env`（`.gitignore` 排除、`package.json` 的 `files` 不含，永不进 git 历史/公开仓库/npm 包）。仓库内一切内容都视为会公开分发。

门禁由 `scripts/desensitize-check.mjs` 执行，规则与槽位来自 `scripts/desensitize.config.mjs`：

1. **槽位规则（主力，高精度）**：槽位表登记"真实值可能出现的出口"（宿主文案、浏览器文案、连接构造代码、扫描器、测试夹具、文档示例、包元数据、本提示词、维护脚本），每个槽位声明它需要的规则（`password`/`dsn`/`host`/`name`）。**槽位 glob 必须匹配到文件，否则门禁报 `slot-stale`**——槽位表不会随目录移动悄悄失效。
2. **通用兜底（覆盖未登记的新出口）**：`ip`（只允许回环、`0.0.0.0` 与 RFC 5737 文档段 `192.0.2.x`/`198.51.100.x`/`203.0.113.x`）、`secret`（GitHub/npm/OpenAI/Slack/AWS/JWT/PEM 等真凭据格式）、`entropy`（大小写/数字混排的高熵串）、`host`（`.local`/`.internal`/`.corp` 等内网后缀）、`name`（本地 denylist）。
3. **本地 denylist（补充）**：pattern 抓不到的**裸名字**（项目/公司/库名）放在 `.env` 的 `DSH_DBHUB_DESENSITIZE_RE`（`|` 分隔、正则转义、多条取并集）。CI 里没有 `.env`，该层自动降级为提示，不影响其余两层。

**约定（新增内容一律照此写）**：示例主机用 `127.0.0.1`/`localhost`/RFC 5737 段；示例密码用 `CHANGE_ME`；测试夹具可用短占位（`u:p`、`root:secret`），但主机仍须回环/保留段；误报走行内标记 `desensitize:allow`（仅限确认无害的行）。

**义务（硬规则）**：新增功能若引入示例、默认值、文案串或夹具 → **同一次改动里更新 `scripts/desensitize.config.mjs` 槽位表**；提交前跑 `npm run check:secrets`，命中就改占位符/规范值。执行点：本地手动 + `prepublishOnly` + CI（`.github/workflows/quality.yml`）。历史事故：这些值曾随 npm 包与公开仓库分发，公开即视为泄露、无法追回。

零知识自检（模型可见面不得含密码）：`node test/zero-knowledge.test.mjs` 全绿 + 上面 `npm run check:secrets` 零匹配。

发布前：按「调试方法」第 3 步在隔离实例完整冷启动一遍，确认 Host 无报错、`/api/dsh-dbhub-live/state` 带会话 cookie 返回 200（不带 cookie 返回 401）、`/plugins/??<包名>/client.js&rev=…` 可访问。

## 发布测试门（release-test/，每个声明版本都实测 web 端）

支持哪些 DSH 版本**不靠记忆**：`release-test/matrix.json` 是唯一声明，`doc/SUPPORT-MATRIX.md` 是由证据生成的表，`npm run release:preflight` 是发版闸门。

```powershell
mise -C release-test install  # 一次性预装矩阵里的全部 DSH 版本（不激活；没 mise 可跳过，测试会自动回退 npm）
npm run test:release       # declared 矩阵：钉版 CLI + 隔离 DSH_HOME + 真实 dsh web + HTTP/日志探针
npm run test:release:all   # 连 advisory 观察项一起跑
node release-test/run.mjs --only 0.2.1-rc.2   # 只跑一个版本（调试用，不能当发版依据）
npm run support:matrix     # 重新生成 doc/SUPPORT-MATRIX.md（矩阵或证据变了就重生成）
npm run support:check      # 校验文档与 matrix/最近证据一致（CI 用）
npm run release:preflight  # 闸门：报告新鲜 + tree 一致 + 矩阵未变 + 声明无偏差 + AI 判定通过 + 工作区干净
```

- 产物：`.release-test/reports/<run>/` —— `report.md`（人看）、`report.json`（机器）、`judge-prompt.md`（给 AI）、`evidence/<版本>/`（安装/启动日志与探针回执）。**`.release-test/` 不进 git**（`.gitignore` 已排除，脱敏门禁 `SKIP_DIRS` 已跳过）。
- **AI 判定是流程的一步，不是可选项**：按 `judge-prompt.md` 复核证据 → `node release-test/run.mjs verdict --template --run <dir>` 生成骨架 → 逐版本写结论、逐条回答 open question → `verdict --check` 校验（硬失败不能判成 pass，报告哈希必须对得上）。
- 结果解读：`fail` = 硬失败，禁止发版；`warn`/`skip` = 进 open questions 由 AI 判定（例如沙箱里被迫手工装配）；`claim drift` = 声明与 manifest 矛盾（典型：peerDependencies 范围排除预发布版）——**报告照跑，但闸门会拦住发版**。
- 增删支持版本：只改 `release-test/matrix.json`，再 `npm run support:matrix` 重生成文档；`package.json` 的 `dsh.compatibility.dshReleases` 必须与矩阵一致（`node release-test/run.mjs matrix` 会列出偏差）。
- 隔离纪律：每个版本都在 `.release-test/homes/dsh-<版本>/` 里跑，**永不碰用户真实 profile**（主实例 fail-loud）。CLI 一律钉版。
- **CLI 来源**：默认 `--cli-source auto`——mise 里预装了该版本就用 `mise x npm:@deepseek-ai/dsh@<版本> -- dsh …`（不激活），否则回退 `.release-test/cache/tools/` 的 npm 一次性安装；报告里记录每个 target 实际用了哪种。预装清单 `release-test/mise.toml` 由矩阵生成，勿手改。确认 mise 装齐后可 `node release-test/run.mjs clean --tools` 回收 npm 缓存（每版本约 470 MB）。
## 分支与发布流程（dev 测试版 → main 正式版）

**分支职责**
- `dev`：**集成/测试分支**。所有改动先落这里（直接提交，或功能分支 PR 进 dev）；允许 force push；CI（`gate`）在这里跑。
- `main`：**只用于发布**。已开分支保护：必需检查 `gate`、禁止 force push、禁止删除。改动只能从 `dev` 合入（PR），main 上不再有其它直接提交。
- 每次发布后 `dev` 与 `main` 收敛：`git checkout dev && git merge --ff-only main`。

**触发词与硬约束（最重要，别越界）**
- 用户说「**可以了，发布**」（或类似）= **发 dev 测试版**。此时**绝不**动 `main`、**绝不**执行 `npm publish` 的默认（`latest`）发布。
- 只有用户明确说「**合并主分支发布正式版**」（或等价明确指令）时，才走正式版流程；并且**正式版的 npm 发布命令只输出给用户手动执行**——代理不代发（用户自己用浏览器登录拿凭据）。仓库里没有 `NPM_TOKEN` secret，CI 也不会替你发。
- **已发布的 tag 与 npm 版本绝不移动 / 删除 / unpublish**；发现缺陷就发下一个补丁版本。这条是 5.0.0→5.0.1 那次事故的直接教训（当时为了"对齐"移动过 tag，用户明确否掉了这种做法）。
- 测试版**必须** `--tag dev`（若发 npm）+ GitHub `--prerelease`；只有正式版才能用 `--latest` 与默认 dist-tag（否则 `latest` 会被指到测试版，普通用户直接中招）。
- 只有 CI（`gate`）绿的提交才能进 `main`；`pnpm pack` 的产物名必须与 `package.json` 版本一致。

**阶段一：测试版（在 dev 上）**
```powershell
git checkout dev && git pull
# 改代码；package.json 版本 = <下一个正式版>-dev.<N>（N 不复用，如 5.1.0-dev.1）
npm run check; npm run check:secrets; npm run check:ui     # 再逐个跑单测
$env:npm_config_store_dir='D:/my/app/dsh/plugin/.pnpm-store'; pnpm pack   # dsh-dbhub-live-<ver>.tgz
git add -A; git commit -m "..."; git push origin dev       # CI 在 dev 上跑 gate
# ⚠ 发版闸门（必跑，见「发布测试门」）：在干净提交上跑矩阵 + AI 判定，preflight 不过不许打 tag
npm run test:release; npm run release:preflight
git tag -a v<ver> -m "..."; git push origin v<ver>
gh release create v<ver> --prerelease --title "v<ver>" --notes-file <notes> dsh-dbhub-live-<ver>.tgz
# 可选（只在需要验证 npm 安装路径时）：npm publish --registry=https://registry.npmjs.org/ --tag dev
# 安装验证（不碰 npm 也行）：dsh plugin --profile web add <tarball>（或 dsh-dbhub-live@dev）
```
预发布不会抢 Release 页的 "Latest" 徽章，普通用户 `dsh plugin add dsh-dbhub-live` 仍拿正式版。

**阶段二：正式版（仅在用户明确要求时）**
```powershell
# 1) 在 dev 上把版本号转正（去掉 -dev.N），提交 "vX.Y.Z (release): ..."，push dev
# 2) 开 PR 合入 main，等 CI 绿后合并
gh pr create --base main --head dev --title "vX.Y.Z (release): ..." --body "..."
gh pr merge --merge
# 3) main 的合并提交也要过闸门（tree 相同则复用 dev 的报告，否则重跑），然后打 tag
npm run release:preflight
git checkout main && git pull; git tag -a vX.Y.Z -m "..."; git push origin vX.Y.Z
# 4) GitHub 正式发布（--latest，附 tarball）
gh release create vX.Y.Z --latest --title "vX.Y.Z" --notes-file <notes> dsh-dbhub-live-X.Y.Z.tgz
# 5) npm：把命令交给用户手动执行（代理不代发）
#    npm publish --registry=https://registry.npmjs.org/    # 不带 --tag → latest 指向它
```

**给代理的默认行为**：本仓库里代理只往 `dev` 提交/推送；`main` 只通过 PR 合入。需要动 `main`/发 npm 时先停下来向用户确认。

## 版本号策略（测试版本 → 发布版本）

- **基线 = 代码库当前版本**（`package.json` 版本，即最近一次发布）。测试/调试迭代一律在基线上挂 `-dev.<序号>`，序号从 1 递增、不复用（如 `4.0.1-dev.1`、`4.0.1-dev.2`…），`pnpm pack` 产物随之换名；
- 原因：pnpm 对 `dsh plugin add <同名同版本 tarball>` 会判「Already up to date」跳过、**不换包**；升版本号才能保证调试包真正部署。
- `dsh plugin add` 后务必用 `dsh plugin ls` 或核对 `node_modules/<pkg>/package.json` 的版本号确认已替换。
- **测试完成要发版时，在基线上按「跨度和力度」决定升级幅度**（不以 dev 序号原号发布）：
  - 小 bug 修复 / 小功能改动 → 升**补丁号**：`4.0.0` → `4.0.1`（例：测试到 `4.0.0-dev.8` 仅小修 → 发布 `4.0.1`）；
  - 大功能新增 / 影响面较广的功能改动 → 升**次版本号**：`4.0.0` → `4.1.0`；
  - 破坏性升级 / 阶段性架构变更 / 跨度过大 → 升**主版本号**：`4.0.0` → `5.0.0`（tag/npm 一律打正式版本号）。
  - 跨档并存时按最高档计（含破坏性改动 → 主版本）；归属拿不准时**先向用户确认再发版**，禁止未确认跨度直接升主版本。
- **发布版本成为新基线**，下一轮测试从 `新基线-dev.1` 重新起序（如 `5.0.0-dev.1`…）。

## 约定

- 产品文案中文、代码注释英文；密码脱敏/零知识不可绕过；扫描必须经 `askUser` 授权。
- **脱敏红线（提交/发布前强制自检）**：仓库任何文件——**包括 `test/`（会打进 npm tarball）与工具描述文案**——不得出现真实内网 IP、真实库名、真实密码、公司/项目标识。写法约定与三层门禁见上面「脱敏门禁」：示例主机只用回环或 RFC 5737 段、示例密码只用 `CHANGE_ME`、新出口同次登记进 `scripts/desensitize.config.mjs`；发现新的真实值**只追加到本地 `.env` 的 `DSH_DBHUB_DESENSITIZE_RE`**，绝不写进任何受版本控制的文件。
- `state.*` 之外不要直接改持久化。
- 增加行为时同步更新本文件、README（用户侧）与 doc/REQUIREMENTS.md（业务侧）。
- README 双语同步：`README.md`（中文）为唯一真源，`README.en.md` 由 AI 从最新中文派生——改动任一侧必须同次更新另一侧，章节结构一一对应。