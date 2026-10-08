# dsh-dbhub-live 5.1 开发计划：环境只读模式 + SSH 隧道（手动配置）+ 侧边栏入口随启用状态

> **文档用途**：本文件是「后续单独开新会话开发这三个功能」的唯一上下文入口。它自带全部上游事实、代码锚点、契约设计与验收标准，新会话**不需要重新调研**（尤其不要再去调研 dbhub 的配置方言与 DSH 的 SSH 插件），按 §8 任务卡实施即可。
> **基线**：`package.json` = `5.0.1`（本计划基于该版本的源码逐行核对）。
> **上游实测版本**：`@bytebase/dbhub@1.4.0`（本机 `…/npm-bytebase-dbhub/1.4.0`）+ 官方文档 <https://dbhub.ai/config/toml>。
> **目标版本**：`5.1.0`（测试期 `5.1.0-dev.<n>`）；理由见 §0 第 1 条。
> **本文件放在仓库根目录**（与 `implementation-notes.md` 同类），不进 npm tarball。

## 阅读顺序

§0 用户已确认的决策 → §1 关键结论（含实测陷阱）→ §4 上游事实 → §5 为什么不做 DSH SSH 复用 → §6 设计决策 → §7 契约 → §8 任务卡 → §9 测试门 → §10 验证。

---

# 0. 用户已确认的决策（本轮范围锁定，勿再扩大）

| # | 决策 | 影响 |
| --- | --- | --- |
| 1 | **版本号 5.1.0**（不是 6.0.0）。用户口径：首位是"破坏性变更 / 兼容性问题"版本；本次对使用者无破坏，只是开发面较大 | 任务卡与发版按 `5.1.0` / `5.1.0-dev.N` |
| 2 | **放弃「复用 DSH 的 SSH 配置」**。原因：那个插件把密码明文存在 JSON 里（未加密），用户明确"不碰它了"。SSH 只做**我们自己的配置 UI + AI 辅助（弹窗输入密码）**两条路，能力全部落在 dbhub 原生 SSH 上 | 删除原计划的 `mode:'dsh'` / `mode:'sshconfig'`、`lib/dshssh.mjs`、`lib/sshconfig.mjs`、view 的 `sshHosts`/`sshConfigHosts`、Phase 3 全部任务。**只保留 manual** |
| 3 | **只读只做环境级开关**；插件级"全局关掉"由既有的**禁用**按钮承担，不再加全局只读 | 只读 = 环境条目上的布尔 |
| 4 | **模型只能开只读、不能关**；关只读必须人在配置页操作 | §6 D7（安全不对称），必须有测试 |
| 5 | `max_rows` 用户没懂 → 本轮**不做**（§附录 D 有一句话解释，便于以后决定） | 从范围移除 |
| 6 | **本轮不做额外功能**（全局只读、`~/.ssh/config` 别名模式、全量迁 TOML 等一律下次再计划） | 附录 D 明确列为"未来可选，本轮不做" |
| 7 | **新增需求**：插件级禁用开关生效后，**把侧边栏入口也关掉**；也就是**移除 `在侧边栏显示入口` 这个勾选项**，由"启用/禁用"驱动侧边栏入口显隐 | 新增 Phase 1（F0），跨 options/config/index/client/测试/文档 |
| 8 | **新增缺陷修复**：环境行「测试」按钮明显比模型调用慢（用户报告："为啥 AI 直接调用工具很快，测试很慢？两个走的不是一个逻辑吗？"）→ **本轮一并修** | 新增 F4 / Phase 2B（根因与证据见 **§1.4**） |

> 第 7 条的实现语义：**侧边栏入口可见 ✅ ⇔ 插件处于启用状态**。禁用后入口消失，但**设置页（`settings.section`）与插件页那行的「配置」必须始终可达**——这是"不自锁"的底线（原 `showSidebarEntry` 的设计理由照旧成立，只是开关从"一个独立选项"变成"启用状态本身"）。

---

# 1. 关键结论（TL;DR）

## 1.1 四个会直接决定实现的实测陷阱

1. **`read_only = true` 这个写法不能用，而且写错会静默失效或直接崩。** dbhub 1.4.0 实测：
   - `[[sources]]` 里写 `readonly = true` → `Fatal error: … readonly must be configured per-tool, not per-source`（进程起不来）；
   - ⚠️ `[[sources]]` 里写 `read_only = true`（用户原本的写法）→ **未知键被静默忽略**：进程照常启动、写操作照常放行 —— "看起来配好了其实没生效"，这是最危险的一种；
   - CLI `--readonly`、环境变量 `READONLY` → `process.exit(1)`；
   - **唯一正确写法**是 per-tool：
     ```toml
     [[tools]]
     name = "execute_sql"
     source = "default"
     readonly = true
     ```
2. **`[[tools]]` 是白名单，不是补丁。** 只列 `execute_sql`，`search_objects` 会从工具列表里彻底消失，调用得到 `{"error":{"code":-32602,"message":"Tool search_objects not found"}}`（实测）→ **只读 TOML 必须同时列 `search_objects`**，否则 `dbhub_search_objects` 在只读环境上直接坏掉。
3. **`--dsn` 与 `--config` 互斥**（实测 `Fatal error`）。只读与 SSH 都只能靠 TOML → **必须引入"每次调用生成一份临时 dbhub.toml"**。这是本迭代唯一真正的架构新增；不是把旧的常驻 toml 装回来（仍单源、一次性进程、无指纹、无 mtime 监听、无空闲回收、无孤儿清理）。
4. **临时 TOML 里可以不写任何密码。** TOML 支持 `${VAR}` 插值（从**子进程环境**取值，实测可用），而 `subprocess.spawn` 的 spec 支持 `env` → 文件里写占位符，真值走子进程环境。

## 1.2 "秘密"指什么（用户问的那一条）

**"秘密" = 任何写进文件就等于泄漏的凭据值**，本迭代涉及三样：

| 秘密 | 出现在哪 | 说明 |
| --- | --- | --- |
| **数据库密码** | DSN 的 `user:password@` 段里 | 例如 `mysql://root:<密码>@192.0.2.10:3306/db`；只读/SSH 环境要生成 TOML，就必须把 DSN 交给 dbhub |
| **SSH 登录密码** | `ssh_password` 字段 | 手动 SSH + 密码认证时 |
| **密钥口令** | `ssh_passphrase` 字段 | 手动 SSH + 加密私钥时 |

**问题**：如果按最直觉的写法把 DSN/密码原样写进临时 TOML，那么每次调用都会在磁盘上多留一份密码文件；崩溃残留、Windows 上删除失败（dbhub 会 watch 该文件）都会让它长期躺着。

**做法**（对比）：

```toml
# ❌ 直觉写法：密码被写进磁盘文件
dsn = "mysql://root:REAL_PASSWORD@192.0.2.10:3306/db"
ssh_password = "REAL_SSH_PASSWORD"

# ✅ 本计划写法：文件里只有占位符，真值放在被 spawn 的子进程环境变量里
dsn = "${DSH_DBHUB_SEC_DSN}"
ssh_password = "${DSH_DBHUB_SEC_SSH_PASSWORD}"
```
```js
subprocess.spawn({ argv: [… '--config', tomlPath], env: { ...process.env, DSH_DBHUB_SEC_DSN: dsn, DSH_DBHUB_SEC_SSH_PASSWORD: pw } })
```
→ 临时文件本身**无密**，残留无害；密码仍然只存在于 `credentials.json`（设计内的唯一存放点）与运行中的进程内存里。
⚠️ 注意：dbhub 的插值是"取不到就原样保留 `${VAR}` **且不报错**"，所以生成器必须为每个引用的变量都注入值（空串也要注入）。

## 1.3 顺手要修的既有 bug

`lib/tools.mjs:302` 调用 `runCopyFrom(ctx, subprocess, exec, target, copyFrom, envName0)`，而函数定义是 `runCopyFrom(ctx, subprocess, target, copyFrom, envName0)`（213 行）→ 参数整体错位，`copyFrom` 永远返回 `result.noSource`（R38、工具描述、README 都宣传了这个能力，实际不可用）。不是数据损坏，但同批修掉并加回归测试。

## 1.4 用户报告的缺陷：环境行「测试」按钮明显比模型调用慢（本轮一并修）

**结论先说：两条路的"连库"部分完全同一套代码，差异不在执行，而在"测试"这条路多做了一次同步的全工作区连接发现（walk）。**

### 1.4.1 代码级对照（已逐行核对）

| 路径 | 入口 | 步骤 |
| --- | --- | --- |
| **环境行 ▶ 测试** | `client.startTest`（client.js 873）→ `configOp({op:'test', workspace, env, nonce})`（883）→ 宿主 `handleConfigOp`（index.mjs 272）→ **`handleTestOp` 的"按已存行"分支（index.mjs 248）** | ① `resolveWorkspaceRef`（`listWorkspaces`，便宜）② **`collectSources` 全工作区 walk** ③ `probeConnection`（一次性 dbhub + `SELECT 1`）④ `reportTest` 回推 |
| **模型 `dbhub_execute_sql`** | `runSourceTool`（tools.mjs 92） | ① `currentWorkspace`（便宜）② **`collectSources` 全工作区 walk**（`resolveSource` 190 行）③ `runAdhoc`（一次性 dbhub）④ 回执 |
| 表单「试连」（对照项） | `dispatchPretest`（client.js 791）→ `configOp({op:'test', **dsn**})` → `handleTestOp` 的**内联 DSN 分支（index.mjs 229-241）** | ① 直接 `probeConnection(inlineDsn)` ② 回推 —— **完全不 walk，所以表单试连是快的** |

→ 步骤 ②③ 是同一套代码（`collectSources` + `runAdhoc`），**所以"AI 很快、测试很慢"不是两套执行逻辑**。真正的差别有三条：

1. **`collectSources` 是"发现全部工作区"，而测试只需要"一个已知工作区的一个已知环境"的 DSN。** 浏览器按零知识红线**不持有 DSN**，所以解析只能由宿主做——但宿主对**持久化行**本来就有更便宜的答案：`store[wsPath].environments[env].dsn`（`listWorkspaceEnvironments(store)` 直读，O(1)、零 spawn）。现在却绕道重扫全部工作区。
2. **模型调用通常吃到了 10 秒的自动发现缓存**（`AUTO_DSN_TTL_MS = 10000`，config.mjs 570）：模型常见节奏是「先 `dbhub_list_sources` / 再执行」，两次相隔几秒 → 第二次 walk 里 `mise env` 全部命中缓存。而**手动点 ▶ 一般距上一次发布/扫描已超过 10 秒** → 必然冷缓存。缓存是"结果缓存"，`resolveAutoDsn`（config.mjs 643-649）**只缓存结果、不共享在途 Promise**。
3. **直接调用 `collectSources` 没有单飞**：发布路径有 `runWalk` 单飞（index.mjs 418-432），但 `handleTestOp`/`resolveSource` 直接调 `collectSources`；若与一次发布 walk 重叠，两次 walk 各自跑，同一个工作区的 `mise env` 被重复 spawn。

### 1.4.2 本机实测的量级（供参考，不代表用户机器）

- 注册工作区 **9** 个；其中**只有 1 个**有持久化 `default` → **冷 walk 会 spawn 8 次 `mise env`**。
- 本机把这 8 次并发跑完的批量耗时 **≈516 ms**（最慢单次 ≈458 ms，0 失败）；插件给单次探测的预算是 **`MISE_ENV_TIMEOUT_MS` = 2500 ms**。
- 结论：**本机 walk ≈0.5 s，慢机器/网络盘/需要 mise 解析工具时可以到 2.5 s 量级**，再叠加探连（spawn dbhub + 握手 + `SELECT 1` + terminate）。若用户感知是"十几秒"，那说明他机器上的 `mise env`（或 `subprocess.resolveExecutable('mise')`、`.env` 的 `fs` 读取）远慢于本机 —— 所以**先做 T2B.1 的分段计时再优化**，不要凭猜测改。

### 1.4.3 用户可自证的诊断（一条命令都不用敲）

