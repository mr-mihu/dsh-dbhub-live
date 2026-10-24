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
- 侧边栏由 `syncSidebar()` 挂 `face.subscribe` 按 view 即时 register/dispose；判定 `sidebarWanted()` = `view.enabled !== false && view.showSidebarEntry !== false`。
- 注册不存在的 slot 会被静默忽略（「配置页消失」就是这么来的），别改回已删除的 slot。

## host face：探测与写回（别退回 inject）

`export const inject` **只能有 `["slots"]`**。`legacyFace(scope)` 与 `httpFace()` 实现同一接口（`getSnapshot` / `subscribe` / `setEnabled` / `saveConfig` / `configOp`，快照 `{ status, value }`），`ctx.get('settingsScope')` 有则优先 legacy。

- HTTP face 四个入口：`GET /state`、`POST /enabled`、`POST /options`、`POST /op`；写完用响应里的 view 直接刷新快照（不等轮询）；`configOp` 的 `{op: …}` 直接 POST。
- **选项写入优先走官方 settings 表单**：Host 发布 `entryId`，客户端有 `ctx.configForms` 且 entryId 非空时 `configForms.get(entryId).set(field, value)`，失败/解析不到才回退 `POST /options`（0.1.x 与无 settings 客户端走这条）。
- **HTTP 通道轮询是「按订阅」的**：只有渲染中页面用 `props.subscribe(fn, { live: true })` 起 1.5s 轮询（`document.hidden` 跳过）；插件作用域订阅（`face.subscribe(syncSidebar)`）只做一次性拉取。**空闲 GUI 不得持续轮询**，残留 interval 会让 `check:ui` 挂住不退出。
- 组件不得接触 `ctx`：数据/回调一律通过注册时的 `inject: () => face` 传入 props。

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
- 🔒 前缀：**现代面不加**（会被误读成"需要密码"，且与只读 chip 的锁冲突）；legacy 面保留原标记。
- 「来源」（手填 / 扫描 / 复制 / 自动发现）**不得做成行内徽章**——它几乎每行都一样却最抢眼；改为环境名 chip 的 tooltip（`originTitle`），只有"自动发现且未持久化"这一例外在 tooltip 里显式点名。
- 改名走 `configOp({op:'rename'})`；改名 + 改连接走**一条** `{op:'add', renameFrom}`（`configOp` 在 legacy 通道是单字段，连续两次写会互相覆盖）。

### 顶部与添加

- **legacy 面（0.1.x）顶部只留一行**：状态徽章 + 工具数 + 设置条摘要 + `[⚙ 设置]` + `[启用/禁用]`；自动更新间隔与「在侧边栏显示入口」复选框一起收进默认收起的设置条。
- **现代面（≥0.2.1）按「三面布局」**：标题 + 版本 + 升级链接；状态行只留状态与连接数；设置用 DSH 行样式；长说明进折叠区。
- **添加连接默认收起**：「＋ 添加连接」（全局；工作区用 `<datalist id="dbh-ws-list">` 给已有工作区）/ 分组头「＋ 环境」（工作区自动带入，少一个字段）。保存仍走原有「试连 → 失败才确认」门禁。

## 环境选项的落点（只读 / SSH）

同一组选项在**两个面**上呈现不同，按 `view.dshModern` 分叉——**这是 legacy 与现代面的分工，不是新旧两套规则**：

| 元素 | 现代面（`dshModern === true`） | legacy 面（`dshModern === false`） |
| --- | --- | --- |
| 只读标记 | 行内 `.dbh-rochip`，弹窗/宽屏/手机三种布局都出现；点击发 `{op:'options', readOnly}`（无 DSN）；必须 **开锁+「可写」/ 闭锁+「只读」**（同一 16px 线性图标风格），否则两个灰色「只读」会被误读成都是只读 | 环境 chip 内 `span.dbh-ro`，说明并入 chip `title` |
| 设置控件 | 开关必须用 `primitives.Switch`（缺失时才回退 `.dbh-fbswitch`） | `.dbh-checkbox` 复选框 |
| 连接串 🔒 | 不加 | 保留 |

- SSH 只影响路由，**不做徽章**，只进环境 chip 的 tooltip（`ro.sshTitle`）。
- 编辑表单里的只读勾选保留（两面都有）；`.dbh-checkbox` **不用 `.dbh-input`、不包进 `.dbh-field`**，否则 `render-check` 的 `dbh-field === 3` 与 `typeWithin('dbh-addpanel',0..2)` 索引会变。
- SSH 高级区 `.dbh-adv` 折叠面板**必须排在 DSN 输入之后**，折叠态放 `uiMemory.advOpen`；区内「测试该配置」旁是**「测试 SSH 隧道」**（独立按钮/回执，只验 SSH 层）。
- 秘密输入 `type="password"`、占位符写明「留空 = 保持原值」，**编辑态绝不回显已存密码/口令/密钥路径**（镜像行只给 `authKind` / `hasPassword` / `hasPassphrase` / `keyReady` 布尔）。
- 写入载荷统一走 `connDraftOf(form)` / `withConnDraft(op, form)`：只读开关与隧道随 `add` / `test` / `options` 三种 op 一起发出，**绝不单独再发一条**。表单对象在产生 op 时会带 `_draft` 指回原始草稿，别绕过这两个函数手拼 `readOnly` / `ssh`。

