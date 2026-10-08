# AGENTS.md — dsh-dbhub-live 开发与调试说明

> 本文件面向在本仓库上继续开发/调试本插件的 AI 与人。业务需求见 [doc/REQUIREMENTS.md](doc/REQUIREMENTS.md)，用户安装使用见 [README.md](README.md)。

## 一句话定位

DSH host 插件（Node ESM）+ Web client 插件（浏览器半）：把 dbhub（Bytebase 的数据库 MCP 服务器）接入 DSH。**零知识凭据管理 + 一次性进程执行**——DSN/密码只存在于宿主侧，模型只见 source 句柄与元数据（类型/主机/端口/库）；每次工具调用 spawn 一条独立 `dbhub --dsn` 进程跑完即杀，无常驻服务。附配置页（设置 → DBHub 数据库工具 / 侧边栏快捷入口（可关）/ 插件页该行的「配置」）：实时状态 + 连接管理（启用禁用、增删改查、环境改名、连接测试）。

## 目录结构

```
lib/
  index.mjs    入口：name/inject/apply、Config(volatile 选项)、发布核心(createHostCore)、两条通道接线(0.1.x settings 命名空间 / connection.fetch HTTP 桥)、settings 表单策略与选项写回
  bridge.mjs   HTTP 桥（纯函数）：/api/dsh-dbhub-live 四条 exact Fetch 路由的请求/响应编解码
  config.mjs   路径/原子持久化(store,runtime,prefs)/DSN 解析/工作区发现/零知识助手(describeConn,connLabel,scrubSecrets)/小工具
  state.mjs    运行时状态机：enabled/phase/toolCount/lastError/mode + 订阅发布（无服务器生命周期）
  options.mjs  可配置参数：updateIntervalDays/showSidebarEntry（Config 采纳 > prefs.json > 0.1.x 设置文档 > 环境变量 > 内置默认；dbhubPackage 仅内部环境knob）
  runtime.mjs  dbhub 可执行文件发现、按需自动安装、定期自动更新（已删除孤儿进程清理）
  mcp.mjs      MCP JSON-RPC 客户端 + 工具注册表 + 工作区×环境来源发现（collectSources/resolveSource）+ 摘要缓存
  adhoc.mjs    唯一执行引擎：每次调用一条一次性 dbhub 进程（零知识标签 + stderr 清洗）
  collect.mjs  授权扫描项目配置文件并提取 DSN 候选（含 askUser 桥接）
  tools.mjs    host 自有工具定义与注册：恒定 4 个（configure/list_sources/execute_sql/search_objects）；configure 探连优先（见零知识契约 5）
  client.js    Web 半（手写 lazy-CJS bundle）：配置页 = `settings.section` 一级设置页 + 可选侧边栏面板（`showSidebarEntry` 开关）+ `plugins.row.config`（summary/page 两视图）；host face 按运行时探测（settingsScope 或 HTTP 桥）
test/          node:test 单元测试（纯逻辑 + bridge 契约 + client bundle 格式契约 + 零知识泄漏门）
scripts/       仓库维护脚本：desensitize.config.mjs（**脱敏槽位表 = 单一事实源**）、desensitize-check.mjs（脱敏门禁）、render-check.mjs（客户端布局离屏渲染/交互门禁，无需 React 依赖）
.github/       CI：push/PR 跑语法检查 + 脱敏门禁 + 单测
doc/           需求文档
.env           本地脱敏黑名单（DSH_DBHUB_DESENSITIZE_RE），gitignore 排除、不进 npm 包——**唯一允许存放真实标识的地方**
cordis.patch.yml   bundle patch：`name: dsh-dbhub-live` 挂载本包
```

## 关键架构事实

