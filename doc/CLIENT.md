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

## 写失败与错误态（四条硬约定）

浏览器半曾经把**所有写失败都当成功**：`httpFace().post` 的 rejection 分支是 `noop`，于是 `saveConfig().then(setSaved(true))` 对 401、`{ok:false,error}`、网络拒绝一律显示「已保存 ✓」，`configOp`（含带 DSN 的保存）、`setEnabled`、`remove` 全部静默丢掉。四条约定按此收口：

1. **写失败必须可见**：face 的写返回 promise，失败时 **reject**（带 message）；组件捕获后写入 `writeError`，渲染一行 `.dbh-error .dbh-writefail[role=alert]`，并且**不得**把 `saved` 置 true。失败后不锁按钮，再次点击就是重试。
2. **错误态可重试**：`StatusCard` 必须读 `snapshot.status`（不是只读 `value`）。`'error'` 时渲染 `.dbh-loadfail` 错误行 + 「重试」按钮（调 `face.refresh()` 做一次真实读取，不是伪造一个空 view）。失败时保留上一次成功读到的行，不显示成"一个连接都没有"。
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

## 环境选项的落点（只读 / SSH）

同一组选项只有一套规则，落点固定：

| 元素 | 呈现 |
| --- | --- |
| 只读标记 | 行内 `.dbh-rochip`，弹窗/宽屏/手机三种布局都出现；点击发 `{op:'options', readOnly}`（无 DSN）；必须 **开锁+「可写」/ 闭锁+「只读」**（同一 16px 线性图标风格），否则两个灰色「只读」会被误读成都是只读 |
| 设置控件 | 开关必须用 `primitives.Switch`（缺失时才回退 `.dbh-fbswitch`） |
| 连接串 🔒 | 不加（唯一锁是只读 chip） |

- SSH 只影响路由，**不做徽章**，只进环境 chip 的 tooltip（`ro.sshTitle`）。
- 编辑表单里的只读勾选保留（两面都有）；`.dbh-checkbox` **不用 `.dbh-input`、不包进 `.dbh-field`**，否则 `render-check` 的 `dbh-field === 3` 与 `typeWithin('dbh-addpanel',0..2)` 索引会变。
- SSH 高级区 `.dbh-adv` 折叠面板**必须排在 DSN 输入之后**，折叠态放 `uiMemory.advOpen`；区内「测试该配置」旁是**「测试 SSH 隧道」**（独立按钮/回执，只验 SSH 层）。
- 秘密输入 `type="password"`、占位符写明「留空 = 保持原值」，**编辑态绝不回显已存密码/口令/密钥路径**（镜像行只给 `authKind` / `hasPassword` / `hasPassphrase` / `keyReady` 布尔）。
- 写入载荷统一走 `connDraftOf(form)` / `withConnDraft(op, form)`：只读开关与隧道随 `add` / `test` / `options` 三种 op 一起发出，**绝不单独再发一条**。表单对象在产生 op 时会带 `_draft` 指回原始草稿，别绕过这两个函数手拼 `readOnly` / `ssh`。

## 三面布局契约（5.2）

同一个组件的**三个面由 slot + 实测宽度决定**：`settings.section`（弹窗，窄列）、主面板与 `plugins.row.config` 的 `page`（宽屏整页）、`< 700px` 手机小屏（堆叠紧凑、触摸尺寸；`isWide` 阈值为 720）。

- **实测宽度 = 回调 ref 持有的 `ResizeObserver`**（`attachMeasuredWidth`），不是「effect 里读一次 `ref.current`」：后者依赖数组为空，列没在那一刻挂上（切面、重挂载、宿主延迟挂载）就**永不重测**，宽度恒 0、布局静默退回 `window.innerWidth`。回调 ref 负责挂/换/卸（同一节点重复调用是 no-op），挂载 effect 只负责卸载时 disconnect；**没有任何计时器**（残留 interval 会让 `check:ui` 挂住）。没有 `ResizeObserver` 的宿主（旧浏览器、离屏门）才回退 viewport。

- **唯一界面**：0.1.x 已不再支持（最低 DSH 0.2.1，预发布算同一条线），所以不再有版本分叉的旧 DOM；宿主版本过旧只显示一条 `.dbh-tooold` 警告，页面与操作不受影响（见 `[28]`）。
- 现代面硬约定：
  1. 页头 = 标题 + 灰色版本号 + 一行「↑ 可升级到 x」文字链接（点击才展开中性说明面板；**禁止红底/红框/error 色**）+ 图标式 ↻；**链接的 tooltip 描述它真正做的事（`ver.linkHint`「展开升级说明与安装命令」），不得写成 `ver.copySpec`（「点击复制 …」）**——复制按钮在面板内，tooltip 与动作不一致时用户会为了复制而点开面板；
  2. 状态行只显示「运行中/已停用 · N 个连接」；工具数 / 一次性模式 / dbhub 版本进页面底部「ⓘ 说明与技术详情」折叠区（默认收起）；
  3. 设置 = **所有非弹窗、非手机页面（宽屏页 / 插件页 / 窄桌面列）一律一行紧凑设置条**（窄列自动加 `.dbh-barnarrow` 隐藏标题与状态词、收窄间距，**不得退回竖排设置行**；弹窗与手机才用竖排）。宽屏条 `.dbh-settingsbar`：标签 + 状态词 + `primitives.Switch` + 更新输入/保存同排，开关 `scale(.85)`；弹窗/手机为紧凑设置行（13px 标题、8px padding、开关 `scale(.8–.9)`）——**字号与控件刻意弱化，连接列表才是主体**。状态词统一为 `启用/停用`、`显示/隐藏`、`开启/关闭`；更新间隔输入 + 天 + 保存必须在同一行不换行；
  4. 行内只读 chip 在三种布局都出现（见上表）；
  5. 弹窗面的设置收进状态行「设置」折叠，宽屏面直接展开。

