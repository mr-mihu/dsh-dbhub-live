# implementation-notes — 0.2.x 双栈移植（5.0.1）

临时工作记忆，不属于发布内容（`package.json` 的 `files` 不含本文件）。三条固定小节 + 末尾五行总结。

## Deviations

- 计划：0.2.x 用 `webServer.register` 注册裸 `/api/dsh-dbhub-live/*` 路由。实际：改用 `ctx.inject(['connection'])` → `connection.fetch.register({ path: '/api/...' })`。原因：`HostConnectionFetch` 在 0.1.6-alpha.2 与 0.2.1-alpha.1 两个安装里都存在（0.1.6 的 `dsh-client-connection/lib/types/rpc-host.d.ts:27`），并且路由天然继承 connection 的 Host/Origin + 浏览器鉴权（裸 webServer 路由没有任何鉴权）。回退条件：若将来 `connection.fetch` 消失，再退回 webServer + loopback 收口。
- 计划：客户端按运行时二选一（settingsScope 或 HTTP）。实际：客户端保留 `settingsScope` 分支但**优先 HTTP**（同一 `face` 接口，两种实现），因为 HTTP 通道在两个运行时都可用；legacy 分支只作为 0.1.x 上没有 connection 服务时的兜底。
- 计划：0.2.x 的 `updateIntervalDays` / `showSidebarEntry` 直接以 volatile Config + `configForms` 为唯一存储。实际：**两者都做了，但分工不同**——`Config`（volatile 字段）是**写入通道与部署种子**，`prefs.json` 仍是有效值的存储；任何显式 Config 值在 boot / `loader/volatile-update` 时被「采纳」（写进 prefs 并生效），页面写入也反向写回 profile patch（`settings.update(entryId, …)`）。原因：客户端页面在两条 dsh 线上都存在，若以 Config 为唯一存储，0.1.x 与「没有 settings 服务的部署」就没有落点；以「采纳」收敛可保证两个界面永不互相打架（实测：patch 里钉 5 → 视图与 prefs 都变 5；页面存 9 → patch 与 prefs 都变 9）。回退条件：若将来要求「Config 是唯一真源」，删掉 prefs 层即可，采纳/写回代码可原样保留。
- 计划：entry id 由插件自己写死（`dbhub-live`）。实际：用 `ctx.fiber.entry.options.id` 运行时解析（0.1.6 与 0.2.1 的 loader 都声明了 `interface Fiber { entry?: Entry }`），解析不到就退化为纯 HTTP `/options`。原因：部署方可以用别的行 id 挂载本包，写死会在那种部署下静默失败。
- 计划：移植会动 `lib/index.mjs` 的发布链路。实际：把发布/命令核心抽成不依赖 settings 的 `createHostCore(...)`，两个通道（legacy scope / HTTP）都只是它的适配器，避免两套状态机。
- 计划：只改 dsh-settings 的 peer 范围。实际：一并把 `@deepseek-ai/cordis` 从精确 `4.0.1` 放宽到 `^4.0.1`（0.2.1 运行时带 4.0.5-alpha.1，精确钉住只会在 pnpm 侧留隐患；插件从不 import cordis），并新增 `@deepseek-ai/dsh-client-connection` peer 作为真实依赖声明（它只参与 DSH 的版本范围校验，不要求部署里存在该包）。
- 计划：0.2.x 的 `settings.register` 不再存在。实际：`wireStatusNamespace` 保留为 `wireLegacySettings`，用 `typeof settings.register === 'function'` 守卫；它同时负责把 0.1.x 用户已存的选项读回来（否则老用户升级插件后选项被静默重置）。

## Discovered edge cases

