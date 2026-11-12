# 变更影响矩阵（按需加载）

> AGENTS.md 里只留一句提醒：**改任何东西前，来这里核查一遍联动项**。原因与判断依据在 [ARCHITECTURE.md](ARCHITECTURE.md)，操作步骤在 [DEVELOPMENT.md](DEVELOPMENT.md) / [CLIENT.md](CLIENT.md) / [RELEASE.md](RELEASE.md) / [DESENSITIZE.md](DESENSITIZE.md)。

## 怎么用

1. 按「改动」列找到你正在动的那一类，再看「同次必须更新」——**同一提交里补齐**，不要留到下次；
2. 跑「自动门禁」列的命令；没有门禁的项靠人工复核；
3. 出现了新的联动关系（第 11 类）→ **本表同次加行**。这是一张受管文档，不是备忘。

## 矩阵

| 改动 | 同次必须更新 | 自动门禁 |
| --- | --- | --- |
| lib 红线语义（零知识 / TOML / source 只读 / 状态通道 / 连接管理） | AGENTS.md 对应条 + `doc/ARCHITECTURE.md` 对应节 + 相关 `test/*.test.mjs` + `doc/REQUIREMENTS.md`（涉需求时） | `npm run check` + 单测 |
| 模型可见文案 / 工具描述 / i18n | `test/zero-knowledge.test.mjs` + `scripts/desensitize.config.mjs` 槽位表 + `README.md` 与 `README.en.md`（用户可见时） | `check:secrets` + 零知识单测 |
| 配置页布局 / 交互 / 文案 | `doc/CLIENT.md` + `scripts/render-check.mjs` 断言 + AGENTS.md「客户端半」 | `check:ui` + `test/client-format.test.mjs` |
| 调试方式 / 隔离实例 / 验证清单 | `doc/DEVELOPMENT.md` | 无（人工） |
| 发布流程 / 版本号 / 支持矩阵 | `doc/RELEASE.md` + `release-test/matrix.json` → `npm run support:matrix`（同时刷新 `release-test/evidence-summary.json` 并重生成 `doc/SUPPORT-MATRIX.md` + `release-test/mise.toml` + 两个 README 的版本段）+ `package.json` 的 `dsh.compatibility.dshReleases` | `support:check` + `support:evidence` + `release:preflight` |
| 脱敏规则 / 槽位 / 示例值 / 测试夹具 | `scripts/desensitize.config.mjs` + `doc/DESENSITIZE.md` | `check:secrets` |
| 门禁脚本 / 闸门判定逻辑（`scripts/*.mjs`、`release-test/support-matrix.mjs`、`release-test/lib/report.mjs`） | `test/gates.test.mjs` 里加一条「坏样本必须红」的用例 + AGENTS.md「质量门」+ 本表 | `test:unit` + 对应门禁 |
| npm 脚本 / 包内容（`files`、`exports`、`dsh.client`） | `package.json` + AGENTS.md「质量门」+ `doc/RELEASE.md`「包内容」+ `doc/REQUIREMENTS.md` R70 | `check:docs` |
| 文档新增 / 改名 / 调整章节（含 `doc/` 与 `AGENTS.md`） | AGENTS.md 里的指针 + **本表** + `package.json` 的 `files`（需随包分发时） | `check:docs` |
| 需求条目（R 编号） | `doc/REQUIREMENTS.md` + AGENTS.md（有行为约束时） | 人工 |
| 用户可见行为 / 界面文案 | `README.md`（唯一真源）→ 同次派生 `README.en.md` + `doc/REQUIREMENTS.md` | `check:secrets` |
| 新增/调整联动关系（即本表） | 本表加行 + AGENTS.md 的提醒指向不变 | `check:docs` |
| 部署开关（`lib/options.mjs`） | 配置页开关 + `STATUS_DEFAULTS` / `STATUS_SCHEMA` / `Config` volatile + `test/options.test.mjs` | 单测 + `check:ui` |
| 输入框 `@` 数据源 / 连接别名（`lib/client.js` 的 input source、`lib/collect.mjs` 的 `assignConnectionAliases`） | 本表 + AGENTS.md「客户端半」与「状态通道」+ `doc/CLIENT.md` 的 `@` 输入源一节 + `doc/REQUIREMENTS.md` R80-R83 + `scripts/render-check.mjs` 的 `[47]` 段（假 ctx 的 `inject` 桩）+ `test/collect-alias.test.mjs` + 两份 README（用户可见） | `check:ui` + 单测 + `check:secrets` |
| 模型侧 `@db:<句柄>` 语义 / 别名目录（`lib/policy.mjs`） | `test/policy.test.mjs`（目录、上限、零知识）+ AGENTS.md「其他不可退化」+ `doc/CLIENT.md` + 两份 README 的策略段字数 | 单测 + `check:secrets` |

## 门禁只保证什么

`npm run check:docs` 机械校验的是**提醒本身不烂**：

- `AGENTS.md`、`README.md`、`README.en.md` 与各文档的链接、锚点真实存在；
- 本表引用的每个仓库路径真实存在；
- 三份入口文档指向 `doc/` 的文档都随 npm 包分发（`files`）；

它**不能**判断内容是否真的同步了——那仍靠评审时按本表逐项核对。同理 `test/gates.test.mjs` 只保证「门禁能红」，不保证门禁的规则是对的：规则的取舍写在 AGENTS.md「质量门」里。