探连结果文本里**自带 probe 耗时**：成功时是 `连接成功（SELECT 1，<ms> ms）`（`result.testOk`）、失败时是 `连接失败（<ms> ms）：…`（`result.testFail`）。
→ **用"感知到的总时长 − 文本里的 ms"≈ 这次 walk（含 `mise env`）的开销。**
- 差值很大 → 命中本节判断，按 Phase 2B 修；
- `ms` 本身就很大 → 是探连/网络本身慢（另一个问题；SSH 隧道场景会更慢，见 §7.6 的超时分档）。

### 1.4.4 另外两点观感因素

- **探连结果通过 `POST /op` 的响应直接回推**（client.js 1375-1386：`post()` 用响应里的 view 刷新快照），所以**没有额外的轮询等待**——慢就是真慢，不是显示延迟。
- 但"测试中…"期间**界面没有任何计时**，客户端兜底又是 30 s（client.js 886-889），所以真实卡住时用户会干等一个没有任何反馈的 30 秒。

### 1.4.5 修复方向（任务见 **Phase 2B**）

- **持久化行零 walk**：`handleTestOp` 先查 store（精确 `workspace + env` → DSN）→ 命中即探连。**语义不变**（对持久化行，store 就是权威值，不存在"测得不准"）。
- **自动发现行优先用已缓存的行**：宿主内存里本就有 `lastRowCache`（**卡片显示的就是它**）→ 命中即探连；仅当没有缓存项时才 walk。
- **在途去重**：`resolveAutoDsn` 缓存"在途 Promise"；`collectSources` 共享一次在途 walk（与发布路径的单飞统一）。
- **同一类浪费在模型侧也存在**（`resolveSource` 对持久化 source 也要 walk）→ 同批给"缓存行命中即短路"的快路径，模型调用一起变快。
- 可选：`AUTO_DSN_TTL_MS` 10 s → 30 s，并提供显式"重新扫描"入口。
- 界面：测试中显示已耗时（`测试中… 1.2s`），让等待可感知。

---

# 2. 目标与非目标

## 2.1 目标

| 编号 | 需求 | 落地形式 |
| --- | --- | --- |
| **F0** | 插件禁用后自动隐藏侧边栏入口；移除 `在侧边栏显示入口` 勾选项 | 侧边栏 `sidebar.panellist` 的注册/注销由 `view.enabled` 驱动；options/Config/view 里的 `showSidebarEntry` 全链路移除 |
| **F1** | UI 增加"启用只读模式"开关，限制某个环境只读 | 环境级布尔（工作区 × 环境）→ 落 `credentials.json`；执行时翻译成 dbhub `[[tools]] readonly = true`；**模型可开不可关**（D7） |
| **F2** | 高级连接：SSH 隧道，UI 或 AI 辅助配置 | 环境级 `ssh` 配置块（host/port/user/认证/密钥路径/口令/ProxyJump），秘密只在浏览器→宿主方向流动并落 `credentials.json`；dbhub 原生 `ssh_*` 字段建隧道 |
| **F3** | 只读/SSH 必须在"试连"里被真实验证 | `{op:'test'}` 扩展为按"有效连接描述符"探连（含隧道与只读），UI 试连门禁沿用 |
| **F4** | **连接测试性能**（用户报告）：点测试按钮不应因为"解析 DSN"而重扫全部工作区 | 持久化行直读 store；自动发现行优先用已缓存行；walk/自动发现加在途去重（Phase 2B） |

## 2.2 非目标（本轮明确不做，附录 D 有清单）

- ❌ **不碰 DSH 的 SSH 配置**（`dsh-ssh.json`、`@linxin666/dsh-ssh`、官方 `ssh` Service 一律不读不用；原因见 §0-2 与 §5）。
- ❌ 不做 `~/.ssh/config` 别名模式（`ssh_host = "<别名>"` 那套 dbhub 原生能力）——留待以后；本轮 SSH 只有"手填"一种来源。
- ❌ 不恢复常驻 dbhub 服务器、不做 toml 热重载/指纹/mtime/多源。
- ❌ 不增加工具声明数量（仍恒定 4 个）。
- ❌ 不支持 dbhub 的 `ssh-agent` 认证；不支持 `ProxyCommand`；**多跳跳板机**本轮按"单跳支持、多跳明确报不支持"处理（§11 R4）。
- ❌ 不做 `max_rows`、不做全局只读、不把普通行迁到 TOML（DB 密码仍走 argv，与 5.0.1 一致）。

---

# 3. 现状盘点（5.0.1 代码锚点）

> 行号取自当前工作副本，实施前以最新为准。**加粗** = 本迭代一定要动。

## 3.1 宿主侧

| 文件 | 关键锚点 | 本迭代 |
| --- | --- | --- |
| `lib/config.mjs` | `normalizeStore` 73、`listWorkspaceEnvironments` 122、**`setWorkspaceEnv` 147**、`renameWorkspaceEnv` 173、`removeWorkspaceEnv` 195、`ensureStorageDir` 226、`writeJsonFile` 242、`loadStore` 258、`loadRuntime` 272、**`normalizePrefs` 291**、`loadPrefs` 301、`normalizeEnvName` 336、`describeConn` 375、`connLabel` 406、`dsnPassword` 419、`dsnUser` 437、**`scrubSecrets` 456**、`listWorkspaces` 527、`runMiseEnv` 573（预算计时器**不得 unref**）、`resolveWorkspaceEnvs` 681、`envSlug` 711、`likelyAuthOrConnError` 726、`buildDsnFromParts` 750、`argsChangedEndpoint` 772、`decideConfigureStep` 796 | ★核心 |
| `lib/adhoc.mjs` | **`probeConnection` 27**、**`runAdhoc` 48**（argv 拼装 64） | ★核心 |
| `lib/runtime.mjs` | `findDbhubExe` 23、`buildSpawnArgv` 82、`installDbhub` 97、`resolveDbhubExe` 170、`isAutoManagedExe` 192、`maybeRefreshDbhub` 205 | ★能力探测 |
| `lib/mcp.mjs` | `createMcpClient` 23、`sourceIdOf` 147、`resolveSource` 186、**`summarizeRows` 225**、`latestSummaries` 240、**`applyRowPatch` 264**、`createRowMirror` 313、**`collectSources` 351** | ★ |
| `lib/tools.mjs` | `runSourceTool` 92、`probeResult` 123、`connCheckText` 140、`runRename` 149、**`runCopyFrom` 213（有 bug，见 §1.3）**、`persistEnv` 243、**`runConfigure` 258**、工具定义 616/688/738 | ★核心 |
| `lib/index.mjs` | **`STATUS_DEFAULTS` 67（含 `showSidebarEntry` 78）**、**`STATUS_SCHEMA` 105（112）**、**`Config` 123/142（125）**、`entryIdOf` 149、`resolveWorkspaceRef` 168、`TEST_TIMEOUT_MS` 184、`withProbeTimeout` 194、**`handleTestOp` 211**、**`handleConfigOp` 272**、`createHostCore` 350、**`view` 365**、`publishFast` 400、`runWalk` 418、`wireLegacySettings` 467（`scope.watch` 里 `options.applyPatch` 507）、`wireHttpBridge` 528、`writeOptionsToForm` 571、`startBackgroundBoot` 618、`apply` 642 | ★核心 |
| `lib/bridge.mjs` | `BRIDGE_BASE` 23、`BRIDGE_ROUTES` 26、`createBridgeRoutes` 65（`GET /state`、`POST /enabled`、`/options`、`/op`） | 基本不动（view 增字段自动透传） |
| `lib/state.mjs` | `setEnabled` 64（持久化 + emit）、`touch` 116 | 不动（F0 依赖它的 emit） |
| **`lib/options.mjs`** | **`BUILTIN_DEFAULTS` 14（`showSidebarEntry` 17）**、**初始化 31-39（36-38）**、**`snapshot` 64（67）**、`get` 76（73 注释）、**`VALIDATORS` 82（84）**、`applyPatch` 94、`initFromLayers` 122、`configValuesOf` 145 | ★F0 |
| `lib/i18n.mjs` | `ZH` 11-99、`EN` 101-189、`currentT` 216 | ★新增文案 |

## 3.2 浏览器侧

| 文件 | 关键锚点 | 本迭代 |
| --- | --- | --- |
| `lib/client.js`（1553 行，手写 lazy-CJS，无构建） | 注册 26、字典 `LOCALE_ZH` 52-122 / `LOCALE_EN` 124-194（**侧边栏文案 69/70/141/142**）、`CSS_TEXT` 271-369、`ensureStyle` 371、`groupRows` 416、`layoutModeOf` 444、`splitConn` 458、`shortHandle` 471、`normalizeEnvForCompare` 496、`envCollision` 512、**`uiMemory` 571**、`StatusCard` 575-1263（**settings draft 673-696（676/688/693/695）**、`addState` 718、`editState` 730、`overwriteState` 759、`requestWrite` 772、`dispatchPretest` 791、`pendingPretest` 1027、`editRow` 1028、`connLabelView` 1061、`envRow` 1068、`groupView` 1079、`tileView` 1101、**`settingsPanel` 1131-1151（侧边栏开关 1141-1148）**、`addPanel` 1209）、`apply` 1265-1540（**`sidebarWanted` 1489-1499（1499）**、`syncSidebar` 1506、`face.subscribe(syncSidebar)` 1539） | ★F0/F1/F2 |
| `scripts/render-check.mjs`（843 行） | 18 组门禁；fixture 386 含 `showSidebarEntry`；[8] 528（设置条含侧边栏开关 562-563）；[18] 791 的 `saveConfig` 调用 805 | ★ |
| `test/client-format.test.mjs`（352 行） | :89-99 侧边栏入口断言（`v.showSidebarEntry !== false`、`props.saveConfig({showSidebarEntry: next})`）；:322 `uiMemory` 字面量；:224 addDsn 字面量；:248 `w.dsn` 禁令 | ★ |
| `test/options.test.mjs` | 大量 `showSidebarEntry` 断言（31-32、45-48、52、62-65、70、78-80、89-93、100-110、120） | ★F0 |
| `test/bridge.test.mjs` | 20（view fixture）、125/128（options 补丁含 `showSidebarEntry`） | ★F0 |
| `scripts/desensitize.config.mjs` | 槽位表 `SLOTS` 173-228 | ★新增文件登记 |

## 3.3 必须守住的不变量（AGENTS.md 红线）

1. **模块依赖只进不出**：`config ← state ← mcp`；`config ← runtime ← adhoc`；`mcp ← tools ← index`；`adhoc ← tools`；`collect ← tools`。新模块只能落在图内（建议 `toml.mjs`/`capability.mjs` 只依赖 `config.mjs`，被 `adhoc.mjs`/`index.mjs`/`tools.mjs` 引用）。
2. **零知识**：模型可见面（参数/描述/结果/列表/卡片）不得出现密码、用户名、完整 DSN；dbhub 文本进模型前必须 `scrubSecrets`。
3. **任何工具都不得声明 `dsn` 参数**；`configure` 收到 `args.dsn` 直接拒绝。
4. **密码只在界面输入**（`askUser` 或 `configOp` 浏览器→宿主）。
5. 工具声明恒定 4 个；`sourceIdOf` 是 source 值唯一构造点。
6. 每条连接只属于一个工作区；不按列表顺序猜目标。
7. **计时器不得 `unref()`**（预算/兜底计时器；只在 Linux CI 暴露）。
8. 面板样式只用 `--dsw-alias-*` token（禁不透明色字面量）；行内操作只允许 24px 图标按钮；行不变的属性不得做行内徽章。
9. `client.js` 的 `apply()` 必须可重复执行（locale 重复注册要降级、不抛）。
10. 新增示例/默认值/文案 → 同批更新 `scripts/desensitize.config.mjs` 槽位表并跑 `npm run check:secrets`。
11. 行为变更 → 同批更新 `README.md` + `README.en.md` + `doc/REQUIREMENTS.md` + `AGENTS.md`。
12. **发布流程按 AGENTS.md 的「分支与发布流程」**：改动只进 `dev`；`main` 只通过 PR 合入；测试版 `--tag dev` + GitHub `--prerelease`；正式版 npm 发布命令只交给用户手动执行；已发布 tag/版本绝不移动。