- **模块依赖只进不出（防环）**：`config ← state ← mcp`；`config ← runtime ← adhoc`；`mcp ← tools ← index`；`adhoc ← tools`；`collect ← tools`。禁止反向或循环 import（HMR/装载顺序依赖它）。零知识助手（describeConn/connLabel/scrubSecrets）在 `config.mjs`，任何模块不得把裸 DSN 直接拼进用户可见文本。
- **无常驻 dbhub 服务器**：`dbhub_execute_sql` / `dbhub_search_objects` 在调用时把 `source` 经 `resolveSource` 解成真实 DSN（宿主侧），然后走 `runAdhoc`（`dbhub --transport stdio --dsn <dsn>` 一次性进程，跑完 terminate）。**没有** toml/指纹/mtime 监听/空闲回收/respawn/孤儿清理/配置变更重启。执行天然并发（进程级隔离）、故障隔离（一条进程挂只坏它自己）、多实例安全（无共享端口/无共享 toml/无跨实例误杀）。**不要把常驻服务器那套装回来。**
- **零知识模型契约（红线）**：
  1. 工具**参数**：`source`/`sql`/`object_type` 等 + configure 的非密预填（type/host/port/database/user）。**任何工具都不得声明 `dsn` 参数**（模型传 DSN 会把密码带进上下文）；configure 收到 `args.dsn` 直接拒绝（`result.noDsnViaModel`）。`dbhub_query`/`dbhub_query_objects` 已删除，勿恢复。
  2. 工具**输出**：结果/列表/标签一律 `connLabel(dsn)`（`type://host:port/db`）或 i18n 模板，密码与用户名永不出现；`dbhub` 返回的文本（含 stderr）进模型前必须过 `scrubSecrets(text, dsn)`。
  3. **密码只在界面输入**：configure 的密码/完整 DSN 一律经 `askUser`（用户敲键盘，不经模型上下文）；配置页 add/edit 的 DSN 走 `configOp` 通道（浏览器→Host），同样不进模型上下文。
  4. **鉴权/连接失败闭环**：`likelyAuthOrConnError` 命中时在错误文本后附 `result.authHint`（引导 `dbhub_configure` 或配置页修改，密码由用户输入）。
  5. **configure 探连优先（交互红线）**：`dbhub_configure` 收到非敏感预填（type/host/database 齐备、非 sqlite）时先宿主侧试连候选 DSN（空密码）：可连通 → 直接持久化返回，**零弹窗**；试连提示需凭据 → 只弹「账号（未知时）+ 密码」最小输入框（`result.ask-*`），其余信息自动沿用；信息不完整或非鉴权失败 → 才弹完整选项（DSN/分项/扫描）。已配置行先探真实 DSN（含已存密码），通过即 `existing-ok` 零输入返回；**模型参数改变了端点（type/host/port/database 任一不同，`argsChangedEndpoint`）时视为新目标，对预填候选重跑试连循环**。凭据弹窗带诊断明细（`detail` = 试连失败原因）与逃生口（`result.askCredMore` → 回到完整选项，避免凭据弹窗死循环；凭据保存后再探失败附 `result.authHint`）。模式菜单里**不再有「仅填写密码」选项**——最小凭据框已取代它；「仍用现有连接」是字面沿用（不补填缺失字段，`result.useExisting*` 文案已澄清）；分项表单会把已知值带入（`result.askHost/askPort/askUserField/askDatabase`，未触碰字段保留预填值）。**试连诊断明确指向“空账号被拒”（`emptyUserDenied`，如 `Access denied for user ''@…`）时，账号为必填**：最小凭据框不提供「留空（使用空账号）」选项，用户仍提交空账号则拒绝保存（`result.askAccountRequired*`），避免把同一个必失败的 DSN 再存回去。决策逻辑收敛在 `config.mjs` 的 `decideConfigureStep`/`argsChangedEndpoint`/`emptyUserDenied`（纯函数，`util.test` 覆盖）。
  6. **零密码泄漏门**：`test/zero-knowledge.test.mjs` 断言 summarizeRows 无 dsn 字段、无工具声明 `dsn` 参数、描述/i18n 文案不含真实形态 DSN；`util.test` 断言 scrubSecrets/connLabel/buildDsnFromParts/decideConfigureStep 行为。改模型可见文案时这些测试必须保持绿。
