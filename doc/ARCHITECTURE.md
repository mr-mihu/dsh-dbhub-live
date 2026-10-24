# 架构理由与踩坑记录（按需加载）

> AGENTS.md 只记**结论**；这里记**原因**——每条红线的由来、当时踩到的坑、以及"为什么不能那样改"的判断依据。
> 改红线或质疑红线前读对应章节。操作步骤见 [DEVELOPMENT.md](DEVELOPMENT.md) / [CLIENT.md](CLIENT.md) / [RELEASE.md](RELEASE.md)。

## 零知识边界

- 模型上下文就是泄露面：任何进 context 的字符串都会被摘要、日志和后续轮次复制。所以规则不是"少给"而是"永不给"——工具参数不接受 DSN（模型传 DSN 等于把密码写进对话），输出一律经 `connLabel` / `scrubSecrets`。
- dbhub 的启动横幅**只把密码掩成 `****`，用户名原样打印**；而连接测试的诊断文本正是这段输出。所以清洗必须折叠任意 URL 形态连接串的整个 userinfo（`://user:pass@`、`://user@` → `://****:****@`），只掩密码不够。
- 仓库被视为公开分发面：这些真实值曾随 npm 包与公开仓库分发过一次，公开即视为泄露、无法追回（详见 [DESENSITIZE.md](DESENSITIZE.md)）。

## 一次性进程的理由

- 常驻 dbhub 服务器会带来一整套生命周期问题：端口/stdio 归属、配置变更重启、指纹与 mtime 监听、空闲回收、孤儿进程、多实例互杀——5.0 之前这些都真实出现过。最终选择"每次调用一条进程"：天然并发隔离、一条进程挂只坏它自己、多实例无共享状态、没有常驻资源可泄漏。
- 代价是每次的启动延迟（spawn + initialize），换来的是可预测性。**不要以"优化启动"为名把常驻服务装回来。**

## 一次性TOML的由来

- `--dsn` 与 `--config` 互斥，而 dbhub 只有 TOML 方言能表达环境级只读（`[[tools]] readonly`）与 SSH 隧道（`ssh_*`）。所以只有"需要这两个特性"的环境走临时 TOML，其余**逐字节保持** `--dsn`（历史行为，密码在 argv）。
- 三个踩过的坑：
  1. 秘密不能落文件 → 文件只写 `${DSH_DBHUB_SEC_*}` 占位符，真值走子进程 env。**dbhub 取不到变量时不报错**，会把 `${VAR}` 原样留在 DSN 里（于是连了一个字面量叫 `${VAR}` 的目标，或出现"神秘失败"）——所以"文本引用的变量集合 == env 键集合"是硬断言。
  2. `[[tools]]` 是**白名单不是补丁**：只要出现任意一条，dbhub 就不再自动挂 `execute_sql` + `search_objects`。只写一条 read_only 会让该环境的 `search_objects` 直接消失（`Tool search_objects not found`）。
  3. source 级 `read_only` 写法会被**静默忽略**，比报错危险得多 → 绝不生成未实测的旧写法。1.4.0 是实测版本，`< 1.0.0` 明确拒绝。
- Windows 上 dbhub 会 watch 这个临时文件，删除可能 EBUSY → `finally` 尽力删 + boot 时 `sweepTempToml()` 清残留。

## 环境选项与执行预算

- 选项**没有版本号也没有迁移函数**是刻意的：`normalizeStore` 保留未知字段，给 env 条目加可选字段不需要迁移；旧文件读回来就是"无只读、无隧道"。别为了"规范"加迁移。
- `setWorkspaceEnv` 的 opts **缺省必须保留**既有选项：`dbhub_configure` 只更新 DSN 的场景下，若默认清空就会把用户的安全开关静默关掉——这是"只读/隧道莫名丢失"的根因。
- 安全不对称必须在**工具路径**拦截而不是 store：模型只能收窄不能放宽，但浏览器必须能自由关，否则用户永远关不掉自己开的只读。
- 预算与看门狗的三角关系：客户端看门狗必须**严格大于**宿主探测预算，否则客户端先放弃、界面报"测试超时"，而宿主那条 dbhub 还在跑；宿主再加 +500ms 兜底，处理 spawn 本身永不 settle 的情况。三个数字必须一起改，`test/adhoc-toml.test.mjs` 会断言。

## envSlug事故