- `@deepseek-ai/schemastery@3.18.2`（0.1.6-alpha.2 自带）**没有** `.volatile()`（0.2.1 的 3.18.5-alpha.1 才有）。任何 `.volatile()` 调用都必须 `typeof f.volatile === 'function'` 守卫，否则 0.1.6 启动即炸。本次没有用 volatile Config，但后续要加时这条必须遵守。
- Cordis Loader 的 `resolveConfig` 要求 `Config['~standard'].validate`（vendor/cordis/src/fiber.ts:51-53）；`Config` 为 `undefined` 时直接跳过校验。不能导出“最小自制 schema”当 Config，只能不导出。
- 0.2.x 的 `settings` 服务只有 `configure/describe/update/replace/mutate`；`describe()` 的 `ns` 是 profile entry id，不带包名——镜像里也确认“configForms 不带 package identity”。
- 客户端旧 `inject = ["slots","settingsScope"]` 是 0.2.x 上“整块界面静默消失”的根因：服务永远不出现 ⇒ 插件 fiber 永远 pending ⇒ `apply()` 不执行。
- `sidebar.panellist`（list，id 对应 `main` 的 key）与 `main`（keyed）在 0.2.1 里都还在；`plugins.row.config` 也还在。真正消失的只有 settings 命名空间与 settingsScope。
- 本仓库测试里 `test/client-format.test.mjs` 有两处硬断言 `var inject = ["slots", "settingsScope"]` 和 `settingsScope.bind({ namespace: NS })`，改客户端必须同步改。
- schemastery **保留未知 config 键**（3.18.2 与 3.18.5-alpha.1 都实测不抛），所以给一个此前没有 Config 的插件补 `Config` 导出，不会因为用户 patch 里多写了键而拒绝启动；反之非法**类型**会抛（fail-loud，符合 cordis 约定）。
- settings 的 `ns` 是 `entry.options.id`，不是 `entry.id`（后者在嵌套 include 下会被拼成路径）；`ctx.fiber.entry.options.id` 是拿自身 entry id 的正确读法。
- `settings.update(id, patch)` 真的会落 profile patch（实测 `.dsh-a/profiles/web/cordis.patch.yml` 从 `updateIntervalDays: 5` 被改成 `9`），所以「页面写入 → 官方表单/store 一致」是可观测的，不必只靠推断。
- 0.1.x 线也实测跑通了（`.dsh-b` + 0.1.6-alpha.2 CLI）：插件加载、**legacy 命名空间与 HTTP 桥同时注册**、`/state` 带 cookie 200 / 不带 401、`entryId='dbhub-live'`；`配置表单策略已注册` 那行正确地不出现（0.1.6 的 settings 没有 `configure`）。
- 取客户端 bundle 的 URL 有个坑：index HTML 的模块清单里 `url` 的 `rev` 带 `-<n>` 后缀（`…-55`，每次渲染都变），用正则从组合列表截 rev 会漏掉后缀而 404；必须整段读清单里的 `url`。

## Questions for review

- 无（本次改动全部可逆：新增通道 + 客户端优先 HTTP；legacy 分支保留）。

## 总结（5 行）

1. 偏离计划 6 处：传输改用 `connection.fetch`（而非裸 webServer 路由）、选项以 `prefs.json` 为存储而 volatile Config 作为写入通道/部署种子（而非 Config 单一真源）、保留 legacy 通道做 0.1.x 兜底、发布核心抽成单一 `createHostCore`、客户端「优先 HTTP」而不是「优先 legacy」、顺带放宽 cordis peer 范围并补 `dsh-client-connection` 依赖声明。
2. 最可能被重新审视的一条：**选项的双写**（prefs + profile patch）——若将来要求 Config 成为唯一真源，删掉 prefs 层；若要求完全不碰 profile patch，去掉 `writeOptionsToForm` 即可，两处都是独立的。
3. 发现的边界情况 11 条：0.1.6 的 schemastery 3.18.2 没有 `.volatile()`；Loader 要求 `Config['~standard']`（故不能导出自制 schema）；schemastery 保留未知 config 键、非法类型才抛；settings 的 `ns` 是 `entry.options.id`（不是 `entry.id`）；`settings.update` 会真实改写 profile patch；0.2.x 的 `describe()` 只按 entry id 寻址、不带包名；客户端旧 `inject` 会让整块界面静默 pending；客户端 bundle 的 URL 必须整段读 index 里的模块清单（rev 带 `-<n>` 后缀，正则截断即 404）；0.1.6 与 0.2.1 的 bundle rev 形态不同（12 位 vs 16 位+后缀）；pnpm 的 store 在 workspace 外时沙箱会拒绝，`pnpm pack` 需要 `npm_config_store_dir` 指到 workspace 内；同一端口重复起实例会 EADDRINUSE 并把「插件已加载」的日志留在崩溃前（别把它当成插件故障）。
4. 验证局限：浏览器 UI 仍未自动化（Tabbit Browser 在沙箱下 `BROWSER_LAUNCH_FAILED`）。替代证据：离线渲染门禁第 18 组（真实组件 + 假 fetch/假 configForms 驱动两条写入路径）+ **两条 dsh 线的真实冷启动**（0.1.6-alpha.2 与 0.2.1-alpha.1 各自 200/401、entryId、bundle 200、Config 采纳与写回）。截图级确认仍待人工在 3082/主实例点一次「设置 → DBHub 数据库工具」。
5. 下一个会话先读：本文件 → `AGENTS.md` 的「状态通道（双栈）」与「调试方法 3」→ `lib/index.mjs` 的 `createHostCore` / `wireLegacySettings` / `wireHttpBridge` → `lib/bridge.mjs`。

