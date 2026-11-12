# 脱敏门禁（`npm run check:secrets`）

> AGENTS.md 的配套文档：新增示例/默认值/文案/夹具、或门禁报错时读。
> 一句话红线见 [AGENTS.md](../AGENTS.md#约定)。

## 原则

真实主机 / 账号 / 密码 / 库名 / 项目名只允许存在于三处（都在仓库外）：

1. `$DSH_HOME/storages/dsh-dbhub-live/credentials.json`（DSN 与连接元数据；SSH 隧道口令自 6.0 起不在这里，见下一条）；
2. DSH 凭据库（默认 `$DSH_HOME/.credentials.yaml`，由 DSH 管理）：SSH 登录密码 / 密钥口令的**值**；插件自己的连接文件只保存引用名（`ssh.passwordRef` / `ssh.passphraseRef`）。插件不读写该文件，只经 `ctx.get('credentials')` 服务读写；
3. 本地 `.env` 的 `DSH_DBHUB_DESENSITIZE_RE`（`.gitignore` 排除、`package.json` 的 `files` 不含）。

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

`SKIP_DIRS` 跳过 `.git`、`node_modules`、`.dsh-test`、**`.dsh-a` / `.dsh-b` / `.pnpm-store`**、`.release-test`、`dist`、`coverage`。后三个 `.` 目录是 [DEVELOPMENT.md](DEVELOPMENT.md) 让开发者建**在仓库里**的：`.dsh-a` / `.dsh-b` 是隔离 `DSH_HOME`（里面是真实本地凭据），`.pnpm-store` 是本机打包用的 store（`.gitignore` 也排除它，否则脏工作区会挡住 `release:preflight`）。扫它们只会把开发者自己的机器误报成泄漏。两个本地开发文档（`doc/PLAN-*.md`、`doc/implementation-notes.md`）不进 git 也不进包，因此不扫。

本地 denylist 编译失败是**门禁失败**（`exit 1`），不是提示：这一层是唯一能看见裸项目名/库名的规则，坏了不能报 clean。

## `password` 规则的判据（D1 / D2）

`password` 规则匹配「关键字 + 赋值」：`password` / `passwd` / `pwd` / `secret` / `token` / `api_key` / `private_key` / `client_secret` … 后跟 `:` 或 `=`。

1. **关键字两侧可以有引号**（D2）：`"password": "…"`、`'api_key': '…'` 与裸写法同等对待。JSON / JS 对象字面量就是这么写的，只认裸关键字等于整类漏检。
2. **引号里的值永远是"写下来的值"**：带引号的字面量不享受任何裸标识符豁免，只接受显式占位（`CHANGE_ME` / `${VAR}` / `process.env.X` / `<password>` / `****` / 全大写下划线常量名 等）。
3. **无引号的值只在"代码文件"里可能被豁免**（D1），并且只有三种形状：
   - 全大写 + 下划线常量：`PASSWORD_FIELD`、`API_KEY_ENV`；
   - 含点号的成员路径：`req.body.password`、`process.env.DB_PASSWORD`；
   - 纯字母/下划线的单词（不含数字）：`auth`、`keep`、`undefined`、`pwdItem`——这是变量名或注释里的词。
   带数字或标点（`hunter2`、`abc123`、`p@ss`）一律按字面量判。这就是**最真实的泄漏形状**：配置示例、文档、`.env` 里都这么写。
4. **文档与配置类文件没有豁免**：`.md` / `.markdown` / `.yml` / `.yaml` / `.toml` / `.json` / 任意 `*.env*` 里的无引号值一律按字面量判（判据：`CONFIG_FILE_RE`，见 `scripts/desensitize-check.mjs`）。人人都这么写，所以这里不能有豁免。
5. **配置形状的文件自动获得 `password` 规则**：未登记进槽位表的新 `.yml` / `.env` 也要查——规则集按「文件形状」而不是只按槽位表决定，否则判据再严也跑不到那个文件上（这正是 D1 第一次修完仍然漏的地方）。
6. **`.env` 的键名常把关键字嵌在中间**（`DB_PASSWORD=`），而 `_` 是词字符，`\bpassword\b` 永远匹配不到。所以配置类文件额外整行匹配 `KEY=value`（`ENV_SECRET_LINE_RE`），并把值交给同一套判据；`DB_PASSWORD=`、`DB_PASSWORD=${DB_PASSWORD}`、`DB_PASSWORD=CHANGE_ME` 分别按「空值 / 引用 / 占位」放行。
5. **占位词不区分大小写**：`Password` / `PASSWORD` 作为**值**出现的 UI 标签（`"adv.auth.password": "Password"`）是占位词，不是口令。

新增/修改这块判据必须同步跑 `node test/gates.test.mjs`：`D1/D2` 用例逐个文件类型（code / doc / yml / toml / json）钉住"坏样本 exit 1"，并反向钉住 `req.body.password`、`PASSWORD_FIELD`、`CHANGE_ME` 仍然 clean。

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
