# release-test — 每个声明版本都实测一遍 web 端

这套东西回答两个问题，且只回答这两个：

1. **这次改动还能装、能跑吗？** —— 对每个声明支持的 DSH 版本，真的装一份钉版 CLI、建隔离 `DSH_HOME`、把 `npm pack` 的产物装进 profile、起 `dsh web`、用 HTTP 与日志探针验一遍。
2. **我们到底声明支持哪些版本？** —— `matrix.json` 是唯一声明，`doc/SUPPORT-MATRIX.md` 是生成的证据表，`release:preflight` 保证两者与 manifest 不打架。

它**不**替代单测与 `check:ui`：那些验的是逻辑与渲染，这里验的是"在真实宿主里装得上、起得来、接口通"。

## 快速开始

```powershell
mise -C release-test install  # ① 一次性预装矩阵里的全部 DSH 版本（不激活、不占 PATH；没装 mise 可跳过）
npm run test:release          # ② declared 矩阵（阻塞发版的那批）
npm run test:release:all      # 加上 advisory 观察项
npm run support:matrix        # ③ 重新生成 doc/SUPPORT-MATRIX.md + mise.toml + README 版本段
npm run release:preflight     # ④ 发版闸门（报告新鲜 + AI 判定通过才放行）
```

单个版本调试（**不能**作为发版依据）：

```powershell
node release-test/run.mjs --only 0.2.1-rc.2
node release-test/run.mjs --only 0.1.6-alpha.2,0.2.1-rc.2 --keep
node release-test/run.mjs --tarball ..\dsh-dbhub-live-5.1.0.tgz   # 测一个已发布的产物
```

## CLI 来源：mise（推荐）还是 npm（回退）

同一个探针套件支持两种 CLI 来源，用 `--cli-source` 选，默认 `auto`：

| 来源 | 怎么来 | 测试时怎么跑 | 适用 |
| --- | --- | --- | --- |
| **mise**（推荐） | `mise -C release-test install` 一次性预装（`release-test/mise.toml` 由矩阵生成） | `mise x npm:@deepseek-ai/dsh@<版本> -- dsh …`，**按版本临时调用，不激活** | 日常开发、CI |
| **npm**（回退） | 每个版本 `npm install --ignore-scripts` 到 `.release-test/cache/tools/` | `node <cache>/…/lib/bin.js …` | 没有 mise 的机器 |

- `auto`：mise 有该版本就用 mise，没有才回退 npm，并在报告 `notes` 里写明回退原因。
- `--cli-source mise`：强制 mise；版本没预装会**直接报错并给出预装命令**，不会偷偷装。
- `--cli-source npm`：强制 npm（0.1.5 在沙箱里需要 host patch 时用这条）。

查看 mise 里已装了什么：`mise ls npm:@deepseek-ai/dsh`。

## 一次运行做了什么

对 `matrix.json` 里每个 target（串行，互不干扰）：

| 步骤 | 细节 | 产物 |
| --- | --- | --- |
| 1. 钉版 CLI | `npm install @deepseek-ai/dsh@<版本> --ignore-scripts` 到 `.release-test/cache/tools/dsh-<版本>/`，带 marker 缓存 | `install.log` |
| 2. 隔离 home | 新建 `.release-test/homes/dsh-<版本>/`，设 `DSH_HOME`、清掉 `DSH_PROFILE*`，用 `--profile web --dump-config` 生成 web profile | `profile.log` |
| 3. 装插件 | 默认 `auto`：先试真实 `dsh plugin add <tarball>`，失败（沙箱 pnpm 锁/离线）才回退到手工解包到 profile `node_modules` 并补 `dsh.profile.bundles`；`--provision cli` 则强制真实安装路径 | `provision.log` |
| 4. 起 web | `dsh web --port <空闲端口> --no-open`，从日志抓 ready 行的 token | `boot.log` |
| 5. 探针 | token→cookie；带/不带 cookie 的 `/api/dsh-dbhub-live/state`；模块清单里的 client bundle；写 options；非法 op；日志里的 4 工具/桥接/表单/命名空间通道 | `probe-summary.json` |
| 6. 收尾 | 杀掉整个进程树（Windows `taskkill /T`，POSIX 进程组），释放端口 | — |

每个 target 的产物在 `.release-test/reports/<runId>/evidence/<版本>/`，报告在同一 run 目录：

