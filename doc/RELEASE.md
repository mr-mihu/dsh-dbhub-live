# 发布与版本（按需加载）

> AGENTS.md 的配套文档：打 tag、发 dev/正式版、改版本号、跑版本矩阵时读。
> 质量门命令与脱敏红线见 [AGENTS.md](../AGENTS.md)；脱敏细则见 [DESENSITIZE.md](DESENSITIZE.md)。

## 发布测试门（`release-test/`，每个声明版本都实测 web 端）

**支持哪些 DSH 版本不靠记忆**：`release-test/matrix.json` 是唯一声明，`doc/SUPPORT-MATRIX.md` 是由证据生成的表，`npm run release:preflight` 是发版闸门。

```powershell
mise -C release-test install  # 一次性预装矩阵里的全部 DSH 版本（不激活；没 mise 可跳过，测试会自动回退 npm）
npm run test:release          # declared 矩阵：钉版 CLI + 隔离 DSH_HOME + 真实 dsh web + HTTP/日志探针
npm run test:release:all      # 连 advisory 观察项一起跑
node release-test/run.mjs --only 0.2.1-rc.2   # 只跑一个版本（调试用，不能当发版依据）
npm run support:matrix        # 重新生成 doc/SUPPORT-MATRIX.md（矩阵或证据变了就重生成；会先刷新证据摘要）
npm run support:check         # 校验结构：生成物 vs 已提交的 matrix.json + evidence-summary.json（CI 用）
npm run support:evidence      # 校验证据摘要是否落后于本机 .release-test/reports（没有报告就跳过）
npm run release:preflight     # 闸门：报告新鲜 + tree 一致 + 矩阵未变 + 声明无偏差 + AI 判定通过 + 工作区干净
```

- 产物：`.release-test/reports/<run>/` —— `report.md`（人看）、`report.json`（机器）、`judge-prompt.md`（给 AI）、`evidence/<版本>/`（安装/启动日志与探针回执）。**`.release-test/` 不进 git**（`.gitignore` 已排除，脱敏门禁 `SKIP_DIRS` 已跳过）。
- **证据摘要随包，报告目录不随包**：`support:matrix` 把本机报告蒸馏成 `release-test/evidence-summary.json`（提交、无路径无秘密），`doc/SUPPORT-MATRIX.md` / 两个 README 只从它渲染。所以干净 checkout（CI）重算得到同一份文档，`support:check` 不会再因为「本机没有报告」变红。**矩阵或证据变了必须重跑 `npm run support:matrix` 并把摘要一起提交**。
- `support:check` 只比**结构**，且比较前归一化行尾（生成器写 LF，Windows 检出可能是 CRLF）。`support:evidence` 才是「本机报告 vs 摘要」的新鲜度校验，CI 里自动跳过。
- **AI 判定是流程的一步，不是可选项**：按 `judge-prompt.md` 复核证据 → `node release-test/run.mjs verdict --template --run <dir>` 生成骨架 → 逐版本写结论、逐条回答 open question → `npm run release:verdict`（即 `verdict --check`）校验（硬失败不能判成 pass，报告哈希必须对得上）。
- 结果解读：`fail` = 硬失败，禁止发版；`warn`/`skip` = 进 open questions 由 AI 判定（例如沙箱里被迫手工装配）；`claim drift` = 声明与 manifest 矛盾（典型：peerDependencies 范围排除预发布版）——**报告照跑，但闸门会拦住发版**。
- 增删支持版本：只改 `release-test/matrix.json`，再 `npm run support:matrix` 重生成文档；`package.json` 的 `dsh.compatibility.dshReleases` 必须与矩阵一致（`node release-test/run.mjs matrix` 会列出偏差）。
- 隔离纪律：每个版本都在 `.release-test/homes/dsh-<版本>/` 里跑，**永不碰用户真实 profile**（主实例 fail-loud）。CLI 一律钉版。
- **CLI 来源**：默认 `--cli-source auto`——mise 里预装了该版本就用 `mise x npm:@deepseek-ai/dsh@<版本> -- dsh …`（不激活），否则回退 `.release-test/cache/tools/` 的 npm 一次性安装；报告里记录每个 target 实际用了哪种。预装清单 `release-test/mise.toml` 由矩阵生成，勿手改。确认 mise 装齐后可 `node release-test/run.mjs clean --tools` 回收 npm 缓存（每版本约 470 MB）。

