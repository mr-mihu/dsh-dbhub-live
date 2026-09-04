// dsh-dbhub-live: plugin-owned tools (never synced away by the server).
//
// Model contract (zero-knowledge): exactly FOUR constant declarations —
//   dbhub_configure      configure a workspace connection (password entered by
//                        the USER in the UI, never by the model)
//   dbhub_list_sources   enumerate every registered connection source with
//                        METADATA ONLY (type/host/port/database) — no DSN, no
//                        username, no password ever crosses to the model
//   dbhub_execute_sql    run SQL on a source (one-shot process per call)
//   dbhub_search_objects search objects on a source (one-shot process)
// Every tool guards on the plugin's enable/disable toggle first, executes
// through runAdhoc (a fresh disposable dbhub per call), and labels results
// with host/port/database metadata — so execution is stateless, concurrent,
// fault-isolated and multi-instance safe.

import { readFileSync, statSync } from 'node:fs'
import {
  listWorkspaces, resolveWorkspaceEnvs, slugify, envSlug, shortHash,
  connLabel, describeConn, dsnPassword, dsnUser, setWorkspaceEnv,
} from './config.mjs'
import {
  coreDisposers, refreshToolCount, disabledMessage,
  collectSources, resolveSource,
} from './mcp.mjs'
import { runAdhoc, probeConnection } from './adhoc.mjs'
import { walkForCandidates, extractDsnCandidates, askUser, answerItemOf, sessionCwd } from './collect.mjs'
import { currentT } from './i18n.mjs'
import * as state from './state.mjs'

function disabledReply() {
  return { ok: false, text: disabledMessage() }
}

// Failure kinds that warrant "check the credentials/connection" guidance.
const AUTH_ERROR_RE = /access denied|ER_ACCESS_DENIED|28000|authentication|invalid (user|password)|password (incorrect|wrong|mismatch)|ECONNREFUSED|connection refused|SOURCE_UNREACHABLE|failed to connect|认证失败|连接被拒|无法连接/i

function likelyAuthOrConnError(text) {
  return AUTH_ERROR_RE.test(String(text || ''))
}

// One shared body for the source-parameterized tools: resolve the `source`
// handle to a configured connection (DSN stays host-side), strip the routing
// arg, run a one-shot dbhub process, and attach credentials guidance when the
// failure looks like an auth/connect problem. Routing keeps the tool DECLARATION
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
  const res = await runAdhoc(
    subprocess, src.row.dsn, base, mcpArgs, exec,
    currentT('label.conn', { src: src.id, dsn: connLabel(src.row.dsn) }),
  )
  if (!res.ok && likelyAuthOrConnError(res.text)) {
    res.text += '\n' + currentT('result.authHint', { src: src.id })
  }
  return res
}

// ── dbhub_configure body ──────────────────────────────────────────────────

// Host-side connection probe (raw ok/message, never surfaced unscrubbed).
async function probeResult(subprocess, dsn) {
  try {
    const p = await probeConnection(subprocess, dsn, 15000)
    return { ok: !!p.ok, message: p.message }
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) }
  }
}

// Host-side connection check appended to every configure result so the model
// knows immediately whether the saved DSN works (it never has to discover the
// truth by trial-and-error). Probe failures surface the scrubbed reason.
async function connCheckText(subprocess, dsn) {
  const r = await probeResult(subprocess, dsn)
  return r.ok ? currentT('result.savedProbeOk') : currentT('result.savedProbeFail', { msg: r.message })
}

