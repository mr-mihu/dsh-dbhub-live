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
- 能力探测按 `exe + mtimeMs` 进程内缓存（`lib/capability.mjs`）：每次 TOML 调用重扫 6 个候选 × 6 层 + `readFileSync` 是不必要的；命中返回**副本**，调用方改不动缓存。
- `waitForExit` 的等待也是**有界**的（`EXIT_WAIT_MS = 5s`）：逃出受管进程组的后代会让它永不 settle，超时按 `false` 处理（再杀一次 + 只警告一次）。
- `MAX_RESPONSE_BYTES` 是**每个客户端一生累计**：单次超过 64 MiB 的合法导出会被 `MCP_TOO_LARGE` 切断，这是有意的取舍（宁可明确失败，也不把宿主内存吃满）。
- 工具恒 4 个：configure / list_sources / execute_sql / search_objects；不为工作区×环境注册工具。
- `apply()` 只注册工具 + `startBackgroundBoot` bookkeeping；dbhub 解析发生在每次调用（`runtime.json` 缓存）；无数据源照常启动。

### 执行路径
- `ro === true || ssh != null` → 临时 `--config`；其余走 `--dsn`。
- TOML 里秘密只写 `${DSH_DBHUB_SEC_*}` 占位符，真值走子进程 env；**引用集合 == env 键集合**（`test/toml.test.mjs`）。
- `tomlString` 转义**全部** TOML 禁止的字符：`\\ " \r \n \t` 之外还有 C0 控制符与 DEL（`\b`/`\f` 用短转义，其余 `\uXXXX`）。裸控制符让整份文档不可解析，而 dbhub 的报错不指名字段——一个控制符会伪装成「隧道坏了」（`test/toml.test.mjs`）。
- `[[tools]]` 是白名单：只读必须写**两条** → [原因](doc/ARCHITECTURE.md#一次性toml的由来)。
- 版本门槛：1.4.0 起实测；`< 1.0.0` 拒绝（`result.dbhubTooOld`）；不生成未实测写法。
- 临时文件在 `$DSH_HOME/storages/dsh-dbhub-live/tmp/`：`finally` 尽力删 + boot 时 `sweepTempToml()`。

### 环境选项（只读 / SSH / 结果行数上限）
- store：`credentials.json` 顶层 `{ [wsPath]: { environments: { [env]: { dsn, dsnPasswordRef?, source, updatedAt, readOnly?, ssh?, maxRows? } } } }`；`ssh = {host,port,user,auth,keyPath?,passphrase?,password?,passwordRef?,passphraseRef?,proxyJump?}`。**秘密默认不写这个文件**：新写入只落 `ssh.passwordRef`/`ssh.passphraseRef`（`DSH_DBHUB_SSH_<8–12 位小写十六进制>`）与 `dsnPasswordRef`（`DSH_DBHUB_DSN_<8–12 位小写十六进制>`），随机、与工作区/环境名无关，值在 DSH 凭据库里；只有凭据服务不可用时才回退明文（见「秘密与凭据库」）。**`dsn` 字段永远不含口令**：URL 形态存 `scheme://user@host/...`，属性形态（`Server=…;Password=…`）存 `Password=${DSH_DBHUB_DSN}` 占位符。
- `setWorkspaceEnv(..., opts?)`：opts 缺省**保留** readOnly/ssh/maxRows；`{readOnly:false}` / `{ssh:null}` / `{maxRows:0}` 才是删除。`opts.dsnPasswordRef`：合法 ref = 采纳、`null` = 删除、**缺省 = 只有 `dsn` 逐字节未变时才保留**（换了 DSN 绝不能继承旧口令引用——那会把旧口令拼进一条新的连接）。`setWorkspaceEnvOptions` 只改选项不碰 DSN。
- 模型传 `readOnly:true` 允许、`false` 拒绝（`result.readOnlyUserOnly`，拦截在 `runConfigure`）。
- `handleConfigOp`：`add` / `set` / `rename` / `remove` / `test` / `options`；`options` 可带 `newEnv`（改名+改选项原子）；行不存在时提升为持久化行（`source:'promoted'`）。实现在 `applyOptionsOp`。
- **`options` 无选项字段且无 `newEnv` = 零写入**：不调 `setWorkspaceEnvOptions`（它会推进 `updatedAt` 并重写文件），直接返回 `{patches:[], noop:true}`；只有改名时补丁仅含 `rename`。空补丁写成一次"编辑"会让"最近改动时间"失去意义。
- **test op 的 `ssh:null` 是信息，不是缺省**：`testOpHasOptions` 按「键存在」判断（`op.ssh && …` 的旧判据会把"清隧道后点测试"打回已存行，探的还是被删掉的隧道），`testProbeOptionsOf` 的三态（null / 对象 / 缺省）不变。SSH 层测试的空 `host`/`user` 在**卡片**就拦下（`adv.testSshNeedFields`）——开关打开时 `connDraftOf` 恒返回对象，旧 `if (!ssh)` 是死分支。
- 扫描候选标签 = **序号 + 是否含密码**（`scanCandidateOptions`）：`connLabel` 只有元数据，同库两条不同凭据会撞成同一标签，"用 prod 那条"可能落库 dev 的 DSN；标签回传即选择键，必须唯一（`test/scan-candidates.test.mjs`）。
- 秘密字段「留空 = 保持原值」（写 ref 不变、不 unset）；`auth==='key'` 且无已存路径时落 `DEFAULT_SSH_KEY_PATH = '~/.ssh/id_ed25519'`；载荷统一走 `connDraftOf` / `withConnDraft`。
- 卡片不回显秘密，所以 `add`/`set` 在写之前也要 `mergeSshOptions(op.ssh, 已存行.ssh)`（与 `options` 同款）；规范化失败 → `result.badSsh` 报错，**不许静默清除隧道**。合并+校验必须发生在**改名之前**（已存行按 `findRow(renameFrom || env)` 取），否则隧道非法时行已改名、回执却说「未做任何修改」（半写）。`ssh` 为任何非 null 值都要校验（含 `''`），不能只在真值时校验。
- `renameWorkspaceEnv` 返回 `{ name, collided, renamed }`：落到已存在的环境必须先确认（`{confirm:true}` / 卡片 `overwrite:true`），未确认则 `renamed:false` 且零写入；`newEnv` 空 = 不改名（不会归一成 `default`）。**冲突判据是 `collided === true`**——用 `!renamed` 会把「改到自己的名字」（`{renamed:false, collided:false}`）误报成「目标环境已存在」；同名 = 无需改名，继续后续写入。`copyFrom` 覆盖已有环境同样先问，且选项取自**源行**（源行没有的只读/隧道即清掉）。
- 描述符 `{dsn, ro, ssh, dsnPasswordRef?}`：**执行/探连前必须用 `resolveEnvSecrets(credentialsOf(ctx), row)` 解析 SSH ref 与数据库口令 ref**（每次操作重新解析、不缓存；SSH 解析失败 → `result.sshSecretMissing`、数据库口令解析失败 → `result.dsnSecretMissing`，两者都**不 spawn dbhub**，绝不退化成空口令）。`probeConnection` 验有效连接，`probeSshTunnel` 只验 SSH 层（`SSH_LAYER_RE` → 断；否则 `DB_LAYER_RE` / 指名转发目标 → 通；都没有 → unknown）。探连的 ssh 三态：`null` = 用户解除隧道（按无隧道探）/ 对象 = 表单在编辑（先与已存行 merge）/ **缺省 = 卡片三项全空**（`connDraftOf` 不发 `ssh` 键，此时用已存行的隧道——否则探的是裸连接，不是会保存的那条）。
- 预算 `PROBE_TIMEOUT_MS = 25s` / `PROBE_TIMEOUT_SSH_MS = 45s` < 客户端看门狗 30s/60s；宿主兜底 = 预算 + 500ms → [原因](doc/ARCHITECTURE.md#环境选项与执行预算)。
- UI 落点：行内 `.dbh-rochip`（点击发 `{op:'options', readOnly}`）；SSH 只进 tooltip。行内「高级」区另有「最大返回行数」数字输入（`.dbh-caprow`，占位「0 或留空 = 不限」）。见 [doc/CLIENT.md](doc/CLIENT.md)。
- **结果行数上限 `maxRows`**：环境级整数，`0`/缺省 = 不限（存量行为不变），`N>0` = 每条语句最多 N 行。存储层 `applyEnvOptions` / `setWorkspaceEnvOptions` 里 `0`/`null` 是**显式 delete**（与 `readOnly:false` 同款），非法值（负数/小数/非数字/NaN）抛 `code:'badMaxRows'` → 卡片 `result.badMaxRows`、模型路径在**改名之前**拒绝（`optionsPatchOf` 在 `applyOptionsOp` 开头抛，零写入）。**裁剪发生在插件侧**（`capExecuteSqlText`，纯函数）：dbhub 的 `max_rows` 在静态 `[[tools]]` 里，单次调用改不了它，所以插件拿到结果文本后自己裁。只裁 `statements[i].rows` 数组（加 `truncated:true`/`shown:N`，**保留原 `count`**、不二次序列化行值），并在结果**首行**加一条本地化提示（写明本次上限、原行数、「可用 maxRows 覆盖」）；**JSON 解析失败或结构不符一律原样返回**。执行侧优先级 = 调用参数 > 环境设置（`resolveRowCap`），参数 `0` = 本次完全不限；`dbhub_execute_sql` 的 `maxRows` **只用于本次裁剪，绝不透传给 dbhub**。门禁 `test/max-rows.test.mjs` + `check:ui` `[48]`。

### 秘密与凭据库（SSH 口令 + 数据库口令）
- 秘密值只存 **DSH 凭据服务**（`ctx.get('credentials')`，可选服务；默认实现落 `$DSH_HOME/.credentials.yaml`，由 DSH 管理，**插件不自己读写该文件**）。store 只留三类引用：`ssh.passwordRef` / `ssh.passphraseRef`（`DSH_DBHUB_SSH_<8–12 位小写十六进制>`）与 `dsnPasswordRef`（`DSH_DBHUB_DSN_<8–12 位小写十六进制>`），**随机生成、与工作区/环境名无关**（改名不重新键化，重名不串号）；ref 名不是秘密，可以出现在日志里。
- **写入顺序是安全属性**：add / set / options / `copyFrom` / 扫描落库都先把新明文交给 `encryptSshSecrets` / `encryptDsnPassword`（`creds.set(ref, value)` **成功**之后才返回只带 ref 的结果），再写 store。凭据服务缺失或 `set` 抛错 → 保持明文（旧布局，连接不受影响）+ `warnOnce` 一条不含值/路径的警告。**不要在 store 写入器里同步调凭据服务**（`config.mjs` 是纯模块，命令层负责这一步）。
- **DSN 口令拆分（纯函数，写入/迁移时）**：`splitDsnPassword(dsn)` 只做两种形态——URL 的 authority `user:password@`（**按原始文本切片**，保留 `user@`，口令段连编码一起存，绝不在编解码之间来回转）与属性串 `Password=` / `Pwd=` / `Passwd=`（任意大小写；值 token 原样更换为 `${DSH_DBHUB_DSN}`）。**安全闸门**：`joinDsnPassword(split.dsn, split.password)` 必须**逐字节**还原原串，否则放弃拆分、保持原样并 `warnOnce('dsn-unsplit', log.dsnUnsplit)`（不含值/路径）。同一属性串里有多个不同口令值、URL 尾部又带 `;password=`（一个 ref 表达不了两处）一律放弃；已经是占位符的串不再拆。宁可少拆一条，也不能拼出一条对不上的 DSN。
- **拼装（每次操作）**：`resolveEnvSecrets(credentialsOf(ctx), row)` 先按 `dsnPasswordRef` 取出值并 `joinDsnPassword` 拼回，再解析 SSH ref；**不缓存**（DSH 的契约是每次操作重新解析）。任一 ref 在但 `resolve` 无值/拼不回去 → `result.sshSecretMissing` / `result.dsnSecretMissing` 本地化报错，**不 spawn dbhub / 不跑探连**，绝不退化成空口令（那会伪装成认证失败）。明文只在宿主内存/子进程里，**不得进 view / patch / 日志**。
- **迁移幂等**：boot 的 `migrateSecrets(credentialsOf(ctx))`（fire-and-forget，不阻塞 boot；`migrateSshSecrets` 是兼容别名）把老明文行搬进凭据库，SSH 口令与 DSN 口令**各自独立**判断：已有对应 ref 的行直接跳过（重复运行不产生新 ref、不重复写）；服务缺失/写失败 → 保留明文、只警告一次。改写前重读**当前**行，避免覆盖并发写入。
- **生命周期**：`removeWorkspaceEnv` 之后 `releaseSshSecrets` / `releaseDsnSecret` 释放不再被任何行引用的 ref（best-effort；**共用 ref 不动**）。`copyFrom` 复制源行的 ref（同一秘密，不新建；源行是未保存的自动发现行时才就地拆分）；`rename` 不动 ref；替换 DSN / 覆盖副本后释放旧 ref（写入失败已 mint 的新 ref 也释放，不留孤儿）。秘密字段「留空 = 保持原值」= 不覆盖 ref、不 unset。
- **降级可见**：某行口令没能拆分（形态不安全 / 凭据服务缺失）时，`/state` 行只带一个布尔 `passwordUnsplit: true`（**没有口令、没有 ref**），卡片在环境名 tooltip 里用既有提示位说明「仍保存在本地连接文件」。门禁 `test/cred-store.test.mjs` / `test/dsn-secret.test.mjs`。

### 会话权限闸门（写操作）
- `dbhub_execute_sql` 尊重**会话输入框的权限模式**；插件的「环境只读」开关含义**不变**（仍由 dbhub 的 `[[tools]] readonly` 硬拒绝，插件只给「需用户在设置里关闭」的引导）。两者是独立属性，闸门**只可能更严**，绝不放宽 dbhub 的拒绝（R59：插件不取代上游判定）。
- 组合：环境只读**开** → 闸门不介入（任何会话模式下都不 spawn 前拒绝）；环境只读**关** → 会话「仅可查看」= 本地拒绝（不 spawn dbhub / 不写临时 TOML / 不写 store）、「工作区内修改」= 写语句**每次**弹窗一次（只有 `allowed-once` 算授权）、「完全权限」= 直接执行；读语句四种组合一律直接执行。
- **闸门位置**：`runSourceTool` 里 `base === 'execute_sql'` 的分支、`runAdhoc` **之前**（源句柄已解析，才能读到该环境的 `ro`）。因此 `dbhub_search_objects`（`base !== 'execute_sql'`）与 `dbhub_configure`（根本不走 `runSourceTool`）完全不受影响。
- 写判定是**纯函数** `classifySql(sql)`：剥前导空白/注释 → 按顶层 `;` 拆语句（`'…'`/`"…"`/反引号/注释里的 `;` 不算；`\'` 与 `''` 要处理）→ 首关键词白名单 `SELECT/SHOW/DESCRIBE/DESC/EXPLAIN/VALUES/TABLE/PRAGMA`，`WITH` 向后扫过配平括号找主语句且必须 `SELECT`；其余（含无法识别的开头）一律写。**任一条写 → 整次写**；空/只有注释 = 读。**宁可误判成写**。MySQL 可执行注释 `/*!…*/` 的正文参与判定（只丢标记与版本号），否则是一条真实绕过。
- 选项 **`sandboxPolicy`**（`ctx.get` 就地取）：`resolve({ session })` 取 `mode`。服务缺失（无头/SDK）**不设闸**；`resolve()` 抛异常同样不设闸并只 `warnOnce` 一次（文案不含 DSN/路径）。未知 mode 按「不设闸」处理（不替会话发明规则）。
- 选项 **`approval`**：`request({ agent, toolName, ...(callId !== undefined ? {callId} : {}), reason, displayReason, signal })`。`rejected`/`cancelled` → 「用户拒绝」拒绝；`unavailable` → 「当前会话不允许弹窗确认（从不询问）」拒绝；服务缺失或 `request` 抛异常（不在开启的轮次里）→ **fail closed** + `warnOnce` 一次。拒绝路径**零 spawn / 零临时文件 / 零 store 写**。
- 弹窗文案 `approval.writeReason`：只给 **source 句柄 + 语句类型关键词 + 语句前 `APPROVAL_SQL_HEAD_MAX = 48` 字符（过 `scrubSecrets`）**；`reason` 同时进会话日志，所以**不得整段回显语句**，也不得出现 DSN/主机/账号。拒绝文案必须写明下一步，并禁止改用命令行/脚本/其它插件绕过。
- 依赖图不变：两个服务都是 `ctx.get` 运行时取的**可选服务**，没有新增 import；`policy` 仍是叶子。门禁 `test/permission-gate.test.mjs`。

### source 身份
- 每条 source 只属于一个工作区，同名不同区是不同目标；`sourceIdOf(row)` 是唯一构造点（`<标题slug>_<路径哈希>[_<envSlug>]`）。
- `envSlug`：`default` 裸值 / 纯小写 ASCII 且名即 slug 时原样（`prod`/`test`/`dev`，**逐字节不变**）/ 其余（`PROD`、`Prod`、`dev!`、`!!!`、名字被长度上限截断）一律 `<slug>-<shortHash(原名)>`，非 ASCII 仍 `env-<hash>` → [原因](doc/ARCHITECTURE.md#envslug事故)。
- **id 必须单射**：投影是有损的（大小写折叠、`!!!`→空、`@*`→`env`），两个不同环境名落到同一句柄时 `resolveSource` 恒返回 `{ambiguous}`，模型对**两条连接都不可达**。所以只保留「名 == slug」的可读句柄，其余全部加短哈希；`prod-<hash>` 永不等于 `prod`。
- **截断冲突拒绝**：`normalizeEnvName` 按 `ENV_NAME_MAX = 64` 截断，两个不同的长名会共用同一个 store key。写入侧（`setWorkspaceEnv` / `renameWorkspaceEnv` / **`setWorkspaceEnvOptions` / `removeWorkspaceEnv`**）在「截断改变了名字 且 目标 key 已存在」时抛 `code:'envNameTruncated'`，**不静默合并两条连接**，也**不得改动那条别人的行**（65 字符名曾经通过只读开关改掉 64 字符行的 `readOnly`、通过删除把它删掉）；卡片/模型侧各有一份本地化文案（`result.envNameTruncated`）。**卡片与模型路径都要自查**：两条命令层都会先把名字归一化，所以 `applyOptionsOp` 与 remove 分支在归一化**之前**用 `envNameTruncatesOntoExisting(ws.path, op.env)` 按**原始**入参判断（否则 raw 名字已被截断、store 无从区分；`dbhub_configure` 同理）。仅长度上限受此保护——`prod ` 与 `prod` 仍是同一行（卡片回传的就是显示名）。已存在的超长行改用截断后的名字更新。门禁 `test/source-identity.test.mjs` / `test/configop-safety.test.mjs`。
- `resolveSource`：**只认精确句柄**（规范 id、`<标题>[_<env>]` 等展示形式、环境名、工作区路径、行号），再按当前会话工作区消歧，最后 `{ambiguous}` 澄清——**不按列表顺序猜，也没有子串/前缀回退**。旧 `wanted.includes(k.id)` 让 `app_ab12_dmeo`（错拼）命中基础行并返回 default 的 DSN；近似句柄必须是「未找到」。除精确 id 外只额外接受 `<baseId>_<envSlug>`（该 env 真实存在）。门禁 `test/resolve-source.test.mjs`。
- `dbhub_configure` 不回退 `workspaces[0]`（`result.unknownWorkspace` / `result.needWorkspace`）；跨区复用走 `copyFrom`。

### 状态通道
- 一个发布核心 `createHostCore`，**唯一通道**：`connection.fetch` 的 `/api/dsh-dbhub-live/{state,enabled,options,op}`。0.1.x 的 settings 命名空间通道已随 0.1.x 支持一起删除。
- **每条 summary 行带 `alias`**（`collect.mjs` 的 `assignConnectionAliases` 是唯一实现点，`summarizeRows` 把它写进 `/state` 的 `workspaces`）：环境名在**所有工作区**里唯一时就是它，否则 `<工作区>_<环境>`，仍撞名再确定性追加 `-2`/`-3`；按 `title+env+path` 排序分配，**与扫描顺序无关**；非空、不含空白、不含 `@`。别名只是显示/手打短名，身份仍是不可变的 `srcId`。
- 客户端 `inject` **只能 `["slots"]`**；`settingsScope` 不注入也不探测（0.2.x 已删除该服务，注入它会让整个浏览器半区永久 pending）→ [为什么](doc/ARCHITECTURE.md#状态通道与inject根因)。
- 注入回调内服务必须 `ctx.get(...)` 就地取。
- view：`{enabled, phase, toolCount, lastError, mode}` + `{updateIntervalDays, showSidebarEntry, announceAccessPolicy, capabilities, workspaces, testResult, opNotice}` + `{pluginVersion, dshVersion, dshMinVersion, dshTooOld, runtime, update}`。**DSN 只从浏览器流向 Host。**

### 部署开关与连接管理
- `lib/options.mjs` 唯一持有开关；Config 值经 `options.configValuesOf` → `applyPatch(..., {persist:true})`；`entryIdOf(ctx)` 运行时解析行 id；不绕过 `applyPatch`。
- 页面只见元数据（`collectSources` → `latestSummaries`）；增删改改名走 `configOp`；`renameFrom` 让「改名 + 改连接」原子。
- 写前先问（`requestWrite` / `envCollision` / `normalizeEnvForCompare` → `dbh-warncard`）→ [原因](doc/ARCHITECTURE.md#覆盖门为什么先问)。
- 被拒的写命令必须有回执：`handleConfigOp` 把失败原因（找不到工作区 / 空 DSN / 改名冲突 / 非法隧道）写进 `opNotice` 一次性发布，卡片 `.dbh-notice` 显示；部分失败时**已落地的补丁照发**（不再 `return []`）。
- 即时回推：`handleConfigOp` 返回补丁并 `publishFast`；`reportTest` 只 `publishMirror`；扫描单飞 + 补丁重放；`rename` 补丁幂等 → [原因](doc/ARCHITECTURE.md#即时回推与扫描单飞)。
- test op 三档快路径 `resolveTestDsn`（store → 卡片缓存 → walk）；失败不写 store/lastError/phase；`kind:'ssh'` 只验 SSH 层。
- 诊断取尾部 600（`diagnosticTail`），前缀 `【SSH 层】/【数据库层】/【插件层】`；页面只认自己派发的 nonce → [原因](doc/ARCHITECTURE.md#诊断为什么取尾部)。

### 版本与更新
- 最低支持 DSH 0.2.1（`DSH_MIN_SUPPORTED`，含预发布：`0.2.1-rc.2` 算 0.2.1）；**0.1.x 与 0.2.0 一律不支持**。`dshTooOld(runtime)` 只驱动一条**卡片可见警告**（+ 一条不含路径的 `warnOnce` 日志），**不是功能门**：工具、配置页、桥接照常工作。解析不到版本 → 不判过旧（不冤枉无法识别的运行时）。
- `{op:'updateCheck'}` 在 `runOp` 中先于 `handleConfigOp` 拦截；不改行、不写 store。门禁 `test/meta.test.mjs` / `test/update.test.mjs`。
- `checkedAt` **只由成功结果推进**：失败只写 `error` 并保留旧 `latest`，不动复用窗口——失败也推进等于把下一次重试推到整个 throttle（30 分钟）之后，网络已恢复而卡片还在报错（`test/update.test.mjs` 断言"失败后下一次非 force 调用会重新请求"）。

### 自动发现（mise）
- 每次探测必须有总超时（`MISE_ENV_TIMEOUT_MS`；`graceMs` 不是超时）；结果按 `AUTO_DSN_TTL_MS` 缓存；工作区之间并发。
- **预算计时器不 `unref()`** → [原因](doc/ARCHITECTURE.md#自动发现的代价与unref教训)。
- `resolveWorkspaceRef` 必须用与扫描同一个 `listWorkspaces(ctx)`。

### 其他不可退化
- 依赖只进不出：`config ← state ← mcp`；`config ← runtime|toml|capability ← adhoc`；`mcp ← tools ← index`；`adhoc|collect ← tools`（`collect ← mcp` 只为 `assignConnectionAliases`，collect 不反向依赖）；`state|options ← policy ← index`（policy **不** import mcp：`@` 目录的取行函数由 index 传入）；`meta`/`update` 是叶子。禁循环 import。
- schema 弹性：`await import('@deepseek-ai/schemastery')` 失败 → `Config` 保持 `undefined`（Loader 跳过校验，页面与工具照常），不改回静态顶层 import。
- `policy.mjs` 唯一 system prompt 段（order 8900）：已配置连接走 `dbhub_*`、禁 CLI/脚本/驱动/其它 MCP/其它数据库插件绕过、只读被拒不换途径；另有一行钉会话权限（「仅可查看」不写库、「工作区内修改」写操作弹窗确认、被拒后同样不得换途径）。不支持的库让给用户其它插件、判不准先问。另解释 `@db:<句柄>` 标记（按出现顺序一一对应、一条消息可有多个）并附 `别名→句柄` 目录（`POLICY_CATALOG_MAX = 12`，超出附 `dbhub_list_sources` 指针，**只有别名与句柄**，绝无 DSN/主机/账号）。取行函数由 index 传入（`registerDbhubPolicy(ctx, latestSummaries)`），policy 不 import mcp。`announceAccessPolicy=false` 时 `text` 为空。门禁 `test/policy.test.mjs`（含 900 字符预算）。
- 启用/禁用：`state.setEnabled` → `credentials.json`；禁用时工具首行返回「插件已禁用」。
- `lastError` **只由 boot 失败写入**（`state.recordError` / `clearError`），工具调用错误不进卡片：它是"插件起不来"的诊断位，不是运行日志。要接工具错误必须先有"成功即清空"的语义，否则一次偶发失败会永久挂在页头（本次刻意不做）。
- SSH 口令弹窗**只在没给 keyPath 时出现**（`tools.mjs` 的 `auth==='key' && !keyPath` 分支）：给了路径就按"无口令"假设，**零打扰是刻意的**（`test/configure-options.test.mjs` 用 `dialogs === 0` 钉住）。带口令的私钥需用户先在界面里配 passphrase，不要让模型路径去追问。
- 存储：`$DSH_HOME/storages/dsh-dbhub-live/`（credentials / prefs / runtime / dbhub-runtime / tmp）；`writeJsonFile` tmp+rename，失败只 `warnOnce`；load 时清洗 + 一次性回写迁移，**未知字段保留**；进程环境变量不参与连接解析。**SSH 口令与数据库口令的值都不在 credentials.json**：它们在 DSH 凭据库（默认 `$DSH_HOME/.credentials.yaml`，DSH 管理）里，本文件只留 ref（`ssh.*Ref` / `dsnPasswordRef`）；凭据服务缺失时回退明文并警告一次。
- **写入保留未知字段**：`normalizeStore` 在 load 时保留 workspace 级与 env 级未知字段，写入侧必须同样保留——`setWorkspaceEnv`/`setWorkspaceEnvOptions`/`renameWorkspaceEnv`/`removeWorkspaceEnv` 都用 `{ ...entry, environments }` 与 `{ ...previous, … }` 重建，否则一次写就把旧版留下的字段擦掉（load 的承诺变成空话）。因此 `applyEnvOptions` 的 `false`/`null` 必须是**显式 delete**：spread 会把字段放回来，靠"不赋值"删不掉。门禁 `test/source-identity.test.mjs`。
- `writeJsonFile` 的临时文件 `mode: 0o600`、`DATA_DIR` / 子目录 `0o700`（Windows 忽略 mode，靠 profile ACL）。**升级来的旧目录/旧文件必须补 chmod**：`mkdirSync(recursive)` 不改已存在目录的 mode，所以 boot 时与每次写入后 best-effort `tightenStorageModes()`（Windows 跳过；失败只 `warnOnce` 一次、文案只带文件名与错误码）。`setFsHooks` 是给测试观察 mode 参数的注入缝，生产恒用 node:fs。旧版明文 `dbhub.toml`（4.0 之前就是连接库）：boot 时 `sweepLegacyConfigFile()` 直接删除并 `warnOnce` 一条不带内容的警告（D1）。

### 客户端半（细节见 [doc/CLIENT.md](doc/CLIENT.md)）
- 手写 lazy-CJS bundle，无构建；`id` = Loader entry 名；三入口都要在：`settings.section`（始终）/ 侧边栏（`enabled && showSidebarEntry`）/ `plugins.row.config`（始终）。
- **写失败必须可见**：face 的写 promise 在失败时 reject（失败分支不得写 `noop`），组件渲染 `.dbh-error .dbh-writefail[role=alert]` 且**不置 `saved`**；`/state` 失败时读 `snapshot.status === 'error'` 渲染 `.dbh-loadfail` + 「重试」（`face.refresh()`）；**错误行还要带自救指引**（去「设置 → 插件」确认启用、升级后重启）——宿主半没加载时这张卡片是唯一还能说话的地方；写被拒后补一次 `refresh()`（写占用的读序号会丢掉先发的 `/state` 读，失败时卡片可能停在 loading 到下一次轮询）；`sidebarWanted()` 只在 `enabled === true` 时注册（未知/失败不注册）；`summary` 与 `page` 两种 view 的 Hook 序列必须一致（summary 早退只能放在所有 Hook 之后）。门禁 `check:ui` 的 `[31]`–`[49]` 用失败桩（401 / `{ok:false}` / fetch 拒绝 / 晚到的读 / 非 JSON / 缺 value / 失败的更新检查 / 批量测试的挂起探针）钉住，假 react 按组件身份校验 Hook 数。
- **连接列表的搜索 / 排序 / 批量测试是纯视图状态**：`filterRows` / `sortRows` / `batchSummaryOf` 是**纯函数块**（源码里 `PURE`/`END … pure helpers` 两个标记之间，`test/conn-list.test.mjs` 按块提取做单测，所以**块内不得引用 React/DOM/计时器/其它模块状态**）。搜索只匹配 `title`/`env`/`alias`/`conn`（**没有任何 DSN 路径**），过滤**只影响显示**（`groups`/`workspaces` 未过滤，供页头计数、`datalist`、`envCollision` 与 `@` 候选使用）；`layoutModeOf` 也用未过滤的 `groups`（否则筛到一条会在平铺/折叠间跳）。`最近更新` 的戳来自**工作区快照** `items[].updatedAt`（行自身有则优先），没有快照的挂载退化为名称顺序——不发明时间戳。批量测试**读 `POST /op` 响应里的 `body.value.testResult`**（宿主应答前已写入），按 nonce 关联，**不新增协议、不新增轮询**；批量状态（`batchRef`+`batch`）与单行状态（`tests`/`nonceKeys`+mirror effect）**分离**，只共用一个按唯一 nonce 键的 `testTimers`（看门狗句柄，卸载时统一清）。并发 `BATCH_CONCURRENCY = 2`，N = **过滤后的可见行数**；停止只清队列（未开始的回「未测」，在途请求照常完成，**不伪造取消**）；对已完成的批量行点 ▶ 先 `forgetBatchRow` 丢掉该行结论（否则单击结果被批量行盖住＝"点了没反应"）。门禁 `check:ui` `[49]`。
- **`@` 输入源**：`ctx.inject(['inputTriggers'], …)`（可选服务，**不进导出的 `inject`**，否则缺失时整个浏览器半区永久 pending）；注册名 `dbhub`/`trigger:'@'` 是稳定 ASCII（它同时是 reference 路由键，不做本地化）。候选只来自 `/state` 的 workspaces 行（复用 `workspacesOf`/`groupRows`），每行只带**别名 / 句柄 / `conn` / 工作区标题 / 只读标记**，绝无 DSN/主机/账号；`onPick` 的 `insert.source` 必须等于注册名、`ref` 用不可变句柄；`codec.serialize → '@db:<句柄>'`（**多选靠它逐 chip 序列化**）、`codec.clipboardText` 用当前别名；`lexicon`/`subscribeLexicon` 跟随 face 已有通知（**不新增定时器**），`warm` 只触发一次既有 `refresh`；**首次 `@` 早于第一次 `/state` 落地时，`candidates()` 先等一次有界的 `refresh`**（并发共享同一个 promise），否则空分组会让菜单立刻关闭、用户第一次按 `@` 像是坏的；停用/读失败/无行 → 空候选（空组自动关菜单），绝不抛错或显示假数据。门禁 `check:ui` `[47]`。
- **写/读两条水位线，`form.set` 只认 `true`，缺 value 不是空页**：读按 `appliedSeq` 丢旧（写发起时占一个更高的读序号），写响应另走 `appliedWriteStamp`（**不**与读序号比，否则「写先发 → 读后发 → 读先回 → 写后回」把写自己的答案丢了）；`form.set` 只有 `ok === true` 算受理（`undefined` 曾导致零 POST 还印「已保存」），其余回落 `POST /options`；`value` 不是非空对象时读进 `status:'error'`（保留旧行）、写 reject，绝不 `publish({status:'ready', value:{}})`；`res.json()` 失败统一本地化；每次写最多等 `WRITE_TIMEOUT_MS = 90s`（> SSH 看门狗，超时只按失败渲染）。门禁 `[38]`–`[41]`。
- `apply()` 可重入：locale 注册失败降级 `localTranslator`。
- **实测列宽靠回调 ref**（`attachMeasuredWidth`）：observer 由 callback ref 挂/换/卸，卸载 effect 只 disconnect，**没有计时器**。不要在空依赖 effect 里读一次 `ref.current`——列没在那一刻挂上就永不重测，宽度恒 0、布局静默退回 viewport。门禁 `[45]`。
- 升级链接的 tooltip = `ver.linkHint`（「展开升级说明与安装命令」）；`ver.copySpec`（「点击复制 …」）**只属于面板内的复制按钮**。门禁 `[24]`。
- 两个 locale 字典**不得有重复键**（对象字面量静默保留后者，改前一条永远无效）；`test/client-format.test.mjs` 按源码断言去重 + 中英键集相同 + en 表不含中文。
- 样式只允许 `--dsw-alias-*` token + 中性半透明兜底；组件不接触 ctx。
- 行内只显示 `w.conn`；操作只用图标；`source` 可复制 chip；库名不截断 → [原因](doc/ARCHITECTURE.md#布局取舍)。
- 空闲不轮询（残留 interval 会让 `check:ui` 挂住不退出）。

## 质量门

```bash
npm run check            # 语法：全部 lib + client.js
npm run check:secrets    # 脱敏门禁（槽位 + 兜底 + 本地 denylist）
npm run check:ui         # 客户端离屏渲染 + 点击交互
npm run check:docs       # 文档链接/锚点、影响矩阵路径、包内文档一致性
npm run test:unit        # 全部 test/*.test.mjs（每文件一个 node 进程，跨平台）
npm run support:check    # 支持矩阵结构：生成物 vs matrix.json + 已提交证据摘要
npm run support:evidence # 证据摘要是否落后于本机 .release-test/reports（没有报告就跳过）

# 单测也可逐文件跑（沙箱内 node --test 的 runner 子进程 EPERM）
Get-ChildItem test/*.test.mjs | ForEach-Object { node $_.FullName }
```

- **`test/gates.test.mjs` 是「门禁的门禁」**：每个门禁都拿 `%TEMP%` 仓库副本喂坏样本，断言「好样本 exit 0 / 坏样本 exit 1」。**改任何门禁脚本，先让自测红一次再改**——不能失败的检查只是装饰。
- **`check:docs` 的覆盖面**：`AGENTS.md` + `README.md` + `README.en.md` + `doc/*.md`。两份 README 里若出现**相对** `doc/` 链接，目标必须在 `package.json` 的 `files` 里；`AGENTS.md` 只在仓库里读，不做随包要求。npm 包**只含运行时**（`lib` / `cordis.patch.yml` / 两份 README / `LICENSE`，实测 22 文件），README 的文档链接用 GitHub 绝对地址、截图用 raw 地址。
- **`check:secrets` 的三个硬点**：① 带引号的赋值**不享受**裸标识符豁免（裸标识符豁免只给 `password: req.body.password` 这类代码引用；`password: '<裸单词>'` 就是写下来的口令，必须红）；② **无引号值的豁免只在代码文件里存在**，且只认「全大写下划线常量」「含点号成员路径」「不含数字的纯单词」三种形状——`.md` / `.yml` / `.yaml` / `.toml` / `.env*` 不给豁免（`password: hunter2` 就是最真实的泄漏形状）；判据与逐文件类型夹具见 [doc/DESENSITIZE.md](doc/DESENSITIZE.md#password-规则的判据d1-d2)；③ 本地 `.env` denylist 的正则编译失败 = 门禁失败（`exit 1`），不是提示——那一层是唯一能看见裸项目名/库名的规则，坏了不能报 clean。
- **`release:preflight` 的证据是自洽性检查，不是执行证明（D8）**：它校验「报告 + 判定 + 矩阵 + 工作树」彼此一致（版本、tree、矩阵哈希、声明目标、`pass>=1 && skip===0`），手写一份自洽的 `report.json` + `verdict.json` 同样能 `exit 0`。真正证明跑过的只有 `npm run test:release` 的日志与 `.release-test/reports/` 里的原始证据，所以**不要把它当作"测试确实跑过"的凭据**，也不要把"preflight 绿了"当成可以跳过一次实跑的许可。同理，diff 结果每次用独立临时文件并在启动时清掉旧 `preflight-git.log`：历史行不得参与本次判定（只改了生成文档时也必须绿）。
- **`support:check` 只比结构**：`doc/SUPPORT-MATRIX.md`、`release-test/mise.toml`、两个 README 的版本段，输入是 `release-test/matrix.json` + **已提交的** `release-test/evidence-summary.json`；比较前归一化行尾（生成器写 LF，Windows 检出可能是 CRLF，`git diff` 却为空）。**证据必须随包**：`.release-test/reports/` 被 gitignore，渲染若依赖它，干净 checkout 重算得到「未验证」与提交版不等——旧版每周 CI 必死在第一步。`support:evidence` 才是「本机报告 vs 摘要」的新鲜度校验，没有 `.release-test/reports/` 时自跳过。
- **预览版可以早于矩阵发布（仅限 `x.y.z-rc.*`）**：`release:preflight` 把**证据类**问题（版本/提交/时效/矩阵哈希/声明版本未跑）降级为警告，因为测试版的意义就是拿真包去跑矩阵；发版后必须立刻用 npm 包装上并跑全量矩阵（见 [doc/RELEASE.md](doc/RELEASE.md)）。`x.y.z` 正式版这些仍是硬阻断；与证据无关的安全项（脏树、报告 red、AI 判定 fail、目标全 skip）对预览版同样硬。门禁 `test/gates.test.mjs` 两种形态都钉住。
- **`release:preflight` 不认「空报告」**：声明版本必须 `checksCounts.pass >= 1 && skip === 0`。`aggregate()` 把全 skip 折成 `warn`，只看 `fail|error` 会让「一项都没跑」通过发版闸门。
- **`prepublishOnly`** = `check` + `check:ui` + `test:unit` + `check:docs` + `check:secrets` + `release:preflight`（发布前自动跑全套，不只是文档/脱敏/闸门三样）。
- CI：`.github/workflows/quality.yml` job **`gate`**（ubuntu-latest + Node 22），push `main`/`dev`、所有 PR、`workflow_dispatch`；`main` 分支保护把它设为必需检查。另有 `release-matrix.yml` 定时跑 `support:check`（结构）与 `support:evidence`（仅本地有报告时才有意义，CI 自跳过）。
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
