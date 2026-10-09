// dsh-dbhub-live: ad-hoc temporary connections.
//
// EVERY tool execution goes through here: each call spawns a fresh throwaway
// `dbhub --transport stdio`, runs one MCP tools/call, then kills it.
// Independent per call, so parallel calls can hit different databases at once
// and a hung/failing process can never take anything else down. Nothing is
// persisted and there is no resident server to maintain. Results and error text
// are scrubbed (scrubSecrets) and labeled with metadata only (connLabel) — a
// password can never reach the model through this layer.
//
// Two spawn shapes, decided per call:
//   · plain connection        → `--dsn <dsn>` (unchanged since 5.0.1, the DB
//                               password rides argv exactly as before);
//   · read-only and/or tunnel → a ONE-SHOT generated TOML (`--config <tmp>`),
//                               because `--dsn` and `--config` are mutually
//                               exclusive and only the TOML dialect carries
//                               `[[tools]] readonly` / the `ssh_*` fields. The
//                               file holds placeholders only; the real secrets
//                               ride the CHILD's environment (see toml.mjs).

import { DATA_DIR, connLabel, scrubSecrets, normalizeSshOptions, expandHome } from './config.mjs'
import { buildSpawnArgv, resolveDbhubExe } from './runtime.mjs'
import { createMcpClient, disabledMessage } from './mcp.mjs'
import { buildDbhubToml, writeTempToml, removeTempToml } from './toml.mjs'
import { detectDbhubCapabilities } from './capability.mjs'
import { currentT } from './i18n.mjs'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import * as state from './state.mjs'

// ── connection descriptor ─────────────────────────────────────────────────
//
// `conn` = `{ dsn, ro, ssh }` is the execution-side view of one environment: the
// real DSN plus its options. A bare DSN string is still accepted (and means "no
// options"), so an unchanged call site keeps working.

/** Coerce a bare DSN or a descriptor into the descriptor shape. */
export function normalizeConn(conn) {
  if (typeof conn === 'string') return { dsn: conn.trim(), ro: false, ssh: null }
  const c = conn && typeof conn === 'object' ? conn : {}
  return {
    dsn: typeof c.dsn === 'string' ? c.dsn.trim() : '',
    ro: c.ro === true,
    ssh: c.ssh && typeof c.ssh === 'object' ? c.ssh : null,
  }
}

/** True when this connection must run through a generated TOML config. */
export function needsToml(conn) {
  const c = normalizeConn(conn)
  return c.ro === true || !!c.ssh
}

/** The secret VALUES a spawned dbhub received (never logged, only scrubbed). */
export function secretsOf(conn) {
  const c = normalizeConn(conn)
  const out = []
  if (c.ssh) {
    if (c.ssh.password) out.push(String(c.ssh.password))
    if (c.ssh.passphrase) out.push(String(c.ssh.passphrase))
  }
  return out
}

// ── probe budgets ─────────────────────────────────────────────────────────
//
// A tunnel probe is slower than a direct one (SSH handshake + forwarded
// connect), so the host-side cap has two tiers. Both stay comfortably BELOW the
// browser watchdog (client.js), which is asserted by test/adhoc-toml.test.mjs.
export const PROBE_TIMEOUT_MS = 25000
export const PROBE_TIMEOUT_SSH_MS = 45000

/** Host-side probe cap for one connection (tunnelled connections get more). */
export function hostTimeoutFor(conn) {
  return needsToml(conn) && normalizeConn(conn).ssh ? PROBE_TIMEOUT_SSH_MS : PROBE_TIMEOUT_MS
}

// dbhub's own read-only rejection (keyword classifier + database read-only mode).
const READONLY_RE = /READONLY_VIOLATION|Read-only mode is enabled/i

/** True when dbhub refused a statement because the environment is read-only. */
export function readOnlyViolation(text) {
  return READONLY_RE.test(String(text || ''))
}

// ── failure attribution on a diagnostic tail ──────────────────────────────
//
// dbhub prints a startup banner FIRST ("Configuration source: …", "Connecting to
// N database source(s)…", the masked DSN) and the actual fatal line LAST. Taking
// the head of that output therefore shows the user everything EXCEPT the reason —
// which is exactly the "I can't tell whether it was the SSH or the DSN" report.
// Keep the END, keep the line structure, and say which layer failed.

