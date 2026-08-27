# dsh-dbhub-live

> 让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) 直接、安全地操作数据库：常驻多源连接 + 按工作区工具 + 临时动态连接 + 懒加载与浏览器状态卡片。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-plugin-blue.svg)](#安装)
[![DBHub](https://img.shields.io/badge/Built_on-DBHub-22a05a)](https://github.com/bytebase/dbhub)

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

```text
# 1) 为当前工作区配置数据库连接（三种方式任选其一）
dbhub_configure

# 2) 在已配置工作区的常驻连接上执行查询
dbhub_execute_sql_myapp  SELECT * FROM users LIMIT 10;

# 3) 临时连任意库做一次性排查
dbhub_query  dsn=mysql://root:pass@192.168.77.6:3306/tx_sd_jinengshu  sql="SHOW TABLES;"
```

## 工具

| 工具 | 说明 |
| --- | --- |
| `dbhub_configure(workspace?, dsn?)` | 为工作区配置/持久化数据库连接。 |
| `dbhub_execute_sql_<工作区>` | 在指定工作区的常驻连接上执行 SQL。 |
| `dbhub_search_objects_<工作区>` | 在指定工作区搜索数据库对象（表/视图/列/索引等）。 |
| `dbhub_query(dsn, sql)` | 临时连接任意库执行 SQL（多语句用 `;` 分隔）。 |
| `dbhub_query_objects(dsn, ...)` | 临时连接任意库搜索数据库对象。 |

> 注：`search_objects` 仅对 SQLite 开放；MySQL / PostgreSQL 等请用 `dbhub_query` 直接查（如 `SHOW TABLES`）。

### 配置方式

1. **显式 DSN** — 传入完整连接串，如 `mysql://user:pass@host:3306/db`。
2. **填写分项** — 按类型 / 主机 / 端口 / 账号 / 密码 / 库名依次填写。
3. **授权扫描** — 授权后扫描项目配置文件（`.env`、`application*.yml`、`docker-compose`、`jdbc.properties` 等），列出候选（密码打码）供你确认。

工作区若已有 `mise env` 或 `.env`（`DSN` / `DB_*`），插件会自动发现，无需手动配置。

## 状态卡片

设置 → 插件 → dsh-dbhub-live（依赖 Web 端设置面板，Host 半侧的 `dsh-dbhub-live` 设置命名空间会实时镜像插件状态）：

- 🟢 运行中 / 🟡 初始化中 / 🔴 异常（异常时展示最近错误，红色）。
- 已注册工具数（随工作区配置 / 服务同步实时变化）。
- 工作模式：懒加载（首次调用时初始化）。
- **启用 / 禁用开关**：关闭后所有 dbhub 工具立即返回「插件已禁用」，不消耗任何进程资源；重新开启后按需自动初始化。开关状态持久化，重启后保留。

## 🔄 dbhub 自动安装与更新

- **首次使用自动安装**：本机没有 `dbhub` 时，插件会在第一次查询时自动安装，之后离线也可用。
- **自动保持更新**：每 7 天在后台静默更新到最新版，失败则沿用现有版本。
- **不碰你的配置**：通过 PATH / mise 自行安装的 `dbhub` 不会被插件改动。

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `DSH_DBHUB_PACKAGE` | 自动安装使用的 npm 包名 | `@bytebase/dbhub` |
| `DSH_DBHUB_UPDATE_DAYS` | 自动更新间隔天数，`0` 关闭 | `7` |

## 数据位置

所有配置与凭据存放在模块目录之外（不受 pnpm 打包影响），删除该目录即可完整清空：

```
~/.dsh/storages/dsh-dbhub-live/
```

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
| 看不到状态卡片 | 确认插件已安装并重启 `dsh web`；Host 半侧未注册状态命名空间时卡片不显示（无设置面板的环境不影响工具使用）。 |
| 扫描不到配置文件 | 默认跳过 `node_modules` / `.git` / `target` / `dist` 等目录，可改用「输入 DSN」或「填写分项」。 |
| 需要自定义 dbhub 版本 | 删除 `~/.dsh/storages/dsh-dbhub-live` 后设置 `DSH_DBHUB_PACKAGE` 指定包/版本。 |
| 不希望自动更新 dbhub | 设置环境变量 `DSH_DBHUB_UPDATE_DAYS=0`。 |

## 开发与测试（不影响主进程）

开发说明见 [AGENTS.md](./AGENTS.md)。推荐的调试路径（详见测试方案 `/插件开发文档/DSH插件测试方案.md`）：

- **日常改代码** → 静态校验（`npm run check`）+ 单元测试（`npm test`），零风险；
- **会话内跑通逻辑** → 动态插件 `cordis_define/run` 快速迭代，不重启 Harness；
- **冷启动验证** → 隔离 `DSH_HOME` 起一个测试实例（如 `dsh web --port 3081`）安装本插件验证启动与客户端 bundle，主实例零影响。

## 许可证

[MIT](./LICENSE)