---

# 4. 上游 dbhub 事实（已完成调研）

## 4.1 形态与版本

- `@bytebase/dbhub@1.4.0` 已是 **Node 实现**（`dist/*.js`，`bin: dist/index.js`），依赖 `ssh2@^1.16`、`@iarna/toml`、`ssh-config`、`zod`，`engines.node >= 22.5.0`。本机 mise 安装于 `…/npm-bytebase-dbhub/1.4.0/…/.bin/dbhub.cmd`。
- 插件安装策略：默认 `options.dbhubPackage = '@bytebase/dbhub'`（**裸名 = latest**），按 `updateIntervalDays` 自动更新；用户自装（PATH/mise）不被动。
- 配置来源优先级：`--demo` → `--config <toml>` → `--dsn` → `DSN` 环境变量 → `DB_*` 变量组 → `.env`。
- **`--config` 与 `--dsn` 互斥**；TOML 必须含 `[[sources]]` 且每个 source 必须有 `id`；`--config` 指向不存在的文件 → fatal。

## 4.2 只读模式（F1 的依据）

```toml
[[tools]]
name = "execute_sql"     # 只有 execute_sql 接受 readonly / max_rows
source = "default"
readonly = true
```
- 校验（1.4.0 `validateTomlConfig`）：非 `execute_sql` 的内置工具带 `readonly`/`max_rows` → fatal；`readonly` 非布尔 → fatal；**source 级 `readonly`/`max_rows` → fatal**。
- **`[[tools]]` 是白名单**（`ToolRegistry.buildRegistry`）：某 source 只要出现任意 `[[tools]]` 条目，就**不再**自动挂默认的 `execute_sql`+`search_objects`，而只挂列出的条目 → **只读必须写两条**。
- 只读判定 = 关键词分类器（`classifySQL`：`read` 放行；`dml`/`ddl`/`admin`/`unknown` 全部 deny）+ 数据库自身只读模式。
- 违规返回（实测，sqlite）：
  ```json
  {"content":[{"type":"text","text":"{\n  \"success\": false,\n  \"error\": \"Read-only mode is enabled. Only the following SQL operations are allowed: select, with, explain, pragma\",\n  \"code\": \"READONLY_VIOLATION\"\n}"}],"isError":true}
  ```
  允许关键词随连接器不同（`allowedKeywords[connectorType]`）。
- `search_objects` 永远只读（`buildSearchObjectsTool` 里 `readonly: true`）。
- 官方文档：<https://dbhub.ai/tools/execute-sql#read-only-mode>（"This is a tool-level setting, not a source-level setting."）、<https://dbhub.ai/config/toml>。

## 4.3 SSH 隧道（F2 的依据）

- 兼容两种写法，**我们只用 TOML**（理由见 D3）：
  - TOML per-source 字段：`ssh_host`、`ssh_port`、`ssh_user`、`ssh_password`、`ssh_key`、`ssh_passphrase`、`ssh_proxy_jump`（代码里还有 `ssh_keepalive_interval`/`ssh_keepalive_count_max`）；
  - CLI：`--ssh-host/--ssh-port/--ssh-user/--ssh-password/--ssh-key/--ssh-passphrase/--ssh-proxy-jump`（**不用**：密码会进 argv）。
- `ssh_key` 接受**文件路径或 base64 私钥**；`~/` 会展开。
- 目标地址取自 **DSN 的 host:port** → **`dsn` 里的主机/端口必须是"从 SSH 服务器看过去"的地址**（内网库常见 `127.0.0.1:3306` 或内网 IP）。
- 失败文案（1.4.0 `connectSource`）：缺 user → `SSH tunnel requires ssh_user (…)`；既无 password 也无 key → `SSH tunnel requires either ssh_password or ssh_key (…)`。
- `ssh_proxy_jump` 是逗号分隔的 `[user@]host[:port]` 列表（ProxyJump 语义），**多跳共用同一份凭据**（代码 `jumpHost.passphrase ?? targetConfig.passphrase`）→ 多跳/跳板机凭据不同 = 不支持。
- `~/.ssh/config` 的 `ProxyCommand` 会被忽略并告警 → 不承诺支持。
- **`ssh_host` 是"无点号裸名"时会被 dbhub 当作 `~/.ssh/config` 别名自行解析**（`looksLikeSSHAlias` + `parseSSHConfig`，会读 HostName/Port/User/IdentityFile/ProxyJump，找不到 IdentityFile 时回退默认密钥）。→ 这是**未来可选**的零秘密模式（附录 D），本轮不做，但**生成器必须知道这个语义**：手填的 `ssh_host` 若用户填了不带点的主机名，会走别名解析分支（例如 `bastion` 会被当别名而不是主机名）→ UI 文案要提示"主机名请填域名或 IP"。

## 4.4 配置机制（决定生成器怎么写）

| 机制 | 事实 | 对实现的影响 |
| --- | --- | --- |
| `--config` | 必须是存在的文件路径 | 生成临时文件并传绝对路径 |
| `${VAR}` 插值 | 递归作用于整个 TOML 的所有字符串；从**子进程环境**取；**未定义时原样保留 `${VAR}` 且不报错** | ★秘密走 env；**每个引用的变量都必须注入值（空串也算）** |
| 插值不二次替换 | 单次 `replace(cb)`，回调返回值不再扫描 | DSN 里若含 `${…}` 也安全 |
| hot reload | 有 `--config` 就 watch 该文件（500ms debounce） | 一次性进程无影响；退出后删文件，删不掉也无害（文件无密） |
| 启动横幅 | stderr 打印脱敏 DSN 与工具表（🔒 标记只读） | 现有 `scrubSecrets(text, dsn)` 已覆盖；新日志不要新增泄漏面 |

## 4.5 实测证据

| 实验 | 结论 |
| --- | --- |
| TOML = sqlite + `execute_sql(readonly)` + `search_objects` | 两工具都在且标 🔒；`INSERT`/`DROP`/`CREATE` → `READONLY_VIOLATION`；`SELECT 1`、`search_objects` 正常 |
| TOML 只列 `execute_sql(readonly)` | 工具列表只剩 `execute_sql`；`search_objects` → `{"code":-32602,"message":"Tool search_objects not found"}` |
| source 级 `readonly = true` | fatal |
| source 级 `read_only = true` | **静默忽略**（危险） |
| `--dsn` + `--config` | fatal |
| `--readonly` | exit 1 + 迁移提示 |
| `database = "${DSH_TEST_DB_PATH}"` + 子进程 env | 正常解析并连上 |

## 4.6 版本门槛

- 本迭代能力**在 1.4.0 上完整实测**。`[[tools]] readonly` 属 1.x 的 TOML 模型；0.x 的 `--readonly`/`READONLY`/source 级 `readonly` 已被新版硬拒绝，两套方言不可混用。
- 规则：**最低支持 1.4.0**；`1.0.0–1.3.x` 允许但记 warning（我们没测过）；`<1.0.0` **拒绝**这两个能力（给升级指引）；版本不可解析 → 放行并在真失败时给指引。落地见 T0.1（不阻塞启动，只在用到这两个能力时报错）。

---

# 5. 为什么本轮不碰 DSH 的 SSH 配置（决策记录，勿再调研）

调研已完成，结论留档，**新会话不要重复调研，也不要实现**：

- DSH 里的 SSH 工具（`ssh_list/ssh_exec/…/ssh_tunnel`）来自第三方包 **`@linxin666/dsh-ssh@0.4.5`**；它**不 provide 任何 Cordis Service**（engine 是 `apply()` 内的闭包变量，`mount-once` 禁止同进程挂第二份），只有 6 个工具 + `/api/dsh-ssh/*` 路由；主机配置在 `$DSH_HOME/dsh-ssh.json`，**密码/口令是明文**（0600）。
- DSH API 目录里那个 `ssh` Service 是官方 `@deepseek-ai/dsh-ssh` 的 `SshConnection`（远程执行/文件系统世界）：本 profile 未挂载，无列主机/解析别名/开隧道方法，且它硬编码 `-o ClearAllForwardings=yes`（转发被禁）——**是陷阱，不是捷径**。
- 因此"复用 DSH SSH 配置"只有"读它的明文 JSON"或"调它的私有 HTTP 路由"两条路。**用户已明确决定放弃**（明文密码不可接受）。
- 若将来要重启这条线：优先走上游 Service 提案（`list/resolve/startTunnel`），其次才是读 JSON；**永远不要**把它的密码复制进我们的 store。

---

# 6. 设计决策

## D1 — 只读用 dbhub 原生 `[[tools]] readonly` ✅
**选**：把只读意图翻译成 TOML，让 dbhub 判定（关键词分类器 + 数据库只读模式）。
**否**：插件侧 SQL 分类后拒绝。理由：会与上游语义漂移（每种连接器的允许关键词不同）；多语句需按语句取最严（上游已做）；绕过面更大；违背"能力交给 dbhub"的既定定位。

## D2 — 只在需要时生成 TOML，其余保持 `--dsn` ✅
`readOnly === true || ssh != null` 的条目走 `--config <临时 toml>`；其余条目**逐字节保持现状**。
理由：改动面最小、回归风险最低、普通条目零额外开销。**否**：全部迁 TOML（能顺带把 DB 密码移出 argv，但把 100% 执行路径押在新机制上）→ 列为附录 D 的未来可选。

## D3 — 生成的 TOML 不含任何秘密（`${VAR}` + `spawn.env`）✅
见 §1.2。**实现细节**：
- 只为**实际写进 TOML 的字段**注入变量，且每个引用都必须有值（空串也注入）。
- 变量名固定前缀 `DSH_DBHUB_SEC_`（`_DSN`、`_SSH_PASSWORD`、`_SSH_PASSPHRASE`）；每次调用都是独立进程，不存在并发串号。
- `env` 必须与 `process.env` 合并（dbhub 的 `~/` 展开、默认密钥回退都依赖 `HOME`）。

## D4 — 存储模型 v3：环境条目新增 `readOnly` / `ssh` ✅
现状（v2）：`{ [wsPath]: { environments: { [env]: { dsn, source, updatedAt } } } }`。

v3（同文件、同结构，只在 env 条目加字段）：
```jsonc
{
  "enabled": true,
  "<工作区路径>": { "environments": {
    "default": { "dsn": "…", "source": "user", "updatedAt": 0, "readOnly": true },
    "prod":    { "dsn": "…", "source": "user", "updatedAt": 0,
                 "ssh": { "host": "bastion.example.com", "port": 22, "user": "ops",
                          "auth": "key", "keyPath": "~/.ssh/id_ed25519",
                          "passphrase": "…", "password": "…", "proxyJump": "" } }
  } }
}
```
- **兼容性天然成立**：`normalizeStore`（88-91）已保留未知 env 字段 → 旧版读 v3 会把新字段当未知字段保留而不丢；新版读 v2 即"无只读、无隧道"，行为与 5.0.1 一致。**无需版本号或迁移函数**。
- **SSH 块不加 `mode` 字段**（本轮只有一种来源）；将来要加 `mode` 时新增可选键即可（前向兼容已保证）。`auth` 是 `'key'|'password'`。
- **必须改 `setWorkspaceEnv`（147-161）**：它每次写入都重建 `{dsn, source, updatedAt}`，会抹掉新字段。新语义：
  - `setWorkspaceEnv(wsPath, env, dsn, source, opts?)`，`opts = { readOnly?: boolean|null, ssh?: object|null }`；
  - **未传 `opts` → 保留既有 `readOnly`/`ssh`**（`dbhub_configure` 只更新 DSN 时不得清掉开关）；
  - `opts.readOnly === false` / `opts.ssh === null` → 显式删除该字段。
- **新增 `setWorkspaceEnvOptions(wsPath, env, patch)`**（只改选项、不碰 DSN）：行不存在 → 返回 `undefined`（调用方决定报错或按 D11 提升）。
- 秘密（`ssh.password`/`ssh.passphrase`）与 `dsn` 同级存放（同一文件、同一信任模型，0600 由用户目录权限保障）。