- **状态通道（双栈，5.0 迭代）**：Host 只有**一个**发布核心（`index.mjs` 的 `createHostCore`：walk / row-mirror / `runOp` / `view()`），由**两条通道**适配到浏览器：① **0.1.x 的 settings 命名空间**（`ctx.inject(['settings'])` + `settings.register(…, STATUS_SCHEMA, {base})` → `scope.replace/watch`，仅在 `typeof settings.register === 'function'` 时启用）；② **鉴权 HTTP 桥**（`ctx.inject(['connection'])` → `connection.fetch.register` 注册 `/api/dsh-dbhub-live/{state,enabled,options,op}` 四条 exact Fetch 路由，**两条 dsh 线都有**）。dsh 0.1.7 用 Config 表单取代了 settings 命名空间（`register` 消失），0.2.x 又删掉了浏览器侧的 `settingsScope` 服务——**这是 5.0 移植的根因**：旧版客户端 `inject: ["slots","settingsScope"]` 永远等不到服务，整个浏览器半区 pending（页面/侧边栏/卡片全部静默消失，连报错都没有）。因此客户端**只 inject `slots`**，host face 用 `ctx.get('settingsScope')` 探测：有就用 legacy 命名空间，没有就走 HTTP 桥（`httpFace()`）；写路由继承 connection 的 Host/Origin 围栏与浏览器鉴权（无 cookie 的 `/api/dsh-dbhub-live/*` 返回 401，实测）。路由编解码在纯函数模块 `lib/bridge.mjs`（`test/bridge.test.mjs` 覆盖）。Web 端有三个入口指向同一个页面：**`settings.section`（id `dbhub`，主入口，settings 面板是核心 shell）**、**可选侧边栏面板**（`sidebar.panellist` + `main`，受 `showSidebarEntry` 控制）、**`plugins.row.config`**（键 `<包名>#<行 id>` = `dsh-dbhub-live#dbhub-live`，owner props 为 `view: 'summary' | 'page'`，该 slot 只在官方插件页的浏览器半区活跃时存在）。**dsh 0.1.6 已删除旧的 `settings.plugin.item` 槽位**：注册到不存在的 slot 会被静默忽略（不报错、界面什么都不显示）——升级 dsh 后「配置页消失」就是这个原因，不要再改回去。**两条通道发布的是同一个 view**：状态 `{enabled, phase(running|disabled), toolCount(恒定4), lastError, mode('oneshot')}` + 配置 `{updateIntervalDays, showSidebarEntry}` + `{workspaces(JSON 元数据摘要：title/path/env/conn(主机端口库)/source/persisted/srcId)}` + `{testResult}`（连接测试的一次性回执，仅内存态、不落任何持久化）；legacy 命名空间里额外有 `{configOp}`（主机消费后由下一次发布清空，天然防环），HTTP 桥则把它换成 `POST /op` 的请求体——**DSN 依旧只从浏览器流向 Host，永不进模型上下文**。**注入回调是独立作用域：内部需要的服务（如 `subprocess`）必须用 `ctx.get('subprocess')` 就地获取，绝不能引用 `apply()` 的局部变量——否则 ReferenceError 会静默杀死整条发布/配置链路（配置页只剩静态值、工作区连接不刷新）**；发布核心把这个读取收敛在 `subprocessOf()` 里，两条通道都不再自己捕获。legacy 回调整体套 `wrap()` 防护，异常必须打日志。
- **可配置参数（三条通道，一个有效值）**：`options.mjs` 只此一处持有部署开关：`updateIntervalDays`、`showSidebarEntry`（布尔，默认 `true`，设置页开关即时生效）；`dbhubPackage` 仅环境变量/内部，不进设置。三条通道都汇到同一个有效值：① **`Config`（named export，两个 `.volatile()` 字段）**——0.1.7+/0.2.x 官方「插件」表单与 cordis.yml 的写入口，**没有默认值**（未设置 = `undefined`，与"显式选择"可区分）；② **`prefs.json`**——有效值的存储（页面写入落点）；③ **0.1.x 设置文档**——只在 boot 时补 prefs 未认领的字段。层叠（低→高）：内置默认 < 环境变量 < 0.1.x 设置文档 < prefs.json；**显式 Config 值在 boot 与 `loader/volatile-update` 时被"采纳"**（`options.configValuesOf(config)` → `applyPatch(..., {persist:true})`），因此官方表单改一项、本插件页面也立刻显示同一值，反向亦然（页面写入 → `settings.update(entryId, …)` 写回 profile patch，实测会真实改写 patch 文件）。`apply(ctx, config)` 的第二个参数就是这个 Config；`entryIdOf(ctx)` 用 `ctx.fiber.entry.options.id` 运行时解析 entry id（**不要写死行 id**，部署方可以换）。**已删除 `idleMinutes`**（无常驻进程可回收）。不要绕过 `applyPatch` 直接改 `options` 内部值。
- **工作区连接管理（configOp 通道）**：store v2 = `{ [wsPath]: { environments: { [env]: {dsn, source, updatedAt} } } }`（v1 单 dsn 条目自动迁移进 `environments.default`）。环境名一律过 `normalizeEnvName`（trim、去控制字符、限长、空值收敛为 `default`），因此**中文环境名是一等公民**。配置页只读**元数据**摘要（`collectSources` → `latestSummaries`，密码/用户名永不出 Host）；增/改/删/改名通过命名空间 `configOp` 单向命令下发，`index.mjs` 用 `setWorkspaceEnv`/`removeWorkspaceEnv`/`renameWorkspaceEnv` 落盘后重扫摘要并发布（configOp 随发布清空，天然防环）。`add`/`set` 可带 `renameFrom` 做「改名 + 改连接」的**单条原子命令**（`configOp` 是单字段，拆两次写会互相覆盖）；纯改名走 `{op:'rename', workspace, env, newEnv}`。自动发现（mise/.env）只提供未覆盖的 `default`，不持久化。**连接测试（`{op:'test', workspace, env, nonce}`）**：`handleTestOp` 用摘要背后的真实 DSN 调 `adhoc.probeConnection`（一次性 dbhub + `SELECT 1`，Host 侧 30s 超时兜底），结果经 `testResult` 镜像字段回推 `{nonce, ok, message}`；测试失败只是行内一次性提示，不得写入 store/lastError/phase。配置页只认自己派发过的 nonce，展示 ~10s 自动消退，刷新即失，天然不保留状态。**覆盖门（`requestWrite`/`envCollision`，4.2 迭代）**：`setWorkspaceEnv` 是**无条件写入**，所以"新增落到已存在环境"和"改名落到已存在环境"在宿主侧都会静默替换原连接。客户端半区因此**先问后写**：`requestWrite(form, check)` 用 `envCollision(workspaces, ws, env)` 判定（环境名比较必须先过 `normalizeEnvForCompare`——它镜像宿主的 `normalizeEnvName`，否则"`prod `"与"`prod`"这种同键异写会漏判），命中就弹 `dbh-warncard`（`role="alert"`，取消/覆盖两个出口），**确认后才走原有的 `dispatchPretest` 预检流程**，取消则一个 op 都不发且保留表单内容。仅"改同一个环境的连接"不设门（编辑的本意）。局限：workspace 留空时页面无法知道宿主会选哪个工作区（`resolveWorkspaceRef` 回退到 `workspaces[0]`），只能用"第一行所属工作区"做近似，不确定时显示 `ovr.bodyAmbiguous` 提示而非断言；要精确判定需要新增宿主侧预检 op（暂不做）。回归门：`npm run check:ui` 第 15/16 组。**即时回推 + 扫描串行化（`createRowMirror`/`publishFast`，4.2 迭代）**：`collectSources` 每次都要重扫全部工作区（没有持久化 `default` 的工作区会各起一次 `mise env`），一次卡片写入过去要等 1–2 秒才在界面上体现；更糟的是**并发扫描互相覆盖**——探针回执触发的那次扫描可能在写入前就开始、在写入后才结束，把用户刚存的行又刷掉（现场症状：行"立刻出现、又立刻消失，之后一直不出来"）。现在的规则：① `handleConfigOp` **返回本次生效的 patch 列表**（`add`/`set`/`rename`/`remove`；`test` 与失败为 `[]`）并立刻 `publishFast`（把补丁套进缓存行后同步 `scope.replace`，仅当 `hasRowCache()` 为真——未扫描的空缓存不能发布）；② **`reportTest` 只 `publishMirror()` 不再扫描**（探针不改变任何行）；③ 扫描**单飞**（`runWalk`：进行中只记 `walkRequested`，结束后补跑一次），并且 `createRowMirror` 会把补丁**持有到"在它之后才开始的那次扫描"落地**为止（`beginWalk`/`endWalk` 对扫描期间到达的补丁重新套用）——所以任何一次扫描都不可能发布出缺少该写入的列表；④ `applyRowPatch` 的 `rename` 必须**幂等**（`from` 行已不存在时返回原列表而不是把 `to` 行删掉），否则重放补丁会丢行。一次点击的开销：1 次扫描 + 2 次纯内存镜像（原来是 3 次扫描）。补丁行里的 `dsn` 只存在于宿主内存，`summarizeRows` 依旧只输出 `conn` 元数据。回归门：`npm run check:ui` 第 15/16/17 组 + `node test/row-cache.test.mjs`（含重放/幂等/扫描期间补丁重放三条）。
- **自动发现的代价与边界（4.2 迭代，别退回"每次同步阻塞探测"）**：`collectSources` 会对**没有持久化 `default`** 的工作区逐个跑 `runMiseEnv`（spawn `mise env`）。三个硬约束：① **每次探测必须有总超时**（`MISE_ENV_TIMEOUT_MS`，`Promise.race` + `terminate()`），`graceMs` 只是 SIGTERM→SIGKILL 的宽限、**不构成超时**——曾经一个不退出的 `mise env` 会让整轮扫描永不返回，而 `dbhub_list_sources` 走的就是这条同步路径，模型侧看到的是调用被中断（`Interrupted`），偏偏卡片因为持有补丁还显示着旧行；② **探测结果（含"什么都没发现"）按工作区路径短期缓存**（`AUTO_DSN_TTL_MS`，`resetAutoDsnCache()` 供测试与显式重扫），否则每一次发布、每一次模型列源/执行都要重新 spawn 一遍 `mise env`；③ **工作区之间并发解析**（`Promise.all`），一个慢目录不得串行拖累其他工作区。回归门：`node test/auto-dsn.test.mjs`（挂起→限时放弃并 terminate、拒绝可执行文件、TTL 内复用、有持久化 default 时不探测）。另：`resolveWorkspaceRef(ref, ctx)` 必须用**与扫描同一个** `listWorkspaces(ctx)` 解析工作区，否则卡片写入的 store key 与扫描查的 key 可能不是同一个拼写，出现"设置里有、模型看不到"。
  - **预算计时器必须保持被引用：绝不要 `unref()`**（`runMiseEnv` 的总超时、`withProbeTimeout` 的探针兜底都是）。unref 的计时器在"它是唯一待办"时根本不会触发——事件循环直接排空、进程先退出，超时**形同虚设**；探针兜底还会留下一个活着的计时器，所以要在竞速结束时 `.finally(() => clearTimeout(t))`。这个缺陷**只在 Linux CI 暴露**（`Promise resolution is still pending but the event loop has already resolved`，整文件被判 cancelled），本地 Windows 会因为别的句柄侥幸留住循环而"通过"——别拿本地绿灯当证据，改这类代码后必须看 CI。