---

# implementation-notes — 5.1 只读模式 + SSH 隧道 + 入口随启用状态（5.1.0-dev.2）

临时工作记忆，不属于发布内容。对应计划：`PLAN-5.1-readonly-and-ssh-tunnel.md`。

## Deviations

- 计划 §7.6 写 `buildDbhubToml({ ro, ssh })`；实际签名是 `buildDbhubToml({ dsn, ro, ssh })`。原因：`env` 必须携带 `DSH_DBHUB_SEC_DSN` 的真值，DSN 只能由调用方传入；文本里仍只有 `${DSH_DBHUB_SEC_DSN}` 占位符。回退条件：无（签名只是把隐含输入显式化）。
- 计划 §7.3 的 `options` op 只有 `{workspace, env, readOnly?, ssh?}`；实际多了一个**可选 `newEnv`**。原因：legacy 通道的 `configOp` 是单字段，用户"改环境名 + 顺手改只读/隧道"若拆成两条命令会互相覆盖（与既有 `add.renameFrom` 同理）。回退条件：若将来不需要"改名 + 改选项"一条原子命令，删掉 `newEnv` 分支即可（`saveEdit` 会退回纯 `rename`）。
- `readOnlyViolation` / `hostTimeoutFor` / `PROBE_TIMEOUT_MS` / `PROBE_TIMEOUT_SSH_MS` 落在 `lib/adhoc.mjs`（计划只说"存在"，没指定文件）。原因：它们描述执行/探连预算，与 `runAdhoc` 同一个模块，避免 `tools/index` 再复制一份常量。回退条件：无。
- `runCopyFrom` 现在**连同源行的 `readOnly` 与 `ssh` 一起复制**（计划未提）。原因：隧道是"怎么到达目标"的一部分，只复制 DSN 会得到一条连不上的连接；只读是用户在源行表达的安全意图。回退条件：若产品认为复制只该搬 DSN，把 `setWorkspaceEnv(..., opts)` 的 opts 去掉即可（单点）。
- 客户端看门狗改成具名常量（`PRETEST_WATCHDOG_MS` 等）而不是裸字面量。原因：`test/adhoc-toml.test.mjs` 要从源码里提取它们与宿主预算比较大小（R11）。回退条件：无。
- 页面"只改选项"时用 `optionsDiffer(row, form)` 决定发 `rename` 还是 `options`；**纯改名仍走覆盖门**。原因：`saveEdit` 最初让纯改名直达 `configOp`，`check:ui` 第 16 组立刻抓到"改名落到已存在环境不再询问"的回归。回退条件：无。
- 版本护栏**同时**放在 `runAdhoc`（执行时）与 UI（`view.capabilities` 禁用控件）。原因：只靠 UI 的话，一个直接被模型调用的旧 dbhub 仍会走未实测方言；文件级探测很便宜。回退条件：无。
- `applyOptionsOp` 从 `handleConfigOp` 抽出并导出（计划未要求）。原因：options op 的 D10 提升语义必须有单测，而 `handleConfigOp` 依赖 4 个服务。它接收 `lookupAuto` 作为参数、自身不发布。回退条件：无（内部函数）。
- `loadPrefs` 也做**一次性回写迁移**（与 `loadStore`/`loadRuntime` 对齐）。原因：`normalizePrefs` 只在内存里丢弃旧 `showSidebarEntry`，`prefs.json` 仍然带着这个已经不存在的选项，与 V0 的"prefs.json 里不再出现"不符。现在首次启动就把清洗结果落盘。回退条件：若认为 prefs 不该在读取时写入，把回写那一行删掉即可（内存语义不变）。

## Discovered edge cases

