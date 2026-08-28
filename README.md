# dsh-dbhub-live

> 让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) 直接、安全地操作数据库：常驻多源连接 + 按工作区工具 + 临时动态连接 + 懒加载与浏览器状态卡片。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-plugin-blue.svg)](#安装)
[![DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/mr-mihu/dsh-dbhub-live)

`dsh-dbhub-live` 是一个 DSH 插件，基于 [DBHub](https://dbhub.ai)（数据库 MCP 服务器）让模型直接查询数据库：既能在已配置的工作区上复用常驻连接，也能临时连任意库做一次性排查。

## ✨ 特性

- **常驻多源服务** — 后台一个 dbhub 服务同时接入多个数据源，连接复用、查询更快。
- **按工作区工具** — `dbhub_execute_sql_<工作区>` / `dbhub_search_objects_<工作区>`，工具名即工作区，多工作区不混淆，连接标注（密码打码）清晰可见。
- **临时动态连接** — `dbhub_query` / `dbhub_query_objects` 每次独立连任意库，可并行查多个不同库，便于跨环境排查。
- **懒加载启动** — 插件启动不阻塞 GUI，工具立即可用；环境初始化推迟到首次调用（初始化期间查询自动等待就绪）。
- **启用 / 禁用开关** — 关闭后所有 dbhub 工具立即返回「插件已禁用」友好提示，无需重启；再次开启立即可用。
- **浏览器状态卡片** — 设置 → 插件 → dsh-dbhub-live 面板实时展示：运行状态徽章（🟢 运行中 / 🟡 初始化中 / 🔴 异常）、已注册工具数、工作模式、最近错误（红色），并提供启用/禁用开关。
- **开箱即用** — 未安装 `dbhub` 时首次使用自动安装，之后自动保持更新，无需手动处理。
- **多种配置方式** — 显式 DSN / 填写分项 / 授权扫描项目配置文件，凭据仅存本机用户目录，密码全程脱敏。

## 支持的数据源

MySQL · PostgreSQL · MariaDB · SQLite · SQL Server

## 环境要求

- DeepSeek Harness 的 `dsh` CLI（`dsh web` 负责 GUI 运行）
- 推荐本机有 Node.js ≥ 18（含 `npm`）——首次使用会自动安装 `dbhub`

## 安装

```bash
# 方式一：使用本机已安装的 dsh
dsh plugin --profile web add dsh-dbhub-live

# 方式二：通过 npx 调用 dsh（无需本机全局安装 dsh）
npx @deepseek-ai/dsh plugin --profile web add dsh-dbhub-live
```

安装后**重启 `dsh web`** 生效（重启后到 设置 → 插件 → dsh-dbhub-live 可看到状态卡片）。

## 快速开始

以下工具由 DSH 的 AI 自动调用，你不用手动执行——直接用自然语言提出需求即可（如「查一下 users 表」），AI 会按需完成配置与查询：

```text
# 1) 若当前工作区还没有连接，AI 先为其配置数据库连接（三种方式见下方「配置方式」）
dbhub_configure

# 2) 在已配置工作区的常驻连接上执行查询
dbhub_execute_sql_myapp  SELECT * FROM users LIMIT 10;

# 3) 临时连任意库做一次性排查
dbhub_query  dsn=mysql://user:pass@127.0.0.1:3306/mydb  sql="SHOW TABLES;"
```

## 工具

| 工具 | 说明 |
| --- | --- |
| `dbhub_configure(workspace?, env?, dsn?)` | 为工作区配置/持久化数据库连接（可指定环境名，默认 `default`）。 |
| `dbhub_list_sources()` | 列出当前已注册的全部连接源（工作区 × 环境、打码连接串、来源与对应工具名），便于确认测试/生产等环境是否存在；**打码连接串仅供识别，不可用于直连**。 |
| `dbhub_execute_sql_<工作区>[_<环境>]` | 在指定工作区、指定环境的常驻连接上执行 SQL。 |
| `dbhub_search_objects_<工作区>[_<环境>]` | 在指定工作区/环境搜索数据库对象（表/视图/列/索引等）。 |
| `dbhub_query(dsn, sql)` | 临时连接任意库执行 SQL（多语句用 `;` 分隔）；**检测到 `****` 脱敏密码会直接拒绝**并引导使用常驻工具。 |
| `dbhub_query_objects(dsn, ...)` | 临时连接任意库搜索数据库对象；同样拒绝脱敏密码。 |

> 注：`search_objects` 仅对 SQLite 开放；MySQL / PostgreSQL 等请用 `dbhub_query` 直接查（如 `SHOW TABLES`）。

### 配置方式

1. **显式 DSN** — 传入完整连接串，如 `mysql://user:pass@host:3306/db`。
2. **填写分项** — 按类型 / 主机 / 端口 / 账号 / 密码 / 库名依次填写。
3. **授权扫描** — 授权后扫描项目配置文件（`.env`、`application*.yml`、`docker-compose`、`jdbc.properties` 等），列出候选（密码打码）供你确认。

工作区若已有 `mise env` 或 `.env`（`DSN` / `DB_*`），插件会自动发现，无需手动配置。

## 状态卡片

设置 → 插件 → dsh-dbhub-live：插件会把运行状态与配置实时同步到 Web 设置面板（仅 `dsh web` 端可见）。卡片为**折叠分区**：状态 / 配置 / 工作区连接。

**状态区**（默认展开）：

- 🟢 运行中 / 🟡 初始化中 / 🔴 异常（异常时展示最近错误，红色）。
- 已注册工具数（随工作区配置 / 服务同步实时变化）、工作模式（懒加载）。
- 常驻进程：运行中 / 待启动（按需）——空闲回收后显示「待启动」。
- **启用 / 禁用开关**：关闭后所有 dbhub 工具立即返回「插件已禁用」，不消耗进程资源；重新开启后按需自动初始化。开关状态持久化。

**配置区**（编辑后点「保存配置」即时生效并持久化）：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| 自动更新间隔(天) | 自动更新 dbhub 的间隔天数，`0` 关闭 | `7` |
| 空闲回收(分钟) | 常驻 dbhub 进程空闲回收时长 | `10` |

优先级：**用户设置 > 进程环境变量（默认值种子）> 内置默认**。自动安装包不在 UI 中（`DSH_DBHUB_PACKAGE` 环境变量单独控制，默认 `@bytebase/dbhub`）。

**工作区连接区**：

- 列出每个工作区 × 环境的连接：工作区名、环境名、**打码**连接串、来源徽章（`已保存` / `自动`）。
  - `已保存`：你配置过（`dbhub_configure` 或卡片添加）。
  - `自动`：未保存，来自 `mise env` / `.env` 自动发现——不持久化，随源文件变化；自动发现不对时可直接「修改」为手动配置覆盖。
- 每行可「修改」（覆盖连接串，自动项会转成已保存项）或「删除」（仅已保存项）。
- **同一工作区可添加多个环境**：表单填「工作区（路径或标题，留空=默认当前工作区）+ 环境名 + 连接串」点「添加连接」。环境 `default` 的工具名为 `dbhub_execute_sql_<工作区>`，其余环境为 `dbhub_execute_sql_<工作区>_<环境>`。

## dbhub 环境变量

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `DSH_DBHUB_PACKAGE` | 自动安装使用的 npm 包名（仅环境变量，不在 UI 暴露） | `@bytebase/dbhub` |
| `DSH_DBHUB_UPDATE_DAYS` | 自动更新间隔天数种子，`0` 关闭（被设置卡片保存过的值覆盖） | `7` |

## 🔄 dbhub 自动安装与更新

- **首次使用自动安装**：本机没有 `dbhub` 时，插件会在第一次查询时自动安装，之后离线也可用。
- **自动保持更新**：后台静默更新到最新版（间隔见「状态卡片 → 可配置参数」），失败则沿用现有版本。
- **不碰你的配置**：通过 PATH / mise 自行安装的 `dbhub` 不会被插件改动。

> 更新间隔默认值也可用环境变量播种，见「状态卡片 → 配置」；一旦在设置卡片保存过，即以设置值为准。

## 数据位置

所有配置与凭据存放在模块目录之外（不受 pnpm 打包影响），删除该目录即可完整清空：

```
~/.dsh/storages/dsh-dbhub-live/
```

按 `DSH_HOME` 实例隔离，同一实例的多个 profile 共享（与 dsh 自身 `workspace.json` 同一约定）。工作区连接按「工作区 × 环境」存储（`environments.default` 为默认环境）；v1 旧格式单连接条目启动时自动迁移。插件对升级/手改遗留的旧格式配置自动清洗并一次性迁移；运行目录被误删或写入被系统拦截时不会崩溃——自动重建目录、写入失败仅告警并继续内存态运行，`dbhub.toml` 写入失败则显示为初始化错误并自动重试。

## 卸载

```bash
dsh plugin --profile web remove dsh-dbhub-live
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 首次使用报「无法获取 dbhub」 | 确认本机有 npm 且能联网；离线可手动安装 `dbhub` 并加入 PATH。 |
| 状态卡片显示 🔴 异常 | 查看状态卡片中的「最近错误」与 `dsh web` 日志；进程异常退出时插件会在下次调用自动重启。 |
| 工具显示「插件已禁用」 | 打开 设置 → 插件 → dsh-dbhub-live 卡片，点击「启用」。 |
| 看不到状态卡片 | 确认插件已安装并重启 `dsh web`；状态卡片只在 Web 设置面板（`dsh web`）显示，在无设置面板的终端环境下不影响工具使用。 |
| 扫描不到配置文件 | 默认跳过 `node_modules` / `.git` / `target` / `dist` 等目录，可改用「输入 DSN」或「填写分项」。 |
| 需要自定义 dbhub 版本 | 设置环境变量 `DSH_DBHUB_PACKAGE`（如 `@bytebase/dbhub@1.2.1`）后重启；或删除 `~/.dsh/storages/dsh-dbhub-live` 重新自动安装。 |
| 不希望自动更新 dbhub | 状态卡片「自动更新间隔(天)」填 `0` 并保存；或设置环境变量 `DSH_DBHUB_UPDATE_DAYS=0`。 |

## 许可证

[MIT](./LICENSE)