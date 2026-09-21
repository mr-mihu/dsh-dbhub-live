# AGENTS.md — dsh-dbhub-live 开发与调试说明

> 本文件面向在本仓库上继续开发/调试本插件的 AI 与人。业务需求见 [doc/REQUIREMENTS.md](doc/REQUIREMENTS.md)，用户安装使用见 [README.md](README.md)。

## 一句话定位

DSH host 插件（Node ESM）+ Web client 插件（浏览器半）：把 dbhub（Bytebase 的数据库 MCP 服务器）接入 DSH。**零知识凭据管理 + 一次性进程执行**——DSN/密码只存在于宿主侧，模型只见 source 句柄与元数据（类型/主机/端口/库）；每次工具调用 spawn 一条独立 `dbhub --dsn` 进程跑完即杀，无常驻服务。附配置页（设置 → DBHub 数据库工具 / 侧边栏快捷入口（可关）/ 插件页该行的「配置」）：实时状态 + 连接管理（启用禁用、增删改查、环境改名、连接测试）。

## 目录结构

```
lib/
  index.mjs    入口：name/inject/apply、状态命名空间(schemastery)接线、后台启动(仅登记+更新检查)、配置变更应用
  config.mjs   路径/原子持久化(store,runtime)/DSN 解析/工作区发现/零知识助手(describeConn,connLabel,scrubSecrets)/小工具
  state.mjs    运行时状态机：enabled/phase/toolCount/lastError/mode + 订阅发布（无服务器生命周期）
  options.mjs  可配置参数：updateIntervalDays（设置UI > 环境默认；dbhubPackage 仅内部环境knob）
  runtime.mjs  dbhub 可执行文件发现、按需自动安装、定期自动更新（已删除孤儿进程清理）
  mcp.mjs      MCP JSON-RPC 客户端 + 工具注册表 + 工作区×环境来源发现（collectSources/resolveSource）+ 摘要缓存
  adhoc.mjs    唯一执行引擎：每次调用一条一次性 dbhub 进程（零知识标签 + stderr 清洗）
  collect.mjs  授权扫描项目配置文件并提取 DSN 候选（含 askUser 桥接）
  tools.mjs    host 自有工具定义与注册：恒定 4 个（configure/list_sources/execute_sql/search_objects）；configure 探连优先（见零知识契约 5）
  client.js    Web 半（手写 lazy-CJS bundle）：配置页 = `settings.section` 一级设置页 + 可选侧边栏面板（`showSidebarEntry` 开关）+ `plugins.row.config`（summary/page 两视图）
test/          node:test 单元测试（纯逻辑 + client bundle 格式契约 + 零知识泄漏门）
doc/           需求文档
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
- **状态命名空间**：Host 注册 `dsh-dbhub-live` 命名空间（`ctx.inject(['settings'], …)` + schema）；Web 端有三个入口指向同一个页面：**`settings.section`（id `dbhub`，主入口，settings 面板是核心 shell）**、**可选侧边栏面板**（`sidebar.panellist` + `main`，受 `showSidebarEntry` 控制）、**`plugins.row.config`**（键 `<包名>#<行 id>` = `dsh-dbhub-live#dbhub-live`，owner props 为 `view: 'summary' | 'page'`，该 slot 只在官方插件页的浏览器半区活跃时存在）。**dsh 0.1.6 已删除旧的 `settings.plugin.item` 槽位**：注册到不存在的 slot 会被静默忽略（不报错、界面什么都不显示）——升级 dsh 后「配置页消失」就是这个原因，不要再改回去。命名空间值 = 状态 `{enabled, phase(running|disabled), toolCount(恒定4), lastError, mode('oneshot')}` + 配置 `{updateIntervalDays, showSidebarEntry}` + `{workspaces(JSON 元数据摘要：title/path/env/conn(主机端口库)/source/persisted/srcId)}` + `{configOp}`（主机消费后自动清空）+ `{testResult}`（连接测试的一次性回执，仅内存态、不落任何持久化）。**注入回调是独立作用域：内部需要的服务（如 `subprocess`）必须用 `ctx.get('subprocess')` 就地获取，绝不能引用 `apply()` 的局部变量——否则 ReferenceError 会静默杀死整条发布/配置链路（配置页只剩静态值、工作区连接不刷新）**。回调整体套 `wrap()` 防护，异常必须打日志。
- **可配置参数**：`options.mjs` 只此一处持有部署开关：`updateIntervalDays`（设置 UI > 环境变量种子 > 内置默认；`dbhubPackage` 仅环境变量/内部，不进设置）、`showSidebarEntry`（布尔，默认 `true`，设置页开关即时生效）。**已删除 `idleMinutes`**（无常驻进程可回收）。不要绕过 `applyPatch` 直接改 `options` 内部值。
- **工作区连接管理（configOp 通道）**：store v2 = `{ [wsPath]: { environments: { [env]: {dsn, source, updatedAt} } } }`（v1 单 dsn 条目自动迁移进 `environments.default`）。环境名一律过 `normalizeEnvName`（trim、去控制字符、限长、空值收敛为 `default`），因此**中文环境名是一等公民**。配置页只读**元数据**摘要（`collectSources` → `latestSummaries`，密码/用户名永不出 Host）；增/改/删/改名通过命名空间 `configOp` 单向命令下发，`index.mjs` 用 `setWorkspaceEnv`/`removeWorkspaceEnv`/`renameWorkspaceEnv` 落盘后重扫摘要并发布（configOp 随发布清空，天然防环）。`add`/`set` 可带 `renameFrom` 做「改名 + 改连接」的**单条原子命令**（`configOp` 是单字段，拆两次写会互相覆盖）；纯改名走 `{op:'rename', workspace, env, newEnv}`。自动发现（mise/.env）只提供未覆盖的 `default`，不持久化。**连接测试（`{op:'test', workspace, env, nonce}`）**：`handleTestOp` 用摘要背后的真实 DSN 调 `adhoc.probeConnection`（一次性 dbhub + `SELECT 1`，Host 侧 30s 超时兜底），结果经 `testResult` 镜像字段回推 `{nonce, ok, message}`；测试失败只是行内一次性提示，不得写入 store/lastError/phase。配置页只认自己派发过的 nonce，展示 ~10s 自动消退，刷新即失，天然不保留状态。
- **工具声明数量恒定（上下文预算红线）**：恒定 4 个（configure / list_sources / execute_sql / search_objects），**绝不为每个工作区 × 环境注册独有工具**；`dbhub_execute_sql(source,…)` / `dbhub_search_objects(source,…)` 调用时 `resolveSource` 按 source 值解析到真实连接。曾实现过的 per-source 注册与 `dbhub_query` 临时连接工具已移除，勿回恢复。
- **工作区语义（模型契约，勿退化）**：**每条 source 只属于一个工作区**，跨工作区的「看起来一样」的连接是不同目标。`sourceIdOf(row)` 是 source 值的**唯一**构造点（`<标题slug>_<工作区路径哈希>[_<环境slug>]`），列表输出、解析器、各工具回执必须都调它，否则模型会拿到解析不回去的句柄。`envSlug`：`default` 保持裸值、纯 ASCII 名保持原 slug（`test`→`test`，既有 source 值不变）、含非 ASCII 的名（`线上`）取 `env-<shortHash>`——**旧实现对每个纯中文名都返回同一个 slug**，`线上` 与 `测试` 曾共用 source 值并被静默查错库；这是回归红线。`resolveSource(ctx, sub, ref, {preferredWsPath})` 精确优先，其次按**当前会话工作区**（`currentWorkspace(ctx, exec)`：会话 cwd 精确匹配 → 最长包含路径）筛选，仍有多条则返回 `{ambiguous:[…]}`，由 `result.ambiguousSource` 让模型用完整 source 值澄清——**绝不按列表顺序猜**。`dbhub_configure` 的工作区解析也**不再回退到 `workspaces[0]`**（那是「把连接配到别人工作区」的隐患）：显式 workspace 必须匹配，否则 `result.unknownWorkspace` 列出可用工作区；未给 workspace 时用当前工作区，解析不出来则 `result.needWorkspace`。跨工作区复用连接一律走 `copyFrom`（宿主侧复制 DSN，零知识不破）而不是直接用别人的 source。`dbhub_list_sources` 按工作区分组并标出【当前工作区】（`result.wsCurrentHead`/`wsOtherHead`/`wsGroup`）。
- **schema 弹性依赖**：优先用真实 `@deepseek-ai/schemastery` schema（`await import`）；解析失败时降级为 `lib/index.mjs` 内建的最小 callable schema（`schema(v)` 合默认值 + `toJSON()`），保证**链路安装（`dsh plugin add <本地目录>`，Node ESM 按源码真实路径解析裸导入）下插件照样启动、卡片照常工作**。tarball/npm 安装（真实目录在 profile node_modules 下）走真实 schemastery 路径。不要把这个 import 改回静态顶层 import——会重新引入链路安装时启动失败。
- **执行时机**：`apply()` 只注册核心工具 + 后台 bookkeeping（`startBackgroundBoot`：置 phase running、刷新工具数、非阻塞检查 dbhub 自动更新）；真正的 dbhub 解析（persisted → mise → PATH → 自动安装）发生在**每次调用**（`resolveDbhubExe` 有 runtime.json 缓存，首次或缺二进制时才安装）。**无工作区数据源时一切照常**——工具正常注册，list_sources 返回空、execute 返回 noSource，不会拉起任何进程。
- **启用/禁用**：`state.setEnabled` 持久化到 `credentials.json`（权威值）；禁用时所有工具 execute 首行返回「插件已禁用」（无进程可停，无需清理）；重新启用即恢复。

