# 脱敏门禁（`npm run check:secrets`）

> AGENTS.md 的配套文档：新增示例/默认值/文案/夹具、或门禁报错时读。
> 一句话红线见 [AGENTS.md](../AGENTS.md#约定)。

## 原则

真实主机 / 账号 / 密码 / 库名 / 项目名只允许存在于两处：

1. `$DSH_HOME/storages/dsh-dbhub-live/credentials.json`（仓库外）；
2. 本地 `.env` 的 `DSH_DBHUB_DESENSITIZE_RE`（`.gitignore` 排除、`package.json` 的 `files` 不含）。

**仓库内一切内容都视为会公开分发**（含 `test/`——它被打进 npm tarball——以及工具描述文案）。这些值一旦公开即视为泄露、无法追回，所以门禁是硬门而不是提示。

## 三层规则

门禁由 `scripts/desensitize-check.mjs` 执行，规则与槽位来自 `scripts/desensitize.config.mjs`。

1. **槽位规则（主力，高精度）**：槽位表登记"真实值可能出现的出口"（宿主文案、浏览器文案、连接构造代码、扫描器、测试夹具、文档示例、包元数据、本提示词、维护脚本），每个槽位声明它需要的规则（`password` / `dsn` / `host` / `name` / `localpath`）。**槽位 glob 必须匹配到文件，否则门禁报 `slot-stale`**——槽位表不会随目录移动悄悄失效。
   - `localpath` 只挂在**文档与提示词类槽位**（`docs` / `package-meta` / `agent-prompt`）：真实机器路径（Windows 盘符绝对路径、用户 home 目录下的路径）不得出现在会被公开分发的文案里；测试夹具允许用合成盘符路径，故 `tests` 槽位不启用它。
2. **通用兜底（覆盖未登记的新出口）**：
   - `ip`：只允许回环、`0.0.0.0` 与 RFC 5737 文档段 `192.0.2.x` / `198.51.100.x` / `203.0.113.x`；
   - `secret`：GitHub / npm / OpenAI / Slack / AWS / JWT / PEM 等真凭据格式；
   - `entropy`：大小写 + 数字混排的高熵串；
   - `host`：`.local` / `.internal` / `.corp` 等内网后缀；
   - `name`：本地 denylist。
3. **本地 denylist（补充）**：pattern 抓不到的**裸名字**（项目 / 公司 / 库名）放在 `.env` 的 `DSH_DBHUB_DESENSITIZE_RE`（`|` 分隔、正则转义、多条取并集）。CI 里没有 `.env`，该层自动降级为提示，不影响其余两层。

`SKIP_DIRS` 跳过 `.git`、`node_modules`、`.dsh-test`、`.release-test`、`dist`、`coverage`；两个本地开发文档（`doc/PLAN-*.md`、`doc/implementation-notes.md`）不进 git 也不进包，因此不扫。

## 写法约定（新增内容一律照此）

| 场景 | 写法 |
| --- | --- |
| 示例主机 | `127.0.0.1` / `localhost` / RFC 5737 段 |
| 示例密码 | `CHANGE_ME` |
| 测试夹具 | 短占位可以（`u:p`、`root:secret`），但主机仍须回环或保留段 |
| 误报 | 行内标记 `desensitize:allow`（仅限确认无害的行） |
| 本地路径 | 用 `<repo>` / `<dsh 安装目录>` 占位，**不写任何人的绝对路径** |

## 义务（硬规则）

- 新增功能若引入示例、默认值、文案串或夹具 → **同一次改动里更新 `scripts/desensitize.config.mjs` 槽位表**；
- 提交前跑 `npm run check:secrets`，命中就改占位符或换规范值，不要用 `desensitize:allow` 掩盖真实值；
- 发现新的真实值 → **只追加到本地 `.env` 的 `DSH_DBHUB_DESENSITIZE_RE`**，绝不写进任何受版本控制的文件。

执行点：本地手动 + `prepublishOnly` + CI（`.github/workflows/quality.yml`）。

## 零知识自检（模型可见面不得含密码）

```bash
node test/zero-knowledge.test.mjs   # 全绿
npm run check:secrets               # 零匹配
```

两者都过才算干净。