- **写入表单与选项草稿是两种形状**：`withConnDraft` 往 *op 形状* 上写 `readOnly`/`ssh`，而 `connDraftOf` 读的是 *草稿形状*（`ro`/`sshOn`/`sshHost`…）。`addDsn` 最初构造的是新对象，导致新增连接的预检载荷**丢掉了只读与隧道**。现在表单对象带 `_draft` 指回原始草稿，`draftOf(form)` 统一取值——`check:ui` 第 20/21 组就是这条的门。
- `configOp` 在 legacy 通道只有**一个字符串字段**：任何"两个改动"都必须是**一条**命令，所以 `options` 带 `newEnv`、`add` 带 `renameFrom`。
- 无 DSN 的编辑里"什么都没改"必须是**空操作**（不回发任何 op）；而"只改名"仍要过覆盖门。
- **`sshOff` 与连接信息同时出现**时，`(sshPlan.ssh) || (旧 ssh)` 这种真值判断会把即将删除的旧隧道当成有效值去探连（子代理发现）。现在用 `!== undefined` 区分"没提隧道"与"明确解除"。
- `readOnly:false` 的拒绝必须放在 `renameFrom`/`copyFrom` 分派**之前**，否则显式解除会被别的分支静默吸收（子代理发现）。
- `optionsPatchOf` 只认真正的布尔：`readOnly: 'yes'` 之类畸形值必须是**空操作**，不能把用户的只读开关"关掉"。
- `applyOptionsOp` 在 `needConnFirst` 错误路径上**不能丢弃已生效的 rename 补丁**（提升失败时也要把改名回执发出去），已修。
- `sweepTempToml` 用 mtime 预算（默认 1h）而不是"清空目录"，否则会删掉正在运行的那次调用刚写的文件。
- dbhub 对**未定义**的 `${VAR}` 是"原样保留且不报错"，所以真正兜底的不是运行时而是生成器测试里"文本引用集合 == env 键集合"的双向断言。
- SSH 的密码/口令会出现在 **dbhub 自己的 stderr 尾巴**里，因此也必须并进 `scrubSecrets(text, dsn, extraSecrets)` 的替换表（不只是 DSN 密码）。
- `describeEnvOptions` 会带出 `host`/`port`/`user`/`proxyJump`（路由元数据，非秘密），但**不镜像密钥路径**，只给 `keyReady` 布尔。
- 版本探测是文件级的：mise（`npm-bytebase-dbhub/<ver>/…`）与 npm 布局（向上找 dbhub 的 `package.json`）都能解析；**PATH 上的裸 shim 可能解析不出** → 记为 `unknown` 并放行（真的不兼容会在调用时报明确错误）。只有名字像 dbhub 的 manifest 才被信任，避免认到别的包的版本号。
- **`@bytebase/dbhub` 的 scope 目录必须显式探测**（子代理用红测试发现）：`npm install @bytebase/dbhub --prefix <dir>` 的布局是 `<dir>/node_modules/@bytebase/dbhub/package.json`，而最初的向上查找只试了 `<dir>/package.json` 与 `<dir>/node_modules/dbhub/package.json` → **默认自动安装路径永远报 `unknown`，`<1.0.0` 的拒绝在默认安装下不可达**（正是"静默降级"的那个危险）。已补第三个候选。
- 向上找 manifest 时的名字过滤必须**严格等于** `@bytebase/dbhub` / `dbhub`：宽松的 `/dbhub/i` 会认到本插件自己的 `dsh-dbhub-live`（相对路径或空 exe 时按 cwd 解析）→ 把本仓库的版本号当成 dbhub 版本。现在空/空白 exe 直接返回 `''`，且只有精确名字才被信任。
- 离屏门禁的 `ctx.slots.register` 返回值必须**真的删除注册项**，"禁用后入口消失"这条断言才有意义（原 harness 的 disposer 是空函数）。
- 门禁里"设置条是否展开"是**页面会话级**状态（跨挂载保留），所以第 19 组不能盲点「设置」（会把已展开的它关掉）。
- 第 22 组用真实 1s 计时器验证"测试中耗时"：残留 interval 会让 `check:ui` 挂住不退出——这正是该组的门禁价值（并因此在末尾补了一次 `liveMount.dispose()`）。
- 脱敏门禁对 base64 PEM 夹具会因熵值判为疑似密钥 → 测试夹具改用低熵假串（不要用 `desensitize:allow` 掩盖）。
- `prefs.json` 里残留的已删除选项**不会自己消失**：`normalizePrefs` 只影响内存，文件要等下一次写入。V0 明确要求文件里也不再出现 → 给 `loadPrefs` 补了与 store/runtime 相同的回写迁移（见 Deviations）。
- 隔离实例冷启动还暴露了一个 **harness 侧事实**：本会话的沙箱禁止命名管道，DSH 的 `subprocess` 服务用管道收集子进程输出，因此**任何** dbhub 探连都会 `spawn EPERM`（`--dsn` 与 `--config` 两条路一样），与本次改动无关；用文件描述符（而不是管道）重定向的独立冒烟脚本可以正常跑通 dbhub。
- 客户端 `SOURCE_LABEL_ZH` 少了 `persisted(promoted)`：被提升的行在 chip tooltip 里会显示原始英文串而不是本地化标签（子代理发现），已补 `src.promoted` 两个语言。