/** Characters of dbhub output kept for a failure report. */
export const DIAG_TAIL_MAX = 600

/**
 * The informative END of a multi-line diagnostic: trailing whitespace trimmed,
 * blank runs collapsed, indentation kept so the lines stay readable in the UI.
 *
 * Stack-frame lines are DROPPED: dbhub's fatal error is followed by ~10 `    at …`
 * frames, and a plain tail-of-N-chars then keeps the frames while cutting the very
 * line that names the reason (measured on dbhub 1.4.0, whose output is
 * `Fatal error: Error: SSH connection error: …` + frames + its tunnel-error
 * property). desensitize:allow (that property NAME is dbhub's, not a credential)
 * @returns a string of at most `max` characters (leading ellipsis when cut).
 */
export function diagnosticTail(text, max) {
  const cap = Number.isFinite(max) && max > 0 ? max : DIAG_TAIL_MAX
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line) => !/^\s*at\s/.test(line))
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  let out = lines.join('\n')
  if (out.length > cap) out = '…' + out.slice(-cap)
  return out
}

// Errors dbhub emits BEFORE it can even try the tunnel / the database: they are
// dbhub's own validation of what we generated, so they belong to no layer.
const PLUGIN_FAIL_RE = /(启动临时 dbhub 失败|生成临时 dbhub 配置失败|无法获取 dbhub|已禁用)/
// Signatures that prove the SSH LAYER itself did not come up. The first two are
// MEASURED against dbhub 1.4.0 (real run: `Fatal error: Error: SSH connection
// error: connect ECONNREFUSED …` plus an `__dbhubSSHTunnelError: true` property on
// the error object); the rest are ssh2's own messages. desensitize:allow (this is
// dbhub's error property name, not a credential)
const SSH_LAYER_RE = /(SSH connection error|__dbhubSSHTunnelError|All configured authentication methods failed|authentication methods failed|Cannot parse privateKey|Encrypted private key|no passphrase|handshake|ssh_host|ssh_user|SSH tunnel requires|proxy ?jump|jump host|ssh2)/i

/**
 * Which layer does this failure belong to? Only meaningful when a tunnel is
 * configured; `''` means "no attribution".
 *   'internal' — the plugin could not even start/configure dbhub;
 *   'ssh'      — the SSH layer (handshake / authentication / key) failed;
 *   'db'       — no SSH signature: the database step failed (the tunnel may well
 *                be up — `probeSshTunnel` is what proves that).
 * @returns 'internal' | 'ssh' | 'db' | ''
 */
export function failureLayerOf(text, conn) {
  const c = normalizeConn(conn)
  const s = String(text || '')
  if (PLUGIN_FAIL_RE.test(s)) return 'internal'
  if (c.ssh) return SSH_LAYER_RE.test(s) ? 'ssh' : 'db'
  return ''
}

/** Localized one-line prefix naming the failing layer ('' when unknown). */
export function failureLayerLabel(text, conn) {
  const layer = failureLayerOf(text, conn)
  if (layer === 'ssh') return currentT('result.layerSsh')
  if (layer === 'db') return currentT('result.layerDb')
  if (layer === 'internal') return currentT('result.layerInternal')
  return ''
}

/**
 * Connectivity probe for one real connection: a throwaway dbhub + `SELECT 1`.
 * Always resolves to a compact, already-localized `{ ok, message }` report
 * suitable for transient UI feedback (the settings card's connection test).
 * @param subprocess - the host subprocess service.
 * @param conn - the connection descriptor `{ dsn, ro, ssh }` (or a bare DSN).
 * @param timeoutMs - hard cap for the whole probe (the signal also kills the
 *   spawned process when it fires).
 * @returns `{ ok, message }` — message is length-capped and scrubbed.
 */
