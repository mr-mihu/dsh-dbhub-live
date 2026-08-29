// dsh-dbhub-live: plugin-owned tools (never synced away by the server).
//
// - dbhub_configure      per-workspace connection configuration
// - dbhub_list_sources   enumerate every registered connection source (for the
//                        model to discover named environments without guessing)
// - dbhub_query          ad-hoc temporary query on any DSN
// - dbhub_query_objects  ad-hoc temporary object search on any DSN
// Every tool guards on the plugin's enable/disable toggle first, so disabling
// the plugin flips all dbhub tools to a friendly message immediately.

import { readFileSync, statSync } from 'node:fs'
import {
  store, saveStore, listWorkspaces, slugify, envSlug, shortHash, maskDsn,
  setWorkspaceEnv,
} from './config.mjs'
import {
  ensureRunning, isServerUp, coreDisposers, refreshToolCount, disabledMessage,
  collectSources, resolveSource, sourceLabel, runOnServer,
} from './mcp.mjs'
import { runAdhoc } from './adhoc.mjs'
import { walkForCandidates, extractDsnCandidates, askUser, answerItemOf, sessionCwd } from './collect.mjs'
import { currentT } from './i18n.mjs'
import * as state from './state.mjs'

function disabledReply() {
  return { ok: false, text: disabledMessage() }
}

// One shared body for the source-parameterized persistent tools: resolve the
// `source` to a configured connection, strip the routing arg, and hand the
// rest to the live dbhub source tool. Routing keeps the tool DECLARATION
// count constant no matter how many workspaces × environments exist.
async function runSourceTool(ctx, subprocess, base, args, exec) {
  if (!state.isEnabled()) return disabledReply()
  const src = await resolveSource(ctx, subprocess, args.source)
  if (!src) {
    return {
      ok: false,
      text: currentT('result.noSource', { src: String((args && args.source) || '') }),
    }
  }
  const mcpArgs = {}
  for (const key of Object.keys(args || {})) {
    if (key !== 'source') mcpArgs[key] = args[key]
  }
  const label = currentT('label.conn', { src: src.id, dsn: maskDsn(src.row.dsn) })
  return runOnServer(ctx, subprocess, base + '_' + src.id, mcpArgs, exec, label)
}

// ── dbhub_configure body ──────────────────────────────────────────────────

// Persist one environment and report the resulting tool name.
async function persistEnv(ctx, subprocess, wsPath, slug, env, dsn, source) {
  const envName = setWorkspaceEnv(wsPath, env, dsn, source)
  await ensureRunning(ctx, subprocess)
  if (!isServerUp()) {
    return { ok: false, text: currentT('result.sevSaveFail') }
  }
  refreshToolCount()
  const suffix = envSlug(envName)
  return {
    ok: true,
    text: currentT('result.savedOk', {
      slug,
      env: envName,
      tool: slug + (suffix ? '_' + suffix : ''),
    }),
  }
}