## 分支职责

- `dev`：**集成/测试分支**。所有改动先落这里（直接提交，或功能分支 PR 进 dev）；允许 force push；CI（`gate`）在这里跑。
- `main`：**只用于发布**。已开分支保护：必需检查 `gate`、禁止 force push、禁止删除。改动只能从 `dev` 经 PR 合入，main 上不再有其它直接提交。
- 每次发布后 `dev` 与 `main` 收敛：`git checkout dev && git merge --ff-only main`。

## 触发词与硬约束（最重要，别越界）

- 用户说「**可以了，发布**」（或类似）= **发 dev 测试版**。此时**绝不**动 `main`、**绝不**执行默认（`latest`）的 `npm publish`。
- 只有用户明确说「**合并主分支发布正式版**」（或等价明确指令）时才走正式版流程；并且**正式版的 npm 发布命令只输出给用户手动执行**——代理不代发（用户自己登录拿凭据）。仓库里没有 `NPM_TOKEN` secret，CI 也不会替你发。
- **已发布的 tag 与 npm 版本绝不移动 / 删除 / unpublish**；发现缺陷就发下一个补丁版本（发布出去的东西收不回来）。
- 测试版**必须** `--tag dev`（若发 npm）+ GitHub `--prerelease`；只有正式版才能用 `--latest` 与默认 dist-tag，否则 `latest` 会被指到测试版，普通用户直接中招。
- 只有 CI（`gate`）绿的提交才能进 `main`；`pnpm pack` 的产物名必须与 `package.json` 版本一致。

## 阶段一：测试版（在 dev 上）

```powershell
git checkout dev && git pull
# 改代码；package.json 版本 = <目标正式版>-dev.<N>（N 不复用，如 5.3.0-dev.1）
npm run check; npm run check:secrets; npm run check:ui     # 再按文件逐个跑单测
$env:npm_config_store_dir = "<repo>/.pnpm-store"; pnpm pack  # dsh-dbhub-live-<ver>.tgz
git add -A; git commit -m "..."; git push origin dev        # CI 在 dev 上跑 gate
# ⚠ 发版闸门（必跑）：在干净提交上跑矩阵 + AI 判定，preflight 不过不许打 tag
npm run test:release; npm run release:preflight
git tag -a v<ver> -m "..."; git push origin v<ver>
gh release create v<ver> --prerelease --title "v<ver>" --notes-file <notes> dsh-dbhub-live-<ver>.tgz
# 可选（只在需要验证 npm 安装路径时）：npm publish --registry=https://registry.npmjs.org/ --tag dev
# 安装验证（不碰 npm 也行）：dsh plugin --profile web add <tarball>（或 dsh-dbhub-live@dev）
```

预发布不会抢 Release 页的 "Latest" 徽章，普通用户 `dsh plugin add dsh-dbhub-live` 仍拿正式版。

## 阶段二：正式版（仅在用户明确要求时）

```powershell
# 1) 在 dev 上把版本号转正（去掉 -dev.N），提交 "vX.Y.Z (release): ..."，push dev
# 2) 开 PR 合入 main，等 CI 绿后合并
gh pr create --base main --head dev --title "vX.Y.Z (release): ..." --body "..."
gh pr merge --merge
# 3) main 的合并提交也要过闸门（tree 相同则复用 dev 的报告，否则重跑），然后打 tag
npm run release:preflight
git checkout main && git pull; git tag -a vX.Y.Z -m "..."; git push origin vX.Y.Z
# 4) GitHub 正式发布（--latest，附 tarball）
gh release create vX.Y.Z --latest --title "vX.Y.Z" --notes-file <notes> dsh-dbhub-live-X.Y.Z.tgz
# 5) npm：把命令交给用户手动执行（代理不代发）
#    npm publish --registry=https://registry.npmjs.org/    # 不带 --tag → latest 指向它
```

