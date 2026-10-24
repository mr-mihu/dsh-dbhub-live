# AGENTS.md — dsh-dbhub-live

> 本仓库的 AI/维护者入口：**这里只记结论**（规则、常量、命令、门禁）。原因与踩坑过程见 [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md)，操作步骤见 [doc/DEVELOPMENT.md](doc/DEVELOPMENT.md)（调试）/ [doc/CLIENT.md](doc/CLIENT.md)（客户端半）/ [doc/RELEASE.md](doc/RELEASE.md)（发布）/ [doc/DESENSITIZE.md](doc/DESENSITIZE.md)（脱敏），改动前要核查的联动清单见 [doc/IMPACT-MATRIX.md](doc/IMPACT-MATRIX.md)。业务需求 [doc/REQUIREMENTS.md](doc/REQUIREMENTS.md)，用户文档 [README.md](README.md)。

## 定位

DSH host 插件（Node ESM）+ Web client 插件：把 dbhub（Bytebase 的数据库 MCP 服务器）接入 DSH。两个性质：**零知识**（DSN/密码只在宿主侧，模型只见 source 句柄与元数据）+ **一次性进程**（每次调用 spawn 一条 dbhub，跑完即杀）。附配置页（设置 → DBHub 数据库工具 / 侧边栏 / 插件页「配置」）：连接管理、连接测试、SSH 层独立测试、环境级只读、SSH 隧道、版本与更新检查；5.2 起三套布局（弹窗 / 宽屏 / 小屏）。

## 仓库结构

```
lib/          host + 客户端实现（模块地图见 ARCHITECTURE）| test/ 单测 | scripts/ 门禁脚本
release-test/ 版本矩阵实测 | doc/ 文档 | .github/ CI | cordis.patch.yml bundle patch | .env 本地脱敏黑名单
```