- **工具声明数量恒定（上下文预算红线）**：恒定 4 个（configure / list_sources / execute_sql / search_objects），**绝不为每个工作区 × 环境注册独有工具**；`dbhub_execute_sql(source,…)` / `dbhub_search_objects(source,…)` 调用时 `resolveSource` 按 source 值解析到真实连接。曾实现过的 per-source 注册与 `dbhub_query` 临时连接工具已移除，勿回恢复。
- **工作区语义（模型契约，勿退化）**：**每条 source 只属于一个工作区**，跨工作区的「看起来一样」的连接是不同目标。`sourceIdOf(row)` 是 source 值的**唯一**构造点（`<标题slug>_<工作区路径哈希>[_<环境slug>]`），列表输出、解析器、各工具回执必须都调它，否则模型会拿到解析不回去的句柄。`envSlug`：`default` 保持裸值、纯 ASCII 名保持原 slug（`test`→`test`，既有 source 值不变）、含非 ASCII 的名（`线上`）取 `env-<shortHash>`——**旧实现对每个纯中文名都返回同一个 slug**，`线上` 与 `测试` 曾共用 source 值并被静默查错库；这是回归红线。`resolveSource(ctx, sub, ref, {preferredWsPath})` 精确优先，其次按**当前会话工作区**（`currentWorkspace(ctx, exec)`：会话 cwd 精确匹配 → 最长包含路径）筛选，仍有多条则返回 `{ambiguous:[…]}`，由 `result.ambiguousSource` 让模型用完整 source 值澄清——**绝不按列表顺序猜**。`dbhub_configure` 的工作区解析也**不再回退到 `workspaces[0]`**（那是「把连接配到别人工作区」的隐患）：显式 workspace 必须匹配，否则 `result.unknownWorkspace` 列出可用工作区；未给 workspace 时用当前工作区，解析不出来则 `result.needWorkspace`。跨工作区复用连接一律走 `copyFrom`（宿主侧复制 DSN，零知识不破）而不是直接用别人的 source。`dbhub_list_sources` 按工作区分组并标出【当前工作区】（`result.wsCurrentHead`/`wsOtherHead`/`wsGroup`）。
- **schema 弹性依赖**：优先用真实 `@deepseek-ai/schemastery` schema（`await import`）；解析失败时降级为 `lib/index.mjs` 内建的最小 callable schema（`schema(v)` 合默认值 + `toJSON()`），保证**链路安装（`dsh plugin add <本地目录>`，Node ESM 按源码真实路径解析裸导入）下插件照样启动、卡片照常工作**。tarball/npm 安装（真实目录在 profile node_modules 下）走真实 schemastery 路径。不要把这个 import 改回静态顶层 import——会重新引入链路安装时启动失败。
- **执行时机**：`apply()` 只注册核心工具 + 后台 bookkeeping（`startBackgroundBoot`：置 phase running、刷新工具数、非阻塞检查 dbhub 自动更新）；真正的 dbhub 解析（persisted → mise → PATH → 自动安装）发生在**每次调用**（`resolveDbhubExe` 有 runtime.json 缓存，首次或缺二进制时才安装）。**无工作区数据源时一切照常**——工具正常注册，list_sources 返回空、execute 返回 noSource，不会拉起任何进程。
- **启用/禁用**：`state.setEnabled` 持久化到 `credentials.json`（权威值）；禁用时所有工具 execute 首行返回「插件已禁用」（无进程可停，无需清理）；重新启用即恢复。