export async function probeConnection(subprocess, conn, timeoutMs) {
  const cap = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : hostTimeoutFor(conn)
  const started = Date.now()
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(cap)
    : new AbortController().signal
  let res
  try {
    res = await runAdhoc(subprocess, conn, 'execute_sql', { sql: 'SELECT 1' }, { signal })
  } catch (e) {
    res = { ok: false, text: String((e && e.message) || e) }
  }
  const ms = Date.now() - started
  if (res && res.ok) return { ok: true, message: currentT('result.testOk', { ms: String(ms) }) }
  const tail = diagnosticTail(res && res.text)
  const layer = failureLayerLabel(res && res.text, conn)
  let detail = tail || currentT('result.testNoDetail')
  if (layer) detail = layer + detail
  return { ok: false, message: currentT('result.testFail', { msg: detail, ms: String(ms) }) }
}

// ── SSH-layer-only probe ──────────────────────────────────────────────────
//
// "I can't tell whether the SSH config or the DSN is wrong" is the question this
// answers, in two steps that need no extra dependency:
//
//   1. a plain TCP connect to `ssh_host:ssh_port` from the plugin host — which
//      separates DNS / firewall / closed-port from everything else, and
//      (for key auth) a local check that the private-key file exists;
//   2. a deliberate dbhub connect THROUGH the tunnel to a port that cannot be
//      listening (`127.0.0.1:1`). If what fails is the DATABASE step, the SSH
//      handshake and authentication must have succeeded — the tunnel carried the
//      connection. An SSH-specific error means the tunnel itself is the problem.
//
// Step 2 is not a full SSH session test with a live database behind it, and the
// report says so.

/** The target port step 2 aims at: guaranteed closed, so only the SSH layer matters. */
export const SSH_PROBE_DSN = 'mysql://probe:CHANGE_ME@127.0.0.1:1/probe'
/** The forwarded target the probe's DSN points at (matched inside dbhub's error). */
const SSH_PROBE_TARGET_RE = /127\.0\.0\.1:1(?![0-9])/
/** TCP reachability budget for the bastion. */
export const SSH_TCP_TIMEOUT_MS = 5000

/** A bare TCP connect (no SSH protocol): resolves `{ ok, code }`. */
export function tcpReachable(host, port, timeoutMs) {
  const cap = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SSH_TCP_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let socket = null
    const finish = (value) => {
      if (settled) return
      settled = true
      // The budget timer stays REFERENCED while it matters and is cleared on both
      // paths, so a fast answer never leaves a live handle behind (CI-visible).
      if (timer) clearTimeout(timer)
      try {
        if (socket) socket.destroy()
      } catch (e) {
        /* the socket may already be gone */
      }
      resolve(value)
    }
    try {
      socket = connect({ host, port })
    } catch (e) {
      resolve({ ok: false, code: String((e && e.code) || (e && e.message) || 'ECONNFAIL') })
      return
    }
    timer = setTimeout(() => finish({ ok: false, code: 'ETIMEDOUT' }), cap)
    socket.once('connect', () => finish({ ok: true, code: '' }))
    socket.once('error', (e) => finish({ ok: false, code: String((e && e.code) || 'ECONNFAIL') }))
    socket.once('timeout', () => finish({ ok: false, code: 'ETIMEDOUT' }))
  })
}

/**
 * Which fields of a raw tunnel block are missing? Names them for the user instead
 * of a generic "incomplete" (R64 requires saying WHAT is missing).
 * @returns a localized list ('' when nothing is missing).
 */
export function missingSshFields(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== ''
  const missing = []
  if (!has(s.host)) missing.push(currentT('field.host'))
  if (!has(s.user)) missing.push(currentT('field.user'))
  if (s.auth !== 'password' && s.auth !== 'key') missing.push(currentT('field.authKind'))
  else if (s.auth === 'key' && !has(s.keyPath)) missing.push(currentT('field.keyPath'))
  else if (s.auth === 'password' && !has(s.password)) missing.push(currentT('field.password'))
  return missing.join('、')
}

/**
 * Validate ONLY the SSH layer of one tunnel configuration.
 * @param subprocess - the host subprocess service.
 * @param ssh - the (possibly unsaved) tunnel block.
 * @param timeoutMs - cap for step 2 (step 1 has its own 5 s budget).
 * @returns `{ ok, layer, message }` with an already-localized, scrubbed message.
 */