**给代理的默认行为**：本仓库里代理只往 `dev` 提交/推送；`main` 只通过 PR 合入。需要动 `main` 或发 npm 时先停下来向用户确认。

## 预览版先发、后跑矩阵（`-rc` 专用）

测试版（`6.0.0-rc.1` 这类）**允许在矩阵跑之前发布**，发到 `dev` tag，绝不覆盖 `latest`：

1. 本地四门禁 + `test:unit` + 在**最新预发布 harness**（当前 `0.2.2-rc.x`）上跑一次真实浏览器回归；
2. `npm publish --tag dev` —— `prepublishOnly` 会跑 `release:preflight`，证据类问题在预览版上只作警告；
3. **发完立刻**用 npm 包安装到各声明版本上跑 `npm run test:release`，产出证据；
4. 证据齐了再考虑 `x.y.z` 正式版（此时 `release:preflight` 对证据是硬阻断）。

未跑矩阵就发正式版仍会被拦住，这条不能绕过。
## 版本号策略（测试版本 → 发布版本）

- **基线 = 代码库当前版本**（`package.json` 版本，即最近一次发布）。测试/调试迭代一律在基线上挂 `-dev.<序号>`，序号从 1 递增、不复用，`pnpm pack` 产物随之换名。
- 为什么要升版本：pnpm 对 `dsh plugin add <同名同版本 tarball>` 会判「Already up to date」跳过、**不换包**，只有换版本号才能保证调试包真正部署。
- `dsh plugin add` 后务必用 `dsh plugin ls` 或核对 `node_modules/<pkg>/package.json` 的版本号确认已替换。
- **测试完成要发版时，在基线上按「跨度和力度」决定升级幅度**（不以 dev 序号原号发布）：
  - 小 bug 修复 / 小功能改动 → 升**补丁号**（`5.2.0` → `5.2.1`）；
  - 大功能新增 / 影响面较广 → 升**次版本号**（`5.2.0` → `5.3.0`）；
  - 破坏性升级 / 阶段性架构变更 → 升**主版本号**（`5.2.0` → `6.0.0`）。
  - 跨档并存时按最高档计；归属拿不准时**先向用户确认再发版**，禁止未确认跨度直接升主版本。
- **发布版本成为新基线**，下一轮测试从 `<新基线>-dev.1` 重新起序。

## 包内容

`package.json` 的 `files` **只放运行时**：`lib`（含浏览器半 `client.js`）、`cordis.patch.yml`、`LICENSE`、两份 README（npm 页要渲染）、`package.json` 本身——实测 22 个文件 / 约 186 kB。文档、测试、门禁脚本、`release-test`、`AGENTS.md` 与截图**都不进包**（它们是仓库的开发资料，不是用户运行需要的东西）；`test:release` / `support:*` / `release:preflight` 这些命令因此在 tarball 里不可用，只能在工作树里跑。

README 里指向文档的链接一律用 GitHub 绝对地址（`blob/dev/doc/...`），截图用 `raw.githubusercontent.com/...`，这样 npm 页面上也能点开、看到图——相对链接在 tarball 里会断。`doc/SUPPORT-MATRIX.md` 是生成物（输入只有 `release-test/matrix.json` 与提交的 `evidence-summary.json`），只在仓库里阅读。

`prepublishOnly` = `npm run check && npm run check:ui && npm run test:unit && npm run check:docs && npm run check:secrets && npm run release:preflight`——发布前自动跑全套（语法 / 客户端离屏门禁 / 全部单测 / 文档 / 脱敏 / 发版闸门），不只是原来那三样。