## 存储与容错（初始化即处理）

- **实例隔离**：所有持久化都在 `$DSH_HOME/storages/dsh-dbhub-live/`（`credentials.json` 凭据+enabled、`prefs.json` 卡片选项、`runtime.json`、`dbhub-runtime/` 自动安装前缀）。隔离粒度 = `DSH_HOME`（同一 home 的多个 profile 共享，与 dsh 自身 workspace.json 约定一致）；执行进程、状态机、工具注册天然按进程隔离。**进程环境变量不参与连接解析**。不再有 dbhub.toml；同 home 并发多实例的残余共享只余 `credentials.json`/`prefs.json`（用户驱动低频写），写出已原子化（见下）。
- **原子写**：`writeJsonFile` 一律 tmp+rename（同目录写临时文件再改名覆盖），并发读者永不见半个文件、并发写者末写覆盖不交错；目录被删时先 `mkdirSync` 重建。写入失败**不抛致命**，`warnOnce` 一次性告警并继续内存态运行（`saveStore`/`saveRuntime` 返回 false）。
- **升级/手改遗留兼容**：`loadStore`/`loadRuntime`/`loadPrefs` 先用纯函数 `normalizeStore`/`normalizeRuntime`/`normalizePrefs` 清洗：丢弃非布尔 `enabled`、非对象/空 dsn 条目、非法 `dbhubExe`/`dbhubInstallAt`；`dsn` 统一 trim；v1 单 dsn 条目自动迁移为 `environments.default`；**未知字段保留**（向前兼容）。清洗结果与原文不同时**一次性回写迁移**（prefs 只保留两个已知字段，非法值直接丢弃而不是回写）。
- **空值安全**：解析器对缺失/空值全部有兜底（`resolveWorkspaceEnvs` 判空、`describeConn` 对不可解析 DSN 兜底、状态 schema 默认值、settings 镜像的 `enabled` 只认布尔），清洗后不存在半吊子条目。

## 调试方法（不影响正在运行的 Harness）

DSH 启动是 fail-loud：任一插件激活失败整树拒绝启动、GUI 打不开。因此**永远不要在配置/源码上直接动主实例**，按下面阶梯来：