## 交互细节（每条都对应一段回归门）

- **复制必须给出干净字符串**：连接串拆成两个 flex item 后，浏览器复制序列化会在块级子元素间插分隔符（粘进 DSN 就成 `…3306/ app`）。因此 `connLabelView` 的元素自己接管 `onCopy`（`e.clipboardData.setData('text/plain', w.conn)` + `preventDefault()`）——挂在**连接串元素**而非整行，复制环境名不受影响。`w.conn` 是元数据，不涉凭据。
- **测试中显示已耗时**：`startTest` 记 `startedAt`，`testing` 态渲染 `test.elapsed`（`测试中… Xs`）；1s 计时器**只在有行处于 testing 时存在**（effect 依赖 `anyTesting`，cleanup 清掉）。看门狗按是否隧道分档（30s / 60s），必须高于宿主探测预算（25s / 45s）。
- **等待态不给二次提交**：`pendingPretest` 期间保存/添加按钮 `disabled`，避免重复派发同一测试。
- 探测要几秒（spawn dbhub），但**写入结果必须立刻可见**——靠宿主 `publishFast` 即时回推，不要改回「等整轮扫描」。
- **删除必须走确认卡**（`.dbh-warncard` + `del.*`）：它是唯一不可撤销的写，取消即零写入；确认后只发一条 `{op:'remove'}`（无 DSN）。
- **保存/开关的结果必须挂在同一个提示上**：`settingsBar` / `settingsRows` 共用 `savedHint()`——失败时它返回 `null`（失败由全局 `.dbh-writefail` 行承担），绝不能出现「已保存 ✓」与错误行同框。

## 验收

- 布局/交互改动的验收 = `npm run check:ui`（离屏渲染 + 点击交互；分段 `[1]`…`[46]`，涵盖模式判定、默认展开、全部展开/折叠、添加面板、复制、i18n 覆盖率、热重载幂等、覆盖门、HTTP 桥、只读/SSH 载荷、三面布局、过旧版本警告、**写失败/错误态/未知态/Hook 序列/间隔校验/删除确认/写读序号/form 受理语义/缺失 value/非 JSON/删除单飞/draft 回滚/tick 抑制/实测列宽**）全绿 + `node test/client-format.test.mjs`。
- 已知易错门：`[13]` 重复 locale 注册、`[16]` 复制字符串、`[17]` 桥接 / `configForms` 优先与回退 / 轮询可回收、`[18]` 启用∧开关 / 禁用一律隐藏 / 设置页始终在、`[19]`/`[20]`/`[21]` 只读与 SSH 载荷、`[22]` 残留 interval、`[24]` 升级链接 tooltip 与「复制」职责分离、`[26]` 弹窗设置折叠、`[27]` 手机布局、`[28]` 过旧版本只警告不拦功能、`[29]` 窄桌面窗口保持横向设置条、`[31]`–`[36]` 失败桩（401 / `{ok:false}` / fetch 拒绝 / 晚到的读响应）、`[37]` 假 react 的 effect 循环上限（否则 Hook 回归 = 挂死而不是红）、`[38]` 写/读两条水位线双向、`[39]` 表单只认 `true`、`[40]` 缺失 value、`[41]` 非 JSON、`[42]` 删除单飞、`[45]` 实测列宽驱动布局（宿主挂 ref + 自带 ResizeObserver 桩）。
- **SSH 层测试的空字段在客户端拦下**：`connDraftOf` 在开关打开时恒返回对象，`if (!ssh)` 是死分支；现在 `host`/`user` 任一为空即用 `adv.testSshNeedFields` 就地回话（不派发、不白等一次宿主往返），填好后再点才发 `{op:'test', kind:'ssh'}`。
- **失败路径必须有桩**：`mount()` 的 `fetchImpl` 是脚本化应答（`undefined` = 正常、`'reject'` = 网络断、`'html'` = 200 但响应体不是 JSON、`{status,payload}` = 指定应答、Promise = 由测试决定何时以及按什么顺序回），只有被接受的应答才记进 `setCalls`/`opCalls`（`posts` 记下发过的每一个写，含被拒的）——所以「写没被接受」「只发了一个 op」都是可断言的。假 react 还会**按组件身份校验 Hook 数**（同类型组件 Hook 数变化即抛，正是 React 的行为），否则条件 Hook 结构性不可见；`render()` 的重渲染循环有 100 轮上限，超限抛 `effect loop did not settle`。