async function runConfigure(ctx, subprocess, args, exec) {
  if (!state.isEnabled()) return disabledReply()
  const userQuestions = ctx.get('userQuestions')
  const workspaces = await listWorkspaces(ctx)
  const currentCwd = sessionCwd(exec.agent)
  let target = workspaces.find((w) => w.path === (args.workspace || currentCwd))
  if (!target) {
    const byTitle = workspaces.find((w) => w.title === args.workspace)
    target = byTitle || (workspaces.find((w) => w.path === currentCwd) || workspaces[0])
  }
  if (!target) return { ok: false, text: currentT('result.noWslabel') }
  const wsPath = target.path
  const slug = slugify(target.title) + '_' + shortHash(wsPath)
  const env = args.env

  // 1) explicit dsn argument
  if (typeof args.dsn === 'string' && args.dsn.trim() !== '') {
    return persistEnv(ctx, subprocess, wsPath, slug, env, args.dsn.trim(), 'user')
  }

  const ans = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'mode',
      header: '配置工作区数据库连接：' + target.title,
      question: '未检测到自动配置（mise env/.env）。怎么提供连接信息？',
      options: [
        { label: '输入完整 DSN', description: '如 mysql://user:pass@host:3306/db' },
        { label: '填写分项（类型/主机/端口/账号/密码/库名）' },
        { label: '扫描项目配置文件（需授权，可能读取含密码的文件）' },
        { label: '取消' },
      ],
    },
  ])
  const mode = answerItemOf(ans, 'mode')
  const chosen = mode && mode.selected && mode.selected[0]
  if (!chosen || chosen === '取消') return { ok: false, text: currentT('result.modeCanceled') }

  if (chosen === '输入完整 DSN') {
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, [
      {
        id: 'dsn',
        header: '完整 DSN',
        question: '请输入数据库连接串',
      },
    ])
    const dsn = answerItemOf(ans2, 'dsn')
    const text = dsn && dsn.custom && dsn.custom.trim()
    if (!text) return { ok: false, text: currentT('result.noDsn') }
    return persistEnv(ctx, subprocess, wsPath, slug, env, text, 'user')
  }

  if (chosen === '填写分项（类型/主机/端口/账号/密码/库名）') {
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, [
      {
        id: 'type',
        header: '类型',
        question: '数据库类型',
        options: [{ label: 'mysql' }, { label: 'postgres' }, { label: 'mariadb' }, { label: 'sqlite' }, { label: 'sqlserver' }],
      },
      { id: 'host', header: '主机', question: '主机地址', options: [{ label: '留空（默认 localhost）' }] },
      { id: 'port', header: '端口', question: '端口（可留空）', options: [{ label: '留空' }] },
      { id: 'user', header: '账号', question: '用户名（可留空）', options: [{ label: '留空' }] },
      { id: 'password', header: '密码', question: '密码（可留空）', options: [{ label: '留空' }] },
      { id: 'db', header: '库名', question: '数据库名（可留空）', options: [{ label: '留空' }] },
    ])
    const val = (id) => {
      const item = answerItemOf(ans2, id)
      if (item && item.custom && item.custom.trim()) return item.custom.trim()
      if (item && item.selected && item.selected[0]) {
        const s = item.selected[0]
        return s.startsWith('留空') ? '' : s
      }
      return ''
    }
    const type = (val('type') || 'mysql').toLowerCase()
    const host = val('host')
    const port = val('port')
    const user = val('user')
    const password = val('password')
    const database = val('db')
    let dsn
    if (type === 'sqlite') dsn = 'sqlite:///' + (host || 'test.db')
    else dsn = type + '://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@' + (host || 'localhost') + (port ? ':' + port : '') + '/' + encodeURIComponent(database)
    return persistEnv(ctx, subprocess, wsPath, slug, env, dsn, 'user')
  }

  // scan path: authorization gate FIRST
  const auth = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'auth',
      header: '授权扫描',
      question: '将扫描工作区项目中的常见数据库配置文件（.env / application*.yml / docker-compose / jdbc.properties 等）' +
        '并读取其中的连接信息（可能包含账号密码）。此操作会读取敏感文件且消耗较多 token，是否授权？',
      options: [
        { label: '授权扫描', description: '扫描后列出候选供你确认，确认才持久化' },
        { label: '取消' },
      ],
    },
  ])
  const authChosen = answerItemOf(auth, 'auth')
  const authOk = authChosen && authChosen.selected && authChosen.selected[0] === '授权扫描'
  if (!authOk) return { ok: false, text: currentT('result.scanDenied') }

  const budget = { count: 0 }
  const files = walkForCandidates(wsPath, budget)
  if (files.length === 0) return { ok: false, text: currentT('result.scanEmpty') }
  const candidates = []
  for (const f of files) {
    let text
    try {
      const st = statSync(f)
      if (st.size > 64 * 1024) continue
      text = readFileSync(f, 'utf8')
    } catch (e) {
      continue
    }
    for (const c of extractDsnCandidates(f, text)) {
      const rel = f.replace(wsPath, '.').replace(/\\/g, '/')
      candidates.push({ label: rel + ' → ' + maskDsn(c.dsn), dsn: c.dsn, via: c.via })
    }
  }
  if (candidates.length === 0) return { ok: false, text: currentT('result.scanNone', { n: files.length }) }
  const pick = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'pick',
      header: '选择连接',
      question: '扫描到以下候选（密码已打码），选择要使用的：',
      options: candidates.map((c) => ({ label: c.label, description: '来源: ' + c.via })),
    },
  ])
  const picked = answerItemOf(pick, 'pick')
  const label = picked && picked.selected && picked.selected[0]
  if (!label) return { ok: false, text: '未选择，已取消' }
  const match = candidates.find((c) => c.label === label)
  if (!match) return { ok: false, text: '选择无效' }
  const envName = setWorkspaceEnv(wsPath, env, match.dsn, 'collected')
  const suffix = envSlug(envName)
  await ensureRunning(ctx, subprocess)
  if (!isServerUp()) {
    return { ok: false, text: currentT('result.sevSaveFail') }
  }
  refreshToolCount()
  return { ok: true, text: currentT('result.scanPicked', { env: envName, slug: slug + (suffix ? '_' + suffix : '') }) }
}