export async function probeSshTunnel(subprocess, ssh, timeoutMs) {
  const s = normalizeSshOptions(ssh)
  if (!s) {
    const missing = missingSshFields(ssh)
    // Nothing missing but still rejected ⇒ the only other reason
    // `normalizeSshOptions` says no: a multi-hop ProxyJump.
    return {
      ok: false,
      layer: 'config',
      message: missing ? currentT('result.sshTestBadConfig', { missing }) : currentT('result.sshTestMultiHop'),
    }
  }
  const where = { host: s.host, port: String(s.port) }
  // 1) can we even reach the bastion's port?
  const reach = await tcpReachable(s.host, s.port, SSH_TCP_TIMEOUT_MS)
  if (!reach.ok) {
    return { ok: false, layer: 'reach', message: currentT('result.sshTestUnreachable', { host: s.host, port: String(s.port), code: reach.code }) }
  }
  // 2) for key auth, the key file must exist on THIS host (no secret echoed)
  if (s.auth === 'key') {
    let ok = false
    try {
      ok = existsSync(expandHome(s.keyPath))
    } catch (e) {
      ok = false
    }
    if (!ok) return { ok: false, layer: 'key', message: currentT('result.sshTestKeyMissing', { path: s.keyPath }) }
  }
  // 3) let dbhub bring the tunnel up against a closed port
  const cap = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : PROBE_TIMEOUT_SSH_MS
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(cap)
    : new AbortController().signal
  let res
  try {
    res = await runAdhoc(subprocess, { dsn: SSH_PROBE_DSN, ro: false, ssh: s }, 'execute_sql', { sql: 'SELECT 1' }, { signal })
  } catch (e) {
    res = { ok: false, text: String((e && e.message) || e) }
  }
  const text = String((res && res.text) || '')
  const layer = failureLayerOf(text, { dsn: SSH_PROBE_DSN, ssh: s })
  if (res && res.ok) {
    // The closed port answered?! Nothing to attribute — report the tunnel as up.
    return { ok: true, layer: 'tunnel', message: currentT('result.sshTestOk', where) }
  }
  if (layer === 'internal') {
    return { ok: false, layer: 'internal', message: currentT('result.sshTestInternal', { msg: diagnosticTail(text) }) }
  }
  // ORDER MATTERS. An SSH-layer signature is emitted by dbhub/ssh2 only for a
  // tunnel-level problem, so it decides the verdict on its own. The
  // "names the forwarded target" test can only be consulted SECOND, because the
  // startup banner names that target in EVERY run (`- default: mysql://…@target`)
  // — consulting it first made a real SSH failure look like a working tunnel
  // (found by review against the measured capture).
  const namesTarget = SSH_PROBE_TARGET_RE.test(text)
  if (layer === 'ssh') {
    return { ok: false, layer: 'ssh', message: currentT('result.sshTestAuthFail', { host: s.host, port: String(s.port), msg: diagnosticTail(text) }) }
  }
  if (namesTarget) {
    // No SSH signature and the failure is at the forwarded target: the tunnel
    // must have carried the connection.
    return { ok: true, layer: 'tunnel', message: currentT('result.sshTestOk', where) }
  }
  // No signature either way: say so instead of guessing (the tail is included).
  return { ok: false, layer: 'unknown', message: currentT('result.sshTestUnknown', { host: s.host, port: String(s.port), msg: diagnosticTail(text) }) }
}

/**
 * Run ONE MCP tool call against a disposable dbhub process.
 * @param subprocess - host subprocess service.
 * @param conn - `{ dsn, ro, ssh }` (a bare DSN string means "no options").
 * @param rawName - the MCP tool name (`execute_sql` / `search_objects`).
 * @param mcpArgs - the tool arguments.
 * @param exec - `{ signal, agent? }`.
 * @param label - optional pre-localized header line.
 * @returns `{ ok, text }` (already scrubbed and metadata-labelled).
 */
