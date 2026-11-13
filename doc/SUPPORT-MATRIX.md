# 支持的 DSH 版本（发布测试矩阵）

> **本文件由脚本生成，请勿手工编辑。**
> 数据源：`release-test/matrix.json`（声明）+ `release-test/evidence-summary.json`（最近验证证据摘要，随包提交）。
> `.release-test/reports/` 只被 `--write` 读取一次并蒸馏成上面这份摘要，渲染不依赖本机目录，所以干净检出也能复现。
> 重新生成：`node release-test/support-matrix.mjs --write`　校验结构：`--check`　校验证据是否过期（仅本机有报告时）：`--check-evidence`

- 插件版本：`6.0.0-rc.4`
- 矩阵指纹：`34be607694e6`（证据摘要按当前矩阵盖章；增减 target 后必须重跑 `--write`）
- 最近一次完整测试：`20261113-173337-34be60`（2026-11-13T09:35:44.234Z，green）
- 最近一次 AI 判定：pass — dsh-agent (lead) @ 2026-11-13T09:36:01.623Z
- 声明范围：0.2.1-rc.2 起至 0.2.2-rc.2（0.2.1 / 0.2.2，含预发布）

## 声明支持（blocking：任一失败即禁止发版）

| DSH 版本 | 集成代际 | 界面 | 声明依据 | 最近验证 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `0.2.1-rc.2` | modern | modern | 0.2.1 线的基线：插件的最低支持版本 + 已实测通过 | 2026-11-13 · 6002a08d | ✅ 通过 |
| `0.2.1-rc.5` | modern | modern | 0.2.1 线的最后一个 rc（旧版本线只覆盖 rc，不覆盖 alpha） | 2026-11-13 · 6002a08d | ✅ 通过 |
| `0.2.2-rc.1` | modern | modern | npm dist-tag latest（用户默认装到的版本） | 2026-11-13 · 6002a08d | ✅ 通过 |
| `0.2.2-rc.2` | modern | modern | npm dist-tag next：最新预发布版本，必须覆盖（新版本发布前最先被用户装到） | 2026-11-13 · 6002a08d | ✅ 通过 |

## 观察项（advisory：只报告，不阻塞）

| DSH 版本 | 集成代际 | 界面 | 声明依据 | 最近验证 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `0.2.1-rc.3` | modern | modern | 0.2.1 线的抽样观察项（不阻塞发版） | 未验证 | — |
| `0.2.2-alpha.3` | modern | modern | 最新预发布线的 alpha 抽样（观察项） | 未验证 | — |

## 这些版本是怎么验证的

每个版本都跑一遍**真实 web 端**，不复用开发机的 profile：

1. **CLI 来源**（两种，同一套探针）：
   - **mise（推荐）**：`mise -C release-test install` 一次性预装全部声明版本（不激活、不占 PATH），测试时按版本临时调用 `mise x npm:@deepseek-ai/dsh@<版本> -- dsh …`；预装清单由本文件同源的脚本生成到 `release-test/mise.toml`。
   - **npm（回退）**：没有 mise 的机器自动回退为每版本一次性 `npm install --ignore-scripts` 到 `.release-test/cache/tools/`。
2. 在 `.release-test/homes/dsh-<版本>/` 建**隔离的 DSH_HOME**，跑 `--profile web --dump-config` 生成 web profile；
3. 把 `npm pack` 出来的**真实发布产物**装进该 profile（`--provision cli` 时走真实 `dsh plugin add`）；
4. 起 `dsh web`，抓 ready 行的 token，换 cookie 后探针：`/api/dsh-dbhub-live/state`（带/不带 cookie）、模块清单里的 client bundle、写 options、非法 op；
5. 断言启动日志里的 4 工具与通道、state 里的 `pluginVersion` / `dshVersion` 与矩阵一致，且 view 里**没有**版本门（门槛由 `engines.dsh` 在激活期强制，插件不再自己判）；
6. 证据落在 `.release-test/reports/<run>/evidence/<版本>/`；由 AI 复核后写 `verdict.json`；`npm run release:preflight` 校验「报告新鲜 + 矩阵未变 + 声明无偏差 + AI 判定通过 + 工作区干净」后才允许打 tag。

## 判定规则

- **declared** 的任一目标出现 `fail`：报告为 red，发版被阻断。
- **advisory** 目标失败：只进入「需要复核」清单，不阻塞。
- 手工装配（`provision=manual`）会标「（手工装配）」并进入复核清单：产物内容验证了，但真实安装路径没走。
- AI 判定必须逐版本给结论、逐条回答 open question，且报告哈希要对得上；判定不能把 fail 说成 pass（脚本会拒绝）。

## 如何增删一个版本

1. 改 `release-test/matrix.json` 的 `targets`（`tier` / `era` / `ui` / `why` / `expect`），`ui` 必须与最低支持版本门一致（>=0.2.1 为 modern，含预发布；低于 0.2.1 的 target 不允许出现在矩阵里）；
2. `node release-test/run.mjs selftest` 校验矩阵结构与 semver 规则；
3. `node release-test/support-matrix.mjs --write` 同步本文件、`release-test/mise.toml` 与两个 README 的版本段；
4. `mise -C release-test install`（或直接跑测试让它回退 npm）→ `node release-test/run.mjs` 全矩阵 → AI 判定；
5. `package.json` **不声明 DSH 版本范围**（只有 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 两个库 peer）：范围无法同时表达「最低 0.2.1」与「未来的任意预发布」，写了反而会在新 DSH 发布当天把用户挡在门外。兼容性由**运行时特性探测**（桥接）+ 卡片里的过旧升级提示保证；`dsh.compatibility.dshReleases` 手工维护，须与矩阵 declared 一致，改完跑 `node release-test/run.mjs matrix` 确认「声明偏差」清零。

## 已知声明偏差

无：矩阵与 `dsh.compatibility.dshReleases` 一致，且没有低于最低支持版本的 target。