- `report.md` —— 人看的表 + 每个 target 的检查清单
- `report.json` —— 机器读（preflight、support-matrix 都吃它）
- `judge-prompt.md` —— **给 AI 复核的请求**（事实、open questions、输出 schema、校验命令）
- `history.jsonl` —— 每次运行一行，用于看趋势

## 判定：机器负责证据，AI 负责判断

机器判定只有三档：

- `pass` —— 硬检查全过
- `warn` —— 有软告警（手工装配、日志里意外的 error 行、启动偏慢、dbhub 缺失）
- `fail` —— 硬检查失败（起不来、4 工具不对、state 不健康、401 失效、bundle 取不到、options 写不进）

`fail` 直接阻断发版。`warn`/`skip` 进 **open questions**，由 AI 复核后决定是否放行 —— 因为"沙箱里只能手工装配"是环境限制，"日志里出现 Error"可能是真缺陷，机器分不清，人不该被机器替着下结论。

AI 复核流程（三步，全部可审计）：

```powershell
# 1) 按 judge-prompt.md 读证据（report.json + evidence/<版本>/*.log）
# 2) 生成骨架，逐版本写 verdict/reason、逐条回答 open question
node release-test/run.mjs verdict --template --run .release-test/reports/<runId>
# 3) 校验：报告哈希要对得上、每个版本都要有结论、fail 不能判成 pass、open question 不能漏答
node release-test/run.mjs verdict --check --run .release-test/reports/<runId>
```

`verdict.json` 与报告放在同一目录；`release:preflight` 只认这份判定。

## 发版闸门（为什么不会忘记）

`node scripts/release-preflight.mjs` 会拒绝发版，除非**同时**满足：

1. 有一份报告，且 `plugin.version` == 当前 `package.json` 版本；
2. 报告的 **git tree** == 当前 HEAD 的 tree（内容一致；ff/squash 合并不改变内容也算有效）；
3. 报告不超过 24 小时（`--max-age-hours` 可调）；
4. `matrix.json` 的哈希与报告里的一致（矩阵改了旧报告作废）；
5. 声明偏差为空（`dsh.compatibility.dshReleases` 都在矩阵里、每个声明版本都能被 `peerDependencies` 匹配；两个 `@deepseek-ai/dsh-*` 的 peer 范围**由矩阵生成**——`support:matrix` 会写回 `package.json`，因为 node-semver 要求预发布比较器与版本同 patch 元组，只能「每元组一段」）；
6. declared 目标全部通过，没有 fail/error；
7. AI 判定存在、哈希对得上、overall ≠ fail；
8. 当前工作区干净。

它被三处调用，形成三层防忘：`prepublishOnly`（npm 发布前）、`AGENTS.md` 的两阶段发布命令（打 tag 前）、以及你自己随时手动跑。

## 目录

```
release-test/
  matrix.json          # 唯一声明：版本 / tier / era / ui / 依据 / 期望通道
  run.mjs              # CLI：run / matrix / report / verdict / clean / selftest
  support-matrix.mjs   # 生成并校验 doc/SUPPORT-MATRIX.md
  lib/
    util.mjs           # 路径、哈希、脱敏、时间
    proc.mjs           # 子进程（fd 落盘，不用管道）、进程树终止
    semver.mjs         # 最小 semver + 预发布规则（含自检向量）
    matrix.mjs         # 矩阵加载/校验/声明偏差/期望通道
    cli-install.mjs    # 钉版 CLI 安装与缓存、npm 调用定位
    artifact.mjs       # npm pack / 指定 tarball
    home.mjs           # 隔离 DSH_HOME、web profile、三种装配方式
    server.mjs         # 起 dsh web、抓 ready/token、清理
    host-patch.mjs     # 沙箱专属：给缓存 CLI 打 junction/optional-deps 补丁（矩阵按 target 声明）
    probe.mjs          # 全部探针 → checks
    report.mjs         # 聚合、Markdown、judge-prompt
    verdict.mjs        # AI 判定模板与校验
    runs.mjs / git.mjs # 历史运行、git 事实
```

## 耗时与成本

- 首次跑全矩阵：每个版本约 2 分钟装 CLI（npm 缓存后 20–60 秒）+ 5–15 秒启动与探针，6 个 declared 目标约 8–15 分钟。
- 再跑：CLI 已缓存，主要成本是启动与探针，约 2–4 分钟。
- 不需要模型 API：判定由你所在会话的 agent 完成，harness 本身零网络依赖（除了 npm 装 CLI）。

