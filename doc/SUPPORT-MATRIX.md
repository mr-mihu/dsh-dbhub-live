# 支持的 DSH 版本（发布测试矩阵）

> **本文件由脚本生成，请勿手工编辑。**
> 数据源：`release-test/matrix.json`（声明）+ `.release-test/reports/`（最近验证证据）。
> 重新生成：`node release-test/support-matrix.mjs --write`　校验是否同步：`node release-test/support-matrix.mjs --check`

- 插件版本：`5.2.0-dev.2`
- 矩阵指纹：`40a3fcef6607`（矩阵变了，旧报告就不再被采信）
- 最近一次完整测试：`20261023-201318-40a3fc`（2026-10-23T12:14:05.691Z，yellow）
- 最近一次 AI 判定：pass-with-notes — lead-agent (release-test review) @ 2026-10-23T12:20:37.8753955Z
- 声明范围：0.1.5-rc.3 起至 0.2.1-rc.2（0.1.5 / 0.1.6 / 0.1.7 / 0.2.0 / 0.2.1，含预发布）

## 声明支持（blocking：任一失败即禁止发版）

| DSH 版本 | 集成代际 | 界面 | 声明依据 | 最近验证 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `0.1.5-rc.3` | legacy | legacy | README: 0.1.5 起的全部版本线（含 0.2.x） | 2026-10-23 · 89b29173 · 手工装配 | ⚠️ 通过（有告警） |
| `0.1.6-alpha.2` | legacy | legacy | package.json dsh.compatibility.dshReleases | 2026-10-23 · 89b29173 · 手工装配 | ⚠️ 通过（有告警） |
| `0.1.7-rc.2` | config-form | legacy | 0.1.7 线：settings 命名空间被 Config 表单取代（本插件双栈的转折点） | 2026-10-23 · 89b29173 · 手工装配 | ⚠️ 通过（有告警） |
| `0.2.0-rc.2` | modern | legacy | package.json dsh.compatibility.dshReleases | 2026-10-23 · 89b29173 · 手工装配 | ⚠️ 通过（有告警） |
| `0.2.1-alpha.1` | modern | modern | package.json dsh.compatibility.dshReleases；也是 dshModern 门槛（>=0.2.1 含预发布） | 2026-10-23 · 89b29173 · 手工装配 | ⚠️ 通过（有告警） |
| `0.2.1-rc.2` | modern | modern | npm dist-tag latest（矩阵的当前默认目标） | 2026-10-23 · 89b29173 · 手工装配 | ⚠️ 通过（有告警） |

## 观察项（advisory：只报告，不阻塞）

| DSH 版本 | 集成代际 | 界面 | 声明依据 | 最近验证 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `0.1.7-alpha.2` | config-form | legacy | 0.1.7 早期预发布（观察项，不阻塞发版） | 2026-10-23 · 1f1e2046 · 手工装配 | ⚠️ 通过（有告警） |
| `0.2.1-alpha.5` | modern | modern | npm dist-tag alpha（观察项，不阻塞发版） | 2026-10-23 · 1f1e2046 · 手工装配 | ⚠️ 通过（有告警） |
| `0.2.1-rc.3` | modern | modern | npm dist-tag next（比 latest 更新的下一版；通过一次完整运行后可提升为 declared） | 2026-10-23 · 1f1e2046 · 手工装配 | ⚠️ 通过（有告警） |

## 这些版本是怎么验证的

每个版本都跑一遍**真实 web 端**，不复用开发机的 profile：

1. **CLI 来源**（两种，同一套探针）：
   - **mise（推荐）**：`mise -C release-test install` 一次性预装全部声明版本（不激活、不占 PATH），测试时按版本临时调用 `mise x npm:@deepseek-ai/dsh@<版本> -- dsh …`；预装清单由本文件同源的脚本生成到 `release-test/mise.toml`。
   - **npm（回退）**：没有 mise 的机器自动回退为每版本一次性 `npm install --ignore-scripts` 到 `.release-test/cache/tools/`。
2. 在 `.release-test/homes/dsh-<版本>/` 建**隔离的 DSH_HOME**，跑 `--profile web --dump-config` 生成 web profile；
3. 把 `npm pack` 出来的**真实发布产物**装进该 profile（`--provision cli` 时走真实 `dsh plugin add`）；
4. 起 `dsh web`，抓 ready 行的 token，换 cookie 后探针：`/api/dsh-dbhub-live/state`（带/不带 cookie）、模块清单里的 client bundle、写 options、非法 op；
5. 断言启动日志里的 4 工具与通道、state 里的 `pluginVersion` / `dshVersion` / `dshModern` 与矩阵一致；
6. 证据落在 `.release-test/reports/<run>/evidence/<版本>/`；由 AI 复核后写 `verdict.json`；`npm run release:preflight` 校验「报告新鲜 + 矩阵未变 + 声明无偏差 + AI 判定通过 + 工作区干净」后才允许打 tag。

## 判定规则

- **declared** 的任一目标出现 `fail`：报告为 red，发版被阻断。
- **advisory** 目标失败：只进入「需要复核」清单，不阻塞。
- 手工装配（`provision=manual`）会标「（手工装配）」并进入复核清单：产物内容验证了，但真实安装路径没走。
- AI 判定必须逐版本给结论、逐条回答 open question，且报告哈希要对得上；判定不能把 fail 说成 pass（脚本会拒绝）。

## 如何增删一个版本

1. 改 `release-test/matrix.json` 的 `targets`（`tier` / `era` / `ui` / `why` / `expect`），`ui` 必须与插件自己的 `dshModern`（>=0.2.1）一致；
2. `node release-test/run.mjs selftest` 校验矩阵结构与 semver 规则；
3. `node release-test/support-matrix.mjs --write` 同步本文件、`release-test/mise.toml` 与两个 README 的版本段；
4. `mise -C release-test install`（或直接跑测试让它回退 npm）→ `node release-test/run.mjs` 全矩阵 → AI 判定；
5. `package.json` 的 `peerDependencies`（两个 `@deepseek-ai/dsh-*`）**由矩阵生成**：本脚本按声明版本推导「每个 patch 元组一段」的范围（node-semver 的预发布规则要求同元组比较器），不要手改；`dsh.compatibility.dshReleases` 仍手工维护，须与矩阵 declared 一致，改完跑 `node release-test/run.mjs matrix` 确认「声明偏差」清零。

## 已知声明偏差

无：矩阵里每个声明版本都能被当前 `peerDependencies` 匹配。