## D5 — 宿主↔浏览器契约：新增 `options` 命令、扩展 `test` 命令 ✅
**问题**：`add`/`set` 在宿主侧强制要求非空 `dsn`（`handleConfigOp` 抛 `DSN 不能为空`），"只翻转只读/只改 SSH"无法走现有命令。
**选**：新增原子命令 `{ op:'options', workspace, env, readOnly?, ssh? }`（只改选项、不动 DSN，回推补丁供即时镜像）；`test` 命令扩展为可携带 `readOnly`/`ssh`（含秘密），使**保存前试连**能真实验证隧道。
**否**：放宽 `add/set` 让 `dsn` 可空（会让"新建连接"与"改选项"语义纠缠，模型路径更难判错）。

## D6 — UI 落点（遵守既有布局红线，最小侵入）✅
- **只读开关**：`editRow`（1028-1050）与 `addPanel`（1209-1250）各加一个 `.dbh-check` 复选框（该样式类**已存在**，设置条 1141-1147 就是同一模式）。
  - 复选框用 `class="dbh-checkbox"`，**不用 `.dbh-input`、不包进 `.dbh-field`** → `render-check` 的 `dbh-field` 数量断言（[8]）与 `typeWithin('dbh-addpanel',0..2)` 索引（[15]/[16]）保持不变。
- **行内可见标记**：只读是逐行不同的属性（不受"行不变属性不得做徽章"约束），且写了会被拒 → 必须一眼可见。方案：`envRow`/`tileView` 的 `span.dbh-envname` 内追加 `span.dbh-ro`（文案 `只读`/`RO`，dimmed），并把"只读模式"并入该 chip 的 `title`（与 `originTitle` 组合）。**不新增图标按钮**（保持 `dbh-iconbtn === 8`）。
- **SSH 状态不做可见徽章**，只进 chip 的 title（如 `· SSH 隧道 bastion.example.com`）——它不改变语义、只改变路由。
- **高级区（SSH）**：新建折叠面板 `.dbh-adv`，位于 add 表单 field 列表**之后**（`.dbh-addfoot` 之前），以及 `editRow` 之下（与 `testRow` 同级）。
  - 触发按钮 `.dbh-advtoggle`（`aria-expanded`，文案 `高级：SSH 隧道`）。
  - 字段：`SSH 主机`/`端口`/`用户` + 认证方式二选一（`密钥`/`密码`）+（密钥时）`密钥路径`/`密钥口令` 或（密码时）`SSH 密码` + `ProxyJump（可选）`。
  - **秘密输入框留空 = 保持原值**（编辑时），占位符必须写明；输入 `type="password"`。
  - 折叠状态放 `uiMemory.advOpen`（与 `addOpen`/`settingsOpen` 同一模式，跨重挂载保留、不持久化）→ **`client-format.test.mjs:322` 的 `uiMemory` 字面量必须同批更新**。
  - 不回显已存的 SSH 密码/口令/密钥路径（与 DSN 不回显同一约定）；镜像行只给 `authKind`/`keyReady`/`hasPassword`/`hasPassphrase` 布尔。
- **不新增任何 `require()`**，不新增任何不透明色字面量。
- 主机名提示：`ssh_host` 填**域名或 IP**（无点裸名会被 dbhub 当 `~/.ssh/config` 别名，见 §4.3）。

## D7 — 权限方向不对称：模型可开只读、不可关只读 ✅（安全红线）
- `dbhub_configure` 传 `readOnly: true` → 允许（收窄权限）。
- `dbhub_configure` 传 `readOnly: false` → **拒绝**，回 `result.readOnlyUserOnly`（"关闭只读请在配置页操作"）。理由：否则模型能自行解除用户设的限制（提权）。
- **拦截点在 `runConfigure`（工具路径），不在 `setWorkspaceEnvOptions`** ——界面（浏览器 configOp）必须能自由关。
- SSH：模型可**新增/启用**（含触发"用户在弹窗里输入密码"的辅助流程），也可解除（解除隧道不会提权）；手工 SSH 的密码/口令**永远只能由用户在弹窗输入**，模型只能传 host/port/user/keyPath 这类非密字段。

## D8 — 模型可见文案与工具参数 ✅
- 新增非密参数：`readOnly`、`sshHost`、`sshPort`、`sshUser`、`sshAuthKind`（`key`|`password`）、`sshKeyPath`、`sshProxyJump`、`sshOff`（解除）。**绝无 `sshPassword`/`sshPassphrase`/`dsn`**（`zero-knowledge.test.mjs` 加断言）。
- `dbhub_execute_sql` 失败文本命中 `READONLY_VIOLATION`/`Read-only mode is enabled` → 追加 `result.readOnlyHint`（引导到配置页关闭），与既有 `result.authHint` 同一模式；注意 **`likelyAuthOrConnError` 现有正则不含 read-only**（已安全，别扩展成会误吞）。
- 工具描述补"只读模式 + SSH 隧道"能力说明（中文，模型可见），并说明密码由界面输入。

## D9 — 上游能力探测（版本护栏）✅
- 新 `lib/capability.mjs`：`detectDbhubCapabilities(exe)` → `{version, readonlyTools, ssh, warning}`；策略见 §4.6；结果写进 `runtime.json`（已支持未知字段保留）并按 exe 缓存；**只在启用只读/SSH 的环境上使用**。
- 文案 `result.dbhubTooOld`；view 增 `capabilities`（JSON 字符串），版本不满足时 UI 禁用只读/SSH 控件并显示原因（而不是点了才失败）。

## D10 — 自动发现的环境（未持久化行）如何挂选项 ✅
- `default` 可能是 `mise env`/`.env` 自动发现出来的（`persisted:false`），没有 store 行 → 选项无处安放。
- **选**：用户显式设置选项（或模型请求）时，宿主侧用**当前解析到的 DSN** 把该环境**提升为持久化行**（`source:'promoted'`）并写入选项；回执带 `result.promotedNotice`，UI 的"来源" tooltip 显示这一新来源。
- **否**：对自动行禁用开关（用户会走进死胡同：想给自动发现的生产库加只读，却被告知"请先手填连接串"）。
- 必须**只**在显式操作时发生（列源、查询、发布都不得触发持久化）。

## D11 — F0：移除 `showSidebarEntry`，侧边栏入口改由 `enabled` 驱动 ✅
- **语义**：`sidebarWanted()` = `valueOf(snapshot).enabled !== false`。禁用 → `syncSidebar()` dispose `sidebar.panellist` 注册；重新启用 → 重新注册（`face.subscribe(syncSidebar)` 与 `setEnabled` 后的通知已经覆盖时机，无需新通道）。
- **移除清单**（全链路，不留半吊子）：`options.mjs`（默认值/snapshot/get/VALIDATORS/`initFromLayers` 自动）、`config.mjs` 的 `normalizePrefs`（旧 prefs 里的该键被丢弃且不复活）、`index.mjs` 的 `STATUS_DEFAULTS`/`STATUS_SCHEMA`/`Config`、`client.js`（字典两键、draft、`cfgSummary`、设置条复选框、`sidebarWanted`）、测试与文档。
- **Config schema 缩一个字段是安全的**：schemastery 保留未知 config 键（3.18.2 与 3.18.5-alpha.1 均实测不抛）→ 仍钉着 `showSidebarEntry` 的 profile patch 不会让插件启动失败。
- **不自锁底线**（必须测）：禁用后 `settings.section` 与 `plugins.row.config` 仍注册、仍可操作；侧边栏入口消失即可。
- **否**：保留 `showSidebarEntry` 并让它与 `enabled` 求与（用户已明确要"去掉勾选"）。

## D12 — 版本号：5.1.0 ✅（用户已定）
次版本号（大功能新增/影响面较广，对使用者无破坏）；测试期 `5.1.0-dev.<n>`，n 从 1 递增不复用。

---

# 7. 契约（逐字段）

## 7.1 存储 v3（`lib/config.mjs`）
```js
export function normalizeSshOptions(raw)      // -> {host,port,user,auth,keyPath?,passphrase?,password?,proxyJump?} | null
export function readOnlyOf(envEntry)          // -> boolean
export function sshOf(envEntry)               // -> normalized ssh | null
export function describeEnvOptions(envEntry)  // -> 秘密安全元数据（镜像行/view 只能用这个）
export function setWorkspaceEnv(wsPath, env, dsn, source, opts)  // opts 缺省 => 保留既有选项
export function setWorkspaceEnvOptions(wsPath, env, patch)       // 只改选项；行不存在 => undefined
```
归一化规则：trim + 去控制字符 + 限长；`port` 1..65535 整数（缺省 22）；`auth` 白名单 `key|password`；manual 必填 `host`/`user`；`auth==='key'` 必填 `keyPath`；`auth==='password'` 必填 `password`（"留空=保持原值"由命令层先合并再归一化）；`proxyJump` 仅接受逗号分隔字符串；未知键丢弃。

`describeEnvOptions` 输出示例（**镜像行/view 只能用它**）：
```js
{ ro: true, ssh: { host:'bastion.example.com', port:22, user:'ops', authKind:'key',
                   hasPassword:false, hasPassphrase:true, keyReady:true, proxyJump:'' } }
```

## 7.2 执行侧「连接描述符」（`lib/mcp.mjs` / `lib/adhoc.mjs`）
```js
row = { wsPath, title, env, dsn, source, persisted, ro:false, ssh:null }
runAdhoc(subprocess, conn, rawName, mcpArgs, exec, label)   // conn = { dsn, ro, ssh }
probeConnection(subprocess, conn, timeoutMs)
```
- `listWorkspaceEnvironments`（122-140）、`resolveWorkspaceEnvs`（681-697）、`collectSources`（351-387）带出 `ro`/`ssh`。
- `summarizeRows`（225-237）只输出 `ro` + `describeEnvOptions(...).ssh`（**秘密安全**）。
- `applyRowPatch`（264-298）：`add`/`set` 分支带 `ro`/`ssh`；**新增 `options` 分支**（幂等合并）。
- 调用点共 3 处：`tools.runSourceTool`（110）、`tools.probeResult`（125）、`adhoc.probeConnection`（35）。

## 7.3 configOp 全表（`lib/index.mjs` `handleConfigOp` 272-342）

| op | 字段 | 语义 | 回推 patch |
| --- | --- | --- | --- |
| `test` | `workspace, env, nonce, dsn?` **+** `readOnly?, ssh?` | 探连；给了 `dsn`/`ssh` 就按"未保存的有效描述符"探（预校验），否则按已存行探 | 无（只回 `testResult`） |
| `add`/`set` | `workspace, env, dsn, source?, renameFrom?` **+** `readOnly?, ssh?` | 落连接 + 选项（一次原子写） | `{op:'add', …, ro, ssh}` |
| `rename` | `workspace, env, newEnv` | 改名（选项随 `{...current}` 一起搬，天然支持） | `{op:'rename', …}` |
| `remove` | `workspace, env` | 删除 | `{op:'remove', …}` |
| **`options`（新）** | `workspace, env, readOnly?, ssh?` | 只改选项；行不存在 → 先按 D10 提升，仍失败则 `patches: []` + 日志 | `{op:'options', path, env, ro, ssh}` |
| 其它 | — | `log.opUnknown`（现状） | `[]` |

`ssh` 字段（浏览器→宿主，允许含秘密）：
```js
{ host, port?, user, auth:'key'|'password', keyPath?, password?, passphrase?, proxyJump? }   // 配置
{ off: true }                                                                              // 解除隧道
```
**"留空 = 保持原值"** 只对秘密字段生效（`password`/`passphrase` 缺省或空串 → 保留已存值；`auth==='key'` 时 `keyPath` 空 → 保留已存路径）；非密字段留空 = 清空（校验会失败，属用户错误）。

## 7.4 view / STATUS_SCHEMA（`lib/index.mjs` 67-116）

- **删除** `showSidebarEntry`（D11）。
- **新增** `capabilities`（JSON 字符串 `{version, readonlyTools, ssh, warning}`，D9）。
- `workspaces` 行内新增 `ro`（boolean）与 `ssh`（元数据对象或无）；**仍绝不含 `dsn`**。
- 同步更新：`STATUS_DEFAULTS`、`STATUS_SCHEMA`、`STATUS_DEFAULTS` 的 fallback schema（`Object.keys(STATUS_DEFAULTS)` 自动覆盖）；两条通道（legacy 命名空间 / HTTP 桥）自动等价。