模块一览、各文件职责在 [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md#模块地图)。

## 红线（结论）

### 零知识
- 工具参数**不得有 `dsn`**；`dbhub_configure` 收到 `args.dsn` 直接拒绝（`result.noDsnViaModel`）。
- 模型可见文本（结果/列表/标签/错误/stderr/诊断）一律过 `connLabel` 或 `scrubSecrets`；清洗要折叠任意 URL 连接串的整个 userinfo → [原因](doc/ARCHITECTURE.md#零知识边界)。
- 密码与完整 DSN 只经界面：`askUser`（configure）/ `configOp`（配置页）。门禁 `test/zero-knowledge.test.mjs`。

### 一次性进程
- `resolveSource` 解 DSN → `runAdhoc` 起一条 `dbhub --transport stdio`，跑完 terminate。**无常驻服务**（无指纹 / mtime / 空闲回收 / respawn / 孤儿清理 / 配置重启）→ [原因](doc/ARCHITECTURE.md#一次性进程的理由)。
- 工具恒 4 个：configure / list_sources / execute_sql / search_objects；不为工作区×环境注册工具。
- `apply()` 只注册工具 + `startBackgroundBoot` bookkeeping；dbhub 解析发生在每次调用（`runtime.json` 缓存）；无数据源照常启动。

### 执行路径
- `ro === true || ssh != null` → 临时 `--config`；其余走 `--dsn`。
- TOML 里秘密只写 `${DSH_DBHUB_SEC_*}` 占位符，真值走子进程 env；**引用集合 == env 键集合**（`test/toml.test.mjs`）。
- `[[tools]]` 是白名单：只读必须写**两条** → [原因](doc/ARCHITECTURE.md#一次性toml的由来)。
- 版本门槛：1.4.0 起实测；`< 1.0.0` 拒绝（`result.dbhubTooOld`）；不生成未实测写法。
- 临时文件在 `$DSH_HOME/storages/dsh-dbhub-live/tmp/`：`finally` 尽力删 + boot 时 `sweepTempToml()`。

### 环境选项（只读 / SSH）
- store：`credentials.json` 顶层 `{ [wsPath]: { environments: { [env]: { dsn, source, updatedAt, readOnly?, ssh? } } } }`；`ssh = {host,port,user,auth,keyPath?,passphrase?,password?,proxyJump?}`。
- `setWorkspaceEnv(..., opts?)`：opts 缺省**保留** readOnly/ssh；`{readOnly:false}` / `{ssh:null}` 才是删除。`setWorkspaceEnvOptions` 只改选项不碰 DSN。
- 模型传 `readOnly:true` 允许、`false` 拒绝（`result.readOnlyUserOnly`，拦截在 `runConfigure`）。
- `handleConfigOp`：`add` / `set` / `rename` / `remove` / `test` / `options`；`options` 可带 `newEnv`（改名+改选项原子）；行不存在时提升为持久化行（`source:'promoted'`）。实现在 `applyOptionsOp`。
- 秘密字段「留空 = 保持原值」；`auth==='key'` 且无已存路径时落 `DEFAULT_SSH_KEY_PATH = '~/.ssh/id_ed25519'`；载荷统一走 `connDraftOf` / `withConnDraft`。
- 描述符 `{dsn, ro, ssh}`：`probeConnection` 验有效连接，`probeSshTunnel` 只验 SSH 层（`SSH_LAYER_RE` → 断；否则 `DB_LAYER_RE` / 指名转发目标 → 通；都没有 → unknown）。
- 预算 `PROBE_TIMEOUT_MS = 25s` / `PROBE_TIMEOUT_SSH_MS = 45s` < 客户端看门狗 30s/60s；宿主兜底 = 预算 + 500ms → [原因](doc/ARCHITECTURE.md#环境选项与执行预算)。
- UI 落点：现代面行内 `.dbh-rochip`（点击发 `{op:'options', readOnly}`），legacy 面 `.dbh-ro`；SSH 只进 tooltip。见 [doc/CLIENT.md](doc/CLIENT.md)。

### source 身份
- 每条 source 只属于一个工作区，同名不同区是不同目标；`sourceIdOf(row)` 是唯一构造点（`<标题slug>_<路径哈希>[_<envSlug>]`）。
- `envSlug`：`default` 裸值 / 纯 ASCII 原 slug / 非 ASCII `env-<shortHash>` → [原因](doc/ARCHITECTURE.md#envslug事故)。
- `resolveSource`：精确 → 当前会话工作区 → `{ambiguous}` 澄清，**不按列表顺序猜**。
- `dbhub_configure` 不回退 `workspaces[0]`（`result.unknownWorkspace` / `result.needWorkspace`）；跨区复用走 `copyFrom`。

### 状态通道
- 一个发布核心 `createHostCore`，两条通道：0.1.x settings 命名空间（仅 `settings.register` 存在时）/ `connection.fetch` 的 `/api/dsh-dbhub-live/{state,enabled,options,op}`。
- 客户端 `inject` **只能 `["slots"]`**；host face 用 `ctx.get('settingsScope')` 探测 → [为什么](doc/ARCHITECTURE.md#状态通道与inject根因)。
- 注入回调内服务必须 `ctx.get(...)` 就地取；legacy 回调 `wrap()` 防护。
- view：`{enabled, phase, toolCount, lastError, mode}` + `{updateIntervalDays, showSidebarEntry, announceAccessPolicy, capabilities, workspaces, testResult}` + `{pluginVersion, dshVersion, dshModern, runtime, update}`；legacy 额外 `configOp`。**DSN 只从浏览器流向 Host。**

### 部署开关与连接管理
- `lib/options.mjs` 唯一持有开关；Config 值经 `options.configValuesOf` → `applyPatch(..., {persist:true})`；`entryIdOf(ctx)` 运行时解析行 id；不绕过 `applyPatch`。
- 页面只见元数据（`collectSources` → `latestSummaries`）；增删改改名走 `configOp`；`renameFrom` 让「改名 + 改连接」原子。
- 写前先问（`requestWrite` / `envCollision` / `normalizeEnvForCompare` → `dbh-warncard`）→ [原因](doc/ARCHITECTURE.md#覆盖门为什么先问)。
- 即时回推：`handleConfigOp` 返回补丁并 `publishFast`；`reportTest` 只 `publishMirror`；扫描单飞 + 补丁重放；`rename` 补丁幂等 → [原因](doc/ARCHITECTURE.md#即时回推与扫描单飞)。
- test op 三档快路径 `resolveTestDsn`（store → 卡片缓存 → walk）；失败不写 store/lastError/phase；`kind:'ssh'` 只验 SSH 层。
- 诊断取尾部 600（`diagnosticTail`），前缀 `【SSH 层】/【数据库层】/【插件层】`；页面只认自己派发的 nonce → [原因](doc/ARCHITECTURE.md#诊断为什么取尾部)。

### 版本与更新
- `dshModern` = DSH >= 0.2.1（含预发布）；解析不到 → desktop true / web false → [原因](doc/ARCHITECTURE.md#版本门与更新检查)。
- `{op:'updateCheck'}` 在 `runOp` 中先于 `handleConfigOp` 拦截；不改行、不写 store。门禁 `test/meta.test.mjs` / `test/update.test.mjs`。

### 自动发现（mise）
- 每次探测必须有总超时（`MISE_ENV_TIMEOUT_MS`；`graceMs` 不是超时）；结果按 `AUTO_DSN_TTL_MS` 缓存；工作区之间并发。
- **预算计时器不 `unref()`** → [原因](doc/ARCHITECTURE.md#自动发现的代价与unref教训)。
- `resolveWorkspaceRef` 必须用与扫描同一个 `listWorkspaces(ctx)`。

### 其他不可退化
- 依赖只进不出：`config ← state ← mcp`；`config ← runtime|toml|capability ← adhoc`；`mcp ← tools ← index`；`adhoc|collect ← tools`；`state|options ← policy ← index`；`meta`/`update` 是叶子。禁循环 import。
- schema 弹性：`await import('@deepseek-ai/schemastery')` 失败 → 内建最小 schema；不改回静态顶层 import。
- `policy.mjs` 唯一 system prompt 段（order 8900）：已配置连接走 `dbhub_*`、禁 CLI/脚本/驱动/其它 MCP/其它数据库插件绕过、只读被拒不换途径；不支持的库让给用户其它插件、判不准先问。`announceAccessPolicy=false` 时 `text` 为空。门禁 `test/policy.test.mjs`。
- 启用/禁用：`state.setEnabled` → `credentials.json`；禁用时工具首行返回「插件已禁用」。
- 存储：`$DSH_HOME/storages/dsh-dbhub-live/`（credentials / prefs / runtime / dbhub-runtime / tmp）；`writeJsonFile` tmp+rename，失败只 `warnOnce`；load 时清洗 + 一次性回写迁移，**未知字段保留**；进程环境变量不参与连接解析。

### 客户端半（细节见 [doc/CLIENT.md](doc/CLIENT.md)）
- 手写 lazy-CJS bundle，无构建；`id` = Loader entry 名；三入口都要在：`settings.section`（始终）/ 侧边栏（`enabled && showSidebarEntry`）/ `plugins.row.config`（始终）。
- `apply()` 可重入：locale 注册失败降级 `localTranslator`。
- 样式只允许 `--dsw-alias-*` token + 中性半透明兜底；组件不接触 ctx。
- 行内只显示 `w.conn`；操作只用图标；`source` 可复制 chip；库名不截断 → [原因](doc/ARCHITECTURE.md#布局取舍)。
- 空闲不轮询（残留 interval 会让 `check:ui` 挂住不退出）。

## 质量门

```bash
npm run check         # 语法：全部 lib + client.js
npm run check:secrets # 脱敏门禁（槽位 + 兜底 + 本地 denylist）
npm run check:ui      # 客户端离屏渲染 + 点击交互
npm run check:docs    # 文档链接/锚点、影响矩阵路径、包内文档一致性

# 单测必须逐文件跑（沙箱内 node --test 的 runner 子进程 EPERM）
Get-ChildItem test/*.test.mjs | ForEach-Object { node $_.FullName }
```

- CI：`.github/workflows/quality.yml` job **`gate`**（ubuntu-latest + Node 22），push `main`/`dev`、所有 PR、`workflow_dispatch`；`main` 分支保护把它设为必需检查。另有 `release-matrix.yml` 定时跑 `support:check`。
- **CI 是真实执行**，Linux 会暴露 Windows 掩盖的缺陷 → [原因](doc/ARCHITECTURE.md#自动发现的代价与unref教训)。
- 发布前在隔离实例完整冷启动一遍：见 [doc/DEVELOPMENT.md](doc/DEVELOPMENT.md) 第 3 步（含 200/401 与 bundle 校验）。

## 变更影响矩阵

改动前先去 [doc/IMPACT-MATRIX.md](doc/IMPACT-MATRIX.md) **按类型核查一遍联动项**（该表按需加载，本文件不内联）。矩阵本身也是受管文档：出现新的联动关系要同次加行，`npm run check:docs` 会校验它的路径与链接。

## 约定

- 产品文案中文、代码注释英文；零知识不可绕过；扫描必须经 `askUser` 授权。
- 仓库内一切内容视为公开分发：不得出现真实主机/账号/密码/库名/项目名，也**不得出现本机绝对路径**；示例主机用回环或 RFC 5737、示例密码用 `CHANGE_ME`；新出口同次登记槽位表；发现新真实值只写本地 `.env`（详见 [doc/DESENSITIZE.md](doc/DESENSITIZE.md)）。
- `state.*` 之外不要直接改持久化。
- 发布：默认只往 `dev` 提交/推送；动 `main`、打 tag、发 npm 前先向用户确认（「可以了，发布」= dev 测试版）。流程见 [doc/RELEASE.md](doc/RELEASE.md)。
- 增加行为时同次更新本文件 + `doc/REQUIREMENTS.md` + README（双语，`README.md` 为唯一真源，`README.en.md` 由 AI 同次派生）。
