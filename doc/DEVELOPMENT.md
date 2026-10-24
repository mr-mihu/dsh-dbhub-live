# 开发与调试（按需加载）

> AGENTS.md 的配套文档：怎么在不弄坏正在运行的 Harness 的前提下验证改动。
> 本文件只讲**操作**；红线与架构约束见 [AGENTS.md](../AGENTS.md)。

DSH 启动是 fail-loud：任一插件激活失败整树拒绝启动、GUI 打不开。所以**永远不要在配置或源码上直接动你正在使用的主实例**，按下面的阶梯来。

## 1. 静态校验（30 秒，零风险）

```bash
npm run check          # node --check 全部 lib
```

单测按**文件逐个跑**——沙箱里 `node --test` 的 runner 子进程会被 EPERM 挡住：

```bash
node test/<file>.test.mjs
```

单测自己会建临时 `DSH_HOME`，不会碰真实 store。

### 只读 / 隧道路径的静态旁路验证（不需要 Harness）

```bash
node -e "…"   # 调用 buildDbhubToml({dsn, ro:true, ssh:{…}}) 打印文本
```

确认三件事：**两条 `[[tools]]` 都在**、文本里没有密码、`env` 覆盖了文本里引用的每个 `${VAR}`。`test/toml.test.mjs` 已自动断言，手工复核只用于排查现场。

### 真 dbhub 冒烟（不经插件）

把生成的 TOML 落到临时目录，直接跑：

```
dbhub --transport stdio --config <file>
```

喂 `initialize` / `tools/list` / `tools/call`。命令见本地文档 `doc/PLAN-5.1-readonly-and-ssh-tunnel.md` 附录 A（该文件 gitignore 排除、不进包）。预期：

- 只读环境 `INSERT` / `CREATE` 回 `READONLY_VIOLATION`；
- `SELECT 1` 与 `search_objects` 成功（**只写一条 `[[tools]]` 会让 `search_objects` 消失**）；
- `--config` 与 `--dsn` 同时给必 fatal。

## 2. 会话内跑通逻辑（不重启）

用动态插件工具 `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine`：把纯逻辑（configure 流程、`scrubSecrets` 等）以**无 import** 的 Host 代码贴进动态包跑，`cordis_stop` 即清场；只活在内存 + 当前会话，不影响主进程。

限制：动态 Host 代码不能用 `import`，带 `@deepseek-ai/schemastery` 的 `lib/index.mjs` 不能整文件贴。只做纯逻辑验证。

## 3. 冷启动验证（隔离实例）

用独立 `DSH_HOME` 起测试实例。约定用**仓库外的独立目录**（例如 workspace 根下的 `.dsh-a` / `.dsh-b`）作为隔离 home；唯一硬要求是**绝不指向真实 home**。

### 路径 A：源码实例（走 tsx）

```bash
cd <dsh 源码 checkout>
mise r dsh web --port 3082 --no-open
```

- `pnpm dsh` 会先跑依赖校验；node_modules 不同步时它想重装并因无 TTY 中止——直接 `node --import tsx/esm apps/cli/src/bin.ts …` 跳过。
- esbuild spawn 在沙箱下 EPERM，属于沙箱边界，别绕。

### 路径 B：已安装实例（推荐，无 esbuild / pnpm）

```powershell
$env:DSH_HOME = "<repo>/.dsh-a"                       # 隔离 home
Remove-Item Env:DSH_PROFILE, Env:DSH_PROFILE_DIR -ErrorAction SilentlyContinue   # 继承主 profile 会污染/参数冲突
node <dsh 安装目录>/lib/bin.js web --port 3082 --no-open
```

`dsh web` 自带 `web` profile，**不要再传 `--profile web`**（会报「select a profile only once」）。

### 装包进隔离实例

```powershell
# pnpm 需要可写 store（默认 store 在 workspace 外会被沙箱拒绝）
$env:npm_config_store_dir = "<repo>/.pnpm-store"
pnpm pack
node <dsh>/lib/bin.js plugin --profile web add <打包目录>/dsh-dbhub-live-<ver>.tgz
```