## 7.5 工具契约（`lib/tools.mjs`）
`dbhub_configure` 参数新增（全部非密）：`readOnly`、`sshHost`、`sshPort`、`sshUser`、`sshAuthKind`、`sshKeyPath`、`sshProxyJump`、`sshOff`。行为决策表：

| 传入内容 | 该 env 是否已有行 | 行为 |
| --- | --- | --- |
| 仅选项类（`readOnly`/`ssh*`） | 有 | 直接改选项 → 探连一次（含隧道）→ 回执"已开启只读 / 已配置 SSH + 校验结果"，**零弹窗** |
| 仅选项类 | 无（自动发现） | 按 D10 提升 + 改选项（回执说明提升） |
| 仅选项类 | 无且无自动发现 | `result.needConnFirst` |
| 选项类 + 连接信息 | 有（同端点） | 端点探连（现状逻辑）→ 落连接 + 选项 |
| 选项类 + 连接信息 | 无 / 端点变了 | 现有 prefill→probe→ask 流程；选项在最终落库时一并写入 |
| `readOnly:false` | 任意 | **拒绝**：`result.readOnlyUserOnly` |
| `sshAuthKind:'password'` 且未给密码 | 任意 | `askUser` 弹窗只问密码（header 带 `host:port user` 元数据，`detail` 带试连失败原因）→ 落库 + 探连 |
| `sshAuthKind:'key'` 且未给 `keyPath` | 任意 | `askUser` 问密钥路径（+ 可选口令） |
| 缺 host/user | 任意 | 拒绝 → 引导补全（`result.sshMissingUser` 等） |
| `sshOff:true` | 有 | 删除 ssh 配置（保留 DSN 与只读） |

`dbhub_execute_sql` / `dbhub_search_objects` 参数**不变**（只读/隧道是环境属性）。

## 7.6 spawn 契约（`lib/adhoc.mjs` + 新 `lib/toml.mjs`）
```js
export function buildDbhubToml({ ro, ssh })   // -> { text, env }   // text 必无秘密
export function writeTempToml(text)           // -> 绝对路径（DATA_DIR/tmp/dbhub-<pid>-<n>-<rand>.toml, 0o600）
export function removeTempToml(path)          // 尽力删除，失败仅 warnOnce（Windows EBUSY/dbhub watcher）
export function sweepTempToml(maxAgeMs = 3600_000)  // 启动时清理陈旧残留（崩溃兜底）
```
- 临时目录 `DATA_DIR/tmp`；`startBackgroundBoot`（index.mjs 618）里跑一次 `sweepTempToml()`。
- argv：`buildSpawnArgv(subprocess, exe, ['--transport','stdio','--config', tomlPath])`（沿用 82 行的 Windows `.cmd` 包装）。
- `env: { ...process.env, ...env }`（D3）。
- **探连超时分档**：宿主 `TEST_TIMEOUT_MS`（index.mjs 184）必须低于客户端看门狗（`dispatchPretest` 796-806）：
  - 无 SSH：宿主 25000 / 客户端 30000（现状，不动）；
  - 有 SSH：宿主 45000 / 客户端 60000（SSH 握手 + 隧道更慢）。
  两者大小关系要有测试断言。

## 7.7 错误与引导文案矩阵（宿主 i18n 新键，zh/en 成对）

| 场景 | 键 | 触发点 |
| --- | --- | --- |
| 只读命中 | `result.readOnlyHint` | `runSourceTool`（与 `authHint` 并列） |
| 关闭只读仅限界面 | `result.readOnlyUserOnly` | `runConfigure`（D7） |
| 开启/关闭只读成功 | `result.readOnlyOn` / `result.readOnlyOff` | `runConfigure` / options op |
| SSH 已配置 / 已解除 | `result.sshSet` / `result.sshCleared` | 同上 |
| 缺少 SSH 用户 / 凭据 | `result.sshMissingUser` / `result.sshMissingAuth` | `normalizeSshOptions` + `runConfigure` |
| 多跳跳板不支持 | `result.sshMultiHopUnsupported` | `normalizeSshOptions`/`runConfigure` |
| 选项行不存在 | `result.needConnFirst` | §7.5 |
| 自动发现行被提升 | `result.promotedNotice` | D10 |
| dbhub 版本过旧 | `result.dbhubTooOld` | D9 |
| 卡片日志 | `log.opOptions`、`log.sshTunnelUp`、`log.tomlSwept` | index.mjs |

**脱敏纪律**：新增文案里的示例主机只用 `127.0.0.1`/`localhost`/RFC 5737（`192.0.2.x`/`198.51.100.x`/`203.0.113.x`），示例密码只用 `CHANGE_ME`。

---

# 8. 实施任务卡

> 每个任务：**改动点 → 验收**。全部完成后跑 §9 全绿 + §10 冷启动。实施中按 `implementation-notes` 约定维护根目录 `implementation-notes.md`（本轮建议新开一节 "5.1 只读与 SSH"）。
> 分支：所有改动落 `dev`（AGENTS.md「分支与发布流程」）。

## Phase 0 — 护栏与脚手架（先做）

### T0.1 上游能力/版本探测
- **改动**：新 `lib/capability.mjs`：`detectDbhubCapabilities(exe)`（§4.6）；`runtime.json` 增缓存（`normalizeRuntime` 已保留未知字段）；`index.mjs` 的 `startBackgroundBoot` 后台探测一次，结果进 view 的 `capabilities`。
- **验收**：新 `test/capability.test.mjs`：受管目录有 package.json → 解析出版本；mise 路径形态；找不到 → `unknown` 且不阻塞；`<1.0.0` → 不支持；`1.2.0` → 支持 + warning。

