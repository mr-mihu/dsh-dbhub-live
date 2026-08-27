# AGENTS.md — dsh-dbhub-live 开发与调试说明

> 本文件面向在本仓库上继续开发/调试本插件的 AI 与人。业务需求见 [doc/REQUIREMENTS.md](doc/REQUIREMENTS.md)，用户安装使用见 [README.md](README.md)。

## 一句话定位

DSH host 插件（Node/E SM）+ Web client 插件（浏览器半）：把 dbhub（Bytebase 的数据库 MCP 服务器）接入 DSH，提供按工作区的常驻连接工具、临时连接工具，外加设置在「设置 → 插件」里的实时状态卡片与启用/禁用开关。

## 目录结构

```
lib/
  index.mjs    入口：name/inject/apply、状态命名空间(schemastery)接线、懒加载编排、配置变更应用
  config.mjs   路径/持久化(store,runtime)/DSN 解析/工作区发现/store v2（environments）助手/小工具
  state.mjs    运行时状态机：enabled/phase/toolCount/lastError/mode + 订阅发布
  options.mjs  可配置参数：updateIntervalDays/idleMinutes（设置UI > 环境默认；dbhubPackage 仅内部环境knob）
  runtime.mjs  dbhub 可执行文件发现、按需自动安装、定期自动更新、孤儿进程清理
  mcp.mjs      MCP JSON-RPC 客户端 + 常驻多源 dbhub 服务生命周期 + collectSources(工作区×环境) + 摘要缓存
  adhoc.mjs    临时连接（每次调用一条一次性 dbhub 进程）
  collect.mjs  授权扫描项目配置文件并提取 DSN 候选（含 askUser 桥接）
  tools.mjs    host 自有工具定义与注册（dbhub_configure 支持 env 参数）
  client.js    Web 半（手写 lazy-CJS bundle）：折叠分区卡片（状态/配置/工作区连接）
test/          node:test 单元测试（纯逻辑 + client bundle 格式契约）
doc/           需求文档
cordis.patch.yml   bundle patch：`name: dsh-dbhub-live` 挂载本包
```

## 关键架构事实

- **模块依赖只进不出**：`config ← state ← runtime ← mcp ← tools ← index`，`adhoc ← mcp`，`collect ← tools`；禁止反向 or 循环 import（HMR/装载顺序依赖它）。
- **状态命名空间**：Host 注册 `dsh-dbhub-live` 命名空间（`ctx.inject(['settings'], …)` + schema）；Web 端 Plugins 选项卡按命名空间分发 `settings.plugin.item` 卡片。命名空间值 = 状态 `{enabled, phase, toolCount, lastError, mode}` + 配置 `{updateIntervalDays, idleMinutes}` + `{serverUp}` + `{workspaces(JSON 掩码摘要)}` + `{configOp}`（主机消费后自动清空）。
- **可配置参数**：`options.mjs` 只此一处持有部署开关（`dbhubPackage` 仅环境变量/内部，不进设置）；watch 把卡片写入的字段经 `options.applyPatch` 应用到运行时。**优先级：用户设置 > 进程环境变量 > 内置默认**。不要绕过 `applyPatch` 直接改 `options` 内部值。
- **工作区连接管理（configOp 通道）**：store v2 = `{ [wsPath]: { environments: { [env]: {dsn, source, updatedAt} } } }`（v1 单 dsn 条目自动迁移进 `environments.default`）。卡片只读**掩码**摘要（`collectSources` → `latestSummaries`，密码永不出 Host）；增/改/删通过命名空间 `configOp` 单向命令下发，`index.mjs` 用 `setWorkspaceEnv`/`removeWorkspaceEnv` 落盘后重扫摘要并发布（configOp 随发布清空，天然防环）。同一工作区多环境：`default` 源 id 保持 `标题_hash` 兼容名，其余环境 `标题_hash_<envSlug>`，工具名随之区分。自动发现（mise/.env）只提供未覆盖的 `default`，不持久化。
- **schema 弹性依赖**：优先用真实 `@deepseek-ai/schemastery` schema（`await import`）；解析失败时降级为 `lib/index.mjs` 内建的最小 callable schema（`schema(v)` 合默认值 + `toJSON()`），保证**链路安装（`dsh plugin add <本地目录>`，Node ESM 按源码真实路径解析裸导入）下插件照样启动、卡片照常工作**。tarball/npm 安装（真实目录在 profile node_modules 下）走真实 schemastery 路径。不要把这个 import 改回静态顶层 import——会重新引入链路安装时启动失败。
- **懒加载**：`apply()` 只注册核心工具 + 后台异步初始化（`startLazyInit`）；任何工具调用先 `ensureRunning`（共享 `server.starting`，并发调用自动排队等待）；启动失败进入 `phase:'error'` 并记录 `lastError`，下次调用自动重试。**无工作区数据源时恒不拉起 dbhub 进程**（空 `[[sources]]` toml 对 dbhub 是致命的；空指纹若被当成“已同步”会在二次调用时绕过 toml 直接 spawn——`ensureRunning` 的 `sources.length === 0` 早退必须在指纹判断之外）。
- **启用/禁用**：`state.setEnabled` 持久化到 `credentials.json`（权威值）；禁用时立即 `terminateServer()` 释放进程，所有工具 execute 首行返回「插件已禁用」；重新启用触发懒加载初始化。
- **密码脱敏**：`maskDsn` 是唯一出口——工具描述、结果前缀、扫描候选一律走它。

## 存储与容错（初始化即处理）