## Questions for review

- `options` op 的 `newEnv`（见 Deviations）是对计划 §7.3 命令表的小幅超集；若将来要严格对齐文档，需要接受"改名 + 改选项"变成两次写入（legacy 通道会丢一次）。
- `copyFrom` 是否应该连选项一起复制（见 Deviations）——这是产品判断，不是技术约束。
- 非秘密的隧道字段（host/port/user/proxyJump）会镜像到浏览器用于编辑态预填；密钥路径、密码、口令永不回显（只给布尔）。若产品要求连 host 也不回显，`describeEnvOptions` 的 ssh 分支去掉三个字段即可。

## 总结（5 行）

1. 偏离计划 9 处：`buildDbhubToml` 显式收 `dsn`；`options` op 增 `newEnv`；探连预算常量落在 adhoc；`copyFrom` 一并复制只读/隧道；客户端看门狗改具名常量；选项判定 `optionsDiffer` 保留纯改名的覆盖门；版本护栏同时落在执行层；`applyOptionsOp` 抽出导出；`loadPrefs` 增加一次性回写迁移。
2. 最可能被重新审视的一条：**`options` op 的 `newEnv`**（对计划命令表的超集，为的是 legacy 单字段通道下"改名 + 改选项"仍是一条原子命令）；其次是 `copyFrom` 是否该复制选项。
3. 发现的边界情况 21 条：写入表单需 `_draft` 才能带上选项（预检载荷曾丢只读/隧道）；`configOp` 单字段 ⇒ 一改动一命令；纯改名仍须覆盖门；`sshOff` 的真值判断会误用旧隧道；`readOnly:false` 必须早于 rename/copy 分派；畸形 `readOnly` 不得清开关；提升失败不能丢 rename 补丁；sweep 用 mtime 预算；未定义 `${VAR}` 静默保留；ssh 秘密也要过 scrubSecrets；key path 不镜像只给 `keyReady`；裸 PATH shim 版本可能 unknown；**`node_modules/@bytebase/dbhub` 这个 scope 目录必须显式探测（否则默认自动安装永远报 unknown、`<1.0.0` 拒绝不可达）**；manifest 名过滤必须严格相等；沙箱/门禁的 details（slots disposer 必须真删、设置条展开态跨挂载、1s 计时器残留会挂住 gate、PEM 夹具触发熵规则）；`prefs.json` 里被删除的选项不会自己消失；本会话沙箱禁止命名管道 ⇒ 插件探连必然 `spawn EPERM`（与改动无关）；`SOURCE_LABEL_ZH` 少了 `promoted` 标签。
4. 验证局限：浏览器仍是离屏渲染门禁（第 19–22 组新增，覆盖"禁用隐藏入口 / 只读开关与行内标记 / 高级 SSH 载荷与秘密不回显 / 测试中计时与计时器回收"），**没有真实浏览器截图级确认**；只读与隧道的真实连通性需要人工用可达主机与真实 dbhub 1.4.0 走一遍 §10.3 V1–V9。
5. 下一个会话先读：本文件 → `PLAN-5.1-readonly-and-ssh-tunnel.md` §1.1（四个实测陷阱）→ `lib/toml.mjs` 与 `lib/adhoc.mjs`（一次性 TOML 的完整契约）→ `lib/index.mjs` 的 `applyOptionsOp` / `handleTestOp` → `lib/tools.mjs` 的 `runConfigure` 选项分支。