### T0.2 新纯模块 `lib/toml.mjs` + 单测
- **改动**：`buildDbhubToml` / `writeTempToml` / `removeTempToml` / `sweepTempToml`（§7.6、附录 B）。
- **要点**：TOML 基本字符串转义（`"`/`\`/换行）；`id = "default"` 固定；**只读必写两条 `[[tools]]`**；秘密一律 `${VAR}` 且 `env` 必有值；`ssh_key` 路径（含 `~/`）与 base64 原样透传。
- **验收**：新 `test/toml.test.mjs`（≥12 例）：无选项不生成；只读两条 tools 且含 `search_objects`；ssh 各字段；**文本不含任何秘密字面量**（假密码断言 `!text.includes(pw)`）；**文本引用的变量集合 == `env` 键集合**（互相校验）；空字段不输出。

### T0.3 临时目录与 GC
- **改动**：`toml.mjs` 导出临时目录常量；`startBackgroundBoot` 调 `sweepTempToml()`。
- **验收**：写入 N 个文件 + 伪造 mtime → sweep 只删过期；`removeTempToml` 对不存在路径不抛；目录被删后写入会重建（复用 `ensureStorageDir`）。

### T0.4 顺手修 `runCopyFrom` 调用错位（§1.3）
- **改动**：`lib/tools.mjs:302` → `runCopyFrom(ctx, subprocess, target, copyFrom, envName0)`。
- **验收**：新 `test/copy-from.test.mjs`（假 ctx/subprocess）：正确解析源行、`setWorkspaceEnv` 落到 `target.path`；`renameFrom`+`copyFrom` 同给 → `result.argConflict`（已有）。

## Phase 1 — F0：侧边栏入口随启用状态（移除 `showSidebarEntry`）

### T1.1 options/config：删字段
- **改动**：`lib/options.mjs`（`BUILTIN_DEFAULTS` 删 17、初始化 36-38 删、`snapshot` 67 删、`get` 注释、`VALIDATORS` 84 删）；`lib/config.mjs`（`normalizePrefs` 296 删该行 + 17 行注释）；`lib/index.mjs`（`STATUS_DEFAULTS` 78、`STATUS_SCHEMA` 112、`Config` 125）。
- **要点**：旧 `prefs.json` 里的 `showSidebarEntry` 被顶掉即可（`savePrefs` 走 `normalizePrefs`）；旧 profile patch 里钉着的该键不会导致启动失败（schemastery 保留未知键）。
- **验收**：改 `test/options.test.mjs`（删/改所有 `showSidebarEntry` 断言，新增一条"prefs 里的旧键被丢弃且不复活"）；`test/bridge.test.mjs`（fixture 与 options 补丁改为只带 `updateIntervalDays`）。

### T1.2 client：入口改由 enabled 驱动 + UI 去勾选
- **改动**：`lib/client.js`：`sidebarWanted`（1495-1499）→ `return v.enabled !== false;`（注释 1489 重写为"入口随插件启用状态显隐；禁用后设置页/插件页仍可达，不自锁"）；删设置条复选框（1141-1148）与 `cfgSummary`（956）里的开关摘要、draft 相关（676/688/693/695）；删字典键 `cfg.sidebar`/`cfg.sidebarHint`（zh 69-70 / en 141-142），新增 `cfg.disabledHint`（禁用时提示"侧边栏入口已隐藏，可在设置页重新启用"）。
- **验收**：`node test/client-format.test.mjs` 的 :89-99 改写为"侧边栏入口由 enabled 驱动 + 禁用后 dispose + 设置页仍注册"；`npm run check:ui` 的 [8] 562-563 改为断言设置条**不含**侧边栏开关且含禁用提示；新增组 **[19] 禁用 → 侧边栏入口消失、设置页仍在；重新启用 → 入口回来**（用 `registrations`/`dispose` 计数与 `setEnabled` 交互）；[18] 里 805 的 `saveConfig({updateIntervalDays:3, showSidebarEntry:false})` 改为只传间隔。
- **门禁注意**：`render-check` fixture 386 里的 `showSidebarEntry` 字段删掉。

### T1.3 Phase 1 收口
- §9 全绿 + §10.3 V0（F0 专项）。

## Phase 2 — F1：环境只读

### T2.1 存储层：`readOnly` + 选项合并
- **改动**：`lib/config.mjs`：`readOnlyOf`、`setWorkspaceEnv` 签名扩展（保留语义）、`setWorkspaceEnvOptions`、`listWorkspaceEnvironments`/`resolveWorkspaceEnvs` 带出 `ro`。
- **验收**：新 `test/env-options.test.mjs`：v2 读入 → `ro=false`；写 `readOnly:true` → 落盘读回；`setWorkspaceEnv` 不带 opts → **保留**；`{readOnly:false}` → 字段删除；未知字段保留不回归；`renameWorkspaceEnv` 后选项跟随。

### T2.2 命令通道：`options` op + `test` op 扩展（宿主）
- **改动**：`lib/index.mjs`：`handleConfigOp` 增 `options` 分支（含 D10 提升）、`handleTestOp` 支持未保存描述符、`log.opOptions`；`TEST_TIMEOUT_MS` 分档（§7.6）。
- **验收**：`test/init.test.mjs`/`test/bridge.test.mjs` 增补：`POST /op {op:{op:'options',…}}` → 200 且 `patches` 含 `{op:'options'}`；未知 op 仍 `[]`；提升成功/失败两条路径。

### T2.3 执行层：连接描述符 + TOML 分支
- **改动**：`lib/adhoc.mjs`（`probeConnection`/`runAdhoc` 改签名 + TOML 分支 + 临时文件生命周期）、`lib/tools.mjs`（3 个调用点）、`lib/mcp.mjs`（`collectSources` 行带 `ro`/`ssh`）。
- **要点**：普通行**必须**仍走 `--dsn`。
- **验收**：新 `test/adhoc-toml.test.mjs`（假 `subprocess.spawn` 记录 spec）：无选项 → `['--dsn', dsn]`；只读 → `['--config', <tmp>]` + 文本两条 `[[tools]]` + `env.DSH_DBHUB_SEC_DSN` 存在 + 文件已写；`finally` 删除；超时分档常量关系。

### T2.4 只读违规引导（模型面）
- **改动**：`readOnlyViolation(text)`（`adhoc.mjs` 或 `tools.mjs`）；`runSourceTool` 命中追加 `result.readOnlyHint`；`i18n.mjs` 增键。
- **验收**：`test/util.test.mjs` 增补分类用例；`test/zero-knowledge.test.mjs` 保持绿。

### T2.5 工具面：`readOnly` 参数 + 决策表 + D7 拦截
- **改动**：`lib/tools.mjs`：schema 增 `readOnly`；`runConfigure` 早期新增"仅选项类"分支（§7.5）；`readOnly:false` 拦截；描述补能力。
- **验收**：新 `test/configure-options.test.mjs`（假 ctx/askUser/subprocess）：仅 `readOnly:true` + 已存行 → 落库且零弹窗；`readOnly:false` → `result.readOnlyUserOnly`；无行无自动发现 → `result.needConnFirst`；选项 + 端点不变 → 保留原 DSN。

### T2.6 UI：只读开关 + 行内标记
- **改动**：`lib/client.js`：`uiMemory` 增 `advOpen`（同批改 `client-format:322`）；`addState`/`editState` 增 `ro`；addPanel/editRow 复选框；`envRow`/`tileView` 的 env chip 增 `dbh-ro` + title 组合；`connDraftOf(form)` 统一产出 `{readOnly, ssh}` 并 spread 进**四处** op 构造点（795、819-821、909、745/750）；`CSS_TEXT` 增 `.dbh-checkbox`/`.dbh-ro`/`.dbh-adv*`（只用 token + 中性半透明兜底）；i18n 键 zh/en 成对。
- **验收**：`npm run check:ui` 全绿（含新组 **[20] 只读开关 → op 载荷 → 行内标记**）+ `client-format`（同批更新 :322 与 :224 的形状断言）。

## Phase 2B — F4：连接测试性能（用户报告；依赖 T2.2 已改完 `handleTestOp`）

> 目标：点一次 ▶ 的总耗时 ≈ 一次探连本身（不再叠加"为拿 DSN 而重扫全部工作区"）。
> **先做 T2B.1 拿到分段数据**，再动 T2B.2/T2B.3 —— 避免在错误的假设上优化。

### T2B.1 先加分段计时（不改行为）
- **改动**：`lib/index.mjs` 的 `handleTestOp`：分别记录 **walk 耗时**（`collectSources` 前后）与 **probe 耗时**（`probeConnection` 前后），打两行 milestone 日志（新 i18n 键 `log.testWalkMs` / `log.testProbeMs`）；`lib/tools.mjs` 的 `runSourceTool` 同样记录 walk 耗时，便于对照模型侧。
- **验收**：点一次 ▶，日志出现两段数字；用 §1.4.3 的方法（文本里的 `ms` vs 感知总时长）与该日志互相印证，确认 walk 是不是主因。**把实测数字写进 `implementation-notes.md`**（用户机器上的数字最有价值）。

### T2B.2 `resolveTestDsn` 纯函数 + 三档解析顺序
- **改动**：新纯函数（放 `lib/mcp.mjs`，只读输入、可单测）：
  ```js
  export function resolveTestDsn({ storeRows, cachedRows, hasCache, walk }) 
  //   判定顺序：① storeRows（持久化行，权威）→ {dsn, from:'store'}
  //             ② cachedRows（宿主内存里卡片正在显示的行）→ {dsn, from:'cache'}
  //             ③ 都没有 → 由调用方 await walk()
  ```
  `handleTestOp` 改为：`storeRows = listWorkspaceEnvironments(store)`（config.mjs 122，已在内存）、`cachedRows = mcp.cachedRows()`；只有第 ③ 档才 `await collectSources(...)`。
- **要点**：**语义不变** —— 对持久化行 store 就是权威值（不存在"测得不准"）；对自动发现行，第 ② 档测的是**用户屏幕上正在显示的那条**（一致），冷缓存才重新发现。零知识不破（DSN 始终不出宿主）。
- **验收**：新 `test/test-op-fastpath.test.mjs`：① 持久化行 → `from === 'store'` 且 **walk 桩未被调用**；② 仅缓存行 → `from === 'cache'`、walk 未调用；③ 都没有 → 走 walk 且结果正确；④ 三档 DSN 一致（同一行三种来源给出同一个 DSN）。

### T2B.3 导出缓存行访问器
- **改动**：`lib/mcp.mjs` 导出 `cachedRows()`（`lastRowCache` 的浅拷贝）与 `cachedRow(wsPath, env)`；`hasRowCache()` 沿用（245）。
- **验收**：`test/row-cache.test.mjs` 增补：未 walk 前 `cachedRows()` 为空且 `hasRowCache()` 为假；walk 后能按 `wsPath+env` 取到；`applyRowPatch` 之后取到的是补丁后的行。

### T2B.4 在途去重（walk 与自动发现）
- **改动**：
  - `lib/config.mjs` 的 `resolveAutoDsn`（643-649）：加模块级 `autoDsnInFlight: Map<wsPath, Promise>`；命中在途 → 复用同一个 Promise；`finally` 删除（**不缓存 rejection**，失败要能重试）；`resetAutoDsnCache()` 同时清空。
  - `lib/mcp.mjs` 的 `collectSources`（351）：加模块级 `walkInFlight`；并发调用共享同一次 walk（可加 `{ force:true }` 给显式重扫用）。
- **要点**：不得改变发布路径既有的单飞语义（`runWalk` 仍在，index.mjs 418-432）；异常路径必须清理在途句柄，否则后续调用会永久拿到一个已 reject 的 Promise。
- **验收**：`test/auto-dsn.test.mjs` 增补：并发两次 `resolveAutoDsn`（同一 wsPath）→ 伪 `subprocess` **只记录一次 spawn**；第一次失败后第二次仍会真正重试；`test/row-cache.test.mjs` 或新文件覆盖 `collectSources` 并发共享（伪 ctx 计数 walk 次数）。

### T2B.5 模型侧快路径（同类浪费，推荐同批）
- **改动**：`lib/mcp.mjs` 的 `resolveSource`（186）：若 `hasRowCache()` 且 `sourceRef` 能在缓存行里精确命中（**用 `sourceIdOf` 比较，别自己拼**）→ 直接返回该行；未命中再走 `collectSources`。
- **要点**：命中即用与"先 `dbhub_list_sources` 再执行"语义一致；新增连接尚未进缓存时自然回落 walk。**绝不能**用缓存代替 walk 来"猜"目标（歧义判定 `pickBest` 必须保持原样）。
- **验收**：`test/resolve-source.test.mjs` 增补：缓存命中时 walk 未被调用且返回同一 id；未命中回落 walk；歧义场景仍返回 `{ambiguous}`（不得被快路径吞掉）。

### T2B.6 界面：测试中显示已耗时
- **改动**：`lib/client.js` 的 `startTest`（873）记录 `startedAt`，`testing` 态显示 `测试中… Xs`（**只在 testing 态**开 1s 计时器，完成/卸载/超时时清理——遵守"空闲不轮询/不残留 interval"红线）；新增 i18n 键 `test.elapsed`（zh/en）。
- **验收**：`npm run check:ui` 新组 **[22]**：测试中显示计时并递增；完成后计时器被清理（`check:ui` 会因残留 interval 挂住不退出，本身就是门禁）；`client-format` 同步（若新增字面量）。

## Phase 3 — F2：SSH 隧道（手动配置）

### T3.1 归一化与校验（纯函数）
- **改动**：`lib/config.mjs`：`normalizeSshOptions` 完整实现（§7.1）、`sshOf`、`describeEnvOptions`（`keyReady` 用 `existsSync` 并容错）。
- **验收**：`test/env-options.test.mjs` 增补：非法 mode/auth/port/缺字段 → null 或错误常量；**秘密不出现在 `describeEnvOptions`**；`hasPassword`/`hasPassphrase`/`keyReady` 正确。

### T3.2 命令/工具通道 + 弹窗辅助
- **改动**：`index.mjs` 的 `options`/`test` 支持 `ssh`；`tools.mjs` 的 `runConfigure` 支持 SSH 参数与 `askUser` 补密钥路径/密码（§7.5 后四行）；`i18n.mjs` 增键。
- **验收**：新 `test/configure-ssh.test.mjs`：假 `askUser` 返回密码 → 落库 `ssh.password` 且**回执不含密码**；缺 user → `result.sshMissingUser`；用户取消 → `result.modeCanceled`；探连失败 → 带失败原因；`sshOff` → 删除且保留 DSN/只读。

### T3.3 执行层物化 + 清洗
- **改动**：`lib/toml.mjs` 补齐 ssh 字段（密码/口令走 `${…}`，密钥路径直写）；`adhoc.mjs` 把 ssh 秘密放进 `env` 并纳入 `scrubSecrets` 的 `extraSecrets`。
- **验收**：`test/toml.test.mjs`/`test/adhoc-toml.test.mjs`/`test/util.test.mjs` 增补：三字段各有断言；`scrubSecrets(text, dsn, [pw])` 覆盖 ssh 密码且既有调用不受影响。

### T3.4 UI：高级区（手动 SSH）
- **改动**：`client.js` 新增 `.dbh-adv`（字段见 D6）；`addPanel`/`editRow` 接入；`connDraftOf` 产出 ssh 草稿；预检（`dbh-pretest`）携带 ssh；`dispatchPretest` 看门狗按 ssh 分档（30s→60s）；`CSS_TEXT`；i18n。
- **验收**：`npm run check:ui` 新组 **[21] 高级 SSH：展开 → 选密码认证 → 填 host/user/密码 → op 载荷带 ssh，且密码不出现在渲染文本**；`client-format` 同步。

## Phase 4 — 文档与发布

### T4.1 `doc/REQUIREMENTS.md`
- **改 R43/R44/R49/R58**（侧边栏开关→随启用状态；选项只剩自动更新间隔）。
- **新增**：R59 环境级只读（dbhub 原生执行；关闭只读必须由人在界面操作；模型只能开不能关）；R60 SSH 隧道（手填，凭据不在模型上下文；密码由界面输入）；R61 试连必须验证"有效连接"（含隧道与只读）；R62 dbhub 能力门槛（不支持时给明确错误与升级指引，不得静默降级）；R63 自动发现环境被显式设置选项时提升为持久化行并告知用户。

### T4.2 `AGENTS.md`
- 目录结构加 `lib/toml.mjs`、`lib/capability.mjs` 与依赖方向。
- 「关键架构事实」新增：**唯一允许的 toml 是"每次调用生成的一次性 TOML"**（无秘密、`tmp/`、用完即删 + 启动 GC）+ `--dsn`/`--config` 互斥 + `[[tools]]` 白名单陷阱 + `${VAR}`+`spawn.env` 秘密通道；明确**禁止**把常驻 toml/热重载/多源装回来。
- 删除/改写所有 `showSidebarEntry` 段落（17、23、43、44、112、127 行）为"侧边栏入口随启用状态显隐"。
- 「调试方法」加只读验证（期望 `READONLY_VIOLATION`）、SSH 验证、`tmp/` 无残留检查；「质量门」加新测试文件；「可配置参数」条改为只剩 `updateIntervalDays`。

### T4.3 README 双语
- `README.md`（真源）：只读开关用法与语义（哪些语句会被拒）、SSH 隧道手填字段与前提（1.4.0+、内网库主机要写"从跳板机看过去"的地址、多跳/agent/ProxyCommand 不支持）、失败排查；删除"在侧边栏显示入口"相关行（23、95、98、109）改为"入口随插件启用状态显隐；禁用后仍可从设置页/插件页进入"。`README.en.md` 同批派生。

### T4.4 脱敏槽位
- `scripts/desensitize.config.mjs`：`connection-code` 槽位 globs 加 `lib/toml.mjs`、`lib/capability.mjs`（或新增 `toml-code` 槽位）；示例主机/密码约定见 §7.7。
- 验收：`npm run check:secrets` 零匹配。

### T4.5 版本与冷启动
- `package.json` → `5.1.0-dev.1`；`check` 脚本纳入新文件。
- 按 AGENTS.md 流程：`pnpm pack`（`npm_config_store_dir` 指回 workspace 内）→ 隔离 home `.dsh-a` 冷启动 → §10 全清单 → CI（`gate`）绿。
- **正式版（仅用户明确要求时）**：版本转正 `5.1.0` → PR `dev`→`main` → tag `v5.1.0` → `gh release create --latest` → npm 发布命令**交给用户手动执行**。

---

# 9. 测试与质量门

## 9.1 新增测试文件

| 文件 | 覆盖 |
| --- | --- |
| `test/toml.test.mjs` | `buildDbhubToml` 全字段（只读双条目、无秘密、`env`↔引用一致、转义、空字段不输出） |
| `test/capability.test.mjs` | 版本探测矩阵 |
| `test/env-options.test.mjs` | 存储 v3（保留/清除/rename 跟随/未知字段不丢）+ `normalizeSshOptions` + `describeEnvOptions` 无秘密 |
| `test/adhoc-toml.test.mjs` | spawn 契约（`--dsn` vs `--config`、env 携带秘密、临时文件清理、超时分档） |
| `test/configure-options.test.mjs` | §7.5 决策表（含 D7 拦截、D10 提升） |
| `test/configure-ssh.test.mjs` | SSH 交互（askUser 密码路径、取消、校验、回执无密码） |
| `test/copy-from.test.mjs` | T0.4 回归 |
| `test/test-op-fastpath.test.mjs` | F4：`resolveTestDsn` 三档顺序（store → 缓存行 → walk）+ "持久化行不 walk" + 三档 DSN 一致 |

## 9.2 既有测试的增补

- `test/options.test.mjs`：删 `showSidebarEntry` 断言 + 新增"旧 prefs 键被丢弃不复活"。
- `test/bridge.test.mjs`：view fixture 与 options 补丁去 `showSidebarEntry`；新增 `options` op 往返；view 含 `capabilities`。
- `test/init.test.mjs`：`options` op、`test` op 带 ssh/readOnly、`STATUS_SCHEMA` 键集合。
- `test/row-cache.test.mjs`：`applyRowPatch` 的 `ro`/`ssh` + `options` 分支幂等。
- `test/zero-knowledge.test.mjs`：`summarizeRows` 不含 ssh 秘密；工具源码**不得**出现 `sshPassword`/`sshPassphrase` 参数；i18n 新键自动纳入既有循环。
- `test/util.test.mjs`：`scrubSecrets` 的 `extraSecrets`、`readOnlyViolation`。
- `test/resolve-*.test.mjs` / `test/auto-dsn.test.mjs`：行对象新增字段若被深比较，需同批更新。

## 9.3 `test/client-format.test.mjs` 必须同批修改

| 行 | 现断言 | 改动 |
| --- | --- | --- |
| :89-99 | 侧边栏入口由 `showSidebarEntry` 控制 | 改为"由 `enabled` 驱动 + 禁用后 dispose + 设置页仍注册" |
| :322 | `uiMemory` 字面量精确匹配 | 加 `advOpen: false` |
| :224 | `addDsn` 的 `requestWrite` 精确形状 | 改为断言 `connDraftOf` 存在 + spread 进该字面量 |
| :206-208 | 两处 `disabled: pendingPretest,\n onClick:` 相邻 | 保持（新字段不得插进这两行之间） |
| :248 | `doesNotMatch /w\.dsn/` | **保持不变**（`w.ssh` 元数据允许；秘密字段名不得出现在 client.js） |
| :27 | require 深比较 | 保持不变（不新增 require） |
| :271-291 | 样式 token 门 | 新 CSS 只用 token/中性半透明 |
| :293 | configOp ops | 增 `op:"options"` |

## 9.4 `scripts/render-check.mjs`

- **既有**：fixture 386 去 `showSidebarEntry`；[8] 562-563 改为"设置条不含侧边栏开关"；[18] 805 的 `saveConfig` 只传间隔；**[1] `dbh-iconbtn === 8` 不改**（不加图标按钮）；**[8] `dbh-field === 3` 不改**（复选框用 `dbh-checkbox`）；**[15]/[16] `typeWithin` 索引 0..2 不改**（新输入框必须排在 DSN 之后——写成实现注释）；[13] 无 `dbh-pill` → `dbh-ro` 是另一个类名，安全。
- **新增**：[19] 禁用→侧边栏入口消失/设置页仍在/重新启用恢复；[20] 只读开关→op 载荷→行内标记；[21] 高级 SSH 手填→op 载荷且秘密不进渲染文本；**[22] 测试中显示已耗时且计时器可回收**（F4/T2B.6）。

## 9.5 质量门命令（沙箱下逐文件跑测）

```powershell
npm run check; npm run check:secrets; npm run check:ui
node test/util.test.mjs; node test/state.test.mjs; node test/options.test.mjs
node test/init.test.mjs; node test/i18n.test.mjs
node test/resolve-source.test.mjs; node test/resolve-workspace.test.mjs
node test/row-cache.test.mjs; node test/auto-dsn.test.mjs; node test/bridge.test.mjs
node test/client-format.test.mjs; node test/zero-knowledge.test.mjs
# 本轮新增：
node test/toml.test.mjs; node test/capability.test.mjs; node test/env-options.test.mjs
node test/adhoc-toml.test.mjs; node test/configure-options.test.mjs
node test/configure-ssh.test.mjs; node test/copy-from.test.mjs
node test/test-op-fastpath.test.mjs
```
**并必须看 CI（`gate`）**：本地 Windows 会掩盖只影响 Linux 的缺陷（`unref` 计时器教训）；本地全绿不等于可发布。

---

# 10. 验证步骤

## 10.1 静态与会话内（零风险）
1. §9.5 全绿。
2. 生成器旁路验证：`node -e` 调 `buildDbhubToml` 打印文本 → 确认无秘密、双 `[[tools]]`。
3. 用真实 dbhub 冒烟（不经插件）：把生成的 TOML 落临时目录 + `dbhub --transport stdio --config <file>` + 喂 `initialize`/`tools/list`/`tools/call`（附录 A 命令可直接复用）。

## 10.2 隔离实例冷启动（`.dsh-a`）
```powershell
$env:npm_config_store_dir='D:/my/app/dsh/plugin/.pnpm-store'; pnpm pack
$env:DSH_HOME='D:/my/app/dsh/plugin/.dsh-a'
Remove-Item Env:DSH_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:DSH_PROFILE_DIR -ErrorAction SilentlyContinue
node <dsh 安装目录>/lib/bin.js web --port 3082 --no-open
```
期望日志：`host apply` + `dbhub 插件已加载（4 个工具）` + `浏览器桥接已注册` + 能力探测结果。
接口校验（带会话 cookie）：
```
GET  /api/dsh-dbhub-live/state        # 200 + value 含 capabilities，且**不含 showSidebarEntry**
GET  /api/dsh-dbhub-live/state（无 cookie）  # 401
POST /api/dsh-dbhub-live/enabled {"enabled":false}   # 200 → 侧边栏入口消失（浏览器确认）
POST /api/dsh-dbhub-live/op {"op":{"op":"options","workspace":"<ws>","env":"default","readOnly":true}}  # 200 + patches
POST /api/dsh-dbhub-live/op {"op":{"op":"nope"}}     # 200 + patches: []
```
浏览器 `127.0.0.1:3082`：设置页可开、行内出现只读标记、禁用后侧边栏入口消失且设置页仍可重新启用。

## 10.3 功能验收清单

| # | 步骤 | 期望 |
| --- | --- | --- |
| V0 | 点"禁用" → 看侧边栏 | 入口立即消失；**设置页仍可打开**、能点"启用"恢复；恢复后入口回来；`prefs.json` 里不再出现 `showSidebarEntry`；把旧 `prefs.json`（带该键）放回去重启 → 不报错、键被丢弃 |
| V1 | UI 给某环境勾只读并保存 | store 出现 `readOnly:true`；行内只读标记；`dbhub_list_sources` 结构不变 |
| V2 | 模型对该 source 执行 `UPDATE`/`CREATE` | `READONLY_VIOLATION` 原文 + **中文引导** |
| V3 | 模型对该 source 执行 `SELECT` 与 `dbhub_search_objects` | 均成功 → **白名单陷阱回归点** |
| V4 | 模型调用 `dbhub_configure(readOnly:false)` | 被拒 + 指引；store 未变；界面关只读后立刻可写 |
| V5 | 一次调用后检查 `storages/dsh-dbhub-live/tmp/` | 无残留；人为留旧文件 → 重启被 sweep |
| V6 | grep 生成过的 TOML 文本找密码 | 零命中（文件里只有 `${DSH_DBHUB_SEC_…}`） |
| V7 | 手填 SSH + 密码认证（用一台可达主机，密码在弹窗输入） | `SELECT 1` 经隧道成功；store 里有 ssh 配置；回执与日志不含密码 |
| V8 | 手填 SSH + 密钥认证（用本机 `~/.ssh/id_ed25519` + 可达主机） | 成功；密钥路径不回显给浏览器（只给 `keyReady`） |
| V9 | `ProxyJump` 填两个跳板（逗号分隔） | 明确报"多跳不支持" + 指引；单跳可用 |
| V10 | 把 dbhub 换成 0.x（或伪造版本），对开启只读的环境执行 | `result.dbhubTooOld`，**不**出现"连上了但静默忽略只读" |
| V11 | 版本/通道回归 | 0.1.x 线（`.dsh-b` + 0.1.6 CLI）与 0.2.x 线都能打开配置页、读写选项、`/state` 401/200 正确；侧边栏显隐在两线上都跟随启用状态 |
| V12 | `copyFrom` 回归 | 模型 `dbhub_configure(copyFrom:'<其他工作区 source>')` 真正在当前工作区建行 |
| V13 | **F4 性能**：对一条**持久化**行点 ▶，并把环境行 ▶ 与模型 `dbhub_execute_sql` 各跑 3 次 | ① 日志里**不再出现 walk 段**（持久化行直读 store）；② 点 ▶ 的总耗时 − 文本里的 probe `ms` ≈ 0（用户机器上目标值 <300 ms）；③ 模型侧同样因 T2B.5 命中缓存而变快；④ 自动发现行（`persisted:false`）在**冷缓存**下仍能正确测出结果（允许较慢，但必须正确） |

## 10.4 手工回归
- 只读开/关交替连续调用同一环境 → 每次重新读取选项（无缓存污染）、临时文件唯一且清理。
- 并发 3 次（2 个 TOML 行 + 1 个普通行）→ 全部成功。
- 禁用/启用快速切换 → 侧边栏入口 register/dispose 不残留、不重复。

---

# 11. 风险与回退

| ID | 风险 | 缓解 |
| --- | --- | --- |
| R1 | `[[tools]]` 白名单挤掉 `search_objects` | 生成器**强制**两条 tools + 单测 + V3 回归；模板注释写明原因 |
| R2 | 上游方言漂移（0.x/1.x/未来 2.x） | T0.1 能力探测 + `result.dbhubTooOld`；**绝不生成未实测的旧写法**（`read_only` 会被静默忽略——最危险） |
| R3 | 临时 TOML 残留/删除失败（Windows EBUSY、config watcher） | 无密内容 + `tmp/` 隔离 + `finally` 尽力删 + 启动 sweep |
| R4 | 多跳/ProxyCommand/agent 无法表达 | 显式拒绝 + 可执行指引（UI 同时说明）；`ssh_host` 无点裸名会被当别名 → UI 提示"填域名或 IP" |
| R5 | `${VAR}` 未定义被保留成字面量（不报错） | 生成器只输出已知字段；文本引用集合与 `env` 键集合**互相校验**（单测） |
| R6 | 零知识边界被 ssh 秘密稀释 | `scrubSecrets` 扩展 + 镜像行只给 `describeEnvOptions` + 秘密只从界面输入 + `zero-knowledge.test.mjs` 增断言 + `check:secrets` |
| R7 | `render-check`/`client-format` 大量精确断言被打破 | §9.3/§9.4 逐条清单；"新输入框必须排在 dsn 之后""复选框不得用 `.dbh-input`/`.dbh-field`"写成实现注释 |
| R8 | F0 移除选项导致旧部署异常（旧 prefs / 旧 profile patch） | 已论证安全：`normalizePrefs` 丢弃旧键、schemastery 保留未知 config 键；V0 专门验证 |
| R9 | F0 自锁（禁用后配置页也进不去） | 侧边栏是"可选入口"，`settings.section` 与 `plugins.row.config` 不随禁用消失；[19]/V0 断言 |
| R10 | `copyFrom` 既有 bug 与本次改动交织 | T0.4 先修 + 回归测试，独立提交便于二分 |
| R11 | 探连预算与看门狗错配（SSH 更慢） | §7.6 分档 + 单测断言 `host < client` |
| R12 | 沙箱/CI 环境差异 | 新代码不得 `unref()` 计时器；新增 spawn 逻辑测试用假 `subprocess`；看 CI |
| R13 | F4 快路径把"快"做成"测得不准" | 判定顺序固定为 **store（持久化行=权威）→ 已缓存行（=用户屏幕上显示的那条）→ walk**；`pickBest` 歧义逻辑不得被绕过；`test-op-fastpath.test.mjs` 断言三档给出同一 DSN；自动发现行冷缓存时**必须**回落到真实 walk（不得仅凭缓存判定"未配置"） |
| R14 | F4 在途去重引入"僵尸 Promise"（一次失败被永久缓存） | 在途句柄必须 `finally` 清理、**不缓存 rejection**；`resetAutoDsnCache()` 一并清空；单测覆盖"失败后下次仍会重试" |

**回退策略（逐特性可关，无需回滚代码）**：不配 `readOnly`/`ssh` 的环境走与 5.0.1 **逐字节相同**的 `--dsn` 路径；出问题就关掉该环境的开关；再退一步可禁用插件（禁用现在还会隐藏侧边栏入口，因此**必须**从设置页或插件页恢复——这正是 V0 要验证的）。F0 若要回退：恢复 `showSidebarEntry` 选项即可（改动是自包含的）。

---

# 12. 文档与发布清单

- [ ] `doc/REQUIREMENTS.md`：改 R43/R44/R49/R58，新增 R59–R63（T4.1）
- [ ] `AGENTS.md`：新模块/依赖方向/一次性 TOML 事实与禁令/侧边栏语义改写/调试方法/质量门（T4.2）
- [ ] `README.md` + `README.en.md` 双语同步（T4.3）
- [ ] `scripts/desensitize.config.mjs` 槽位 + `npm run check:secrets` 零匹配（T4.4）
- [ ] `package.json`：`check` 脚本 + `5.1.0-dev.1`
- [ ] `implementation-notes.md`（根目录，不进包）：本轮偏离与边界情况
- [ ] 发布前：隔离实例冷启动 + §10.3 全表 + §10.4 + **CI `gate` 绿**
- [ ] 发版按 AGENTS.md 流程（只动 `dev`；正式版 PR 合 `main`、tag、`--latest`、npm 命令交用户）

---

# 附录 A — 实测复现命令

```powershell
$dir='<临时目录>'; $exe='<mise>/npm-bytebase-dbhub/1.4.0/node_modules/.bin/dbhub.cmd'
# TOML：只读 + 双工具（正确模板）
@'
[[sources]]
id = "default"
type = "sqlite"
database = "<dir>/test.db"

