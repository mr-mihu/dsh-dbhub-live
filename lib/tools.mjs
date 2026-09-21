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
  store, listWorkspaces, listWorkspaceEnvironments, resolveWorkspaceEnvs,
  connLabel, describeConn, dsnPassword, dsnUser,
  setWorkspaceEnv, renameWorkspaceEnv, normalizeEnvName,
  likelyAuthOrConnError, buildDsnFromParts, decideConfigureStep, argsChangedEndpoint,
  emptyUserDenied,
} from './config.mjs'
import {
  coreDisposers, refreshToolCount, disabledMessage,
  collectSources, resolveSource, sourceIdOf,
} from './mcp.mjs'
import { runAdhoc, probeConnection } from './adhoc.mjs'
import { walkForCandidates, extractDsnCandidates, askUser, answerItemOf, sessionCwd } from './collect.mjs'
import { currentT } from './i18n.mjs'
import * as state from './state.mjs'

function disabledReply() {
  return { ok: false, text: disabledMessage() }
}

// ── current-workspace resolution ──────────────────────────────────────────
//
// Every workspace owns its connections: the same database configured in two
// workspaces is TWO sources, not one shared connection. Acting on the wrong
// workspace is worse than asking, so this never falls back to "some other
// workspace" — an unresolvable target is reported back instead.

