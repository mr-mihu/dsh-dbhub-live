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
- `connLabel` 是**结构性闸门**：只有 `new URL()` 真正解析成功的串才被信任（`Server=…;pass=…`、Go 风格 `u:secret@tcp(…)`、JDBC 属性后缀、裸路径一律 → 本地化占位 `result.unknownConn`，绝不回显原串）；解析成功的值再过两条 path 闸门——含 `@`（userinfo），或含 key 命中 `/pass|pwd|secret|token|auth|cred/i` 的 `k=v` 对 —— 命中即占位。**不要用密码关键词表代替它**，也不要加"字段里 includes 密码"的判据（会杀掉 `postgres:postgres@…/postgres` 这类正常标签）。`decodeURIComponent` 必须兜底（失败用原串）、`connLabel` 整体 try/catch：单条坏行不得让整份列表抛错 → [原因](doc/ARCHITECTURE.md#零知识边界)。
- `runAdhoc` 的结果**首行 prefix 与正文一起过 `scrubSecrets`**（含调用方传入的 `label`）。
- 卡片写命令的补丁**只带元数据**（`op/path/title/env/from/ro/source`）：`/op` 响应里没有 `dsn`、没有 `ssh`；镜像要的 DSN 由 `mirrorPatchOf` 从 store 回读（`publishFast` 只喂宿主内存）。
- 密码与完整 DSN 只经界面：`askUser`（configure）/ `configOp`（配置页）。门禁 `test/zero-knowledge.test.mjs`。

### 一次性进程
- `resolveSource` 解 DSN → `runAdhoc` 起一条 `dbhub --transport stdio`，跑完 terminate。**无常驻服务**（无指纹 / mtime / 空闲回收 / respawn / 孤儿清理 / 配置重启）→ [原因](doc/ARCHITECTURE.md#一次性进程的理由)。
- **每个请求都必须有请求级超时**：`MCP_INIT_TIMEOUT_MS = 15s`（`initialize`）/ `MCP_CALL_TIMEOUT_MS = 120s`（`tools/call`，**挂死探测不是查询预算**）。唯一其它取消源 `exec.signal` 只在用户取消/轮次中断时触发；超时 → `code:'MCP_TIMEOUT'`、立刻 `terminate()` 该条 dbhub、临时 TOML 照常删、回执走 `result.mcpTimeout`（错误文本只带方法名与毫秒数，不带参数）。
- **上限与解码**：stdout 用 `StringDecoder('utf8')` 累积解码（`String(chunk)` 会把跨 64KiB 边界的中文切成 `U+FFFD`），行用片段数组而非 `buf +=`（32MB 单行 3.6s 同步拷贝）；超 `MAX_LINE_BYTES = 8 MiB`（单行）/ `MAX_RESPONSE_BYTES = 64 MiB`（累计）→ `code:'MCP_TOO_LARGE'` + 终止本次调用。
- **pending 的 key 是字符串 id**（`String(msg.id)`，number 与字符串回包都能匹配）；`handle.stdin` 必须挂 `'error'` 监听（写已关闭管道 → `settleAll`，否则是 uncaught）；`waitForExit` 返回 `false` 要再 `terminate()` 一次并 `warnOnce`（不含路径）。
- 自动安装 npm 也必须 drain stdout 且有总超时（`DBHUB_INSTALL_TIMEOUT_MS = 180s`）：stdout 无人读 → 64KiB 管道写满 → 安装永不退出 → `installingDbhub` 永不落 → 本会话 dbhub 永久不可用。
- 能力探测按 `exe + mtimeMs` 进程内缓存（`lib/capability.mjs`）：每次 TOML 调用重扫最多 18 个路径 + `readFileSync` 是不必要的；命中返回**副本**，调用方改不动缓存。
- `waitForExit` 的等待也是**有界**的（`EXIT_WAIT_MS = 5s`）：逃出受管进程组的后代会让它永不 settle，超时按 `false` 处理（再杀一次 + 只警告一次）。
- `MAX_RESPONSE_BYTES` 是**每个客户端一生累计**：单次超过 64 MiB 的合法导出会被 `MCP_TOO_LARGE` 切断，这是有意的取舍（宁可明确失败，也不把宿主内存吃满）。
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
- 卡片不回显秘密，所以 `add`/`set` 在写之前也要 `mergeSshOptions(op.ssh, 已存行.ssh)`（与 `options` 同款）；规范化失败 → `result.badSsh` 报错，**不许静默清除隧道**。合并+校验必须发生在**改名之前**（已存行按 `findRow(renameFrom || env)` 取），否则隧道非法时行已改名、回执却说「未做任何修改」（半写）。`ssh` 为任何非 null 值都要校验（含 `''`），不能只在真值时校验。
- `renameWorkspaceEnv` 返回 `{ name, collided, renamed }`：落到已存在的环境必须先确认（`{confirm:true}` / 卡片 `overwrite:true`），未确认则 `renamed:false` 且零写入；`newEnv` 空 = 不改名（不会归一成 `default`）。**冲突判据是 `collided === true`**——用 `!renamed` 会把「改到自己的名字」（`{renamed:false, collided:false}`）误报成「目标环境已存在」；同名 = 无需改名，继续后续写入。`copyFrom` 覆盖已有环境同样先问，且选项取自**源行**（源行没有的只读/隧道即清掉）。
- 描述符 `{dsn, ro, ssh}`：`probeConnection` 验有效连接，`probeSshTunnel` 只验 SSH 层（`SSH_LAYER_RE` → 断；否则 `DB_LAYER_RE` / 指名转发目标 → 通；都没有 → unknown）。探连的 ssh 三态：`null` = 用户解除隧道（按无隧道探）/ 对象 = 表单在编辑（先与已存行 merge）/ **缺省 = 卡片三项全空**（`connDraftOf` 不发 `ssh` 键，此时用已存行的隧道——否则探的是裸连接，不是会保存的那条）。
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
- view：`{enabled, phase, toolCount, lastError, mode}` + `{updateIntervalDays, showSidebarEntry, announceAccessPolicy, capabilities, workspaces, testResult, opNotice}` + `{pluginVersion, dshVersion, dshModern, runtime, update}`；legacy 额外 `configOp`。**DSN 只从浏览器流向 Host。**

### 部署开关与连接管理
- `lib/options.mjs` 唯一持有开关；Config 值经 `options.configValuesOf` → `applyPatch(..., {persist:true})`；`entryIdOf(ctx)` 运行时解析行 id；不绕过 `applyPatch`。
- 页面只见元数据（`collectSources` → `latestSummaries`）；增删改改名走 `configOp`；`renameFrom` 让「改名 + 改连接」原子。
- 写前先问（`requestWrite` / `envCollision` / `normalizeEnvForCompare` → `dbh-warncard`）→ [原因](doc/ARCHITECTURE.md#覆盖门为什么先问)。
- 被拒的写命令必须有回执：`handleConfigOp` 把失败原因（找不到工作区 / 空 DSN / 改名冲突 / 非法隧道）写进 `opNotice` 一次性发布，卡片 `.dbh-notice` 显示；部分失败时**已落地的补丁照发**（不再 `return []`）。
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
- `writeJsonFile` 的临时文件 `mode: 0o600`、`DATA_DIR` / 子目录 `0o700`（Windows 忽略 mode，靠 profile ACL）。**升级来的旧目录/旧文件必须补 chmod**：`mkdirSync(recursive)` 不改已存在目录的 mode，所以 boot 时与每次写入后 best-effort `tightenStorageModes()`（Windows 跳过；失败只 `warnOnce` 一次、文案只带文件名与错误码）。`setFsHooks` 是给测试观察 mode 参数的注入缝，生产恒用 node:fs。旧版明文 `dbhub.toml`（4.0 之前就是连接库）：boot 时 `sweepLegacyConfigFile()` 直接删除并 `warnOnce` 一条不带内容的警告（D1）。

### 客户端半（细节见 [doc/CLIENT.md](doc/CLIENT.md)）
- 手写 lazy-CJS bundle，无构建；`id` = Loader entry 名；三入口都要在：`settings.section`（始终）/ 侧边栏（`enabled && showSidebarEntry`）/ `plugins.row.config`（始终）。
- **写失败必须可见**：face 的写 promise 在失败时 reject（失败分支不得写 `noop`），组件渲染 `.dbh-error .dbh-writefail[role=alert]` 且**不置 `saved`**；`/state` 失败时读 `snapshot.status === 'error'` 渲染 `.dbh-loadfail` + 「重试」（`face.refresh()`）；`sidebarWanted()` 只在 `enabled === true` 时注册（未知/失败不注册）；`summary` 与 `page` 两种 view 的 Hook 序列必须一致（summary 早退只能放在所有 Hook 之后）。门禁 `check:ui` 的 `[32]`–`[37]` 用失败桩（401 / `{ok:false}` / fetch 拒绝 / 晚到的读）钉住，假 react 按组件身份校验 Hook 数。
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