[[tools]]
name = "execute_sql"
source = "default"
readonly = true

[[tools]]
name = "search_objects"
source = "default"
'@ | Set-Content "$dir/dbhub.toml"
# MCP 握手（stdin 重定向，避免 Node 管道 EPERM）
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"execute_sql","arguments":{"sql":"INSERT INTO t(a) VALUES (1)"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"execute_sql","arguments":{"sql":"SELECT 1 AS ok"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_objects","arguments":{"object_type":"table"}}}
'@ | Set-Content "$dir/in.txt"
cmd /c "cd /d $dir && `"$exe`" --transport stdio --config dbhub.toml < in.txt > out.txt 2> err.txt"
```
结论要点：启动表两工具都标 🔒 且日志含 `Watching dbhub.toml for changes`；id=3 → `READONLY_VIOLATION`（sqlite 允许 `select, with, explain, pragma`）；id=4/5 成功；**删掉 `search_objects` 条目后** id=5 → `Tool search_objects not found`；source 级 `readonly` → fatal、`read_only` → 静默忽略；`--config`+`--dsn` → fatal；`--readonly` → exit 1；`${VAR}` + 子进程 env → 正常解析。
参考文档：<https://dbhub.ai/config/toml>、<https://dbhub.ai/tools/execute-sql>、<https://dbhub.ai/config/command-line>、<https://dbhub.ai/blog/dbhub-1-0-0>。

# 附录 B — TOML 模板

**B.1 只读（无 SSH）**
```toml
[[sources]]
id = "default"
dsn = "${DSH_DBHUB_SEC_DSN}"

[[tools]]
name = "execute_sql"
source = "default"
readonly = true

[[tools]]
name = "search_objects"
source = "default"
```
→ `env = { DSH_DBHUB_SEC_DSN: <dsn> }`

**B.2 手动 SSH + 密钥认证（+ 可选口令）**
```toml
[[sources]]
id = "default"
dsn = "${DSH_DBHUB_SEC_DSN}"
ssh_host = "bastion.example.com"
ssh_port = 22
ssh_user = "deploy"
ssh_key = "~/.ssh/id_ed25519"
ssh_passphrase = "${DSH_DBHUB_SEC_SSH_PASSPHRASE}"
ssh_proxy_jump = "jump.example.com:2222"

[[tools]]
name = "execute_sql"
source = "default"
readonly = true

[[tools]]
name = "search_objects"
source = "default"
```

**B.3 手动 SSH + 密码认证**
```toml
ssh_host = "192.0.2.10"
ssh_user = "ops"
ssh_password = "${DSH_DBHUB_SEC_SSH_PASSWORD}"
```

**B.4 只有 SSH、无只读**：省略两个 `[[tools]]` 段（dbhub 会挂默认的 `execute_sql` + `search_objects`）。

**B.5 转义**：TOML 基本字符串里 `"` → `\"`、`\` → `\\`、换行 → `\n`；base64 私钥（含 `+`/`/`/`=`）按同一规则处理。

# 附录 C — 新增 i18n 键

**宿主 `lib/i18n.mjs`（zh/en 成对）**：`result.readOnlyHint`、`result.readOnlyUserOnly`、`result.readOnlyOn`、`result.readOnlyOff`、`result.sshSet`、`result.sshCleared`、`result.sshMissingUser`、`result.sshMissingAuth`、`result.sshMultiHopUnsupported`、`result.needConnFirst`、`result.promotedNotice`、`result.dbhubTooOld`、`log.opOptions`、`log.sshTunnelUp`、`log.tomlSwept`、`log.testWalkMs`、`log.testProbeMs`（F4 分段计时）。

**客户端 `lib/client.js`**：新增 `add.readOnly`、`ro.chip`、`ro.title`、`add.adv`、`adv.host`、`adv.port`、`adv.user`、`adv.auth`、`adv.auth.key`、`adv.auth.password`、`adv.keyPath`、`adv.passphrase`、`adv.password`、`adv.proxyJump`、`adv.keepSecret`、`adv.hostHint`（填域名或 IP）、`adv.slow`（SSH 试连更慢）、`cfg.disabledHint`、`test.elapsed`（F4 测试中计时）；**删除** `cfg.sidebar`、`cfg.sidebarHint`。

# 附录 D — 未来可选（本轮明确不做）

| 项 | 一句话说明 |
| --- | --- |
| `max_rows` | dbhub `[[tools]]` 层的**每工具最大返回行数**：`max_rows = 1000` 会把 SELECT 结果截断到 1000 行（被截断时结果里带 `truncated: true`）。与 `readonly` 同一层、成本低，可做成环境级"最大返回行数"。**本轮不做**（用户未懂此概念，下次再议） |
| `~/.ssh/config` 别名模式 | `ssh_host = "<别名>"`（无点裸名）时 dbhub 自行解析 HostName/User/Port/IdentityFile/ProxyJump，**我们不需要接触任何密钥或密码**。零成本、零秘密，适合用密钥的用户；本轮不做 |
| 复用 DSH 的 SSH 配置 | 需要读第三方插件的明文 JSON 或调其私有 HTTP 路由；用户已否决（§5）；若要做，先推上游 Service 提案 |
| 全量迁 TOML | 所有执行都走 `--config`，从而把 DB 密码从 argv 移走（安全加分）；前置是 D2 分支稳定一个版本 + 性能对比 |
| 全局只读 | 插件级"全部环境只读"；目前由"禁用"承担全局关停 |

# 附录 E — 逐文件改动索引

| 文件 | 任务 | 改动摘要 |
| --- | --- | --- |
| `lib/options.mjs` | T1.1 | 删 `showSidebarEntry`（默认值/初始化/snapshot/VALIDATORS/注释） |
| `lib/config.mjs` | T1.1/T2.1/T3.1/**T2B.4** | `normalizePrefs` 删键；`readOnlyOf`/`sshOf`/`normalizeSshOptions`/`describeEnvOptions`；`setWorkspaceEnv` 保留语义；`setWorkspaceEnvOptions`；`listWorkspaceEnvironments`/`resolveWorkspaceEnvs` 带 `ro`/`ssh`；`scrubSecrets` 加 `extraSecrets`；**`resolveAutoDsn` 在途去重（不缓存 rejection）** |
| `lib/toml.mjs`（新） | T0.2/T0.3/T3.3 | `buildDbhubToml`/`writeTempToml`/`removeTempToml`/`sweepTempToml` |
| `lib/capability.mjs`（新） | T0.1 | `detectDbhubCapabilities` |
| `lib/adhoc.mjs` | T2.3/T2.4/T3.3 | `conn` 描述符、TOML 分支、env 秘密、临时文件生命周期、超时分档、`readOnlyViolation`、`secretsOf` |
| `lib/mcp.mjs` | T2.3/**T2B.3/T2B.4/T2B.5** | 行带 `ro`/`ssh`；`summarizeRows` 元数据；`applyRowPatch` 带字段 + `options` 分支；**`cachedRows()`/`cachedRow()`；`collectSources` 在途共享；`resolveSource` 缓存命中短路**；**`resolveTestDsn` 纯函数** |
| `lib/tools.mjs` | T0.4/T2.5/T3.2 | `runCopyFrom` 修正；`runConfigure` 决策表 + D7 拦截 + D10 提升；schema 新参数；描述补能力 |
| `lib/index.mjs` | T1.1/T2.2/**T2B.1/T2B.2** | 删 `showSidebarEntry`；增 `capabilities`；`options` op；`test` op 扩展；**`handleTestOp` 分段计时 + `resolveTestDsn` 三档快路径**；超时常量；启动 sweep + 能力探测 |
| `lib/i18n.mjs` | 全程 | 附录 C 宿主键 |
| `lib/client.js` | T1.2/T2.6/T3.4/**T2B.6** | 侧边栏随 enabled；删开关 UI/字典；只读复选框与行内标记；高级 SSH 区；`connDraftOf`；**测试中耗时显示（只在 testing 态起计时器）**；CSS；文案 |
| `scripts/desensitize.config.mjs` | T4.4 | 槽位 globs |
| `scripts/render-check.mjs` | T1.2/T2.6/T3.4 | fixture 386；[8]/[18] 调整；新增 [19][20][21] |
| `test/*` | §9.1/§9.2/§9.3 | 新增 7 个文件 + 既有增补 |
| `package.json` | T4.5 | `check` 脚本 + 版本号 |
| `doc/REQUIREMENTS.md`、`AGENTS.md`、`README.md`、`README.en.md` | Phase 4 | 见 §12 |

# 附录 F — 待确认（其余已在 §0 锁定）

1. **只读开关在"自动发现的环境"上的提升语义**（D10）：确认"用户显式设置选项时自动落库并标 `promoted`"可接受（否则该场景只能要求用户手填连接串）。
2. **侧边栏入口在"禁用"时消失**是否符合预期（用户已提出，此处仅复核）：禁用后必须从**设置页或插件页**重新启用；`settings.section` 与 `plugins.row.config` 始终在，因此不会自锁。
3. `max_rows`、`~/.ssh/config` 别名模式、全量 TOML —— 是否列入下一轮（附录 D）。