// ── tool builders ─────────────────────────────────────────────────────────

// Enumerate every registered connection source so the model can discover
// named environments (test/prod/...) and their tool names without guessing.
function buildListSourcesTool(ctx, subprocess) {
  return {
    name: 'dbhub_list_sources',
    description:
      '列出当前已注册的全部数据库连接源（每个 = 工作区 × 环境）及其对应的常驻查询工具名。' +
      '注意：列表中的连接串是脱敏显示（密码为 ****），仅供识别环境，绝不能拷进 dbhub_query / dbhub_query_objects 直连（会失败）；' +
      '查询某个环境请直接调用该行给出的 dbhub_execute_sql_<工作区>[_<环境>] 工具（已内置真实凭据）。' +
      '当用户提到某个环境（如 test/测试）但你不确定它是否已注册时，先调用本工具确认环境名，再调用对应环境的工具，避免误用默认（生产）库。' +
      '常驻连接为懒建立：本工具能列出的 source 不代表数据库当前可达，若某环境库不可达，只有对该 source 的调用会返回连接错误（不影响其他环境）。无参数。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    output: {
      schema: {},
      render: (_args, value) => [
        {
          type: 'text',
          text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)),
        },
      ],
    },
    async execute() {
      if (!state.isEnabled()) return disabledReply()
      const { rows } = await collectSources(ctx, subprocess)
      if (rows.length === 0) {
        return { ok: true, text: currentT('result.sourcesEmpty') }
      }
      const lines = rows.map((r) => {
        const badge = r.persisted ? currentT('result.badgeSaved') : currentT('result.badgeAuto')
        const srcId = slugify(r.title) + '_' + shortHash(r.wsPath) + (r.env === 'default' ? '' : '_' + envSlug(r.env))
        return currentT('result.srcRow', {
          title: r.title,
          badge,
          env: r.env,
          dsn: maskDsn(r.dsn),
          src: r.source || '?',
          srcId,
        })
      })
      return {
        ok: true,
        text: currentT('result.sourcesIntro', { n: rows.length }) + '\n' + lines.join('\n'),
      }
    },
  }
}