## 存储与容错（初始化即处理）

- **实例隔离**：所有持久化都在 `$DSH_HOME/storages/dsh-dbhub-live/`（`credentials.json` 凭据+enabled、`runtime.json`、`dbhub-runtime/` 自动安装前缀）。隔离粒度 = `DSH_HOME`（同一 home 的多个 profile 共享，与 dsh 自身 workspace.json 约定一致）；执行进程、状态机、工具注册天然按进程隔离。**进程环境变量不参与连接解析**。不再有 dbhub.toml；同 home 并发多实例的残余共享只余 `credentials.json`（用户驱动低频写），写出已原子化（见下）。
- **原子写**：`writeJsonFile` 一律 tmp+rename（同目录写临时文件再改名覆盖），并发读者永不见半个文件、并发写者末写覆盖不交错；目录被删时先 `mkdirSync` 重建。写入失败**不抛致命**，`warnOnce` 一次性告警并继续内存态运行（`saveStore`/`saveRuntime` 返回 false）。
- **升级/手改遗留兼容**：`loadStore`/`loadRuntime` 先用纯函数 `normalizeStore`/`normalizeRuntime` 清洗：丢弃非布尔 `enabled`、非对象/空 dsn 条目、非法 `dbhubExe`/`dbhubInstallAt`；`dsn` 统一 trim；v1 单 dsn 条目自动迁移为 `environments.default`；**未知字段保留**（向前兼容）。清洗结果与原文不同时**一次性回写迁移**。
- **空值安全**：解析器对缺失/空值全部有兜底（`resolveWorkspaceEnvs` 判空、`describeConn` 对不可解析 DSN 兜底、状态 schema 默认值、settings 镜像的 `enabled` 只认布尔），清洗后不存在半吊子条目。

