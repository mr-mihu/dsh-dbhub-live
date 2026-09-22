# dsh-dbhub-live

**简体中文** · [English](README.en.md)

> 让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) 直接、安全地操作数据库：**凭据零知识**（密码永不经模型）+ **一次性进程执行**（无常驻服务、天然并发与多实例安全）+ 按工作区×环境的连接管理 + 浏览器配置页。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-plugin-blue.svg)](#安装)
[![DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)
[![npm version](https://img.shields.io/npm/v/dsh-dbhub-live)](https://www.npmjs.com/package/dsh-dbhub-live)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/zh/plugins/mr-mihu/dsh-dbhub-live)

`dsh-dbhub-live` 是一个 DSH 插件，基于 [DBHub](https://dbhub.ai)（数据库 MCP 服务器）让模型直接查询数据库：模型只说「查哪个工作区的哪个环境」，插件在宿主侧解析真实连接并执行——**密码/连接串永远不会出现在模型能看到的地方**。每次调用都是独立的一次性 dbhub 进程，跑完即杀。

## ✨ 特性

- **凭据零知识** — 模型只见 `source` 句柄与元数据（类型 / 主机 / 端口 / 库名）；密码、用户名、完整 DSN 只在宿主侧存在；配置/修改密码时**在界面输入**，不经过模型。
- **一次性进程执行** — 没有常驻 dbhub 服务：每次调用 spawn 一条独立进程执行完即回收。单条查询挂掉只影响它自己；多任务并行、多个 DSH 实例同时跑互不干扰（无共享端口、无互杀）。
- **工具声明恒定 4 个** — `dbhub_configure` / `dbhub_list_sources` / `dbhub_execute_sql` / `dbhub_search_objects`，环境再多也不膨胀模型上下文。
- **按工作区 × 环境管理连接** — 一个工作区可配多个环境（default / prod / dev / test…），通过 `source` 值区分，互不混淆。
- **鉴权失败闭环** — 凭据或连接信息不对时，工具给出明确指引；模型引导你在界面更新密码（不会向模型索要密码），或你直接在设置卡片修改。**配置时自动试连**：说的是非敏感连接信息会先在宿主侧实测——可连通就直接生效（免密码库零输入），只差密码时弹窗只问「账号（未知时）+ 密码」，不再让你重选输入方式；若试连明确报“空账号被拒”，账号为必填（不再提供「留空（使用空账号）」选项），避免把同一个必失败的配置再存回去。
- **启用 / 禁用开关** — 关闭后所有 dbhub 工具立即返回「插件已禁用」友好提示，无需重启。
- **浏览器配置页** — 三个入口同一个页面：**设置 → DBHub 数据库工具**（一级设置页，推荐）、**左侧栏「DBHub 数据库工具」快捷入口**（可在设置页用开关关闭）、插件页 dsh-dbhub-live 那行的「配置」。实时展示：状态徽章、工作模式（一次性连接）、已注册工具数、环境数、最近错误，并提供启用/禁用开关、连接增删改查、**环境改名**与连接测试。
- **开箱即用** — 未安装 `dbhub` 时首次执行自动安装，之后按设置间隔自动更新。

## 支持的数据源

MySQL · PostgreSQL · MariaDB · SQLite · SQL Server

## 环境要求

- DeepSeek Harness 的 `dsh` CLI（`dsh web` 负责 GUI 运行）
- 推荐本机有 Node.js ≥ 18（含 `npm`）——首次执行会自动安装 `dbhub`

## 安装

```bash
# 方式一：使用本机已安装的 dsh
dsh plugin --profile web add dsh-dbhub-live

# 方式二：通过 npx 调用 dsh（无需本机全局安装 dsh）
npx @deepseek-ai/dsh plugin --profile web add dsh-dbhub-live

# 更新到指定版本（推荐写明当前发布的版本号，避免 pnpm 判「Already up to date」跳过）
dsh plugin --profile web update dsh-dbhub-live@4.1.0
```

安装后**重启 `dsh web`** 生效（重启后到 **设置 → DBHub 数据库工具** 可看到配置页）。

## 快速开始

以下工具由 DSH 的 AI 自动调用，你不用手动执行——直接用自然语言提出需求即可（如「查一下 users 表」）：

```text
# 1) 若当前工作区还没有连接，AI 先引导配置（密码在界面输入，AI 看不到）
dbhub_configure

# 2) 在已配置工作区的连接上执行查询（source 见 dbhub_list_sources）
dbhub_execute_sql  source=myapp  sql="SELECT * FROM users LIMIT 10;"

# 3) 查看已注册的连接与 source 值
dbhub_list_sources
```

## 工具

| 工具 | 说明 |
| --- | --- |
| `dbhub_configure(workspace?, env?, renameFrom?, copyFrom?, type?, host?, port?, database?, user?)` | 为工作区配置/持久化数据库连接。**不接受 dsn 参数**——密码/连接串一律在界面输入（不经过模型）；type/host/port/database/user 可作为非敏感预填。**预填够用时插件会先自动试连**：可连通 → 直接保存并返回 source 值；提示要密码 → 弹出最小「账号（未知时）+ 密码」输入框；信息不全或其它失败 → 才弹出完整方式选择。**改名**：`env=新名` + `renameFrom=旧名`（连接与凭据原样保留，可用于 `default` → `prod` 或中英文互改；目标已存在时先请用户确认）。**跨工作区复制**：`copyFrom=其他工作区的 source 值` + `env=本工作区环境名`，插件在宿主侧复制连接，密码不经模型。 |
| `dbhub_list_sources()` | 列出全部连接源，**按工作区分组**并标出【当前工作区】：仅元数据（类型/主机/端口/库）+ 来源徽章 + 对应 **source 值**。 |
| `dbhub_execute_sql(source, sql)` | 在指定数据源上执行 SQL；`source` 见 `dbhub_list_sources`。**每个 source 只属于一个工作区**，优先用当前工作区的；要复用其他工作区的连接，先用 `dbhub_configure` 的 `copyFrom` 复制到当前工作区，不要直接拿别的工作区的 source 查询。每次调用为独立一次性连接，多语句用 `;` 分隔。 |
| `dbhub_search_objects(source, object_type, ...)` | 在指定数据源搜索数据库对象（表/视图/列/索引等）。 |

> **安全**：模型无法通过本插件拿到任何密码——结果与列表只标注 `mysql://host:3306/db` 这类元数据；dbhub 的报错文本在返回前也会被清洗。查询失败时按提示到界面更新密码即可。

> 注：`search_objects` 仅对 SQLite 开放；MySQL / PostgreSQL 等请用 `dbhub_execute_sql` 直接查（如 `SHOW TABLES`）。

### 配置方式

0. **自动试连（默认优先）** — 你在对话里说出连接信息（如「mysql 198.51.100.1:3307/mydb」）后，插件先用这些非敏感信息实测：能连上就直接保存（数据库不需要密码时全程零输入）；提示需要密码 → 弹窗只问「账号（未知时）+ 密码」，其余信息自动沿用，并附失败原因与该连接信息不对时的「改用其他方式」入口；若试连明确报“空账号被拒”（如 `Access denied for user ''`），账号为必填（不提供「留空」选项）；信息不完整或其它原因失败，才进入下面三种方式。若你说的是另一个库/主机/端口（与已存连接不同），插件会按新信息重新试连判断。
1. **显式 DSN** — 在界面输入完整连接串，如 `mysql://user:pass@host:3306/db`。
2. **填写分项** — 在界面按类型 / 主机 / 端口 / 账号 / 密码 / 库名依次填写；已从对话中得知的字段会自动带入，只补缺项即可。
3. **授权扫描** — 授权后扫描项目配置文件（`.env`、`application*.yml`、`docker-compose`、`jdbc.properties` 等），列出候选（只显示主机/端口/库，密码不显示，由插件直接读取）供你确认。

工作区若已有 `mise env` 或 `.env`（`DSN` / `DB_*`），插件会自动发现，无需手动配置。

## 配置页

三个入口，同一个页面、同一份状态：

1. **设置 → DBHub 数据库工具**（推荐）：插件在设置面板注册的一级页面，任何部署都有。
2. **左侧栏「DBHub 数据库工具」**：快捷入口，默认开启；不想占用左侧栏时，在设置页把「在侧边栏显示入口」关掉即可（即时生效，无需重启/刷新）。
3. **插件 → dsh-dbhub-live → 配置**：dsh 0.1.6 起官方「插件」页给每个插件行提供的配置控件（该页由官方插件管理器提供，缺失时用前两个入口）。

> 关闭侧边栏入口**不会**让你失去配置页：设置页与插件页那行的「配置」始终可用。

配置页全部文案（名称、状态、配置项、按钮、连接行）跟随 dsh 界面语言（中 / 英，设置 → 通用 → 语言）切换；模型的报错/反馈与宿主日志同样跟随。

**状态**：状态徽章（🟢 运行中 / ⚪ 已禁用）、**启用/禁用开关**、工作模式（一次性连接）、工具声明（`4 个（固定）`）、环境数（`N 个 · 已保存 M`）、最近错误（异常时红色展示）。

**配置**（编辑后点「保存配置」即时生效并持久化）：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| 自动更新间隔(天) | 自动更新 dbhub 的间隔天数，`0` 关闭 | `7` |
| 在侧边栏显示入口 | 是否在左侧栏显示「DBHub 数据库工具」快捷入口；改动即时生效 | 开 |

优先级：**用户设置 > 进程环境变量（默认值种子）> 内置默认**。自动安装包不在 UI 中（`DSH_DBHUB_PACKAGE` 环境变量单独控制，默认 `@bytebase/dbhub`）。

**工作区连接**：

- 列出每个工作区 × 环境的连接：工作区名、环境名、**source 值**（模型调用 `dbhub_execute_sql` 时填这个，等宽字体显示）、**连接元数据**（🔒 `mysql://host:3306/db`——不含账号密码，密码永不出现在页面上）、来源徽章（`已保存` / `自动`）与来源明细（`已保存·用户` / `已保存·扫描` / `已保存·复制` / `自动·mise env` / `自动·.env`）。
  - `已保存`：你配置过（`dbhub_configure` 或配置页添加）。
  - `自动`：未保存，来自 `mise env` / `.env` 自动发现——不持久化，随源文件变化；自动发现不对时可直接「修改」为手动配置覆盖。
- 每行可「测试」（连接探活，见下）、「修改」（改连接串 **或改环境名**；改名连接与凭据原样保留，只填名字不填连接串即为纯改名）或「删除」（仅已保存项）。
- **连接测试**：点「测试」后 Host 用该环境的真实 DSN 走一次性临时连接（独立 dbhub 进程执行 `SELECT 1`）实测可达性，成功 / 失败即时在行内提示。结果是一次性反馈：不持久化、约 10 秒后自动消失；失败不会标记、限制或改动这条连接，不影响其他环境与查询（慢库 / 不通库最长等待约 30 秒）。
- **同一工作区可添加多个环境**：表单填「工作区（路径或标题，留空=默认当前工作区）+ 环境名 + 连接串」点「添加连接」。环境名**支持中文**（如 `线上` / `测试`）：显示用原名，source 值中的环境段用 `env-<短哈希>` 保证**不同中文名不会撞车**（纯 ASCII 名如 `test` / `dev` 的 source 值保持不变）。

## dbhub 环境变量

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `DSH_DBHUB_PACKAGE` | 自动安装使用的 npm 包名（仅环境变量，不在 UI 暴露） | `@bytebase/dbhub` |
| `DSH_DBHUB_UPDATE_DAYS` | 自动更新间隔天数种子，`0` 关闭（被设置卡片保存过的值覆盖） | `7` |

## 🔄 dbhub 自动安装与更新

- **首次使用自动安装**：本机没有 `dbhub` 时，插件会在第一次执行时自动安装，之后离线也可用。
- **自动保持更新**：后台静默更新到最新版（间隔见「配置页 → 可配置参数」），失败则沿用现有版本。
- **不碰你的配置**：通过 PATH / mise 自行安装的 `dbhub` 不会被插件改动。

> 更新间隔默认值也可用环境变量播种，见「配置页 → 配置」；一旦在设置卡片保存过，即以设置值为准。

## 数据位置

所有配置与凭据存放在模块目录之外（不受 pnpm 打包影响），删除该目录即可完整清空：

```
~/.dsh/storages/dsh-dbhub-live/
```

按 `DSH_HOME` 实例隔离，同一实例的多个 profile 共享（与 dsh 自身 `workspace.json` 同一约定）。工作区连接按「工作区 × 环境」存储（`environments.default` 为默认环境）；v1 旧格式单连接条目启动时自动迁移。插件对升级/手改遗留的旧格式配置自动清洗并一次性迁移；运行目录被误删或写入被系统拦截时不会崩溃——自动重建目录、写入失败仅告警并继续内存态运行。**没有常驻 dbhub 进程与共享配置文件**：同机多实例、同 DSH_HOME 并发运行也不会互相干扰。

## 卸载

```bash
dsh plugin --profile web remove dsh-dbhub-live
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 首次使用报「无法获取 dbhub」 | 确认本机有 npm 且能联网；离线可手动安装 `dbhub` 并加入 PATH。 |
| 某个环境的查询报连接被拒 / 认证失败 | 该环境为独立一次性连接：不可达只让该次调用报错，其他环境与调用不受影响。错误末尾会附指引——凭据或连接信息有误时，可让 AI 调用 `dbhub_configure` 引导你在界面更新，或直接在 插件 → dsh-dbhub-live → 配置 中修改。 |
| 工具显示「插件已禁用」 | 打开 插件 → dsh-dbhub-live → 配置，点击「启用」。 |
| 看不到配置页 | 确认插件已安装并重启 `dsh web`；配置页只在 Web 设置面板（`dsh web`）显示，在无设置面板的终端环境下不影响工具使用。 |
| 扫描不到配置文件 | 默认跳过 `node_modules` / `.git` / `target` / `dist` 等目录，可改用「输入 DSN」或「填写分项」。 |
| 需要自定义 dbhub 版本 | 设置环境变量 `DSH_DBHUB_PACKAGE`（如 `@bytebase/dbhub@1.2.1`）后重启；或删除 `~/.dsh/storages/dsh-dbhub-live` 重新自动安装。 |
| 不希望自动更新 dbhub | 配置页「自动更新间隔(天)」填 `0` 并保存；或设置环境变量 `DSH_DBHUB_UPDATE_DAYS=0`。 |
| 密码无法在对话中更新（模型问你要密码） | 这是设计如此：模型不应接触密码。让 AI 调用 `dbhub_configure`，在界面弹出的输入框中填密码即可；或自行到 插件 → dsh-dbhub-live → 配置 修改。 |

## 许可证

[MIT](./LICENSE)