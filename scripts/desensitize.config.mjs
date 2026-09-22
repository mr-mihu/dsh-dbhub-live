// dsh-dbhub-live — desensitization slot registry (single source of truth).
//
// Every place a real host, account, password, database or project name COULD be
// written down is a *slot*. The gate `npm run check:secrets` resolves each slot
// against this registry, so the check is high-precision at the places we know
// and still has a generic backstop for places nobody registered yet.
//
// The registry is verified: a slot whose globs match no file fails the gate
// (`slot-stale`), so it cannot silently rot while the tree moves.
//
// Two rule sets:
//   * backstop — runs on EVERY scanned file (unknown surfaces): IP literals,
//     secret formats, high-entropy strings.
//   * slot rules — run inside the registered slots only (targeted, lower noise):
//     credentialed-URL password/host, secret-keyword assignments, internal host
//     suffixes, and the local denylist of bare names.
//
// Rules for editing content (not just for the gate):
//   * example host      -> 127.0.0.1, localhost, or an RFC 5737 range
//                          (192.0.2.x / 198.51.100.x / 203.0.113.x)
//   * example password  -> CHANGE_ME
//   * test fixtures     -> short placeholders are fine (`u:p`, `root:secret`),
//                          but the host still obeys the example-host rule
//   * real values       -> ONLY $DSH_HOME/storages/dsh-dbhub-live/credentials.json
//                          (outside the repository) and the local .env denylist
//
// Adding a feature that introduces a new example, default, copy string or
// fixture means adding/updating its slot HERE in the same change (AGENTS.md
// "质量门" states the obligation).

/** Placeholder passwords allowed in an example or fixture DSN. */
export const PLACEHOLDER_PASSWORDS = [
  'CHANGE_ME',
  'changeme',
  'your-password',
  '<password>',
  '****',
  'p',
  'pass',
  'password',
  'secret',
  'secret.pw',
  'pw',
]

/** Placeholder hostnames allowed in an example or fixture DSN. */
export const PLACEHOLDER_HOSTS = [
  'localhost',
  'host',
  'h',
  'db',
  'dbhost',
  'mysql',
  'postgres',
  'x',
  'alice',
  'bob',
  'u',
  'user',
  'root',
  'evil',
  'nope',
  'example.com',
  'db.example.com',
]

/**
 * IP literals that may appear in the repository. Anything else is a real
 * address and must be replaced by a loopback or RFC 5737 documentation range.
 */
export const IP_ALLOWLIST = [
  { label: 'IPv4 loopback 127.0.0.0/8', test: /^127\./ },
  { label: 'IPv4 bind-any 0.0.0.0', test: /^0\.0\.0\.0$/ },
  { label: 'RFC 5737 documentation 192.0.2.0/24', test: /^192\.0\.2\./ },
  { label: 'RFC 5737 documentation 198.51.100.0/24', test: /^198\.51\.100\./ },
  { label: 'RFC 5737 documentation 203.0.113.0/24', test: /^203\.0\.113\./ },
  { label: 'IPv6 loopback ::1', test: /^::1$/ },
  { label: 'IPv6 unspecified ::', test: /^::$/ },
]

/** Hostname suffixes that reveal an internal/private network. */
export const INTERNAL_HOST_SUFFIXES = [
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.corp',
  '.intra',
  '.home',
  '.localdomain',
]

/** Property names whose assigned literal must be a placeholder or a reference. */
export const SECRET_KEYWORDS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'auth_token',
  'access_token',
  'api_key',
  'apikey',
  'access_key',
  'private_key',
  'client_secret',
]

/** Values that are obviously not a real secret (references or placeholders). */
export const PLACEHOLDER_VALUE_RE =
  /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z0-9_]+|env\.[A-Za-z0-9_]+|CHANGE_ME|changeme|your-password|<[^>]+>|\*+|-+|''|""|)$/