## 调试方法（不影响正在运行的 Harness）

DSH 启动是 fail-loud：任一插件激活失败整树拒绝启动、GUI 打不开。因此**永远不要在配置/源码上直接动主实例**，按下面阶梯来：

1. **静态校验（30 秒，零风险）** — `npm run check`（node --check 全部 lib）→ 逐个跑单测（沙箱下 `node --test` 的 runner 子进程会被 EPERM 挡，按本文件惯例**逐个文件**跑：`node test/x.test.mjs`）。单测会自己建临时 `DSH_HOME`，不会碰真实 store。
2. **会话内跑通逻辑（不重启）** — 用动态插件工具连（`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine`）：把要验证的纯逻辑（如 configure 流程、scrubSecrets）以无 import 的 Host 代码贴进动态包，在会话里跑，`cordis_stop` 即清场。动态包只活在进程内存 + 当前会话，改动/出错都不影响主进程。动态 Host 代码不能用 `import`，带 `@deepseek-ai/schemastery` import 的 `lib/index.mjs` 不能整文件贴进动态包；只对纯逻辑做动态验证。
3. **冷启动验证（隔离实例）** — 用独立 `DSH_HOME` 起测试实例。本机备有独立测试 home：`deepseek-harness/mise.toml` 已把 `DSH_HOME` 指向 `D:/my/app/dsh/plugin/.dsh-a`，所以在该目录下用 `mise r dsh …` 启动的实例**与主进程（`%USERPROFILE%\.dsh`，3080）完全隔离**：
   ```powershell
   cd D:\my\app\dsh\plugin\deepseek-harness          # mise.toml 在此，DSH_HOME 已指向 .dsh-a
   mise r dsh web --port 3082 --no-open               # 首次自动初始化 web 模板
   mise r dsh plugin --profile web add D:/path/to/<pkg>.tgz   # 用 pnpm pack 产物；同版本会被跳过，必须先升版本号
   mise r dsh plugin --profile web ls                 # 核对 node_modules/<pkg>/package.json 版本确已替换
   mise r dsh web --port 3082 --no-open
   # 验证：日志出现 [dsh-dbhub-live] 加载 + 「设置页入口已注册: settings.section id=dbhub」「插件页配置入口已注册: plugins.row.config …」；
   #      GET /plugins/dsh-dbhub-live/client.js 返回 bundle；http://127.0.0.1:3082 侧边栏出现「DBHub 数据库工具」、设置里出现同名一级页面
   ```
4. **在位热更新（有失败保护，谨慎）** — 主实例的 `cordis.patch.yml` 支持 HMR，读取/解析失败时保留最后一个可用树，GUI 不会挂。但 HMR 不监听插件源码，只适合挂载/卸载验证，代码迭代请用 1/2/3。
5. **安全网** — `$DSH_SNAPSHOT=replay` 可从 `cordis.snapshot.yml` 启动回放点；改动主 profile 前先备份 `cordis.patch.yml`。