function normalizePath(p) {
  return String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Resolve the CURRENT session workspace: an exact path match first, then the
 * longest registered workspace path that contains the session cwd.
 * @returns `{ workspaces, current, cwd }` (current may be undefined).
 */
async function currentWorkspace(ctx, exec) {
  const workspaces = await listWorkspaces(ctx)
  const cwd = sessionCwd(exec && exec.agent)
  if (!cwd) return { workspaces, current: undefined, cwd }
  const target = normalizePath(cwd)
  const exact = workspaces.find((w) => normalizePath(w.path) === target)
  if (exact) return { workspaces, current: exact, cwd }
  const containing = workspaces
    .filter((w) => target.startsWith(normalizePath(w.path) + '\\') || target.startsWith(normalizePath(w.path) + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return { workspaces, current: containing, cwd }
}

/** Model-facing line for one ambiguous source candidate (metadata only). */
function candidateLine(c) {
  return currentT('result.candidateRow', { srcId: c.id, title: c.title, path: c.path, env: c.env })
}

/** Shared ambiguity reply: never guess between look-alike workspaces. */
function ambiguousReply(ref, ambiguous) {
  return {
    ok: false,
    text: currentT('result.ambiguousSource', {
      src: String(ref || ''),
      list: ambiguous.map(candidateLine).join('\n'),
    }),
  }
}

/** List the workspaces so the model can name one instead of guessing. */
function workspaceListText(workspaces) {
  return workspaces.map((w) => '- ' + w.title + '（' + w.path + '）').join('\n')
}

// One shared body for the source-parameterized tools: resolve the `source`
// handle to a configured connection (DSN stays host-side), strip the routing
// arg, run a one-shot dbhub process, and attach credentials guidance when the
// failure looks like an auth/connect problem. Routing keeps the tool DECLARATION
// count constant no matter how many workspaces × environments exist.
async function runSourceTool(ctx, subprocess, base, args, exec) {
  if (!state.isEnabled()) return disabledReply()
  // The session workspace is the primary key of source resolution: a handle
  // that matches several workspaces resolves to THIS one, and only a genuine
  // tie is bounced back as an ambiguity.
  const { current } = await currentWorkspace(ctx, exec)
  const src = await resolveSource(ctx, subprocess, args.source, { preferredWsPath: current ? current.path : '' })
  if (!src) {
    return {
      ok: false,
      text: currentT('result.noSource', { src: String((args && args.source) || '') }),
    }
  }
  if (src.ambiguous) return ambiguousReply(args && args.source, src.ambiguous)
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

// Localized "✅ reachable / ⚠️ failed" line from a probe outcome.
function probeSoundText(probe) {
  return probe.ok ? currentT('result.savedProbeOk') : currentT('result.savedProbeFail', { msg: probe.message })
}

// Host-side connection check appended to every configure result so the model
// knows immediately whether the saved DSN works (it never has to discover the
// truth by trial-and-error). Probe failures surface the scrubbed reason.
async function connCheckText(subprocess, dsn) {
  return probeSoundText(await probeResult(subprocess, dsn))
}

// Rename a persisted environment in place (model-callable). The connection
// itself does not change, so no credential is re-entered and nothing is
// probed: only the handle the model resolves against changes. Renaming onto an
// existing environment needs the user's confirmation, because it would drop
// that environment's connection.
async function runRename(userQuestions, exec, target, renameFrom, toEnv) {
  const wsPath = target.path
  const from = normalizeEnvName(renameFrom)
  const to = normalizeEnvName(toEnv)
  if (from === to) {
    return {
      ok: true,
      text: currentT('result.renameNoop', {
        env: to,
        srcId: sourceIdOf({ title: target.title, wsPath, env: to }),
      }),
    }
  }
  const persisted = listWorkspaceEnvironments(store).filter((r) => r.wsPath === wsPath)
  const fromRow = persisted.find((r) => r.env === from)
  if (!fromRow) {
    return {
      ok: false,
      text: currentT('result.renameMissing', {
        env: from,
        title: target.title,
        list: persisted.map((r) => r.env).join(', ') || '-',
      }),
    }
  }
  const toRow = persisted.find((r) => r.env === to)
  if (toRow) {
    const ans = await askUser(userQuestions, exec.agent, exec.signal, [
      {
        id: 'overwrite',
        header: currentT('result.renameOverwriteHeader', { title: target.title }),
        question: currentT('result.renameOverwriteQ', { from, to, conn: connLabel(toRow.dsn) }),
        options: [{ label: currentT('result.renameOverwriteOk') }],
      },
    ])
    const picked = answerItemOf(ans, 'overwrite')
    if (!(picked && picked.selected && picked.selected.length)) {
      return { ok: false, text: currentT('result.modeCanceled') }
    }
  }
  const renamed = renameWorkspaceEnv(wsPath, from, to)
  if (!renamed) {
    return { ok: false, text: currentT('result.renameMissing', { env: from, title: target.title, list: '-' }) }
  }
  refreshToolCount()
  state.touch()
  return {
    ok: true,
    text: currentT('result.renameOk', {
      title: target.title,
      from: from,
      to: renamed,
      conn: connLabel(fromRow.dsn),
      srcId: sourceIdOf({ title: target.title, wsPath, env: renamed }),
    }),
  }
}

// Copy an already-configured connection into THIS workspace (model-callable).
// The DSN is read and written host-side only: the model passes a source
// handle, never a connection string, so the copy creates a real local
// connection without any credential crossing the model context. This is the
// sanctioned way to reuse another workspace's connection — using that
// workspace's source handle directly would query a different target.
async function runCopyFrom(ctx, subprocess, target, copyFrom, envName0) {
  const src = await resolveSource(ctx, subprocess, copyFrom, { preferredWsPath: target.path })
  if (!src) return { ok: false, text: currentT('result.noSource', { src: copyFrom }) }
  if (src.ambiguous) return ambiguousReply(copyFrom, src.ambiguous)
  if (src.row.wsPath === target.path && src.row.env === envName0) {
    return { ok: false, text: currentT('result.copySelf', { title: target.title, env: envName0 }) }
  }
  const envName = setWorkspaceEnv(target.path, envName0, src.row.dsn, 'copied')
  refreshToolCount()
  state.touch()
  const sound = await connCheckText(subprocess, src.row.dsn)
  return {
    ok: true,
    text: currentT('result.copiedOk', {
      title: target.title,
      env: envName,
      fromTitle: src.row.title,
      fromEnv: src.row.env,
      conn: connLabel(src.row.dsn),
      srcId: sourceIdOf({ title: target.title, wsPath: target.path, env: envName }),
    }) + ' ' + sound,
  }
}

// Persist one environment and report the resulting source handle. No resident
// server to sync — the next call resolves this row's DSN and spawns on demand.
// state.touch() republishes the settings mirror so a connection configured in
// the chat shows up on the card immediately. A host-side probe runs right
// after saving and its outcome rides the result text; pass `probe` to reuse an
// outcome already computed for the same DSN (avoids double-probing).
async function persistEnv(ctx, subprocess, ws, env, dsn, source, probe) {
  const envName = setWorkspaceEnv(ws.path, env, dsn, source)
  refreshToolCount()
  state.touch()
  const sound = probe ? probeSoundText(probe) : await connCheckText(subprocess, dsn)
  return {
    ok: true,
    text: currentT('result.savedOk', {
      slug: ws.title,
      env: envName,
      srcId: sourceIdOf({ title: ws.title, wsPath: ws.path, env: envName }),
    }) + ' ' + sound,
  }
}

async function runConfigure(ctx, subprocess, args, exec) {
  if (!state.isEnabled()) return disabledReply()
  const userQuestions = ctx.get('userQuestions')
  const { workspaces, current } = await currentWorkspace(ctx, exec)
  // Target workspace: an explicit argument must MATCH (path or title); a bare
  // call targets the session workspace. There is deliberately no "first
  // workspace" fallback — silently configuring someone else's workspace (and
  // then querying it) is exactly the confusion this resolver exists to stop.
  let target
  if (typeof args.workspace === 'string' && args.workspace.trim()) {
    const wanted = args.workspace.trim()
    target = workspaces.find((w) => w.path === wanted || normalizePath(w.path) === normalizePath(wanted))
      || workspaces.find((w) => w.title === wanted)
    if (!target) {
      return {
        ok: false,
        text: currentT('result.unknownWorkspace', { ws: wanted, list: workspaceListText(workspaces) }),
      }
    }
  } else {
    target = current
    if (!target) {
      return {
        ok: false,
        text: currentT('result.needWorkspace', { list: workspaceListText(workspaces) }),
      }
    }
  }
  const wsPath = target.path
  const envName0 = normalizeEnvName(args.env)
  const srcId = sourceIdOf({ title: target.title, wsPath, env: envName0 })

  // Security red line: a password (or full DSN) passed by the model as a tool
  // argument would land in the model context. Refuse loudly — the password is
  // always entered by the user through the UI channel below.
  if (typeof args.dsn === 'string' && String(args.dsn).trim() !== '') {
    return { ok: false, text: currentT('result.noDsnViaModel') }
  }

  // ── environment operations that need no connection facts ─────────────────
  const renameFrom = typeof args.renameFrom === 'string' && args.renameFrom.trim() ? args.renameFrom.trim() : ''
  const copyFrom = typeof args.copyFrom === 'string' && args.copyFrom.trim() ? args.copyFrom.trim() : ''
  if (renameFrom && copyFrom) return { ok: false, text: currentT('result.argConflict') }
  if (renameFrom) return await runRename(userQuestions, exec, target, renameFrom, envName0)
  if (copyFrom) return await runCopyFrom(ctx, subprocess, exec, target, copyFrom, envName0)

  // ── non-secret connection facts the Host can assemble (NEVER the password):
  //    model-supplied prefills, completed from an existing (auto/saved) row
  //    for this workspace × env when present.
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

  // ── probe first, ask only what is actually missing ───────────────────────
  // Two targets:
  //  - the EXISTING row (its real DSN carries the saved password) is verified
  //    when the model didn't change the endpoint;
  //  - when the model names a DIFFERENT endpoint (re-described DB), the old
  //    row is superseded: the probe-first loop re-runs against a candidate
  //    assembled from the new prefills (empty password).
  // Whatever connects without further input is persisted directly — a dialog
  // appears only when the probe says credentials are needed or the non-secret
  // info is incomplete.
  const existingMeta = existingRow ? describeConn(existingRow.dsn) : undefined
  const endpointChanged = argsChangedEndpoint(args, existingMeta)
  const existingTarget = existingRow && !endpointChanged ? existingRow : undefined
  const existingCheck = existingTarget ? await probeResult(subprocess, existingTarget.dsn) : undefined
  const candidateCheck = (!existingTarget && prefill.type && prefill.host && prefill.database && prefill.type.toLowerCase() !== 'sqlite')
    ? await probeResult(subprocess, buildDsnFromParts(prefill))
    : undefined
  const step = decideConfigureStep({ existingRow: existingTarget, existingCheck, prefill, candidateCheck })

  // already-configured environment that passes the probe → zero input needed
  if (step.kind === 'existing-ok') {
    return {
      ok: true,
      text: currentT('result.existingOk', {
        env: envName0,
        conn: connLabel(existingTarget.dsn),
        srcId,
      }),
    }
  }

  // everything the model already knows connects → persist with no dialog
  if (step.kind === 'persist-direct') {
    const dsn = buildDsnFromParts(prefill)
    const envName = setWorkspaceEnv(wsPath, envName0, dsn, 'user')
    refreshToolCount()
    state.touch()
    return {
      ok: true,
      text: currentT('result.autoOk', {
        slug: target.title,
        env: envName,
        conn: connLabel(dsn),
        srcId: sourceIdOf({ title: target.title, wsPath, env: envName }),
      }),
    }
  }

  // only the credentials are missing/stale → ONE minimal account+password
  // dialog (account is asked only when it is unknown; password always). The
  // question carries the connection metadata and the probe diagnosis so the
  // user never re-types what the model already provided; a "wrong connection"
  // escape routes back to the full input options instead of trapping the user.
  if (step.kind === 'ask-credentials') {
    // The question must never re-ask what the model already provided: show the
    // connection metadata (type://host:port/db) it applies to.
    const connMeta = (prefill.type && prefill.host && prefill.database)
      ? connLabel(buildDsnFromParts(prefill))
      : (existingTarget ? connLabel(existingTarget.dsn) : '')
    const diagnosis = (existingCheck && existingCheck.message) || (candidateCheck && candidateCheck.message) || ''
    // When the probe explicitly blames an EMPTY account ("Access denied for
    // user ''@..."), the account is NOT optional: offering a leave-empty choice
    // would re-create exactly the DSN that failed. The question then requires
    // a non-empty account instead of the "use empty account" option.
    const accountRequired = !prefill.user && step.emptyUserDenied === true
    const questions = []
    if (!prefill.user) {
      questions.push({
        id: 'account',
        header: currentT('result.askAccountHeader', { conn: connMeta }),
        question: accountRequired
          ? currentT('result.askAccountRequiredQ', { conn: connMeta })
          : currentT('result.askAccountQ', { conn: connMeta }),
        detail: diagnosis,
        ...(accountRequired ? {} : { options: [{ label: '留空（使用空账号）' }] }),
      })
    }
    questions.push({
      id: 'password',
      header: currentT('result.askPwdHeader', { conn: connMeta }),
      question: currentT('result.askPwdQ', { conn: connMeta }),
      detail: prefill.user ? diagnosis : '',
    })
    questions.push({
      id: 'more',
      header: currentT('result.askCredMoreHeader'),
      question: currentT('result.askCredMoreQ'),
      options: [{ label: currentT('result.askCredMore'), description: currentT('result.askCredMoreDesc') }],
    })
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, questions)
    const moreItem = answerItemOf(ans2, 'more')
    const wantsOther = moreItem && moreItem.selected && moreItem.selected[0] === currentT('result.askCredMore')
    if (!wantsOther) {
      const accountItem = answerItemOf(ans2, 'account')
      const pwdItem = answerItemOf(ans2, 'password')
      // Dialog dismissed / service unavailable → treat as cancel, never as a
      // validation error of the (unanswered) fields below.
      if (!ans2 || !Array.isArray(ans2.answers) || ans2.answers.length === 0) {
        return { ok: false, text: currentT('result.modeCanceled') }
      }
      const account = accountItem ? String(accountItem.custom || '').trim() : ''
      const password = pwdItem ? String(pwdItem.custom || '').trim() : ''
      if (accountRequired && !account) {
        // Saving the empty-account DSN again would reproduce the probe failure.
        return { ok: false, text: currentT('result.askAccountRequired') }
      }
      if (!password) return { ok: false, text: currentT('result.noDsn') }
      const dsn = buildDsnFromParts({ ...prefill, user: prefill.user || account, password })
      // Probe the NEW DSN and reuse the outcome (persistEnv probes only when
      // no probe is passed); an auth-style failure appends the update hint so
      // the model never has to discover it by trial-and-error.
      const probe = await probeResult(subprocess, dsn)
      const r = await persistEnv(ctx, subprocess, target, envName0, dsn, 'user', probe)
      if (!probe.ok && likelyAuthOrConnError(probe.message)) {
        r.text += '\n' + currentT('result.authHint', { src: srcId })
      }
      return r
    }
    // fall through to the mode-selection dialog below (the user says the
    // connection itself is wrong)
  }

  // ── fallback: info incomplete or probe failed non-auth → mode selection ──
  // Options do NOT include a "password only" row anymore: when the probe says
  // only credentials are missing the minimal dialog above already handles it.
  const useExisting = [
    { label: currentT('result.useExisting'), description: currentT('result.useExistingDesc') },
  ]
  const fullOptions = [
    { label: '输入完整 DSN', description: '如 mysql://user:pass@host:3306/db（界面输入，含密码则不再另问）' },
    { label: '填写分项（类型/主机/端口/账号/密码/库名）' },
    { label: '扫描项目配置文件（需授权，可能读取含密码的文件）' },
  ]
  const modeOptions = existingTarget ? useExisting.concat(fullOptions) : fullOptions
  // NB: no "取消" option rows — the question dialog already renders its own
  // cancel button; adding one would show two cancels. Dismissing/closed asks
  // resolve to undefined below and are treated as cancel.

  const ans = await askUser(userQuestions, exec.agent, exec.signal, [
    {
      id: 'mode',
      header: '配置工作区数据库连接：' + target.title,
      question: existingTarget
        ? currentT('result.confExistingBroken', {
            env: envName0,
            conn: connLabel(existingTarget.dsn),
            msg: existingCheck ? existingCheck.message : '',
          })
        : step.failed
          ? currentT('result.confQ') + ' ' + currentT('result.probeFailNote', { msg: candidateCheck ? candidateCheck.message : '' })
          : currentT('result.confQ'),
      options: modeOptions,
    },
  ])
  const mode = answerItemOf(ans, 'mode')
  const chosen = mode && mode.selected && mode.selected[0]
  if (!chosen) return { ok: false, text: currentT('result.modeCanceled') }

  if (existingTarget && chosen === currentT('result.useExisting')) {
    // No re-entry, no config change — just confirm and let the caller proceed.
    return {
      ok: true,
      text: currentT('result.useExistingOk', {
        env: envName0,
        conn: connLabel(existingTarget.dsn),
        srcId,
      }),
    }
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
    const r = await persistEnv(ctx, subprocess, target, envName0, text, 'user')
    if (!dsnPassword(text)) r.text += ' ' + currentT('result.noPasswordInDsn')
    return r
  }

  if (chosen === '填写分项（类型/主机/端口/账号/密码/库名）') {
    // The field form carries every known value so the user only fills the
    // gaps — untouched fields keep the prefill-derived value.
    const ans2 = await askUser(userQuestions, exec.agent, exec.signal, [
      {
        id: 'type',
        header: '类型',
        question: '数据库类型',
        options: [{ label: 'mysql' }, { label: 'postgres' }, { label: 'mariadb' }, { label: 'sqlite' }, { label: 'sqlserver' }],
      },
      { id: 'host', header: '主机', question: currentT('result.askHost', { cur: prefill.host || '（未提供，默认 localhost）' }), options: [{ label: '留空（默认 localhost）' }] },
      { id: 'port', header: '端口', question: currentT('result.askPort', { cur: prefill.port || '（未提供，用默认端口）' }), options: [{ label: '留空' }] },
      { id: 'user', header: '账号', question: currentT('result.askUserField', { cur: prefill.user || '（未提供）' }), options: [{ label: '留空' }] },
      { id: 'password', header: '密码', question: '密码（界面输入，不会发送给模型）', options: [{ label: '留空' }] },
      { id: 'db', header: '库名', question: currentT('result.askDatabase', { cur: prefill.database || '（未提供）' }), options: [{ label: '留空' }] },
    ])
    const pick = (id, fallback) => {
      const item = answerItemOf(ans2, id)
      if (item && item.custom && item.custom.trim()) return item.custom.trim()
      if (item && item.selected && item.selected.length) {
        const s = item.selected[0]
        return s.startsWith('留空') ? '' : s
      }
      return fallback // untouched → keep the prefill-derived value
    }
    const dsn = buildDsnFromParts({
      type: pick('type', prefill.type || 'mysql'),
      host: pick('host', prefill.host || ''),
      port: pick('port', prefill.port || ''),
      user: pick('user', prefill.user || ''),
      password: pick('password', ''),
      database: pick('db', prefill.database || ''),
    })
    return persistEnv(ctx, subprocess, target, envName0, dsn, 'user')
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
  const envName = setWorkspaceEnv(wsPath, envName0, match.dsn, 'collected')
  refreshToolCount()
  state.touch()
  const sound = await connCheckText(subprocess, match.dsn)
  return {
    ok: true,
    text: currentT('result.scanPicked', {
      env: envName,
      srcId: sourceIdOf({ title: target.title, wsPath, env: envName }),
    }) + ' ' + sound,
  }
}

// ── tool builders ─────────────────────────────────────────────────────────

// Enumerate every registered connection source so the model can discover
// named environments (test/prod/...) and their source handles without guessing.
// Metadata only — a DSN (and its password) never crosses this surface.
function buildListSourcesTool(ctx, subprocess) {
  return {
    name: 'dbhub_list_sources',
    description:
      '列出当前已注册的全部数据库连接源，按【工作区】分组（每条 = 一个工作区的某个环境），只给元数据（类型/主机/端口/库名；密码与账号永不显示，也绝不能尝试获取）。' +
      '工作区模型（重要）：**每条 source 只属于一个工作区**。不同工作区即使配置了看起来相同的连接，也是**不同的目标**，绝不能当作同一个来用；返回结果会明确标出【当前工作区】。' +
      '**优先使用当前工作区的 source**（用返回的 source 值调用 dbhub_execute_sql / dbhub_search_objects）。' +
      '仅当当前工作区没有所需连接时才参考其他工作区：先向用户确认能否复用那个连接，确认后调用 dbhub_configure 并传 copyFrom（把该连接复制到当前工作区，连接串与密码不出宿主）——**不要直接用其他工作区的 source 值查询**，那会打到别的目标上。' +
      '需要判断某个环境（如 demo/test/prod/线上）是否已配置时，**先调用本工具确认，不要直接向用户索要连接信息**（已配置的环境会列出；未列出的才需要 dbhub_configure 新增）。' +
      '当同一个名字（同名工作区、或同名环境）在多个工作区都存在时，必须用本工具返回的完整 source 值指定目标，不要用简称猜测。' +
      '注意：能列出不代表数据库当前可达；不可达/凭据有误的环境只会在该 source 的调用上返回连接错误并附修改指引。每次调用为独立一次性连接（进程级隔离，多任务并发互不影响）。无参数。',
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
    async execute(_args, exec) {
      if (!state.isEnabled()) return disabledReply()
      const { rows } = await collectSources(ctx, subprocess)
      if (rows.length === 0) {
        return { ok: true, text: currentT('result.sourcesEmpty') }
      }
      const { current } = await currentWorkspace(ctx, exec)
      // Group by workspace so the model reads the ownership FIRST: a flat list
      // let two workspaces' look-alike connections blur into one another.
      const groups = []
      const byPath = new Map()
      for (const r of rows) {
        let g = byPath.get(r.wsPath)
        if (!g) {
          g = { title: r.title, path: r.wsPath, rows: [] }
          byPath.set(r.wsPath, g)
          groups.push(g)
        }
        g.rows.push(r)
      }
      const localGroup = current ? byPath.get(current.path) : undefined
      const others = groups.filter((g) => !localGroup || g.path !== localGroup.path)
      const rowLine = (r) => currentT('result.srcRow', {
        env: r.env,
        badge: r.persisted ? currentT('result.badgeSaved') : currentT('result.badgeAuto'),
        conn: connLabel(r.dsn),
        src: r.source || '?',
        srcId: sourceIdOf(r),
      })
      const blocks = [currentT('result.sourcesIntro', { n: String(rows.length), m: String(groups.length) })]
      if (localGroup) {
        blocks.push(currentT('result.wsCurrentHead') + '\n' + currentT('result.wsGroup', { title: localGroup.title, path: localGroup.path }) + '\n' + localGroup.rows.map(rowLine).join('\n'))
      } else {
        blocks.push(currentT('result.wsNoCurrent'))
      }
      if (others.length > 0) {
        blocks.push(currentT('result.wsOtherHead') + '\n' + others
          .map((g) => currentT('result.wsGroup', { title: g.title, path: g.path }) + '\n' + g.rows.map(rowLine).join('\n'))
          .join('\n'))
      }
      return { ok: true, text: blocks.join('\n\n') }
    },
  }
}

function buildConfigureTool(ctx, subprocess) {
  return {
    name: 'dbhub_configure',
    description:
      '配置某个工作区的数据库连接（持久化）。参数：workspace（工作区路径或标题，省略 = 当前会话工作区；给错会报错并列出可用工作区，不会替你换一个）、env（环境名，默认 default，支持中文如 线上/测试，同一工作区可添加多个环境）、' +
      'type/host/port/database/user（可选的非敏感预填信息）、renameFrom（改名）、copyFrom（从其他工作区复制连接）。' +
      '工作区模型（重要）：**每条连接只属于一个工作区**，不同工作区的相似连接是不同目标。默认只操作当前会话工作区；需要操作别的工作区时必须显式传 workspace。' +
      '安全约定：密码或完整 DSN **不能作为本工具参数传入**（会直接拒绝）——插件会在界面弹窗让用户输入密码（不经模型）。' +
      '改名：传 env = 新名字 + renameFrom = 旧名字，连接与凭据原样保留（可用于把 default 改成 prod，或把中文/英文环境名互改）；目标环境已存在时会先请用户确认（会覆盖那条连接）。' +
      '复制：传 copyFrom = 其他工作区的 source 值或「工作区/环境名」+ env = 本工作区要创建的环境名，插件在宿主侧把连接复制到当前工作区，连接串与密码不经模型。**其他工作区已配置的连接要复用时，一律走复制，不要直接拿别的工作区的 source 去查询。**' +
      '交互优化：从用户的话里提炼出的类型/主机/端口/库名等非敏感信息，直接作为预填参数传入即可——插件会先在宿主侧自动试连（自动判断是否可用）：' +
      '（1）试连成功 → 直接持久化并返回 source 值，用户无需任何输入；' +
      '（2）试连提示需要凭据 → 弹窗只询问密码（账号未知时一并询问），其余信息自动沿用，不再要求选择输入方式；' +
      '（3）信息不完整或试连因其他原因失败 → 才弹出完整选项（输入 DSN / 填写分项 / 授权扫描项目配置文件）。' +
      '重要：若所需环境（default/prod/dev/test…）**已经配置过**（先用 dbhub_list_sources 确认，能看到全部已注册环境与 source 值），' +
      '**不要向用户索要连接信息，也不要重复调用本工具**——直接用 dbhub_execute_sql / dbhub_search_objects 即可；本工具对已配置环境会宿主侧自动校验，通过时直接返回确认（用户无需任何输入）。' +
      '仅当：某环境查询报连接/凭据错误需更新、或确实需要新增一个未配置的环境时才调用本工具；要复用别的工作区的连接时先用 copyFrom。' +
      '配置保存后插件会宿主侧自动做连接校验，结果（可连通/失败原因）随回执返回：成功了就直接用 dbhub_execute_sql 验证，失败就按原因处理——**不要重复调用本工具向用户索要连接信息**。' +
      '当某个 source 的查询因凭据/连接错误失败时，可调用本工具更新该环境的连接（模型只提醒与引导，密码由用户输入）。',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: '工作区路径或标题；省略 = 当前会话工作区（必须精确匹配，否则报错并列出可用工作区）' },
        env: { type: 'string', description: '环境名（如 prod/dev/test/线上/测试）；默认 default，多个环境各自拥有独立 source；改名时这里传新名字' },
        renameFrom: { type: 'string', description: '把该工作区已存在的环境（旧名字）改名为 env；连接与凭据原样保留，密码不经模型' },
        copyFrom: { type: 'string', description: '要复制的来源：其他工作区的 source 值（或「工作区标题/环境名」「source 值」）；插件在宿主侧复制到本工作区的 env，连接串与密码不经模型' },
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
        '在指定数据源上执行 SQL。source 必填：数据源标识，先调用 dbhub_list_sources 查看全部可用值与对应环境（结果按工作区分组，标出【当前工作区】）。' +
        '工作区规则：每个 source 只属于一个工作区，**优先用当前工作区的 source**；仅当当前工作区没有所需连接时，才先向用户确认并调用 dbhub_configure 的 copyFrom 把其他工作区的连接复制到当前工作区，**不要直接用其他工作区的 source**（那是另一个目标）。' +
        '同名工作区/同名环境同时存在时，必须使用 dbhub_list_sources 返回的完整 source 值。' +
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
        '在指定数据源上搜索数据库对象（表/视图/列/索引等）。source 必填（见 dbhub_list_sources；每条 source 只属于一个工作区，优先用当前工作区的，不要拿其他工作区的 source 当同一个用）。' +
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