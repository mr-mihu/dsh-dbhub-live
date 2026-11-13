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
| 环境级结果行数上限（`maxRows`：store 字段、`{op:'options'}` 写入、`dbhub_execute_sql` 单次覆盖与截断提示） | AGENTS.md「环境选项（只读 / SSH / 结果行数上限）」+ `doc/REQUIREMENTS.md` R84 + `doc/CLIENT.md` 的「环境选项的落点」+ `doc/ARCHITECTURE.md`「环境选项与执行预算」+ `test/max-rows.test.mjs` + `scripts/render-check.mjs` 的 `[48]` 段 + 两份 README（用户可见） | `test/max-rows.test.mjs` + `check:ui` + `check:secrets` + `check:docs` |
| 会话权限闸门（`dbhub_execute_sql` 的写判定 `classifySql`、`sandboxPolicy.resolve` 与 `approval.request` 两个可选服务、拒绝/弹窗文案） | AGENTS.md「会话权限闸门（写操作）」+ `doc/ARCHITECTURE.md`「会话权限闸门」+ `doc/REQUIREMENTS.md` R85 + `lib/policy.mjs` 的会话权限行 + `test/permission-gate.test.mjs` + `lib/i18n.mjs` 的 `result.sessionReadOnly` / `result.write*` / `approval.writeReason` + 两份 README（用户可见） | `test/permission-gate.test.mjs` + 单测 + `check:secrets` + `check:docs` |
| SSH 秘密存储（`ctx.get('credentials')` 凭据库、`ssh.passwordRef` / `passphraseRef`、boot 迁移、执行前解析、删除/替换时释放） | AGENTS.md「秘密与凭据库」+「环境选项」+「存储」+ `doc/ARCHITECTURE.md`「环境选项与执行预算」+ `doc/REQUIREMENTS.md` R86 + `doc/DESENSITIZE.md`「原则」+ `test/cred-store.test.mjs` + `lib/i18n.mjs` 的 `result.sshSecretMissing` / `log.cred*` / `log.secret*` + 两份 README 的 SSH 隧道段 | `test/cred-store.test.mjs` + 单测 + `check:secrets` + `check:docs` |
| 数据库口令存储（`dsnPasswordRef`、`splitDsnPassword` / `joinDsnPassword` 逐字节闸门、`${DSH_DBHUB_DSN}` 占位符、boot 合并迁移、执行/探连前拼装、`result.dsnSecretMissing`、`passwordUnsplit` 状态位、删除/覆盖释放 ref） | AGENTS.md「秘密与凭据库」+「环境选项」+「存储」+ `doc/ARCHITECTURE.md`「数据库口令为什么也拆进凭据库」+ `doc/CLIENT.md`「环境选项的落点」+ `doc/REQUIREMENTS.md` R94 + `doc/DESENSITIZE.md`「原则」+ `test/dsn-secret.test.mjs` + `lib/i18n.mjs` 的 `result.dsnSecretMissing` / `log.dsn*` + `lib/client.js` 的 `ws.dsnUnsplitHint` + 两份 README「数据位置」与 SSH 段 | `test/dsn-secret.test.mjs` + `test/cred-store.test.mjs` + 单测 + `check:secrets` + `check:docs` + `check:ui` |
| 连接列表的搜索 / 排序 / 批量测试（`lib/client.js` 的 `filterRows` / `sortRows` / `batchSummaryOf` 纯函数块、`batchRef` 批量状态、`{op:'test'}` 的 POST 应答解析、`.dbh-searchbar` / `.dbh-batchsum` 样式） | `doc/CLIENT.md`「连接列表的搜索 / 排序 / 批量测试」+ AGENTS.md「客户端半」+ `doc/REQUIREMENTS.md` R87-R91 + `scripts/render-check.mjs` 的 `[49]` 段 + `test/conn-list.test.mjs` + `lib/client.js` 的两份 locale 字典 + 两份 README（用户可见） | `check:ui` + `test/conn-list.test.mjs` + `test/client-format.test.mjs`（i18n 去重/键集/en 纯净）+ `check:secrets` + `check:docs` |
| 版本漂移监控（`scripts/version-watch.mjs` 的 `compareVersions` / `classify` 与退出码、`.github/workflows/version-watch.yml` 的 issue 幂等逻辑） | `doc/RELEASE.md`「版本漂移监控」+ AGENTS.md「质量门」的 CI 两条 + `test/version-watch.test.mjs` | `test:unit`（`test/version-watch.test.mjs`）+ `check:docs` + `check:secrets` |

## 门禁只保证什么

`npm run check:docs` 机械校验的是**提醒本身不烂**：

- `AGENTS.md`、`README.md`、`README.en.md` 与各文档的链接、锚点真实存在；
- 本表引用的每个仓库路径真实存在；
- 三份入口文档指向 `doc/` 的文档都随 npm 包分发（`files`）；

它**不能**判断内容是否真的同步了——那仍靠评审时按本表逐项核对。同理 `test/gates.test.mjs` 只保证「门禁能红」，不保证门禁的规则是对的：规则的取舍写在 AGENTS.md「质量门」里。