沙箱内 pnpm 可能因为事先被别处 store 链接过而报 `UNEXPECTED_STORE`；此时可手工替换 `.dsh-a/profiles/web/node_modules/dsh-dbhub-live/` 的目录内容（`file:` 依赖就是普通目录，不写 store、不动 lockfile）。**仅用于验证，不要当成发布流程。**

### 验证清单（0.2.x）

日志应出现：

```
[dsh-dbhub-live] host apply
dbhub 插件已加载（4 个工具）
模型侧访问策略已注册（system prompt 段 …）
浏览器桥接已注册: /api/dsh-dbhub-live/*
```

接口（从启动日志取 `?token=…` → `GET /?token=…` 拿会话 cookie）：

| 请求 | 期望 |
| --- | --- |
| `GET /api/dsh-dbhub-live/state` | 200 + `{ok,value}`；**不带 cookie 必须 401** |
| `POST /api/dsh-dbhub-live/options {"updateIntervalDays":3}` | 200，且 `$DSH_HOME/storages/dsh-dbhub-live/prefs.json` 落盘 |
| `POST /api/dsh-dbhub-live/op {"op":{"op":"nope"}}` | 200 + `patches: []` |

volatile Config 通道（0.1.7+ / 0.2.x）：在 profile 的 `cordis.patch.yml` 里钉 `- id: <行 id>` + `config: {updateIntervalDays: 5}` → 重启后视图与 `prefs.json` 都变 5（采纳），日志出现「配置表单策略已注册: auto=false」；再 `POST /options {"updateIntervalDays":9}` → **profile patch 文件本身**应被改写成 9，视图里的 `entryId` 等于该行 id（不是包名）。

客户端包 URL 必须带 `rev`：

```
/plugins/??dsh-dbhub-live/client.js&rev=<rev>    # 200（单斜杠路径一律 404）
```

**取 bundle URL 的正确方式**：index HTML 里的模块清单 JSON（`{"id":"dsh-dbhub-live","url":"/plugins/??…&rev=<rev>"}`），`rev` 带 `-<n>` 后缀（如 `d4aeeae7c6c2a859-55`，每次渲染会变）。用正则截 `rev` 会截断后缀而 404——必须整段取出该 `url` 再请求。

浏览器：`http://127.0.0.1:3082` 侧边栏出现「DBHub 数据库工具」、设置里出现同名一级页面，行内显示连接元数据。

### 0.1.x 线（双栈的另一半）

另起一个 scratch home 装 0.1.6 的 CLI 即可，`dsh web` 会自己初始化 web 模板：

```powershell
# 用 0.1.6 的 CLI 初始化 DSH_HOME=<repo>/.dsh-b，把包目录拷进 profiles/web/node_modules/
# 并在 package.json 的 dsh.profile.bundles 里加上 dsh-dbhub-live（bundle 的 patch 会自行插入插件行）
```

期望日志：`host apply` + `dbhub 插件已加载（4 个工具）` + `状态命名空间已注册: dsh-dbhub-live` + `浏览器桥接已注册: …`（0.1.6 没有 `settings.configure`，故没有「配置表单策略」那行）。期望接口：`/api/dsh-dbhub-live/state` 带 cookie 200、不带 401；view 里 `entryId` = 行 id；bundle 200。

`mise r dsh plugin … ls` 只用于核对安装版本。

### 桌面端

**不做本地自动验证**——由用户经可视化「插件」页安装/更新/卸载后人工确认（见 README「更新」）。

## 4. 在位热更新（有失败保护，谨慎）

主实例的 `cordis.patch.yml` 支持 HMR，读取/解析失败时保留最后一个可用树，GUI 不会挂。但 **HMR 不监听插件源码**，只适合挂载/卸载验证；代码迭代用上面的 1 / 2 / 3。

## 5. 安全网

`$DSH_SNAPSHOT=replay` 可从 `cordis.snapshot.yml` 启动回放点。改动主 profile 前先备份 `cordis.patch.yml`。
