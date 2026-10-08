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