## 三面布局契约（5.2，`dshModern` 门）

同一个组件的**三个面由 slot + 实测宽度决定**：`settings.section`（弹窗，窄列）、主面板与 `plugins.row.config` 的 `page`（宽屏整页）、`< 700px` 手机小屏（堆叠紧凑、触摸尺寸；`isWide` 阈值为 720）。

- **新界面必须挂在 `view.dshModern` 下**；`dshModern === false`（DSH 0.1.x）必须渲染**与旧版逐字兼容的 DOM**（含旧页头 `4 个工具（固定）`、⚙ 设置条、`dbh-checkbox`），否则 `scripts/render-check.mjs` 既有断言会红。旧断言不动，新断言由 harness 另行扩展。
- 现代面硬约定：
  1. 页头 = 标题 + 灰色版本号 + 一行「↑ 可升级到 x」文字链接（点击才展开中性说明面板；**禁止红底/红框/error 色**）+ 图标式 ↻；
  2. 状态行只显示「运行中/已停用 · N 个连接」；工具数 / 一次性模式 / dbhub 版本进页面底部「ⓘ 说明与技术详情」折叠区（默认收起）；
  3. 设置 = **所有非弹窗、非手机页面（宽屏页 / 插件页 / 窄桌面列）一律一行紧凑设置条**（窄列自动加 `.dbh-barnarrow` 隐藏标题与状态词、收窄间距，**不得退回竖排设置行**；弹窗与手机才用竖排）。宽屏条 `.dbh-settingsbar`：标签 + 状态词 + `primitives.Switch` + 更新输入/保存同排，开关 `scale(.85)`；弹窗/手机为紧凑设置行（13px 标题、8px padding、开关 `scale(.8–.9)`）——**字号与控件刻意弱化，连接列表才是主体**。状态词统一为 `启用/停用`、`显示/隐藏`、`开启/关闭`；更新间隔输入 + 天 + 保存必须在同一行不换行；
  4. 行内只读 chip 在三种布局都出现（见上表）；
  5. 弹窗面的设置收进状态行「设置」折叠，宽屏面直接展开。

## 交互细节（每条都对应一段回归门）

- **复制必须给出干净字符串**：连接串拆成两个 flex item 后，浏览器复制序列化会在块级子元素间插分隔符（粘进 DSN 就成 `…3306/ app`）。因此 `connLabelView` 的元素自己接管 `onCopy`（`e.clipboardData.setData('text/plain', w.conn)` + `preventDefault()`）——挂在**连接串元素**而非整行，复制环境名不受影响。`w.conn` 是元数据，不涉凭据。
- **测试中显示已耗时**：`startTest` 记 `startedAt`，`testing` 态渲染 `test.elapsed`（`测试中… Xs`）；1s 计时器**只在有行处于 testing 时存在**（effect 依赖 `anyTesting`，cleanup 清掉）。看门狗按是否隧道分档（30s / 60s），必须高于宿主探测预算（25s / 45s）。
- **等待态不给二次提交**：`pendingPretest` 期间保存/添加按钮 `disabled`，避免重复派发同一测试。
- 探测要几秒（spawn dbhub），但**写入结果必须立刻可见**——靠宿主 `publishFast` 即时回推，不要改回「等整轮扫描」。

## 验收

- 布局/交互改动的验收 = `npm run check:ui`（离屏渲染 + 点击交互；分段 `[1]`…`[30]`，涵盖模式判定、默认展开、全部展开/折叠、添加面板、复制、i18n 覆盖率、热重载幂等、覆盖门、HTTP 桥、只读/SSH 载荷、现代三面、版本门）全绿 + `node test/client-format.test.mjs`。
- 已知易错门：`[14]` 重复 locale 注册、`[17]` 复制字符串、`[18]` 无 settingsScope 走桥接 + `configForms` 优先与回退 + 轮询可回收、`[19]` 启用∧开关 / 禁用一律隐藏 / 设置页始终在、`[20]`/`[21]`/`[23]` 只读与 SSH 载荷、`[22]` 残留 interval、`[28]` 手机布局、`[29]` 0.1.x 渲染旧页、`[30]` 窄桌面窗口保持横向设置条。