- 早期实现把非 ASCII 环境名统一 slug 化成一个值，`线上` 与 `测试` 拿到同一个 source 句柄 → 解析时**静默查错库**（模型以为在测环境，实际打线上）。现在：`default` 裸值、纯 ASCII 保留原 slug（既有 source 不变）、非 ASCII 取 `env-<shortHash>`。这是回归红线，不是风格问题。

## 状态通道与inject根因

> **为什么不能改回 inject（5.0 移植的根因）**：dsh 0.1.7 用 Config 表单取代了 settings 命名空间，0.2.x 又删掉浏览器侧 `settingsScope`。旧客户端 `inject: ['slots', 'settingsScope']` 在 0.2.x 上永远等不到服务 → 整个浏览器半区 pending、**无任何报错**，表现就是「配置页 / 侧边栏 / 插件页卡片静默消失」。所以这一层必须做成运行时探测 + 双实现（`legacyFace` / `httpFace`），而不是声明式依赖。

- 第二个静默失败面：**注入回调是独立作用域**。在回调里引用 `apply()` 的局部变量会 ReferenceError，而错误发生在发布链路上——页面只剩静态值、无任何可见报错。需要的服务必须 `ctx.get(...)` 就地获取。
- 两条通道都发布同一个 view 是刻意的：客户端只写一份渲染逻辑，通道差异收敛在 `legacyFace` / `httpFace` 两个适配器里。

## 诊断为什么取尾部

- dbhub 失败时致命行在输出末尾（前面是启动横幅与重试日志），取开头只能得到 `connecting…`。所以 `diagnosticTail` 取尾部 600 字符、丢 `at …` 栈帧与折行残片、按行边界截断（否则会截出半行 JSON/半个错误）。
- 分层前缀的意义：SSH 层与数据库层的可诊断性不同——只有**独立的 SSH 探测**能证明"隧道起来了"；反向不成立，所以 db 层失败的措辞必须谨慎，不能写成"隧道断了"。

## 即时回推与扫描单飞

- `collectSources` 每次都要重扫全部工作区（无持久化 `default` 的工作区各起一次 `mise env`），一次写入原本要等 1–2s。更糟的是**并发扫描互相覆盖**：探针回执触发的扫描可能在写入前开始、写入后结束，把新行刷掉——表现就是"立刻出现又消失"。
- 结论：写入路径返回本次补丁并 `publishFast` 同步镜像；探针只镜像不扫描；扫描单飞并重放扫描期间到达的补丁；`rename` 补丁必须幂等（否则重放会丢行）。一次点击 = 1 次扫描 + 2 次纯内存镜像。

## 自动发现的代价与unref教训

- `mise env` 探测没有总超时会出事：曾有一个不退出的 `mise env` 让整轮扫描永不返回，而 `dbhub_list_sources` 正走这条同步路径，模型侧看到 `Interrupted`。所以每次探测必须有总超时（`graceMs` 只是 SIGTERM→SIGKILL 宽限，**不是超时**），结果按 TTL 缓存，工作区之间并发。
- **预算计时器绝不 `unref()`**：unref 计时器在"它是唯一待办"时不触发——事件循环排空、进程先退，超时形同虚设。该缺陷**只在 Linux CI 暴露**（整文件 cancelled），本地 Windows 会侥幸通过：本地全绿不能当发布依据。

## 布局取舍

- 行内只放图标、来源不做徽章、库名不截断，三条来自同一约束：每个连接只占一行，宽度是稀缺资源。文字按钮吃掉半行；"来源"徽章几乎每行相同却最抢眼；库名被截断是最高频的抱怨。
- 三面布局的两个阈值（700 / 720）：实测出现过 710px 视口既不算手机（>= 700）也不够宽（< 720）的**空档**，布局判定落空。两阈值之间的窄桌面列必须走紧凑设置条，不能退回竖排。
- 现代面与 legacy 面必须能同时存在：`render-check` 的旧断言写死了 0.1.x 的 DOM，新界面只能挂在 `dshModern` 下；否则一次"统一界面"就会让旧线渲染异常。

## 覆盖门为什么先问

- `setWorkspaceEnv` 是**无条件写入**：新增或改名落到已存在的环境会静默替换原连接，而客户端无法回滚。所以写入前必须比较，命中就弹确认卡；比较前必须过 `normalizeEnvForCompare`（镜像宿主 `normalizeEnvName`），否则「prod 」与「prod」这种同键异写会漏判。取消 → 零 op 且保留表单内容。