function buildConfigureTool(ctx, subprocess) {
  return {
    name: 'dbhub_configure',
    description:
      '配置某个工作区的数据库连接（持久化）。参数：workspace（工作区路径或标题，默认当前会话工作区）、env（环境名，默认 default，同一工作区可添加多个环境）、dsn（完整连接串，可选）。' +
      '未提供 dsn 时会询问用户：输入 DSN / 填写分项 / 授权扫描项目配置文件（读取 .env、application*.yml、docker-compose、jdbc.properties 等并列出候选供确认）。' +
      '配置后自动生成 dbhub.toml、重启常驻 dbhub 服务并注册该工作区的工具（dbhub_execute_sql_<工作区>[_<环境>] 等）。' +
      '每个工作区只需配置一次，之后自动持久化；有 mise env/.env 自动配置的工作区无需调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: '工作区路径或标题；默认当前会话工作区' },
        env: { type: 'string', description: '环境名（如 prod/dev/test）；默认 default，多个环境各自注册独立工具' },
        dsn: { type: 'string', description: '完整数据库连接串；省略则询问用户或扫描' },
      },
      required: [],
    },
    timeoutMs: 120000,
    output: {
      schema: {},
      render: (_args, value) => [
        {
          type: 'text',
          text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)),
        },
      ],
    },
    async execute(args, exec) {
      return runConfigure(ctx, subprocess, args, exec)
    },
  }
}