## 常见问题

**`dsh plugin add` 失败，回退到 manual** —— 沙箱里 pnpm 要写全局锁目录（`%LOCALAPPDATA%\pnpm-store-operation-locks`）会被拒。报告会标 `warn` 并注明"真实安装路径未走"，AI 判定时决定是否接受。想强制真实路径：`--provision cli`（在普通终端/CI 上可以）。

**启动报 `plugin tree failed to load` / `Cannot find the native Koffi module`（0.1.5 上常见，沙箱专属）** —— 这个 Windows 沙箱里 Node 看不到目录 junction，dsh 旧版的 module-fallback 会因此把可选的平台包（koffi/sharp）漏掉并 fail-loud。`matrix.json` 里对应 target 声明了 `sandboxPatch`，harness 会自动给**缓存里的 CLI 副本**打两处补丁（见 `lib/host-patch.mjs`，报告里会写明"environment workaround, not a plugin change"）。普通机器 / CI（Linux）不需要这个补丁。另一种办法：`--with-scripts` 重装 CLI（仅当安装脚本能跑时）。

**同一个 home 第二次启动报 `exists and is not a symlink or dsh-managed module proxy`** —— 0.1.5/0.1.6 对 profile 里已存在的普通目录很挑。默认每次运行都会重建 home，不受影响；用 `--keep` 保留的 home 想复用，先删掉 `<home>\profiles\node_modules`。

**0.1.5 / 0.1.6 上看到 `配置表单写入失败（仅本地 prefs 生效）`** —— 预期行为：那两个版本没有可写回的 settings 表单，options 只落本地 `prefs.json`。probe 已把它列为已知良性行，不会计入 `log.unexpected-errors`。

**启动报 `sets "DSH_..."` 错误** —— dsh 会加载 `<cwd>/.env`，而本仓库的 `.env` 里有 `DSH_DBHUB_DESENSITIZE_RE`（dsh 不允许 DSH_* 来自 .env）。所以 harness 一律在 `.release-test/homes/dsh-<版本>/workspace` 下起进程，不在仓库根。

**没有 `dbhub 能力探测` 行** —— dbhub 未安装或不在 PATH；探针会给 `warn` 而不是 fail（CI 上常见）。

**端口冲突** —— 每个 target 用系统分配的空闲端口（listen 0 再关掉），不会撞你正在用的 `dsh web`。

**想清缓存** —— `node release-test/run.mjs clean`（清 homes + 旧报告）；`clean --tools`（删掉 `.release-test/cache/tools/` 下所有 npm 一次性安装，**每版本约 470 MB**，确认 mise 已装齐后再删）；`clean --all`（tools + homes + 矩阵外缓存）。

**mise 说某个版本没装** —— `mise -C release-test install`（读 `release-test/mise.toml` 一次装齐）；只想装一个：`mise install npm:@deepseek-ai/dsh@<版本>`。装完用 `mise ls npm:@deepseek-ai/dsh` 核对。

**别人拉下这个仓库要怎么跑** —— 两种都行：装了 mise 的机器 `mise -C release-test install` 后直接 `npm run test:release`（走 mise，不落仓库缓存）；没装 mise 的机器同样 `npm run test:release`，会自动回退成 npm 一次性安装（首次每版本 1–2 分钟，缓存在 `.release-test/`，已 gitignore）。两边探针与判定完全一致。

## 加一个版本 / 改声明

1. 改 `matrix.json` 的 `targets`：`version`、`tier`（declared/advisory）、`era`（legacy/config-form/modern）、`ui`（必须与 `lib/meta.mjs` 的 dshModern 门一致：>=0.2.1 为 modern）、`why`（依据：README / package.json / dist-tag）、`expect`（bridge/settingsNamespace/configForm 的 required/optional/absent）。
2. `node release-test/run.mjs selftest` —— 结构校验 + semver 规则自检。
3. `node release-test/run.mjs --only <新版本>` 先单跑，确认期望通道没写错。
4. `npm run test:release` 全量 + AI 判定。
5. `npm run support:matrix` 重生成文档并提交。

**注意**：`package.json` 的 `dsh.compatibility.dshReleases` 与 `matrix.json` 必须一致；`run.mjs matrix` 会把不一致列出来，`release:preflight` 会拦住发版。