/** Well-known credential formats: never legitimate in this repository. */
export const SECRET_FORMATS = [
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { label: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { label: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
]

/**
 * High-entropy literal detection (catches random passwords nobody listed, e.g.
 * the short random strings this repository used to keep in its blacklist).
 * Only quoted single tokens are considered; hashes and ids are allowlisted.
 */
export const ENTROPY = {
  minLength: 12,
  minBitsPerChar: 3.5,
  /**
   * Structural requirement before entropy even applies: a random credential
   * mixes letter case or digits, while ordinary code identifiers and copy
   * strings are single-case words (`dbhub_configure`, `dbhub_search_objects`,
   * `/plugins/dsh-dbhub-live/client.js`).
   */
  requireMixed: true,
  /** Tokens that are structurally not secrets. */
  allowPatterns: [
    /^[0-9a-fA-F]{16,}$/, // hex digest / sha fragment
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // uuid
    /^[A-Za-z0-9]+\.(mjs|js|json|md|yml|yaml|ts|tsx|png|tgz)$/, // file name
    /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/, // lowercase slug / identifier (kebab or snake)
    /^[A-Za-z0-9_.-]+=[^\s]*$/, // `KEY=value` fragment (env/config line)
    /^[A-Za-z0-9_-]+:[A-Za-z0-9_./-]+$/, // `key: value` fragment
    /^https?/, // url fragment
    /^[A-Za-z0-9_./-]*[./][A-Za-z0-9_./-]*$/, // path-like token (contains . or /)
    /^[A-Z][A-Z0-9_]{7,}$/, // SCREAMING_SNAKE env/const name
    /^[A-Za-z]+$/, // a single word
  ],
}

/** Inline escape hatch: a line carrying this marker is skipped. */
export const PRAGMA = 'desensitize:allow'

/** Rules the checker understands. */
export const ALL_RULES = ['ip', 'secret', 'entropy', 'password', 'dsn', 'host', 'name']

/**
 * Backstop rules: applied to every scanned file, including files no slot
 * registers yet — they are cheap and high-signal (IP literals, credential
 * formats, entropy, internal hostnames, the local denylist of bare names).
 */
export const BACKSTOP_RULES = ['ip', 'secret', 'entropy', 'host', 'name']

/**
 * Registered slots. `globs` are repository-relative and must match at least one
 * file. `rules` are the targeted rules applied inside the slot.
 */
export const SLOTS = [
  {
    id: 'host-copy',
    description: '宿主侧模型可见文案：工具描述、i18n 结果与标签（会打进 npm 包、直接进模型上下文）',
    globs: ['lib/i18n.mjs', 'lib/tools.mjs', 'lib/index.mjs', 'lib/mcp.mjs', 'lib/state.mjs'],
    rules: ['password', 'dsn', 'host', 'name'],
  },
  {
    id: 'client-copy',
    description: '浏览器半区文案与 UI 占位符（设置页/插件页展示，会打进 npm 包）',
    globs: ['lib/client.js'],
    rules: ['password', 'dsn', 'host', 'name'],
  },
  {
    id: 'connection-code',
    description: '连接构造与解析代码：不得有硬编码 host/user/password 默认值',
    globs: ['lib/config.mjs', 'lib/adhoc.mjs', 'lib/options.mjs', 'lib/runtime.mjs'],
    rules: ['password', 'dsn', 'host', 'name'],
  },
  {
    id: 'scan-code',
    description: '项目文件扫描器：只允许文件名模式，不得出现具体路径/库名',
    globs: ['lib/collect.mjs'],
    rules: ['password', 'host', 'name'],
  },
  {
    id: 'tests',
    description: '测试夹具：DSN/IP/账号只能是回环或 RFC 5737 文档段 + 占位符',
    globs: ['test/**/*.mjs'],
    rules: ['password', 'dsn', 'host', 'name'],
  },
  {
    id: 'docs',
    description: '用户文档示例：安装、配置、故障排查里的连接示例',
    globs: ['README.md', 'README.en.md', 'doc/**/*.md'],
    rules: ['password', 'dsn', 'host', 'name'],
  },
  {
    id: 'package-meta',
    description: '包元数据与 bundle patch：description/keywords 不得含内部项目名',
    globs: ['package.json', 'cordis.patch.yml'],
    rules: ['password', 'host', 'name'],
  },
  {
    id: 'agent-prompt',
    description: '开发规范（提示词）：只写规则与变量名，绝不写真实值',
    globs: ['AGENTS.md'],
    rules: ['password', 'dsn', 'host', 'name'],
  },
  {
    id: 'tooling',
    description: '仓库维护脚本自身（不含黑名单值；.env 由 .gitignore 排除、不参与扫描）',
    globs: ['scripts/*.mjs'],
    rules: ['password', 'host'],
  },
]

/** The local denylist variable read from the gitignored `.env`. */
export const DENYLIST_VAR = 'DSH_DBHUB_DESENSITIZE_RE'

/** Paths the walk never enters and files it never reads. */
export const SKIP_DIRS = ['.git', 'node_modules', '.dsh-test', 'dist', 'coverage']
export const SKIP_FILES = ['.env', '.env.local']
export const SKIP_EXT_RE = /\.(tgz|png|jpe?g|gif|webp|ico|zip|gz|exe|dll|node|woff2?|pdf)$/i
export const MAX_FILE_BYTES = 2 * 1024 * 1024