// Persist one environment and report the resulting source handle. No resident
// server to sync — the next call resolves this row's DSN and spawns on demand.
// state.touch() republishes the settings mirror so a connection configured in
// the chat shows up on the card immediately. A host-side probe runs right
// after saving and its outcome rides the result text.
async function persistEnv(ctx, subprocess, wsPath, slug, env, dsn, source) {
  const envName = setWorkspaceEnv(wsPath, env, dsn, source)
  refreshToolCount()
  state.touch()
  const suffix = envSlug(envName)
  const sound = await connCheckText(subprocess, dsn)
  return {
    ok: true,
    text: currentT('result.savedOk', {
      slug,
      env: envName,
      srcId: slug + (suffix ? '_' + suffix : ''),
    }) + ' ' + sound,
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
  const envName0 = String(env == null ? '' : env).trim() || 'default'

  // Security red line: a password (or full DSN) passed by the model as a tool
  // argument would land in the model context. Refuse loudly — the password is
  // always entered by the user through the UI channel below.
  if (typeof args.dsn === 'string' && String(args.dsn).trim() !== '') {
    return { ok: false, text: currentT('result.noDsnViaModel') }
  }

  // ── non-secret connection facts the Host can assemble (NEVER the password):
  //    model-supplied prefills, completed from an existing (auto/saved) row
  //    for this workspace × env when present — so "password only" is a real
  //    option for environments that already have endpoint metadata.
  const prefill = {}
  for (const k of ['type', 'host', 'port', 'database', 'user']) {
    if (typeof args[k] === 'string' && String(args[k]).trim() !== '') prefill[k] = String(args[k]).trim()
  }
  let existingRow
  try {
    const envs = await resolveWorkspaceEnvs(subprocess, ctx.get('fs'), wsPath, undefined)
    existingRow = envs.find((r) => r.env === envName0) || undefined
  } catch (e) {
    existingRow = undefined
  }
  if (existingRow) {
    const meta = describeConn(existingRow.dsn)
    const un = dsnUser(existingRow.dsn)
    if (!prefill.type && meta.type) prefill.type = meta.type
    if (!prefill.host && meta.host) prefill.host = meta.host
    if (!prefill.port && meta.port) prefill.port = meta.port
    if (!prefill.database && meta.database) prefill.database = meta.database
    if (!prefill.user && un) prefill.user = un
  }
  // "Password only" is offered ONLY when the non-secret set is complete
  // (type/host/database/user; port optional) — otherwise it would persist a
  // mostly-blank DSN that cannot connect.
  const canPasswordOnly = !!(prefill.type && prefill.host && prefill.database && prefill.user)
  const srcId = slug + (envSlug(envName0) ? '_' + envSlug(envName0) : '')

  // ── already-configured environment → verify first, never demand re-entry ──
  // If this workspace × env already has a row (auto or saved) that PASSES a
  // host-side probe, confirmation costs zero input from the user. The dialog
  // only appears when the record is missing or the check fails — and then the
  // first option is "use the existing connection as-is" (no re-entry).
  let existingCheck = undefined // undefined = probe not run / no row
  if (existingRow) {
    existingCheck = await probeResult(subprocess, existingRow.dsn)
    if (existingCheck.ok) {
      return {
        ok: true,
        text: currentT('result.existingOk', {
          env: envName0,
          conn: connLabel(existingRow.dsn),
          srcId,
        }),
      }
    }
  }

  const useExisting = [
    { label: currentT('result.useExisting'), description: currentT('result.useExistingDesc') },
  ]
  const fixOptions = canPasswordOnly
    ? [
        { label: '仅填写密码（其余使用已有连接信息）', description: '最快：只需输入密码' },
        { label: '输入完整 DSN', description: '如 mysql://user:pass@host:3306/db（界面输入，含密码则不再另问）' },
        { label: '填写分项（类型/主机/端口/账号/密码/库名）' },
      ]
    : [
        { label: '输入完整 DSN', description: '如 mysql://user:pass@host:3306/db（界面输入，含密码则不再另问）' },
        { label: '填写分项（类型/主机/端口/账号/密码/库名）' },
      ]
  const newEnvOptions = canPasswordOnly
    ? [
        { label: '仅填写密码（其余使用已有连接信息）', description: '最快：只需输入密码' },
        { label: '输入完整 DSN', description: '如 mysql://user:pass@host:3306/db（界面输入，含密码则不再另问）' },
        { label: '填写分项（类型/主机/端口/账号/密码/库名）' },
        { label: '扫描项目配置文件（需授权，可能读取含密码的文件）' },
      ]
    : [
        { label: '输入完整 DSN', description: '如 mysql://user:pass@host:3306/db（界面输入，含密码则不再另问）' },
        { label: '填写分项（类型/主机/端口/账号/密码/库名）' },
        { label: '扫描项目配置文件（需授权，可能读取含密码的文件）' },
      ]
  // NB: no "取消" option rows — the question dialog already renders its own
  // cancel button; adding one would show two cancels. Dismissing/closed asks
  // resolve to undefined below and are treated as cancel.

  const ans = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'mode',
      header: '配置工作区数据库连接：' + target.title,
      question: existingRow
        ? currentT('result.confExistingBroken', {
            env: envName0,
            conn: connLabel(existingRow.dsn),
            msg: existingCheck ? existingCheck.message : '',
          })
        : canPasswordOnly
          ? currentT('result.confQWithPwd')
          : currentT('result.confQ'),
      options: existingRow ? useExisting.concat(fixOptions) : newEnvOptions,
    },
  ])
  const mode = answerItemOf(ans, 'mode')
  const chosen = mode && mode.selected && mode.selected[0]
  if (!chosen) return { ok: false, text: currentT('result.modeCanceled') }

  if (existingRow && chosen === currentT('result.useExisting')) {
    // No re-entry, no config change — just confirm and let the caller proceed.
    return {
      ok: true,
      text: currentT('result.useExistingOk', {
        env: envName0,
        conn: connLabel(existingRow.dsn),
        srcId,
      }),
    }
  }

  if (canPasswordOnly && chosen === '仅填写密码（其余使用已有连接信息）') {
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, [
      { id: 'password', header: '密码', question: '请输入该连接的密码（不会发送给模型）', options: [] },
    ])
    const item = answerItemOf(ans2, 'password')
    const password = item && item.custom ? String(item.custom).trim() : ''
    if (!password) return { ok: false, text: currentT('result.noDsn') }
    const type = (prefill.type || 'mysql').toLowerCase()
    const host = prefill.host || 'localhost'
    const port = prefill.port || ''
    const database = prefill.database || ''
    const user = prefill.user || ''
    let dsn
    if (type === 'sqlite') dsn = 'sqlite:///' + (prefill.host || 'test.db')
    else dsn = type + '://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@' + host + (port ? ':' + port : '') + '/' + encodeURIComponent(database)
    return persistEnv(ctx, subprocess, wsPath, slug, env, dsn, 'user')
  }

  if (chosen === '输入完整 DSN') {
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, [
      {
        id: 'dsn',
        header: '完整 DSN',
        question: '请输入数据库连接串（若已含密码则提交后不再询问；只在界面输入，不会发送给模型）',
      },
    ])
    const dsn = answerItemOf(ans2, 'dsn')
    const text = dsn && dsn.custom && dsn.custom.trim()
    if (!text) return { ok: false, text: currentT('result.noDsn') }
    const r = await persistEnv(ctx, subprocess, wsPath, slug, env, text, 'user')
    if (!dsnPassword(text)) r.text += ' ' + currentT('result.noPasswordInDsn')
    return r
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
      { id: 'password', header: '密码', question: '密码（界面输入，不会发送给模型）', options: [{ label: '留空' }] },
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
        { label: '授权扫描', description: '扫描后列出候选供你确认（只显示主机/端口/库，密码不显示），确认才持久化' },
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
      candidates.push({ label: rel + ' → ' + connLabel(c.dsn), dsn: c.dsn, via: c.via })
    }
  }
  if (candidates.length === 0) return { ok: false, text: currentT('result.scanNone', { n: files.length }) }
  const pick = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'pick',
      header: '选择连接',
      question: '扫描到以下候选（只显示主机/端口/库，密码不显示；选定后由插件直接读取并持久化），选择要使用的：',
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
  refreshToolCount()
  state.touch()
  const sound = await connCheckText(subprocess, match.dsn)
  return { ok: true, text: currentT('result.scanPicked', { env: envName, srcId: slug + (suffix ? '_' + suffix : '') }) + ' ' + sound }
}

