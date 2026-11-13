# 客户端半（lib/client.js）与布局契约

> AGENTS.md 的配套文档：改 `lib/client.js`、改配置页布局/交互/i18n 时读。
> 架构红线（注入、零知识、状态通道）见 [AGENTS.md](../AGENTS.md)；**这些布局取舍的依据**（为什么只用图标、为什么“来源”不做徽章、为什么库名不截断、为什么是 700/720 双阈值）见 [ARCHITECTURE.md](ARCHITECTURE.md#布局取舍)。

## bundle 契约（手写 lazy-CJS，无构建步骤）

`lib/client.js` 由 DSH client 模块系统按 `dsh.client` 声明 + `exports["./client"]` 直接服务，**没有构建步骤**。改完跑 `node test/client-format.test.mjs` 守护：

- 必须以 `window.__ModuleLoader__.load({ id: "dsh-dbhub-live", factory: (require) => { … } })` 注册；
- `id` 必须等于 Loader entry 名（`dsh-dbhub-live`，见 `cordis.patch.yml` 的 `name`），**不是行 id**；
- factory 只允许 `require("react")` 等 baseline 模块；不 import 其他插件的值（bundle-purity）；
- 导出 `name` / `inject` / `apply`，结尾 `return module.exports`；
- 若本包脱离仓库发布 npm，`dsh.client` 与 `exports["./client"]` 必须保留，否则 client-modules 扫描会启动报错。

## 三个入口（都要在，且不得自锁）

| slot | 说明 |
| --- | --- |
| `settings.section`（id `dbhub`，order 40） | **主入口，始终注册**。设置面板是核心 shell，任何部署都在，用户也在那里找连接管理 |
| `sidebar.panellist`（id `dbhub`）+ `main`（key `dbhub`） | 侧边栏快捷入口，**仅 `enabled && showSidebarEntry` 同时成立时显示** |
| `plugins.row.config`（key `dsh-dbhub-live#dbhub-live`） | 组件同时服务 `props.view === 'summary'`（一行摘要）与 `'page'`（完整表单，自画标题/图标/面包屑）；仅在官方插件页浏览器半区活跃时存在，**不能当唯一入口** |

- **「隐藏入口」≠「禁用插件」**：关开关只是不显示侧边栏入口，工具照常可用；禁用则一律不贡献入口。
- 两种状态下 `settings.section` 与 `plugins.row.config` 都**始终注册**，否则用户再也回不来。
- 侧边栏由 `syncSidebar()` 挂 `face.subscribe` 按 view 即时 register/dispose；判定 `sidebarWanted()` = `view.enabled === true && view.showSidebarEntry !== false`。**「未知」不注册**：`enabled` 必须是字面 `true`（读不到状态、或读失败时没有入口），因为 `syncSidebar` 只在 publish 时触发，用 `enabled !== false` 会在首帧就把入口挂上去、并且带着一个指向"打不开的页面"的快捷方式。
- 注册不存在的 slot 会被静默忽略（「配置页消失」就是这么来的），别改回已删除的 slot。

## host face：探测与写回（别退回 inject）

`export const inject` **只能有 `["slots"]`**。`httpFace()` 是唯一实现（`getSnapshot` / `subscribe` / `setEnabled` / `saveConfig` / `configOp` / `refresh`，快照 `{ status, value }`）。`settingsScope` 既不注入也不探测——0.2.x 已删除该服务，而 0.1.x（唯一提供它的版本线）已不再支持。

- HTTP face 四个入口：`GET /state`、`POST /enabled`、`POST /options`、`POST /op`；写完用响应里的 view 直接刷新快照（不等轮询）；`configOp` 的 `{op: …}` 直接 POST。
- **写失败必须冒泡**：`request` 的 rejection 一路传到调用方（失败分支**不得**写成 `noop`），见下节。`refresh()` 永不 reject（失败时把 `status:'error'` 发布出去，由页面渲染 + 提供重试）。
- **选项写入优先走官方 settings 表单**：Host 发布 `entryId`，客户端有 `ctx.configForms` 且 entryId 非空时 `configForms.get(entryId).set(field, value)`，失败/解析不到才回退 `POST /options`（无 settings 客户端的部署走这条）。
- **HTTP 通道轮询是「按订阅」的**：只有渲染中页面用 `props.subscribe(fn, { live: true })` 起 1.5s 轮询（`document.hidden` 跳过）；插件作用域订阅（`face.subscribe(syncSidebar)`）只做一次性拉取。**空闲 GUI 不得持续轮询**，残留 interval 会让 `check:ui` 挂住不退出。
- 组件不得接触 `ctx`：数据/回调一律通过注册时的 `inject: () => face` 传入 props。

## `@` 输入源（输入框里多选数据源，右侧可下钻）

除三个页面入口外，`apply()` 还向 DSH 的 **input-trigger** 服务（`ctx.inputTriggers`，`@deepseek-ai/dsh-client-ui-input-trigger`）注册**一个** `@` 分组。契约（改动前先读 `lib/client.js` 的注释头）：

- **可选注入，绝不写进导出的 `inject`**：`ctx.inject(["inputTriggers"], (scope) => scope.effect(() => scope.inputTriggers.registerSource(source), …))`。导出 `inject` 仍只有 `["slots"]`——把可选服务写进去，缺失时整个浏览器半区会永久 pending（与 `settingsScope` 同一个坑）。
- **`name: 'dbhub'` 是稳定 ASCII**：它既是菜单分组标题，又是提交时 reference 的路由键（`insert.source` 必须与它逐字相同），不做本地化、不随 locale 变。
- **两级菜单，层级由草稿文本判定**（`drilled` 是**控制器全局**的：DSH 自带的文件目录在同一个控制器上下钻时它同样是 `true`，**不能只看它**）：
  1. **顶层**（`!drilled`，或面包屑刚把草稿改回裸 `@`）：只有**一个分组** `at.group`（「dbhub 数据库」）。组内先是**当前会话工作区**的连接（`name`/`label` = 环境名，按 env 排序），最后一行是**文件夹**「其他工作区」——`drill: true` + `icon: 'folder'`（chevron），`description` = `at.othersHint`（「按 Tab 进入」）。当前工作区没有连接时**跳过它**（不出现空分组）；没有其他工作区时**不出现**文件夹行。
  2. **文件夹内**（`drilled` 且 `query` 以 `at.others` 开头）：列出**其他工作区**的连接，`name`/`label` = `工作区 · 环境`；`query` 去掉标记后的剩余文本按 `name` 子串过滤。
  3. **别人下钻**（`drilled` 但 `query` 不以我们的标记开头）：返回 `[]`。空分组被平台丢弃，我们就不再出现在别人的文件目录里——**判据是我们自己插入的草稿文本，不是全局的 `drilled`**。
- **下钻 = 改写草稿文本**：`onPick` 收到 `action: 'drill'` 时**不返回 `insert`**，而是 `{ text: '@' + t('at.others'), continue: true }`（`execute()` 只认 `text`；`continue` 让菜单保持打开）。文件夹行与面包屑都走这条；面包屑第一段（`value: 'root'`）返回 `{ text: '@', continue: true }`，回到顶层（菜单在裸 `@` 上重开并重新拉候选）。
- **面包屑**：`header()` 只在状态 2 返回 `[{ label: t('at.group'), value: 'root' }, { label: t('at.others'), value: 'others', current: true }]`；其他状态返回 `undefined`（顶层与别人的下钻都没有我们的面包屑）。
- **当前工作区只用会话信息**：`candidates(session, …)` 的 `sessionId` + 可选 `sessions` 服务（`list.getSnapshot().byId[id].cwd`），也接受自带 `cwd` 的 session 对象。拿不到时**不猜**：顶层退化为「环境名 + 工作区后缀去重」的扁平列表且没有文件夹行（宁可平铺，也不把别人的行标成"当前"）。
- **名字唯一性**（`name` 是精确匹配键）：顶层用环境名（同一工作区内不会重复）；文件夹层用 `工作区 · 环境`；万一撞名（同名工作区 + 同名环境）退回 Host 的 `alias`（保证唯一）。降级平铺时跨区重名的环境先用 `环境 · 工作区`，再退回 `alias`。
- **零知识**：候选里只允许环境名 / `工作区 · 环境` / 别名 / 句柄 / `conn`（**只给 `host:port/database`**，去掉 `scheme://`，给窄屏留空间）/ 只读标记 / 工作区标题。**不出现 DSN、账号、密码、本机路径**（`srcId` 只是句柄）。
- **`onPick`（选择）返回 `{ insert: { source: 'dbhub', ref: <句柄>, label: <菜单名>, appearance: 'file', clipboardText: '@'+别名 } }`**：`ref` 用**句柄**而不是别名，别名会随增删连接变化。
- **`codec`**：`serialize(ref) → '@db:<句柄>'`（提交时**每个 chip 各调一次**，这就是一条消息多选能工作的机制）；`clipboardText(ref)` 用该句柄**当前**的别名（找不到就退回句柄本身）。
- **`lexicon()` / `subscribeLexicon()`** 返回/跟随当前别名集合，供「手打 `@别名` 也变成引用」；订阅复用 face 已有的通知点（`face.subscribe`），**不新增定时器**。`warm()` 只触发一次既有 `face.refresh()`。
- **空态语义**：插件停用、`/state` 读取失败、没有任何连接行 → `candidates()` 返回 `[]`（空分组自动关菜单）。**绝不抛错、绝不显示假数据**；`ctx` 没有该服务时整个注册不执行，插件其余部分照常。
- **首个 `@` 不等空快照**：`/state` 尚未落地时 `candidates()` 先等一次有界的 `refresh()`（并发共用同一个 promise）。否则第一次按 `@` 会得到空分组、菜单立刻关闭，看起来像功能坏了。等完仍是失败/无行，才按上一条返回空。
- Host 侧配套：`summarizeRows` 给每行写入 `alias`（`collect.mjs` 的 `assignConnectionAliases` 是唯一实现点），所以 `/state` 的 `workspaces` 天然带别名；策略段同时解释 `@db:<句柄>` 并附「别名 → 句柄」目录（见 [AGENTS.md](../AGENTS.md)）。

## 写失败与错误态（四条硬约定）

浏览器半曾经把**所有写失败都当成功**：`httpFace().post` 的 rejection 分支是 `noop`，于是 `saveConfig().then(setSaved(true))` 对 401、`{ok:false,error}`、网络拒绝一律显示「已保存 ✓」，`configOp`（含带 DSN 的保存）、`setEnabled`、`remove` 全部静默丢掉。四条约定按此收口：

1. **写失败必须可见**：face 的写返回 promise，失败时 **reject**（带 message）；组件捕获后写入 `writeError`，渲染一行 `.dbh-error .dbh-writefail[role=alert]`，并且**不得**把 `saved` 置 true。失败后不锁按钮，再次点击就是重试。
2. **错误态可重试**：`StatusCard` 必须读 `snapshot.status`（不是只读 `value`）。`'error'` 时渲染 `.dbh-loadfail` 错误行 + 「重试」按钮（调 `face.refresh()` 做一次真实读取，不是伪造一个空 view）。失败时保留上一次成功读到的行，不显示成"一个连接都没有"。**错误行还要带一句自救指引**（去「设置 → 插件」确认启用；升级后重启）——宿主半没加载时，这张卡片是唯一还能说话的地方。写被拒后补一次 `refresh()`：写会占一个更高的读序号、把先发的 `/state` 读丢掉，没有这一步卡片可能停在 `loading` 直到下一次轮询。门禁 `[33]`。
3. **未知态不注册入口**：`sidebarWanted()` 只在 `enabled === true` 时返回 true（见「三个入口」）。
4. **Hook 序列一致**：`{'props.view'}` 的 `summary` / `page` 两种 view 必须**跑完全相同的 Hook 序列**——summary 的早退只能发生在**所有 Hook 之后**，页面树在返回处用 `isPage ? … : summaryNode` 选择。否则同一实例从 `summary` 切到 `page` 会抛 `Rendered more hooks than during the previous render`（`plugins.row.config` 的卡片就是这样同时服务两种 view 的）。

配套细节（都各有一段门禁）：

- **探测命令发送失败**（401 / 离线）要**立刻**把该次探测收尾成「命令未能送达宿主」，并 `clearTimeout` 掉已起的看门狗；否则页面先转 30s/60s，最后报「测试超时未返回」——把"没送到"报成"连不上"。
- **写后的响应乱序（两条水位线，别合并成一条）**：读响应按 `seq`/`appliedSeq` 排序——比已应用版本旧的读直接丢弃，写命令**发起时**就取一个高于所有在途读的序号，于是「写之前发起、写之后才回」的轮询答案不会盖掉用户刚点的写。**写响应另算一条水位线**（`appliedWriteStamp`）：它是「用户这次写之后」的状态，**永不**与读序号比较，只与更晚的写比较。否则「写先发 → 读后发 → 读先回 → 写后回」里读拿走了更高序号，写自己的答案被丢掉，卡片停在写前值、旁边还挂着「已保存 ✓」，得等 1.5s 轮询自愈。门禁 `[39]`。
- **settings 表单的受理只看 `true`**：`form.set(key, raw)` resolve `undefined`（0.2.x 若干构建就是这样）曾被 `ok !== false` 读成「受理」→ 零 POST、零校验，页面仍印「已保存 ✓」。现在只有 `ok === true` 算受理，`false`/`undefined`/reject 一律回落 `POST /options`（那条路由由宿主真写）。门禁 `[40]`。
- **宿主返回值缺失 ≠ 空页**：`{ok:true}` 却没有 view（反代改写、响应截断）曾被当成 `value: {}` 发布——3 tile→0、布局标志全部消失，弹窗行上还留着「已保存 ✓」。现在 `value` 不是「非空对象」时：**读**保留旧行并进 `status:'error'`（与 fetch 失败同一条 `.dbh-loadfail` + 「重试」路径），**写**直接 reject（`.dbh-writefail` + draft 回滚 + 不置 `saved`），绝不 `publish({status:'ready'})`。门禁 `[40]`。
- **非 JSON 响应必须本地化**：反代返回 HTML 时 `res.json()` 抛 `Unexpected token '<' … is not valid JSON`——英文栈信息，还带着响应体。解析失败统一映射成传输失败（本地化 `error.write`），底层文本与响应体一律不进页面。门禁 `[42]`。
- **不可撤销的写要单飞**：删除确认用 ref 同步占位（`setState(null)` 要等下一次渲染，同一 tick 的第二次点击拿到的还是旧闭包），连点只发一个 `remove`；失败后解除占用，再点就是重试。门禁 `[43]`。
- **失败时不许留旧勾**：`savedHint()` 是 `saved && !writeError`——「已保存 ✓」不能和一条失败行同时出现（启用/停用这类没有 draft 可回滚的写只设 `writeError`，一次先前的成功会把它漏出来）。门禁 `[45]`；写失败**必须**把 draft 放回宿主值（`draftEdited.current = false` + `setDraft(draftFromValue(value))`），否则字段里留着一个 store 从未接受的值，门禁 `[44]`。
- **间隔校验在客户端先做**：`Number("") === 0` 会把"留空"存成"永不更新"，`1.5` 也能混过去。提交前 `trim` 判空 + `Number.isInteger` + 范围 `0..365`，非法只显示 `.dbh-invalid`（中英双份文案）且**不发任何请求**；编辑时清除该提示。
- **draft 与宿主快照同步**：初始化器只跑一次，所以还要一个 effect——本地没有未提交编辑时跟随 `value`；写入失败按当前 `value` 回滚（开关不能停在"已隐藏"而 store 还是"显示"）。
- **删除先确认**：`.dbh-warncard`（`del.*` 文案）确认前零写入，取消即零写入；这条是唯一不可撤销的写，不能一键直达。
- **写有上限**：一次写最多等 `WRITE_TIMEOUT_MS = 90s`——没有它，一个「接了连接却永不回答」的网桥会让写永远 pending（无提示、无错误、无重试，点击直接消失）。上限**必须长于** 30/60s 的探测看门狗，因为 `{op:'test'}` 的 POST 会真的花掉一整个 SSH 预算；超时**只是失败**（本地化 `error.write`、draft 回滚、不置 `saved`），不新增「超时」语义，宿主也可能已经写入，下一次读取给出真相。门禁：`test/client-format.test.mjs` 断言上限 > SSH 看门狗（`check:ui` 不为它等 90s）。
- **更新检查按钮必须有可见状态**：只写 `disabled: checking` 等于没反应（用户的原话是"点了跟没点一样"）。检查中：子元素 `.dbh-spin` 转圈（900ms，`prefers-reduced-motion` 时静止）+ 旁边 `.dbh-verstate` 显示「检查中…」+ `aria-busy`；完成：停转并短暂显示「已是最新 / 发现 vX / 检查失败」，**2.5 秒自清**（复用 `savedHint` 的 `setTimeout` + 卸载清理模式）。动画挂在**子元素**上，所以 `:disabled` 不会让它停——`[52]` 有一条断言专门防这个。
- **更新检查的收尾条件写「宿主答了」，不是「时间戳动了」**（D5）：`{op:'updateCheck'}` 失败时宿主**只写 `update.error`**，刻意不推进 `checkedAt`（复用窗口不能被一次失败推走）。清理 `checking` 的 effect 若只比较 `checkedAt`，这条条件在失败时永远不成立 → 按钮一直 `disabled`、tooltip 停在「检查中…」，直到 20s 看门狗自己松手——恰好把宿主刚写下的错误藏了 20 秒。现在基线记录**整条 update 快照**（`raw` + `checkedAt` + `error`），任一变化即视为已答复：清 `checking`、清看门狗，tooltip 立刻变成「检查更新失败：<原因>」，按钮可以马上再点。门禁 `[47]`。
- **零知识**：错误行只显示宿主返回的 `message`（宿主已清洗）或本地化文案；传输失败**不得**回显 HTTP 状态里的原始响应体，更不能拼接输入框里的 DSN。

## apply() 必须能被重复执行

客户端 HMR 会重跑整个 bundle。`localeSvc.register(NS, …)` **不幂等**（同 namespace+locale 再注册抛 `locale namespace … already has locale zh`，整个浏览器半区同步失败）。所以：

1. 捕获 disposer 用 `ctx.effect(() => dispose, …)` 挂在插件作用域；
2. 注册失败**降级到 `localTranslator(localeSvc)`**（读本 bundle 字典 + `localeSvc.getLocale().active`），绝不打断整个插件半；
3. 新增/改动 `apply()` 注册都要问一句：**reload 第二次还会成功吗？**

样式在 `apply()` 里由 `ensureStyle()` 注入一份作用域样式表（`#dsh-dbhub-live-style`，类名前缀 `dbh-`）——悬浮/焦点是伪类，内联样式表达不了；**不要把样式退回成一堆内联对象**。

## 主题适配（红线）

- 样式表**只允许 `--dsw-alias-*` token**，兜底值必须中性且半透明（`rgba(127,127,127,.3)`、`transparent`）；
- **禁止任何不透明色字面量**（`#ffffff` / `#f6f8fa` / `#1f2328` / 品牌色…）。用户会装主题/皮肤插件（本机就有 skin-center，背景可能是半透明的），写死白底或固定浅灰字会直接看不清；`test/client-format.test.mjs` 有 "tokens only" 断言门禁；
- 只在动态取值时用内联样式；对比度：正文及以上用 `label-primary` / `label-secondary`，`label-dimmed` 只留给极次要说明。

## 布局契约

### 整体结构

- **按 `path` 分组**（`groupRows`；标题不是身份——同名工作区是不同目标，同名组头用路径消歧）。
- `layoutModeOf` **无阈值**判定：所有工作区都只有 1 个环境 → **平铺网格**（`dbh-tiles`，`minmax(280px,1fr)` + 内容列 `max-width:960px`，自然封顶 3 列）；只要有任一工作区是多环境 → **分组折叠**（`dbh-group` + 可点击组头 `aria-expanded`）。判定必须是纯函数，改判定先改 `scripts/render-check.mjs` 的断言。
- **层级**：工作区分组是 level-1（边框卡片 + 极淡阴影），环境行是 level-2（缩进 + 左侧引导竖线 `dbh-groupbody{border-left}`）；两层绝不能长得像同一层。
- **默认展开**：单个工作区自动展开；多工作区时展开「最近活跃工作区」（由 `useWorkspaces` 的 `WorkspaceSnapshot.updatedAt` 推出；设置面板是全局的，拿不到当前会话选中态，**别猜**）；取不到快照全折叠。另有「全部展开/折叠」总控。展开态 / 添加面板 / 设置条存模块级 `uiMemory`（同页面会话内跨重挂载保留，**不持久化**——视图状态不是配置）。

### 每个连接只占一行

```
环境 chip（窄、淡） · 连接元数据 · source chip · [▶][✏][🗑]
```

三条硬规则：

1. 行内操作**只允许图标**（`primitives` 的 `IconPlayOutline16` / `IconEditOutline16` / `IconCloseOutline16` / `IconTrashOutline16`，无边框 24px，label 走 `title`/`aria-label`）——文字按钮一放上来就吃掉半行。
2. `source` 做成**可复制 chip**（`sourceChip`）：虚线边框 + 复制图标 + **短句柄**（`shortHandle`：≤14 字全显，否则保留"工作区哈希 + 环境段"两段），让人一眼看出"这是 id、点了复制"，而不是"复制整行连接串"；全文与用途进 tooltip（`ws.srcHint`），复制走 `primitives.writeClipboard`（自带 execCommand 兜底）。
3. 连接元数据用 `connLabelView` 拆成 `前缀(type://host:port/) + 库名`，**前缀可截断、库名绝不截断**（`dbh-conn-pre` 省略号 / `dbh-conn-db` 不收缩）——"窄行里看不到库名"是最常见的抱怨。

- 行内只允许出现 `w.conn`（元数据）；`srcId` 只是句柄，**绝不回显 DSN**。
- 🔒 前缀：**不加**（会被误读成"需要密码"，且与只读 chip 的锁冲突）。
- 「来源」（手填 / 扫描 / 复制 / 自动发现）**不得做成行内徽章**——它几乎每行都一样却最抢眼；改为环境名 chip 的 tooltip（`originTitle`），只有"自动发现且未持久化"这一例外在 tooltip 里显式点名。
- 改名走 `configOp({op:'rename'})`；改名 + 改连接走**一条** `{op:'add', renameFrom}`（桥接上是一条命令，分两次写会互相覆盖）。
- 写命令被拒时必须有可见回执：宿主把失败原因放进 `view.opNotice`（一次性 JSON `{ok:false,message}`，下一条命令即清空），卡片渲染成 `.dbh-notice`。浏览器半**不读** `/op` 响应体，所以收不到这条就等于"点了没反应"。覆盖类确认（改名落到已有环境、`add` 带 `renameFrom`）在卡片侧由 `dbh-warncard` 确认后，把 `overwrite:true` 一起发给宿主。

### 顶部与添加

- **顶部**：标题 + 版本 + 升级链接；状态行只留状态与连接数；设置用 DSH 行样式；长说明进折叠区。宿主版本过旧时，标题下方多一条 `.dbh-tooold` 警告卡（中英双语，写明最低版本与当前版本）——页面、连接、工具全部照常，**不是**功能门。
- **添加连接默认收起**：「＋ 添加连接」（全局；工作区用 `<datalist id="dbh-ws-list">` 给已有工作区）/ 分组头「＋ 环境」（工作区自动带入，少一个字段）。保存仍走原有「试连 → 失败才确认」门禁。

## 连接列表的搜索 / 排序 / 批量测试

连接列表上方是**一行**控件（`.dbh-searchbar`，empty / tiled / grouped 三种布局都渲染）：搜索框（带「搜索」文字前缀与内嵌 `×`）、过滤计数、排序**文字**控件、「测试全部」；运行中出现一条 `.dbh-batchsum` 汇总。三者全是**组件本地视图状态**（`useState`）：不持久化、不写 `uiMemory`、不新增协议。**桌面与窄桌面（≥700px）这一行不换行**（`flex-wrap:nowrap`），只有手机才让搜索框独占一行；搜索框 `flex:1` 且上限 360px，排序与批量靠 `.dbh-grow` 撑到右边缘。

### 搜索（只影响显示）

- 纯函数 `filterRows(rows, query)`：**大小写不敏感子串**，字段固定为 `title` / `env` / `alias` / `conn`（`conn` 是宿主已发布的元数据 `type://host:port/db`，**没有任何 DSN 可达路径**）。空查询返回原数组（不算过滤）。
- 外观是**一个盒子**（`.dbh-search`）：左边 `搜索` 文字前缀（`.dbh-searchlabel`，**不是按钮**）、中间无边框的 input、右边 `×`（`.dbh-searchclear`，**只有有内容时才出现**）。占位文案因此可以很短（`search.ph`「输入关键字」）。
- 过滤生效时显示 `search.count`（「N / M」）；**无匹配**渲染 `.dbh-empty.dbh-nomatch`（「没有匹配的连接」+ 独立的「清除搜索」按钮——手机上看不到 `×` 时这是唯一出口），**不能**落到「还没有配置连接」——那是"一条连接都没配"，是不同事实（`page([])` 仍走 `ws.empty`）。
- 过滤**只影响显示**：`envCollision` 的冲突判定、行内保存/测试/删除、`@` 候选与标题计数全部仍用**未过滤**的 `groups` / `workspaces`。
- 过滤期间分组**自动展开**（`groupOpen` 里 `filtering` → true），但用户显式点过折叠的组仍尊重其选择：匹配项藏在折叠组里，会让搜索框看起来是坏的。

### 排序（分组跟着排）

- 纯函数 `sortRows(rows, mode, recentAtOf)`，四个状态：`''`（默认，**保持宿主顺序、完全不排**）、`name-asc`、`name-desc`（标题 → 环境 → 路径，**大小写不敏感 + 原串兜底**，刻意不用 `localeCompare`——同一份列表在每台机器上必须排得一样）与 `recent`（`updatedAt` 倒序，同值回落名称；缺失/空串沉底；数字戳按数值比，ISO 串按字典序比）。`'name'` 是旧写法，等同 `name-asc`。降序把**整条比较链**反过来，相等行仍保持输入顺序（稳定）。
- **一个文字控件，不是标签页也不是下拉**：`sortViewOf(mode)` 给出「标签键 + 箭头」，`nextSortMode(mode)` 给出下一态——默认 → 名称 ↑ → 名称 ↓ → 最近更新 → 默认。CSS 上无边框、无背景、次级色，只有 `:hover` 才加下划线（`.dbh-sorttext`）。
- **分组的顺序免费跟着排**：`groupRows` 保留首次出现顺序，所以先 `sortRows` 再 `groupRows` 就是"组也排好了"。列表渲染 `visibleGroups`；`groups`（未过滤）只用于页头总数、`datalist` 与冲突判定。
- `最近更新` 的戳来自**工作区快照**（`props.useWorkspaces` 的 `items[].updatedAt`）；行自身有 `updatedAt` 时优先用它。没有快照的挂载（插件页 / 侧边栏）里该模式退化为名称顺序——**不发明时间戳**。
- **布局不从过滤结果推**：`layoutModeOf` 用的是**未过滤**的 `groups`。否则"筛到一条"会把卡片在平铺与折叠之间来回切，输入时整行在光标下跳。

### 批量测试（并发 2、读 POST 应答、无轮询）

- **`/op` 的响应体就是完整 view**，宿主在应答前已把本轮结果写进 `lastTestResult`，所以批量读 `body.value.testResult`（`{nonce, ok, message}`）按 nonce 关联每行，**不需要宿主改动、不等 1.5s 轮询、不碰单行的 mirror effect**。
- **状态与单行测试分离**：批量用 `batchRef`（在途/停止/重启的权威）+ `batch` state（渲染）；单行仍用 `tests` / `nonceKeys` + `view.testResult` 的 effect。批量 nonce **不在** `nonceKeys` 里，因此 mirror effect 永远认不出它（不会互相覆盖）；单行的应答也从不写批量 map。唯一共享的是 `testTimers`（看门狗句柄表），键是唯一 nonce，互不清对方。
- **N = 可见行数**：`startBatch` 取当前 `visibleRows`（过滤 + 排序后）作为队列；按钮文案 `batch.all` 用的也是同一个数。
- **并发 2**（`BATCH_CONCURRENCY`）：每条都要在宿主上 spawn 一个 dbhub，12 行不能一次要 12 个。调度是**无定时器**的 `pumpBatch`（结算一条就补一条）。
- **每行四态**：`等待`（queued）/ `测试中…` / `通过 ✓` / `失败 ✗ · 原因`（原因折叠空白后截断到 `BATCH_REASON_MAX = 120` 加省略号）。批量行用**自己的类**（`.dbh-test-wait` / `.dbh-test-batch` / `.dbh-batch-ok` / `.dbh-batch-fail`），不与单行的 10 秒 tick 混淆。汇总 `.dbh-batchsum` = `batchSummaryOf`（`未测 = total - pass - fail`，包含排队中与停止后没跑的）。
- **看门狗与形状照旧**：`{op:'test', workspace, env, nonce}`，30s / 60s 分档，句柄进 `testTimers`（与单行同一个 map，所以卸载清理天然覆盖）。**失败原因**走既有本地化：派发被拒 → `test.notSent`；无应答/应答缺该 nonce → `test.timeout`；宿主文本原样（已清洗）。
- **停止的语义**：`stopBatch` 只清队列（未开始的行**回到未测**，删除其 map 条目），**不动已发出的请求**——协议里没有取消，插件不伪造取消；在途应答照常落地，行显示真实结果。停止后按钮立刻变回「测试全部（N）」，汇总保留（含未测数）。
- **卸载**：`batchLive` → false、`batchRef` → null（迟到的结算按 `batchRef.current !== run` 丢弃），并清空 `testTimers` 里的每一个句柄（含批量的）。
- **单行点测与批量不打架**：排队/在跑的批量行 `batchBusy` → 行内 ▶ 禁用、`startTest` 直接返回；对**已完成**的批量行点 ▶ 会先 `forgetBatchRow` 丢掉该行的批量结论（否则单击的瞬时结果会被批量行盖住，表现为"点了没反应"），汇总相应把它记回未测。

### 验收

- `check:ui` `[49]`：搜索框在三种布局都在、大小写/别名/`conn`/中文命中、「N / M」、无匹配空态与独立的清除按钮、**四个排序状态**（默认保持宿主顺序、名称 ↑、名称 ↓、最近更新）与**组顺序**跟随排序、并发上限 2、四态渲染、汇总、停止（未开始的不再派发、在途仍落地、按钮复原）、N=可见行数、op 形状无新增字段、卸载无残留计时器；`[50]` 再钉工具栏结构与几何（一行不换行、搜索前缀不可点、无 `<select>`、三个控件同 28px）。

## 设置项：改完即生效（没有 保存 按钮）

设置区的四个输入（更新间隔、测试并发数、默认返回行数、导出目录）**没有「保存」按钮**：`onBlur` 与 `Enter` 各提交**该字段**（`commitField(field, raw)`），提交中显示「保存中…」、成功后短暂显示「已保存 ✓」（1.6s 后自行消失，下一次编辑也会清掉）。这是被用户逼出来的设计——改完以为已生效、找保存按钮找到放弃。

- **一次只写一个键**：`payload[field] = value` 走既有 `props.saveConfig`（`POST /options`）。旧的整表提交会把其它字段一并重发，反而可能把别处刚改的值写回去。
- **本地预校验只在浏览器能做的地方做**：间隔 0–365、并发 1–8、行数 ≥0，非法则**零请求** + 就地 `.dbh-invalid`（`cfg.badInterval` / `cfg.badConcurrency` / `cfg.badRows`）。**`exportDir` 不预判**——目录可写与否只有宿主能证明（`prepareExportDir` 的探针），所以它直接发，拒绝原因由宿主回。
- **失败即回退**：写失败走统一的 `onWriteFail`（draft 回到宿主值、`saved` 取消、清掉任何旧的「已保存 ✓」、`.dbh-writefail[role=alert]` 显示原因）。旧的勾不能与新错误并存，这条由 `[44]` 钉住。
- **导出目录**一行另有两个按钮：`?`（`title` 悬停 + 点击就地展开同一段说明，`cfg.exportDirHint`）与「默认」（把输入框写成空串并立即提交 = 默认位置）。
- **「选择」按钮只在平台真的提供目录选择时出现**：宿主服务 `remote.directoryPicker` 经 `ctx.inject(["remote.directoryPicker"], …)`（**可选、等待形式，绝不进导出的 `inject`**，否则缺服务会让整个浏览器半区永久 pending）注册进模块级 `pickerRegistry`；存在时按钮渲染，点击 `pick()` → `{ok:true,value}` 填进输入框并**立即走同一条提交路径**，`{ok:false}` 用既有 `.dbh-writefail` 显示 `error.message`，取消（`null` / 无 value）**什么都不做**——不清空用户已填的内容。桌面端这是系统目录框，网页端是 DSH 自己的目录浏览；路径只由平台产生，插件不读本机目录。
- 窄屏（弹窗 / 手机）是同一批控件的竖排版本（`.dbh-srow`，导出目录那行是 `.dbh-srow-export`，输入框 `flex:1` 撑满控件区）——**同一个 `cfgField()` 工厂**，所以两面的校验、提交、回退完全一致。
- 导出目录输入框 `min-width:280px`（`.dbh-input-dir`，monospace、左对齐）：占位「留空 = 默认位置（数据目录/exports）」必须能整句看见，1440px 与 720px 都是；窄了就换行，不裁字。
- `check:ui` `[48]`：blur/Enter 各写一个键、非法值零请求、导出框宽度与占位完整（1440/720）、`?` 展开、`默认` 写空串、picker 三态（存在→填值并提交 / 拒绝→显示且不改输入 / 不存在→无按钮）。

## 行的顺序 / 拖拽 / 复制（与后端 `move` / `copy` / `order` 对接）

**顺序是宿主的**：`/state` 的每一行都带该工作区的 `order: string[]`（只含**已持久化**的环境名）。客户端从不自己改顺序：

- `orderMapOf(rows)` 取每个工作区**第一行**的数组（线上没有分组对象）；`sortByStoredOrder(rows)` 按它排出平铺行序列——`order` 里的名字按数组顺序，**不在里面的一律按名称追加**（就是自动发现的行），组与组之间保持它们在 `/state` 里的先后（拖一行到别的组不该让工作区本身跳位）。没有 `order` 的工作区（无持久化行 / 老宿主）退化为名称序。
- **显式排序优先于存储顺序**：`sortMode` 非空（名称 ↑ / 名称 ↓ / 最近更新）时按排序排，同时**禁用拖拽**（手柄 `aria-disabled` + 行 `draggable=false`，tooltip 说「先切回默认」）；回到「默认」才用 `order`。
- 拖拽：行左侧 `.dbh-grip`（`⋮⋮`，仅 hover 显示，`cursor:grab`），`draggable` 挂在**行**上。拖动中的行加 `.dbh-dragging`（半透明）；经过目标行时按上半/下半给出 `.dbh-drop-before` / `.dbh-drop-after`（inset 阴影，不产生布局位移）；组尾还有一条 `.dbh-dropend` 落到「末尾」。瓦片布局里 tile 自身既是拖动源也是放置目标（拖到 tile = 追加到该工作区）。
- **落点索引**：`moveIndexFor(envs, sourceEnv, overEnv, after)` 是纯函数，按宿主的语义算——`index` measured **在源被移除之后**，所以同组向下拖要减 1，落在自己下一格是 no-op 而不是越界；跨组时源不在目标列表里，不偏移；尾部/空投 = 目标持久化行数。结果一律夹取到合法区间。
- 落手只发 `{op:'move', env, workspace, toWorkspace, index}`（五个键，无 DSN），成功后**重读 `/state`**（不本地改序）；失败显示宿主原因（`.dbh-writefail`）并**再读一次**——列表本来就没被改过，重读即回滚。
- 复制：持久化行有 `.dbh-copybtn`（与其它图标按钮同款）→ `{op:'copy', env, workspace}` → 重读；新行出现在源行下面，宿主给的名字是 `-copy-1/2…`，用户可再改。
- **自动发现的行**（`persisted !== true`）不可拖、没有复制按钮、也不在 `order` 里；它们的行仍然渲染一个置灰的手柄，tooltip 说明「需要先保存（编辑一次即可）」。对它们发 op 宿主会回 `unknownEnv`。
- **触屏**：HTML5 拖拽在手指上不触发，所以 `isMobile` 下**不渲染手柄**，行内改为「上移 / 下移」两个极小图标按钮（`.dbh-movebtn`，边界按钮 disabled），发同一个 `move` op：上移 `index = at-1`、下移 `index = min(len-1, at+1)`（同样是移除后的坐标）。
- `check:ui` `[51]` 钉住：行按 `order` 排（自动行附在末尾）、排序控件优先且禁用拖拽、组内下拖 index 1 / 上拖 index 0、跨组 `toWorkspace + index`、组尾追加 index=len、op 只有五个键、复制 op + 重读、失败原因 + 重读回滚、触屏无手柄且有上移/下移（首个 up 禁用、末个 down 禁用，点击发 index 1）。

## 环境选项的落点（只读 / SSH / 结果行数上限）

同一组选项只有一套规则，落点固定：

| 元素 | 呈现 |
| --- | --- |
| 只读标记 | 行内 `.dbh-rochip`，弹窗/宽屏/手机三种布局都出现；点击发 `{op:'options', readOnly}`（无 DSN）；必须 **开锁+「可写」/ 闭锁+「只读」**（同一 16px 线性图标风格），否则两个灰色「只读」会被误读成都是只读 |
| 最大返回行数 | **已移除**：上限改成全局设置 `defaultMaxRows`（设置条第二行）；老数据里的环境值不再参与判定 |
| 设置控件 | 开关必须用 `primitives.Switch`（缺失时才回退 `.dbh-fbswitch`） |
| 连接串 🔒 | 不加（唯一锁是只读 chip） |

- SSH 只影响路由，**不做徽章**，只进环境 chip 的 tooltip（`ro.sshTitle`）。
- 数据库口令没能移入凭据库的行（凭据服务缺失或形态无法安全拆分）：`/state` 行只多一个布尔 `passwordUnsplit`，环境 chip 的 tooltip 追加 `ws.dsnUnsplitHint`（「仍以明文保存在本地连接文件」）。**镜像与补丁里不得出现口令或 ref**——这个布尔值就是全部可见信息。
- 编辑表单里的只读勾选保留（两面都有）；`.dbh-checkbox` **不用 `.dbh-input`、不包进 `.dbh-field`**，否则 `render-check` 的 `dbh-field === 3` 与 `typeWithin('dbh-addpanel',0..2)` 索引会变。**「最大返回行数」刻意用 `.dbh-caprow` 而不是 `.dbh-advrow`**：后者在门禁里被当作"隧道字段"计数（未开隧道时必须为 0），且它必须排在 DSN 之后、SSH 字段之后以保住 `typeWithin('dbh-advbody',0..3)` 的索引。
- **行数上限的就地校验**：`parseRowCap` 返回 `null`（负数 / 小数 / 非数字文本）时保存按钮**零请求**并渲染 `.dbh-error .dbh-invalid`（`cap.badRows`，错误按表单归属，添加面板与行编辑器各看自己那条）；这是**发请求前**的校验，不是把值塞给宿主再等拒绝。空值 = `0` = 不限，是显式写入（与 `readOnly:false` 同款），不是"省略"。
- SSH 高级区 `.dbh-adv` 折叠面板**必须排在 DSN 输入之后**，折叠态放 `uiMemory.advOpen`；区内「测试该配置」旁是**「测试 SSH 隧道」**（独立按钮/回执，只验 SSH 层）。折叠按钮**不再因 dbhub 能力过旧而禁用**（面板里还有行数上限，它不依赖 dbhub 方言）；SSH 复选框与相关字段在能力不足时禁用并显示 `capHint`。
- 秘密输入 `type="password"`、占位符写明「留空 = 保持原值」，**编辑态绝不回显已存密码/口令/密钥路径**（镜像行只给 `authKind` / `hasPassword` / `hasPassphrase` / `keyReady` 布尔）。
- 写入载荷统一走 `connDraftOf(form)` / `withConnDraft(op, form)`：只读开关、行数上限与隧道随 `add` / `test` / `options` 三种 op 一起发出，**绝不单独再发一条**。表单对象在产生 op 时会带 `_draft` 指回原始草稿，别绕过这两个函数手拼 `readOnly` / `maxRows` / `ssh`。
- **结果导出 NOT in the card**：导出（CSV / JSON）是**纯模型侧**能力——`dbhub_execute_sql` 的工具参数 `export`，宿主落盘后只回摘要与绝对路径（见 [AGENTS.md](../AGENTS.md#结果导出csv-json)）。**界面上没有按钮、没有新 op、没有新 view 字段**；文件在 `$DSH_HOME/storages/dsh-dbhub-live/exports/`，由用户按路径自行读取 / 清理（插件不自动删除）。客户端半若将来要展示导出文件，必须新增只带路径与行数的元数据通道，**不得**把文件内容或 DSN 带进 `/state`。

## 三面布局契约（5.2）

同一个组件的**三个面由 slot + 实测宽度决定**：`settings.section`（弹窗，窄列）、主面板与 `plugins.row.config` 的 `page`（宽屏整页）、`< 700px` 手机小屏（堆叠紧凑、触摸尺寸；`isWide` 阈值为 720）。

- **实测宽度 = 回调 ref 持有的 `ResizeObserver`**（`attachMeasuredWidth`），不是「effect 里读一次 `ref.current`」：后者依赖数组为空，列没在那一刻挂上（切面、重挂载、宿主延迟挂载）就**永不重测**，宽度恒 0、布局静默退回 `window.innerWidth`。回调 ref 负责挂/换/卸（同一节点重复调用是 no-op），挂载 effect 只负责卸载时 disconnect；**没有任何计时器**（残留 interval 会让 `check:ui` 挂住）。没有 `ResizeObserver` 的宿主（旧浏览器、离屏门）才回退 viewport。

- **唯一界面**：0.1.x 已不再支持（最低 DSH 0.2.1，预发布算同一条线），所以不再有版本分叉的旧 DOM；宿主版本过旧只显示一条 `.dbh-tooold` 警告，页面与操作不受影响（见 `[28]`）。
- 现代面硬约定：
  1. 页头 = 标题 + 灰色版本号 + 一行「↑ 可升级到 x」文字链接（点击才展开中性说明面板；**禁止红底/红框/error 色**）+ 图标式 ↻；**链接的 tooltip 描述它真正做的事（`ver.linkHint`「展开升级说明与安装命令」），不得写成 `ver.copySpec`（「点击复制 …」）**——复制按钮在面板内，tooltip 与动作不一致时用户会为了复制而点开面板；
  2. 状态行只显示「运行中/已停用 · N 个连接」；工具数 / 一次性模式 / dbhub 版本进页面底部「ⓘ 说明与技术详情」折叠区（默认收起）；
  3. 设置 = **所有非弹窗、非手机页面（宽屏页 / 插件页 / 窄桌面列）一律一行紧凑设置条**（窄列自动加 `.dbh-barnarrow` 隐藏标题与状态词、收窄间距，**不得退回竖排设置行**；弹窗与手机才用竖排）。宽屏条 `.dbh-settingsbar` 两行：第一行标签 + 状态词 + `primitives.Switch` + 更新间隔输入 + 天，第二行并发数 / 默认行数 / 导出目录；开关 `scale(.85)`；弹窗/手机为紧凑设置行（13px 标题、8px padding、开关 `scale(.8–.9)`）——**字号与控件刻意弱化，连接列表才是主体**。状态词统一为 `启用/停用`、`显示/隐藏`、`开启/关闭`；**没有保存按钮**（见上节「改完即生效」），导出目录那一行收起时永远不换行。
  4. 行内只读 chip 在三种布局都出现（见上表）；
  5. 弹窗面的设置收进状态行「设置」折叠，宽屏面直接展开。
- **设置区新增的字段（`defaultMaxRows` / `batchConcurrency` / `exportDir`）与写通道**：三个字段都走既有 `saveConfig`（同一个设置条/设置行、同一份 `.dbh-writefail`），但**`exportDir` 必须绕开 `configForms.set` 快路径、强制 `POST /options`**：它是唯一在宿主侧做「目录真能写」探针的选项（`badExportDir`），而官方表单只有 `true/undefined` 两种回答、没有错误通道，走表单会让拒绝原因丢失、甚至显示「已保存」。`/options` 对这类**业务性拒绝**回 200 `{ok:false,error:'<本地化原因>'}`（客户端 `request()` 对非 2xx 只显示通用「写入失败」），因此 saveOptions 里应把含 `exportDir` 的 patch 直接交给桥。输入框占位「留空 = 默认位置（数据目录/exports）」，值从 `/state` 的 `exportDir` 回填（空串 = 默认）。

## 交互细节（每条都对应一段回归门）

- **复制必须给出干净字符串**：连接串拆成两个 flex item 后，浏览器复制序列化会在块级子元素间插分隔符（粘进 DSN 就成 `…3306/ app`）。因此 `connLabelView` 的元素自己接管 `onCopy`（`e.clipboardData.setData('text/plain', w.conn)` + `preventDefault()`）——挂在**连接串元素**而非整行，复制环境名不受影响。`w.conn` 是元数据，不涉凭据。
- **测试中显示已耗时**：`startTest` 记 `startedAt`，`testing` 态渲染 `test.elapsed`（`测试中… Xs`）；1s 计时器**只在有行处于 testing 时存在**（effect 依赖 `anyTesting`，cleanup 清掉）。看门狗按是否隧道分档（30s / 60s），必须高于宿主探测预算（25s / 45s）。
- **等待态不给二次提交**：`pendingPretest` 期间保存/添加按钮 `disabled`，避免重复派发同一测试。
- 探测要几秒（spawn dbhub），但**写入结果必须立刻可见**——靠宿主 `publishFast` 即时回推，不要改回「等整轮扫描」。
- **删除必须走确认卡**（`.dbh-warncard` + `del.*`）：它是唯一不可撤销的写，取消即零写入；确认后只发一条 `{op:'remove'}`（无 DSN）。
- **保存/开关的结果必须挂在同一个提示上**：`settingsBar` / `settingsRows` 共用 `savedHint()`——失败时它返回 `null`（失败由全局 `.dbh-writefail` 行承担），绝不能出现「已保存 ✓」与错误行同框。

## 验收

- 布局/交互改动的验收 = `npm run check:ui`（离屏渲染 + 点击交互；分段 `[1]`…`[49]`，涵盖模式判定、默认展开、全部展开/折叠、添加面板、复制、i18n 覆盖率、热重载幂等、覆盖门、HTTP 桥、只读/SSH 载荷、三面布局、过旧版本警告、**写失败/错误态/未知态/Hook 序列/间隔校验/删除确认/写读序号/form 受理语义/缺失 value/非 JSON/删除单飞/draft 回滚/tick 抑制/实测列宽**、**`@` 输入源（形状/候选/多选序列化/空态/无服务部署）**、**行数上限（数字输入/非法值零请求/正确的 options 载荷）**、**连接搜索/排序/批量测试（过滤与空态、组顺序、并发 2、逐行状态、停止、汇总、卸载无残留计时器）**）全绿 + `node test/client-format.test.mjs` + `node test/conn-list.test.mjs`。
- 已知易错门：`[13]` 重复 locale 注册、`[16]` 复制字符串、`[17]` 桥接 / `configForms` 优先与回退 / 轮询可回收、`[18]` 启用∧开关 / 禁用一律隐藏 / 设置页始终在、`[19]`/`[20]`/`[21]` 只读与 SSH 载荷、`[22]` 残留 interval、`[24]` 升级链接 tooltip 与「复制」职责分离、`[26]` 弹窗设置折叠、`[27]` 手机布局、`[28]` 过旧版本只警告不拦功能、`[29]` 窄桌面窗口保持横向设置条、`[31]`–`[36]` 失败桩（401 / `{ok:false}` / fetch 拒绝 / 晚到的读响应）、`[37]` 假 react 的 effect 循环上限（否则 Hook 回归 = 挂死而不是红）、`[38]` 写/读两条水位线双向、`[39]` 表单只认 `true`、`[40]` 缺失 value、`[41]` 非 JSON、`[42]` 删除单飞、`[45]` 实测列宽驱动布局（宿主挂 ref + 自带 ResizeObserver 桩）、`[48]` 行数上限（作用域必须落在 `.dbh-editbox`：`uiMemory.addOpen` 跨挂载保留，残留的添加面板也有一个 `.dbh-caprow`）、`[49]` 连接搜索/排序/批量测试（批量把 `setTimeout` 也纳管：只有"卸载后没有残留计时器"才能证明看门狗被清掉；批量断言必须排在**上一段挂载被 dispose 之后**，否则会命中残留的本地状态）。
- **SSH 层测试的空字段在客户端拦下**：`connDraftOf` 在开关打开时恒返回对象，`if (!ssh)` 是死分支；现在 `host`/`user` 任一为空即用 `adv.testSshNeedFields` 就地回话（不派发、不白等一次宿主往返），填好后再点才发 `{op:'test', kind:'ssh'}`。
- **失败路径必须有桩**：`mount()` 的 `fetchImpl` 是脚本化应答（`undefined` = 正常、`'reject'` = 网络断、`'html'` = 200 但响应体不是 JSON、`{status,payload}` = 指定应答、Promise = 由测试决定何时以及按什么顺序回），只有被接受的应答才记进 `setCalls`/`opCalls`（`posts` 记下发过的每一个写，含被拒的）——所以「写没被接受」「只发了一个 op」都是可断言的。假 react 还会**按组件身份校验 Hook 数**（同类型组件 Hook 数变化即抛，正是 React 的行为），否则条件 Hook 结构性不可见；`render()` 的重渲染循环有 100 轮上限，超限抛 `effect loop did not settle`。