export async function runAdhoc(subprocess, conn, rawName, mcpArgs, exec, label) {
  const c = normalizeConn(conn)
  if (!state.isEnabled()) {
    return { ok: false, text: disabledMessage() }
  }
  if (!c.dsn) {
    return { ok: false, text: currentT('result.dsnMissing') }
  }
  let exe
  try {
    exe = await resolveDbhubExe(subprocess, exec.signal)
  } catch (e) {
    return { ok: false, text: '无法获取 dbhub: ' + String((e && e.message) || e) }
  }
  const useToml = needsToml(c)
  let tomlPath = ''
  let argv
  let childEnv
  if (useToml) {
    // Version guard (D9/R2): an old dbhub either rejects the generated dialect
    // outright or — much worse — silently IGNORES it, which would look like
    // "read-only is on" while every write still goes through. Refuse loudly.
    const cap = detectDbhubCapabilities(exe)
    const wanted = c.ro ? 'readonlyTools' : 'ssh'
    if (cap && cap[wanted] === false) {
      return { ok: false, text: currentT('result.dbhubTooOld', { version: cap.version || 'unknown' }) }
    }
    try {
      const built = buildDbhubToml({ dsn: c.dsn, ro: c.ro, ssh: c.ssh })
      tomlPath = writeTempToml(built.text)
      // Secrets travel in the CHILD's environment; the file only holds `${VAR}`.
      childEnv = { ...process.env, ...built.env }
      argv = ['--transport', 'stdio', '--config', tomlPath]
    } catch (e) {
      removeTempToml(tomlPath)
      return { ok: false, text: '生成临时 dbhub 配置失败: ' + String((e && e.message) || e) }
    }
  } else {
    argv = ['--transport', 'stdio', '--dsn', c.dsn]
  }
  const extraSecrets = secretsOf(c)
  let handle
  try {
    handle = subprocess.spawn({
      argv: buildSpawnArgv(subprocess, exe, argv),
      cwd: DATA_DIR,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      signal: exec.signal,
      ...(childEnv ? { env: childEnv } : {}),
    })
  } catch (e) {
    removeTempToml(tomlPath)
    return { ok: false, text: '启动临时 dbhub 失败: ' + String((e && e.message) || e) }
  }
  let stderrTail = ''
  try {
    const client = createMcpClient(handle, (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000)
    })
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dsh-dbhub-adhoc', version: '3.0.0' },
    })
    client.notify('notifications/initialized')
    const res = await client.request('tools/call', { name: rawName, arguments: mcpArgs })
    const textOf = (r) => {
      if (r && Array.isArray(r.content)) {
        const parts = []
        for (const b of r.content) if (b && typeof b.text === 'string') parts.push(b.text)
        return parts.join('\n')
      }
      return JSON.stringify(r)
    }
    // Zero-knowledge surface: the header carries metadata only (host/port/db),
    // and every line — including dbhub's own error text — is scrubbed before
    // it can reach the model (the SSH password / passphrase included).
    const prefix = (label !== undefined && label !== null
      ? String(label)
      : currentT('label.adhocConn', { dsn: connLabel(c.dsn) })) + '\n'
    if (res && res.isError) return { ok: false, text: prefix + scrubSecrets(textOf(res), c.dsn, extraSecrets) }
    if (res && res.structuredContent !== undefined) {
      return { ok: true, text: prefix + scrubSecrets(JSON.stringify(res.structuredContent, null, 2), c.dsn, extraSecrets) }
    }
    return { ok: true, text: prefix + scrubSecrets(textOf(res), c.dsn, extraSecrets) }
  } catch (e) {
    let detail = String((e && e.message) || e)
    if (stderrTail) detail += '\n[dbhub stderr] ' + stderrTail
    return { ok: false, text: scrubSecrets(detail, c.dsn, extraSecrets) }
  } finally {
    try {
      handle.terminate()
    } catch (e) {
      /* ignore */
    }
    try {
      await handle.waitForExit(exec.signal)
    } catch (e) {
      /* ignore */
    }
    // Best effort: the temp file holds no secret, but it must not accumulate.
    removeTempToml(tomlPath)
  }
}