export function registerCoreTools(ctx, subprocess) {
  try {
    const def = buildConfigureTool(ctx, subprocess)
    const disposer = ctx.tools.register(def)
    coreDisposers.set('dbhub_configure', disposer)
  } catch (e) {
    console.error('[dsh-dbhub-live] register dbhub_configure failed: ' + String((e && e.message) || e))
  }
  try {
    const def = buildListSourcesTool(ctx, subprocess)
    const disposer = ctx.tools.register(def)
    coreDisposers.set('dbhub_list_sources', disposer)
  } catch (e) {
    console.error('[dsh-dbhub-live] register dbhub_list_sources failed: ' + String((e && e.message) || e))
  }
  // Persistent source tools: ONE declaration per operation, routing by the
  // `source` argument (constant tool count regardless of workspace × env).
  const sourceDefs = [
    {
      name: 'dbhub_execute_sql',
      description:
        '在指定数据源的常驻连接上执行 SQL。source 必填：数据源标识，先调用 dbhub_list_sources 查看全部可用值与对应环境（如 <工作区> 为默认环境，<工作区>_<环境> 为命名环境，例如通过 _test 指向测试库）。' +
        'sql：要执行的 SQL（多语句用 ; 分隔）。结果自动标注所连环境。' +
        '连接为按需建立（该 source 首次调用时才真正连库）：某个环境的数据库不可达只会让该 source 的调用返回连接错误，不影响其他环境查询与常驻服务存活。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '数据源标识（来自 dbhub_list_sources），按环境选择测试/生产' },
          sql: { type: 'string', description: '要执行的 SQL（多语句用 ; 分隔）' },
        },
        required: ['source', 'sql'],
      },
      timeoutMs: 60000,
      output: {
        schema: {},
        render: (_args, value) => [
          { type: 'text', text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)) },
        ],
      },
      async execute(args, exec) {
        return runSourceTool(ctx, subprocess, 'execute_sql', args, exec)
      },
    },
    {
      name: 'dbhub_search_objects',
      description:
        '在指定数据源的常驻连接上搜索数据库对象（表/视图/列/索引等）。source 必填（见 dbhub_list_sources）。' +
        '注意：dbhub 的 search_objects 仅对 sqlite 开放（🔒），MySQL/PostgreSQL 等请用 dbhub_execute_sql 直接查（如 SHOW TABLES）。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '数据源标识（来自 dbhub_list_sources）' },
          object_type: { type: 'string', enum: ['schema', 'table', 'view', 'column', 'procedure', 'function', 'index'], description: '对象类型' },
          pattern: { type: 'string', description: 'LIKE 模式' },
          schema: { type: 'string', description: '限定 schema' },
          table: { type: 'string', description: '限定表（需 schema）' },
          detail_level: { type: 'string', enum: ['names', 'summary', 'full'], description: '详细程度' },
          limit: { type: 'integer', description: '最大结果数' },
        },
        required: ['source', 'object_type'],
      },
      timeoutMs: 60000,
      output: {
        schema: {},
        render: (_args, value) => [
          { type: 'text', text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)) },
        ],
      },
      async execute(args, exec) {
        const mcp = {}
        for (const k of ['object_type', 'pattern', 'schema', 'table', 'detail_level', 'limit']) {
          if (args[k] !== undefined && args[k] !== null) mcp[k] = args[k]
        }
        return runSourceTool(ctx, subprocess, 'search_objects', { source: args.source, ...mcp }, exec)
      },
    },
  ]
  for (const def of sourceDefs) {
    try {
      const disposer = ctx.tools.register(def)
      coreDisposers.set(def.name, disposer)
    } catch (e) {
      console.error('[dsh-dbhub-live] register ' + def.name + ' failed: ' + String((e && e.message) || e))
    }
  }
  // Ad-hoc temporary connections: model passes a full dsn per request; each
  // call is an independent throwaway dbhub, so two calls can hit two different
  // databases at once. Independent state -> safe to run concurrently.
  const adhocDefs = [
    {
      name: 'dbhub_query',
      description:
        '临时动态连接任意数据库并执行 SQL（每次调用独立临时连接，可同时查多个不同库）。' +
        '参数 dsn 必填：完整连接串，指定 ip/端口/账号/密码/库（如 mysql://user:pass@host:3306/db）。' +
        '适合一次性排查/对比不同环境；与持久配置的工作区工具互不影响。多语句用 ; 分隔。',
      parameters: {
        type: 'object',
        properties: {
          dsn: { type: 'string', description: '完整数据库连接串，如 mysql://root:pass@192.168.77.6:3306/tx_sd_jinengshu' },
          sql: { type: 'string', description: '要执行的 SQL（多语句用 ; 分隔）' },
        },
        required: ['dsn', 'sql'],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      output: {
        schema: {},
        render: (_args, value) => [
          { type: 'text', text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)) },
        ],
      },
      async execute(args, exec) {
        return runAdhoc(subprocess, args.dsn, 'execute_sql', { sql: args.sql }, exec)
      },
    },
    {
      name: 'dbhub_query_objects',
      description:
        '临时动态连接并搜索数据库对象（表/视图/列/索引等），每次调用独立临时连接。' +
        '注意：dbhub 的 search_objects 仅对 sqlite 开放（🔒），MySQL/PostgreSQL 等请用 dbhub_query 直接查（如 SHOW TABLES）。' +
        '参数 dsn 必填（ip/端口/账号/密码/库）。',
      parameters: {
        type: 'object',
        properties: {
          dsn: { type: 'string', description: '完整数据库连接串，如 mysql://root:pass@192.168.77.6:3306/tx_sd_jinengshu' },
          object_type: { type: 'string', enum: ['schema', 'table', 'view', 'column', 'procedure', 'function', 'index'], description: '对象类型' },
          pattern: { type: 'string', description: 'LIKE 模式' },
          schema: { type: 'string', description: '限定 schema' },
          table: { type: 'string', description: '限定表（需 schema）' },
          detail_level: { type: 'string', enum: ['names', 'summary', 'full'], description: '详细程度' },
          limit: { type: 'integer', description: '最大结果数' },
        },
        required: ['dsn', 'object_type'],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      output: {
        schema: {},
        render: (_args, value) => [
          { type: 'text', text: String(value && value.text !== undefined ? value.text : JSON.stringify(value)) },
        ],
      },
      async execute(args, exec) {
        const mcp = {}
        for (const k of ['object_type', 'pattern', 'schema', 'table', 'detail_level', 'limit']) {
          if (args[k] !== undefined && args[k] !== null) mcp[k] = args[k]
        }
        return runAdhoc(subprocess, args.dsn, 'search_objects', mcp, exec)
      },
    },
  ]
  for (const def of adhocDefs) {
    try {
      const disposer = ctx.tools.register(def)
      coreDisposers.set(def.name, disposer)
    } catch (e) {
      console.error('[dsh-dbhub-live] register ' + def.name + ' failed: ' + String((e && e.message) || e))
    }
  }
  refreshToolCount()
}