// ── tool builders ─────────────────────────────────────────────────────────

// Enumerate every registered connection source so the model can discover
// named environments (test/prod/...) and their source handles without guessing.
// Metadata only — a DSN (and its password) never crosses this surface.
function buildListSourcesTool(ctx, subprocess) {
  return {
    name: 'dbhub_list_sources',
    description:
      '列出当前已注册的全部数据库连接源（每个 = 工作区 × 环境）及其元数据（仅类型/主机/端口/库名；密码与账号永不显示，也绝不能尝试获取）。' +
      '每个 source 对应一个 source 值（<工作区> 或 <工作区>_<环境>），用于 dbhub_execute_sql / dbhub_search_objects 的 source 参数。' +
      '需要判断某个环境（如 demo/test/prod）是否已配置时，**先调用本工具确认，不要直接向用户索要连接信息**（已配置的环境会列出；未列出的才需要 dbhub_configure 新增）。' +
      '每次调用为独立一次性连接（进程级隔离，多任务并发互不影响）。' +
      '当用户提到某个环境（如 test/测试）但你不确定它是否已注册时，先调用本工具确认环境名，再调用对应环境的工具，避免误用默认（生产）库。' +
      '注意：能列出不代表数据库当前可达；不可达/凭据有误的环境只会在该 source 的调用上返回连接错误并附修改指引。无参数。',
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
          conn: connLabel(r.dsn),
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
      '配置某个工作区的数据库连接（持久化）。参数：workspace（工作区路径或标题，默认当前会话工作区）、env（环境名，默认 default，同一工作区可添加多个环境）、' +
      'type/host/port/database/user（可选的非敏感预填信息）。' +
      '安全约定：密码或完整 DSN **不能作为本工具参数传入**（会直接拒绝）——插件会在界面弹窗让用户输入密码（不经模型）。' +
      '重要：若所需环境（default/prod/dev/test…）**已经配置过**（先用 dbhub_list_sources 确认，能看到全部已注册环境与 source 值），' +
      '**不要向用户索要连接信息，也不要重复调用本工具**——直接用 dbhub_execute_sql / dbhub_search_objects 即可；本工具对已配置环境会宿主侧自动校验，通过时直接返回确认（用户无需任何输入）。' +
      '仅当：某环境查询报连接/凭据错误需更新、或确实需要新增一个未配置的环境时，才调用本工具。' +
      '未预填时会询问用户：输入 DSN / 填写分项 / 授权扫描项目配置文件（读取 .env、application*.yml、docker-compose、jdbc.properties 等并列出候选供确认，密码不出 Host）。' +
      '每个工作区只需配置一次，之后自动持久化；有 mise env/.env 自动配置的工作区无需调用本工具。' +
      '配置保存后插件会宿主侧自动做连接校验，结果（可连通/失败原因）随回执返回：成功了就直接用 dbhub_execute_sql 验证，失败就按原因处理——**不要重复调用本工具向用户索要连接信息**。' +
      '「仅填写密码」只在该环境已具备完整连接信息（类型/主机/库名/账号）时出现，其余情况请让用户用「输入完整 DSN」或「填写分项」。' +
      '当某个 source 的查询因凭据/连接错误失败时，可调用本工具更新该环境的连接（模型只提醒与引导，密码由用户输入）。',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: '工作区路径或标题；默认当前会话工作区' },
        env: { type: 'string', description: '环境名（如 prod/dev/test）；默认 default，多个环境各自拥有独立 source' },
        type: { type: 'string', enum: ['mysql', 'postgres', 'mariadb', 'sqlite', 'sqlserver'], description: '数据库类型（非敏感预填）' },
        host: { type: 'string', description: '主机地址，可省略（默认 localhost）' },
        port: { type: 'string', description: '端口，可省略' },
        database: { type: 'string', description: '数据库名，可省略' },
        user: { type: 'string', description: '用户名，可省略（非敏感；密码绝不能传）' },
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
  // Source tools: ONE declaration per operation, routing by the `source`
  // argument (constant tool count regardless of workspace × env).
  const sourceDefs = [
    {
      name: 'dbhub_execute_sql',
      description:
        '在指定数据源上执行 SQL。source 必填：数据源标识，先调用 dbhub_list_sources 查看全部可用值与对应环境（如 <工作区> 为默认环境，<工作区>_<环境> 为命名环境，例如通过 _test 指向测试库）。' +
        'sql：要执行的 SQL（多语句用 ; 分隔）。' +
        '每次调用为独立一次性连接（进程级隔离：多任务并发互不影响；连接信息含密码由插件在宿主侧解析，结果只标注主机/端口/库）。' +
        '某环境数据库不可达或凭据有误时，仅该次调用返回错误并附「更新凭据」指引（用 dbhub_configure，密码由用户输入）。',
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
        '在指定数据源上搜索数据库对象（表/视图/列/索引等）。source 必填（见 dbhub_list_sources）。' +
        '注意：dbhub 的 search_objects 仅对 sqlite 开放（🔒），MySQL/PostgreSQL 等请用 dbhub_execute_sql 直接查（如 SHOW TABLES）。' +
        '每次调用为独立一次性连接（进程级隔离，多任务并发互不影响）。',
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
  refreshToolCount()
}