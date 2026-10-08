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

import { DATA_DIR, connLabel, scrubSecrets } from './config.mjs'
import { buildSpawnArgv, resolveDbhubExe } from './runtime.mjs'
import { createMcpClient, disabledMessage } from './mcp.mjs'
import { buildDbhubToml, writeTempToml, removeTempToml } from './toml.mjs'
import { detectDbhubCapabilities } from './capability.mjs'
import { currentT } from './i18n.mjs'
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

/**
 * Connectivity probe for one real connection: a throwaway dbhub + `SELECT 1`.
 * Always resolves to a compact, already-localized `{ ok, message }` report
 * suitable for transient UI feedback (the settings card's connection test).
 * @param subprocess - the host subprocess service.
 * @param conn - the connection descriptor `{ dsn, ro, ssh }` (or a bare DSN).
 * @param timeoutMs - hard cap for the whole probe (the signal also kills the
 *   spawned process when it fires).
 * @returns `{ ok, message }` — message is single-line and length-capped.
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
  // Collapse the (possibly multi-KB stderr tail) failure into one short line.
  let detail = String((res && res.text) || '').replace(/\s+/g, ' ').trim()
  if (detail.length > 180) detail = detail.slice(0, 180) + '…'
  if (!detail) detail = currentT('result.testNoDetail')
  return { ok: false, message: currentT('result.testFail', { msg: detail, ms: String(ms) }) }
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