## 脱敏的不可逆性

- 详见 [DESENSITIZE.md](DESENSITIZE.md)。一句话：真实值曾随 npm 包与公开仓库分发过一次，公开即无法追回；所以门禁是硬门，示例主机只用回环/RFC 5737，示例密码只用 `CHANGE_ME`，任何人不得把本机绝对路径写进受版本控制的文件。

## 版本门与更新检查

- `dshModern` 门（>= 0.2.1，含预发布）不是"只有新版本测过"，而是"新界面依赖的 slot/DOM 能力在这个版本才稳定"。运行版本解析不到时回退为 desktop=true / web=false——桌面端总是新版、旧 web 线保持 legacy，比猜一个值安全。
- 更新检查**绝不抛错**：它只是页头一行提示，失败必须只体现为 `error` 字段，不得影响插件任何功能。

## 模块地图

```
lib/
  index.mjs      入口：name/inject/apply、Config(volatile)、发布核心 createHostCore(walk/row-mirror/runOp/view)、
                 双通道接线(0.1.x settings 命名空间 / connection.fetch HTTP 桥)、settings 表单策略与选项写回、configOp 命令处理
  meta.mjs       插件版本(读 package.json)、DSH 运行时版本探测、semver 比较、dshModern 门
  update.mjs     最新版本检查：npm registry 为主 → GitHub Releases 兜底；内存节流、force、绝不抛错
  bridge.mjs     /api/dsh-dbhub-live 四条 exact Fetch 路由的请求/响应编解码（纯函数）
  config.mjs     路径与原子持久化(store/runtime/prefs)、DSN 解析、工作区发现、环境选项(readOnly/ssh 归一化、默认密钥)、
                 零知识助手(describeConn/connLabel/scrubSecrets)、configure 决策纯函数(decideConfigureStep/argsChangedEndpoint/emptyUserDenied)
  i18n.mjs       宿主侧文案表与插值
  state.mjs      运行时状态机 enabled/phase/toolCount/lastError/mode + 订阅发布
  options.mjs    部署开关：updateIntervalDays / showSidebarEntry / announceAccessPolicy；层叠 Config > prefs.json > 0.1.x 设置文档 > 环境变量 > 内置默认
  runtime.mjs    dbhub 可执行文件发现、按需自动安装、定期自动更新
  capability.mjs 上游能力探测（文件级，不 spawn）：[[tools]] readonly 与 ssh_* 需 1.4.0+
  toml.mjs       一次性 TOML 生成器 buildDbhubToml/writeTempToml/removeTempToml/sweepTempToml（文本绝不含秘密）
  mcp.mjs        MCP JSON-RPC 客户端、工具注册表、来源发现 collectSources/resolveSource、摘要缓存、测试快路径 resolveTestDsn
  adhoc.mjs      唯一执行引擎：一次性 dbhub 进程（描述符 {dsn,ro,ssh}）、--dsn 或临时 TOML、stderr 清洗、
                 probeConnection、probeSshTunnel、diagnosticTail/DIAG_TAIL_MAX=600/failureLayerOf
  collect.mjs    授权扫描项目配置文件(mise/.env)提取 DSN 候选，含 askUser 桥接
  tools.mjs      4 个工具的定义与注册；configure 探连优先
  policy.mjs     模型侧访问策略：唯一的 system prompt 段（order 8900）
  client.js      Web 半（手写 lazy-CJS bundle，无构建）：settings.section + 侧边栏面板 + plugins.row.config(summary/page)
test/            node:test 单测（纯逻辑 + bridge/客户端契约 + 零知识泄漏门）
scripts/         desensitize.config.mjs(槽位表=单一事实源) / desensitize-check.mjs / docs-check.mjs / render-check.mjs / release-preflight.mjs
release-test/    版本矩阵实测：matrix.json(唯一声明) / run.mjs / support-matrix.mjs / mise.toml
.github/         workflows/quality.yml(CI gate) + release-matrix.yml(定时 support:check)
doc/             REQUIREMENTS.md / ARCHITECTURE.md / DEVELOPMENT.md / CLIENT.md / RELEASE.md / DESENSITIZE.md / SUPPORT-MATRIX.md / images/
                 + 本地文档(PLAN-*、implementation-notes、RELEASE-NOTES-*，均 gitignore 排除)
```