- **实例隔离**：所有持久化都在 `$DSH_HOME/storages/dsh-dbhub-live/`（`credentials.json` 凭据+enabled、`runtime.json`、`dbhub.toml`、`dbhub-runtime/` 自动安装前缀）。隔离粒度 = `DSH_HOME`（同一 home 的多个 profile 共享，与 dsh 自身 workspace.json 约定一致）；dbhub 进程、状态机、工具注册天然按进程隔离。**进程环境变量不参与连接解析**。
- **升级/手改遗留兼容**：`loadStore`/`loadRuntime` 先用纯函数 `normalizeStore`/`normalizeRuntime` 清洗：丢弃非布尔 `enabled`、非对象/空 dsn 条目、非法 `dbhubExe`/`dbhubInstallAt`；`dsn` 统一 trim；v1 单 dsn 条目自动迁移为 `environments.default`；**未知字段保留**（向前兼容）。清洗结果与原文不同时**一次性回写迁移**，之后每次启动都是规范化文件。
- **空值安全**：解析器对缺失/空值全部有兜底（`resolveWorkspaceEnvs` 判空、`maskDsn` 对不可解析 DSN 正则兜底、状态 schema 默认值、settings 镜像的 `enabled` 只认布尔），清洗后不存在半吊子条目。
- **运行目录被删 / 写入被拦截**：每次 JSON/toml 写入前自动 `mkdirSync` 重建目录；写入失败**不抛致命**，`warnOnce` 一次性告警并继续内存态运行（凭据持久化失效但工具可用）；`dbhub.toml` 写入失败按**初始化错误**记录（状态卡片 🔴 + `lastError`）并下次调用自动重试；npm 自动安装前同样重建目录。注意：以上全是 best-effort，被拦截时重启会丢「仅内存态」的修改，属预期。

## 调试方法（不影响正在运行的 Harness）

DSH 启动是 fail-loud：任一插件激活失败整树拒绝启动、GUI 打不开。因此**永远不要在配置/源码上直接动主实例**，按下面阶梯来：

1. **静态校验（30 秒，零风险）** — `npm run check`（node --check 全部 lib）→ `npm test`（node:test 单测）。单测会自己建临时 `DSH_HOME`，不会碰真实 store。
2. **会话内跑通逻辑（不重启）** — 用动态插件工具连（`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine`）：把要验证的纯逻辑（如 configure 流程、状态机）以无 import 的 Host 代码贴进动态包，在会话里跑，`cordis_stop` 即清场。动态包只活在进程内存 + 当前会话，改动/出错都不影响主进程。
   - 注意：动态 Host 代码不能用 `import`，所以带 `@deepseek-ai/schemastery` / `dsh-settings` import 的 `lib/index.mjs` 不能整文件贴进动态包；只对纯逻辑做动态验证。
3. **冷启动验证（隔离实例）** — 用独立 `DSH_HOME` 起测试实例：
   ```powershell
   $env:DSH_HOME = "D:\path\.dsh-test"        # 放工作区内即可免越权
   dsh web --port 3081 --no-open              # 首次自动初始化 web 模板
   dsh plugin --profile web add D:/path/to/dsh-dbhub-live
   dsh web --port 3081 --no-open
   # 验证：日志出现 [dsh-dbhub-live] 初始化/服务已加载；GET /plugins/dsh-dbhub-live/client.js 返回 bundle
   ```
4. **在位热更新（有失败保护，谨慎）** — 主实例的 `cordis.patch.yml` 支持 HMR，读取/解析失败时保留最后一个可用树，GUI 不会挂。但 HMR 不监听插件源码，只适合挂载/卸载验证，代码迭代请用 1/2/3。
5. **安全网** — `$DSH_SNAPSHOT=replay` 可从 `cordis.snapshot.yml` 启动回放点；改动主 profile 前先备份 `cordis.patch.yml`。

## 修改 client 半（lib/client.js）

`lib/client.js` 是**手写 lazy-CJS bundle**，DSH client 模块系统按 `dsh.client` 声明 + `exports["./client"]` 直接服务它，**没有构建步骤**。遵守以下契约（改完跑 `node test/client-format.test.mjs` 守护）：

- 必须以 `window.__ModuleLoader__.load({ id: "dsh-dbhub-live", factory: (require) => { … } })` 注册；
- `id` 必须等于 Loader entry 名（`dsh-dbhub-live`，见 cordis.patch.yml 的 `name`），不是行 id；
- factory 只允许 `require("react")` 等 baseline 模块；不 import 其他插件的值（bundle-purity）；
- 导出 `name/inject/apply`，结尾 `return module.exports`；
- 组件不得接触 `ctx`，数据/回调一律通过注册时的 `inject: () => face` 传入 props；用内联样式，不依赖 CSS 文件。
- 若本包脱离仓库（发布 npm），`dsh.client` 与 `exports["./client"]` 必须保留，否则 client-modules 扫描会启动报错。

## 质量门

```bash
npm run check   # 全部 lib 语法
npm test        # 单元测试（node:test；沙箱内请逐个文件跑：node test/x.test.mjs）
```

发布前：按「调试方法」第 3 步在隔离实例完整冷启动一遍，确认 Host 无报错、`/plugins/dsh-dbhub-live/client.js` 可访问。

## 约定

- 产品文案中文、代码注释英文；密码脱敏不可绕过；扫描必须经 `askUser` 授权。
- `state.*` 之外不要直接改 `store`/`runtime` 之外的持久化。
- 增加行为时同步更新本文件、README（用户侧）与 doc/REQUIREMENTS.md（业务侧）。