1. **静态校验（30 秒，零风险）** — `npm run check`（node --check 全部 lib）→ 逐个跑单测（沙箱下 `node --test` 的 runner 子进程会被 EPERM 挡，按本文件惯例**逐个文件**跑：`node test/x.test.mjs`）。单测会自己建临时 `DSH_HOME`，不会碰真实 store。
2. **会话内跑通逻辑（不重启）** — 用动态插件工具连（`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine`）：把要验证的纯逻辑（如 configure 流程、scrubSecrets）以无 import 的 Host 代码贴进动态包，在会话里跑，`cordis_stop` 即清场。动态包只活在进程内存 + 当前会话，改动/出错都不影响主进程。动态 Host 代码不能用 `import`，带 `@deepseek-ai/schemastery` import 的 `lib/index.mjs` 不能整文件贴进动态包；只对纯逻辑做动态验证。
3. **冷启动验证（隔离实例）** — 用独立 `DSH_HOME` 起测试实例。本机备有独立测试 home：`.dsh-a`（`deepseek-harness/mise.toml` 把 `DSH_HOME` 指向它）。两条可用路径：
   - **源码实例（`mise r dsh …`，走 tsx）**：`cd D:\my\app\dsh\plugin\deepseek-harness` 后 `mise r dsh web --port 3082 --no-open`。注意 `pnpm dsh` 会先跑 pnpm 依赖校验，node_modules 不同步时它会想重装并因无 TTY 中止——直接 `node --import tsx/esm apps/cli/src/bin.ts …` 可跳过；esbuild 的 spawn 在沙箱下会 EPERM（属沙箱边界，别绕）。
   - **已安装实例（推荐，无 esbuild/pnpm）**：直接用 npm 安装版 CLI，`$env:DSH_HOME='D:/my/app/dsh/plugin/.dsh-a'`，并**清掉继承来的 `DSH_PROFILE`/`DSH_PROFILE_DIR`**（它们指向主 profile 会造成污染/参数冲突），然后 `node <dsh 安装目录>/lib/bin.js web --port 3082 --no-open`。`dsh web` 自带 `web` profile，**不要再传 `--profile web`**（会报 "select a profile only once"）。
   ```powershell
   # 装包：pnpm 需要可写 store（默认 store 在 workspace 外会被沙箱拒绝）
   $env:npm_config_store_dir='D:/my/app/dsh/plugin/.pnpm-store'; pnpm pack
   node <dsh>/lib/bin.js plugin --profile web add D:/path/to/dsh-dbhub-live-<ver>.tgz
   # 沙箱内 pnpm 可能事先被别处 store 链接过而报 UNEXPECTED_STORE；此时可手工替换
   # .dsh-a/profiles/web/node_modules/dsh-dbhub-live/ 的目录内容（file: 依赖就是普通目录，
   # 不写 store、不动 lockfile），仅用于验证，不要当成发布流程。
   # 验证清单（0.2.x）：
   #   日志：`[dsh-dbhub-live] host apply` + `dbhub 插件已加载（4 个工具）` + `浏览器桥接已注册: /api/dsh-dbhub-live/*`
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
   **取 bundle URL 的正确方式**：index HTML 里嵌着模块清单 JSON（`{"id":"dsh-dbhub-live","url":"/plugins/??…&rev=<rev>"}`），**rev 带 `-<n>` 后缀**（如 `d4aeeae7c6c2a859-55`，每次渲染会变）；用正则从组合列表里截 rev 会截断后缀而 404，必须整段取出该 `url` 再请求。
   **0.1.x 线（双栈的另一半）**：另起一个 scratch home 装 0.1.6 的 CLI 跑一遍即可，`dsh web` 会自己初始化 web 模板：
   ```powershell
   # 用 0.1.6 的 CLI 初始化 DSH_HOME=.dsh-b，然后把包目录拷进 profiles/web/node_modules/
   # 并在 package.json 的 dsh.profile.bundles 里加上 dsh-dbhub-live（bundle 的 patch 会自行插入插件行）
   # 期望日志：`host apply` + `dbhub 插件已加载（4 个工具）` + `状态命名空间已注册: dsh-dbhub-live`
   #           + `浏览器桥接已注册: /api/dsh-dbhub-live/*`（0.1.6 没有 settings.configure，故没有"配置表单策略"那行）
   # 期望接口：/api/dsh-dbhub-live/state 带 cookie 200、不带 401；view 里 entryId=行 id；bundle 200
   ```
   `mise r dsh plugin … ls` 只用于核对安装版本；沙箱里 pnpm 的 store 可能不可写，见上面手工路径。
4. **在位热更新（有失败保护，谨慎）** — 主实例的 `cordis.patch.yml` 支持 HMR，读取/解析失败时保留最后一个可用树，GUI 不会挂。但 HMR 不监听插件源码，只适合挂载/卸载验证，代码迭代请用 1/2/3。
5. **安全网** — `$DSH_SNAPSHOT=replay` 可从 `cordis.snapshot.yml` 启动回放点；改动主 profile 前先备份 `cordis.patch.yml`。

## 修改 client 半（lib/client.js）

`lib/client.js` 是**手写 lazy-CJS bundle**，DSH client 模块系统按 `dsh.client` 声明 + `exports["./client"]` 直接服务它，**没有构建步骤**。遵守以下契约（改完跑 `node test/client-format.test.mjs` 守护）：

- 必须以 `window.__ModuleLoader__.load({ id: "dsh-dbhub-live", factory: (require) => { … } })` 注册；
- `id` 必须等于 Loader entry 名（`dsh-dbhub-live`，见 cordis.patch.yml 的 `name`），不是行 id；
- factory 只允许 `require("react")` 等 baseline 模块；不 import 其他插件的值（bundle-purity）；
- 导出 `name/inject/apply`，结尾 `return module.exports`；
- 注册的 slot 必须是 `plugins.row.config`（key = `dsh-dbhub-live#dbhub-live`；见「状态通道」条），组件同时服务 `props.view === 'summary'`（一行摘要）与 `'page'`（完整表单，页面自己画标题/图标/面包屑）；**另外必须注册 `settings.section`（id `dbhub`，order 40）作为主入口**——设置面板是核心 shell，任何部署都在，用户也在那里找连接管理；`plugins.row.config` 只在官方插件页的浏览器半区活跃时存在，不能作为唯一入口。侧边栏快捷入口（`sidebar.panellist` id `dbhub` + `main` key `dbhub`，组件 `PanelIcon`/`ConfigPanel`）**由 `showSidebarEntry` 选项控制**：`syncSidebar()` 挂在 `face.subscribe` 上，按当前 view 即时 register/dispose，关闭它不得影响设置页与插件页入口（避免自锁）。**HTTP 通道的轮询是「按订阅」的**：只有渲染中的页面用 `props.subscribe(fn, { live: true })` 拉起 1.5s 轮询（`document.hidden` 时跳过），插件作用域那次订阅（`face.subscribe(syncSidebar)`）只做一次性拉取——空闲的 GUI 不得持续轮询桥接（曾经漏掉这个区分，`npm run check:ui` 会因残留 interval 挂住不退出）。
- **host face 的探测与写回（源代码级契约，别退回 inject）**：`export const inject` 只能有 `["slots"]`；`legacyFace(scope)` 与 `httpFace()` 实现同一接口（`getSnapshot/subscribe/setEnabled/saveConfig/configOp`，快照形状 `{ status, value }`），`ctx.get('settingsScope')` 存在时优先 legacy。HTTP face 的四个入口分别是 `GET /state`、`POST /enabled`、`POST /options`、`POST /op`，写完用响应里的 view 直接刷新快照（不等下一次轮询）；`configOp` 的 `{op: …}` 对象直接 POST，不再走「写字符串字段再等主机清空」的绕路。**选项写入优先走官方 settings 表单**：Host 在 view 里发布 `entryId`，客户端有 `ctx.configForms` 且 entryId 非空时用 `configForms.get(entryId).set(field, value)`，失败或解析不到 entryId 才回退 `POST /options`（0.1.x 与没有 settings 客户端的部署走这条）。回归门：`node test/client-format.test.mjs` + `npm run check:ui` 第 18 组（无 settingsScope 时走桥接、四个写入口、`configForms` 优先与 entryId 缺失时的回退、轮询可回收）。
- 组件不得接触 `ctx`，数据/回调一律通过注册时的 `inject: () => face` 传入 props；**样式改为 `apply()` 里 `ensureStyle()` 注入一份作用域样式表（`#dsh-dbhub-live-style`，类名前缀 `dbh-`）**——悬浮/焦点态是伪类，内联样式表达不了；颜色一律用 `--dsw-alias-*` 主题 token + 中性兜底（深色/skin 切换不串色），只在动态取值时用内联样式。**不要把样式退回成一堆内联对象。**
- **`apply()` 必须能被重复执行（客户端 HMR 会重跑整个 bundle）**：`localeSvc.register(NS, …)` **不是幂等**——同一 namespace+locale 再注册会抛 `locale namespace … already has locale zh`，客户端半区会整块同步失败（页面提示「插件未能完成同步」）。因此：① 捕获 register 返回的 disposer 并用 `ctx.effect(() => dispose, …)` 挂在插件作用域上（`ctx.effect` 是客户端插件的标准清理口，`ctx.slots.inject` 自身已按作用域清理，沿用即可）；② 注册失败时 **降级到 `localTranslator(localeSvc)`**（读本 bundle 自己的字典 + `localeSvc.getLocale().active`），绝不让重复注册打断整个插件半；③ 新增/修改 `apply()` 里的任何服务注册都要问一句「reload 第二次还会成功吗」。回归门：`npm run check:ui` 第 14 组（重复注册 + dispose 后再注册 + 降级后文案仍是本地化文本）。
- 配置页渲染的 `workspaces` 行只显示 `w.conn`（元数据标签），**不得显示/回显 DSN**；改名走 `configOp({op:'rename'})`，改名+改连接走**一条** `{op:'add', renameFrom}`（`configOp` 是单字段，连续两次写会互相覆盖）。
- **布局契约（4.2 迭代沉淀，别再退回「每行三到四行 + 常显表单」）**：
  - **按 `path` 分组**（`groupRows`，标题不是身份：同名工作区是不同目标，同名组头用路径消歧），`layoutModeOf` **无阈值**判定：所有工作区都只有 1 个环境 → **平铺网格**（`dbh-tiles`，`minmax(280px,1fr)` + 内容列 `max-width:960px` 自然封顶 3 列）；只要有任一工作区是多环境 → **分组折叠**（`dbh-group` + 可点击组头 `aria-expanded`）。判定必须是纯函数，改判定先改 `scripts/render-check.mjs` 的断言。
  - **每个连接只占一行**：`环境 chip（窄、淡） · 🔒 连接元数据 · source chip · [▶][✏][🗑] 图标按钮`。三条硬规则：
    ① 行内操作**只允许图标**（`primitives` 的 `IconPlayOutline16` / `IconEditOutline16` / `IconCloseOutline16` / `IconTrashOutline16`，无边框 24px，label 走 `title`/`aria-label`）——文字按钮一放上来就吃掉半行，这是被用户点名过的；
    ② `source` 句柄做成**可复制 chip**（`sourceChip`）：虚线边框 + 复制图标 + **短句柄**（`shortHandle`：≤14 字全显，否则保留"工作区哈希 + 环境段"两段），让人一眼看出"这是 id、点了复制"，而不是"复制整行连接串"；全文与用途进 tooltip（`ws.srcHint`），复制走 `primitives.writeClipboard`（自带 execCommand 兜底）；
    ③ 连接元数据用 `connLabelView` 拆成 `🔒 + 前缀(type://host:port/) + 库名`，**前缀可截断、库名绝不截断**（`dbh-conn-pre` 省略号 / `dbh-conn-db` 不收缩）——"窄行里看不到库名"是最常见的抱怨。
    行内只允许出现 `w.conn`，`srcId` 只是句柄、绝不回显 DSN。**「来源」（手填/扫描/复制/自动发现）不得做成行内徽章**——它几乎每行都一样、却是最抢眼的元素；改为环境名 chip 的 tooltip（`originTitle`），只有"自动发现且未持久化"这一例外在 tooltip 里显式点名。
  - **层级**：工作区分组是 level-1（边框卡片 + 极淡阴影），环境行是 level-2（缩进 + 左侧引导竖线，见 `dbh-groupbody{border-left}`）；两层绝不能长得像同一层。
  - **主题适配（红线）**：样式表**只允许 `--dsw-alias-*` token**，兜底值必须中性且半透明（`rgba(127,127,127,.3)`、`transparent`），**禁止任何不透明色字面量**（`#ffffff`/`#f6f8fa`/`#1f2328`/品牌色…）——用户会装主题/皮肤插件（本机就有 skin-center，且背景可能是半透明的），写死白底或固定浅灰字会直接看不清；`test/client-format.test.mjs` 有"tokens only"断言门禁。对比度：正文及以上用 `label-primary`/`label-secondary`，`label-dimmed` 只留给极次要说明。
  - **默认展开**：单个工作区自动展开；多工作区时展开「最近活跃工作区」（由 `settings.section` 标准 prop `useWorkspaces` 的 `WorkspaceSnapshot.updatedAt` 推出——设置面板是全局的，拿不到"当前会话"选中态，别去猜）；取不到快照就全折叠。另有「全部展开/折叠」总控。展开态、添加面板、设置条存在模块级 `uiMemory`（同一页面会话内跨重挂载保留，**不持久化**——这是视图状态，不是配置）。
  - **顶部只留一行**：状态徽章 + 工具数 + 设置条摘要 + `[⚙ 设置]` + `[启用/禁用]`；自动更新间隔与侧边栏开关收进默认收起的设置条。**添加连接默认收起**：「＋ 添加连接」（全局，工作区用 `<datalist id="dbh-ws-list">` 给已有工作区）/ 分组头「＋ 环境」（工作区自动带入，少一个字段）；保存仍走原有「试连 → 失败才确认」门禁。
  - 布局/交互改动的验收 = `npm run check:ui`（离屏渲染 + 点击交互，涵盖模式判定、默认展开、全部展开/折叠、添加面板、复制按钮、中英 i18n 覆盖率）全绿 + `node test/client-format.test.mjs`。
  - **复制必须给出干净字符串**：连接串被拆成两个 flex item 渲染后，浏览器自己的复制序列化会在块级子元素之间插分隔符（粘进 DSN 输入框就成了 `…3306/ app`，测试直接失败）。因此 `connLabelView` 的元素自己接管 `onCopy`（`e.clipboardData.setData('text/plain', w.conn)` 并 `preventDefault()`）——挂在**连接串元素**而不是整行上，复制环境名不受影响；`w.conn` 本身是元数据，不涉及凭据。回归门：`npm run check:ui` 第 17 组。
  - **等待态不给二次提交**：预检进行中（`pendingPretest`）保存/添加按钮 `disabled`，避免重复派发同一个测试。真实的连接探测本来就要几秒（要 spawn dbhub），但**写入结果必须立刻可见**——这靠宿主侧的即时回推（见「工作区连接管理」条的 `publishFast`），不要改回"等整轮扫描"。
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
  && node test/client-format.test.mjs && node test/zero-knowledge.test.mjs
```

### 脱敏门禁（`npm run check:secrets`）

真实主机/账号/密码/库名/项目名只允许存在于两处：`$DSH_HOME/storages/dsh-dbhub-live/credentials.json`（仓库外）与本地 `.env`（`.gitignore` 排除、`package.json` 的 `files` 不含，永不进 git 历史/公开仓库/npm 包）。仓库内一切内容都视为会公开分发。

门禁由 `scripts/desensitize-check.mjs` 执行，规则与槽位来自 `scripts/desensitize.config.mjs`：

1. **槽位规则（主力，高精度）**：槽位表登记"真实值可能出现的出口"（宿主文案、浏览器文案、连接构造代码、扫描器、测试夹具、文档示例、包元数据、本提示词、维护脚本），每个槽位声明它需要的规则（`password`/`dsn`/`host`/`name`）。**槽位 glob 必须匹配到文件，否则门禁报 `slot-stale`**——槽位表不会随目录移动悄悄失效。
2. **通用兜底（覆盖未登记的新出口）**：`ip`（只允许回环、`0.0.0.0` 与 RFC 5737 文档段 `192.0.2.x`/`198.51.100.x`/`203.0.113.x`）、`secret`（GitHub/npm/OpenAI/Slack/AWS/JWT/PEM 等真凭据格式）、`entropy`（大小写/数字混排的高熵串）、`host`（`.local`/`.internal`/`.corp` 等内网后缀）、`name`（本地 denylist）。
3. **本地 denylist（补充）**：pattern 抓不到的**裸名字**（项目/公司/库名）放在 `.env` 的 `DSH_DBHUB_DESENSITIZE_RE`（`|` 分隔、正则转义、多条取并集）。CI 里没有 `.env`，该层自动降级为提示，不影响其余两层。

**约定（新增内容一律照此写）**：示例主机用 `127.0.0.1`/`localhost`/RFC 5737 段；示例密码用 `CHANGE_ME`；测试夹具可用短占位（`u:p`、`root:secret`），但主机仍须回环/保留段；误报走行内标记 `desensitize:allow`（仅限确认无害的行）。

**义务（硬规则）**：新增功能若引入新的示例、默认值、文案串或夹具 → **同一次改动里更新 `scripts/desensitize.config.mjs` 的槽位表**；提交前跑 `npm run check:secrets`，命中就改成占位符/规范值再提交 git 与 npm。执行点：本地手动 + `prepublishOnly`（挡住带真实值的包）+ CI（`.github/workflows/quality.yml`，别人的提交也拦得住）。历史事故：这些值曾随 npm 包与公开仓库分发，公开即视为泄露、无法追回。

零知识自检（模型可见面不得含密码）：`node test/zero-knowledge.test.mjs` 全绿 + 上面 `npm run check:secrets` 零匹配。

发布前：按「调试方法」第 3 步在隔离实例完整冷启动一遍，确认 Host 无报错、`/api/dsh-dbhub-live/state` 带会话 cookie 返回 200（不带 cookie 返回 401）、`/plugins/??<包名>/client.js&rev=…` 可访问。

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