## 修改 client 半（lib/client.js）

`lib/client.js` 是**手写 lazy-CJS bundle**，DSH client 模块系统按 `dsh.client` 声明 + `exports["./client"]` 直接服务它，**没有构建步骤**。遵守以下契约（改完跑 `node test/client-format.test.mjs` 守护）：

- 必须以 `window.__ModuleLoader__.load({ id: "dsh-dbhub-live", factory: (require) => { … } })` 注册；
- `id` 必须等于 Loader entry 名（`dsh-dbhub-live`，见 cordis.patch.yml 的 `name`），不是行 id；
- factory 只允许 `require("react")` 等 baseline 模块；不 import 其他插件的值（bundle-purity）；
- 导出 `name/inject/apply`，结尾 `return module.exports`；
- 注册的 slot 必须是 `plugins.row.config`（key = `dsh-dbhub-live#dbhub-live`；见「状态命名空间」条），组件同时服务 `props.view === 'summary'`（一行摘要）与 `'page'`（完整表单，页面自己画标题/图标/面包屑）；**另外必须注册 `settings.section`（id `dbhub`，order 40）作为主入口**——设置面板是核心 shell，任何部署都在，用户也在那里找连接管理；`plugins.row.config` 只在官方插件页的浏览器半区活跃时存在，不能作为唯一入口。侧边栏快捷入口（`sidebar.panellist` id `dbhub` + `main` key `dbhub`，组件 `PanelIcon`/`ConfigPanel`）**由 `showSidebarEntry` 选项控制**：`syncSidebar()` 在 `host.subscribe` 上按镜像值即时 register/dispose，关闭它不得影响设置页与插件页入口（避免自锁）；
- 组件不得接触 `ctx`，数据/回调一律通过注册时的 `inject: () => face` 传入 props；用内联样式，不依赖 CSS 文件；
- 配置页渲染的 `workspaces` 行只显示 `w.conn`（元数据标签），**不得显示/回显 DSN**；改名走 `configOp({op:'rename'})`，改名+改连接走**一条** `{op:'add', renameFrom}`（`configOp` 是单字段，连续两次写会互相覆盖）。
- 若本包脱离仓库（发布 npm），`dsh.client` 与 `exports["./client"]` 必须保留，否则 client-modules 扫描会启动报错。

## 质量门

```bash
npm run check   # 全部 lib 语法
# 单测：沙箱内逐个文件跑（node --test 的 runner 子进程在沙箱下 EPERM）
node test/util.test.mjs && node test/state.test.mjs && node test/options.test.mjs \
  && node test/init.test.mjs && node test/i18n.test.mjs \
  && node test/resolve-source.test.mjs && node test/resolve-workspace.test.mjs \
  && node test/client-format.test.mjs && node test/zero-knowledge.test.mjs
```

脱敏自检（**每次提交/发布前必须零匹配**；黑名单按需追加新发现的真实值）：

```bash
git grep -inE '10\.253\.|192\.168\.77|tx_zdsf|tx_sd_jineng|db_zdsf|hbtx|1hn7yaw|9sqpcz|唐讯|广告宝|110\.120\.66' -- ':!node_modules' ':!AGENTS.md'
```

零知识自检（模型可见面不得含密码）：`node test/zero-knowledge.test.mjs` 全绿 + 上面 git grep 零匹配。

发布前：按「调试方法」第 3 步在隔离实例完整冷启动一遍，确认 Host 无报错、`/plugins/dsh-dbhub-live/client.js` 可访问。

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
- **脱敏红线（提交/发布前强制自检）**：仓库任何文件——**包括 `test/`（会打进 npm tarball）与工具描述文案**——不得出现真实内网 IP、真实库名、真实密码、公司/项目标识。示例 DSN 一律用 `127.0.0.1` 或文档保留段（`192.0.2.x` / `198.51.100.x` / `203.0.113.x`），且**密码位只用占位词**（`user:pass@`、`u:p@`、`username:password@`、`账号:密码@`）。历史事故：工具描述里的示例 DSN 与测试用例里的「真实值」曾随 npm 包与公开仓库历史分发——公开即视为泄露、无法追回。每次提交前跑「质量门」中的脱敏自检；发现新的真实值，清洗后将其加入黑名单。
- `state.*` 之外不要直接改持久化。
- 增加行为时同步更新本文件、README（用户侧）与 doc/REQUIREMENTS.md（业务侧）。
- README 双语同步：`README.md`（中文）为唯一真源，`README.en.md` 由 AI 从最新中文派生——改动任一侧必须同次更新另一侧，章节结构一一对应。