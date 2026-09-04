// dsh-dbhub-live: ad-hoc temporary connections.
//
// EVERY tool execution goes through here: each call spawns a fresh throwaway
// `dbhub --transport stdio --dsn <dsn>`, runs one MCP tools/call, then kills
// it. Independent per call, so parallel calls can hit different databases at
// once and a hung/failing process can never take anything else down. Nothing
// is persisted and there is no resident server to maintain. Results and error
// text are scrubbed (scrubSecrets) and labeled with metadata only
// (connLabel) — a password can never reach the model through this layer.

import { DATA_DIR, connLabel, scrubSecrets } from './config.mjs'
import { buildSpawnArgv, resolveDbhubExe } from './runtime.mjs'
import { createMcpClient, disabledMessage } from './mcp.mjs'
import { currentT } from './i18n.mjs'
import * as state from './state.mjs'

/**
 * Connectivity probe for one real DSN: a throwaway dbhub + `SELECT 1`.
 * Always resolves to a compact, already-localized `{ ok, message }` report
 * suitable for transient UI feedback (the settings card's connection test).
 * @param subprocess - the host subprocess service.
 * @param dsn - the REAL (unmasked) DSN to probe.
 * @param timeoutMs - hard cap for the whole probe (default 30s; the signal
 *   also kills the spawned process when it fires).
 * @returns `{ ok, message }` — message is single-line and length-capped.
 */
export async function probeConnection(subprocess, dsn, timeoutMs) {
  const cap = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000
  const started = Date.now()
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(cap)
    : new AbortController().signal
  let res
  try {
    res = await runAdhoc(subprocess, dsn, 'execute_sql', { sql: 'SELECT 1' }, { signal })
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

export async function runAdhoc(subprocess, dsn, rawName, mcpArgs, exec, label) {
  if (!state.isEnabled()) {
    return { ok: false, text: disabledMessage() }
  }
  if (!dsn || typeof dsn !== 'string' || !dsn.trim()) {
    return { ok: false, text: currentT('result.dsnMissing') }
  }
  let exe
  try {
    exe = await resolveDbhubExe(subprocess, exec.signal)
  } catch (e) {
    return { ok: false, text: '无法获取 dbhub: ' + String((e && e.message) || e) }
  }
  let handle
  try {
    handle = subprocess.spawn({
      argv: buildSpawnArgv(subprocess, exe, ['--transport', 'stdio', '--dsn', dsn.trim()]),
      cwd: DATA_DIR,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      signal: exec.signal,
    })
  } catch (e) {
    return { ok: false, text: '启动临时 dbhub 失败: ' + String((e && e.message) || e) }
  }
  let stderrTail = ''
  try {
    const client = createMcpClient(handle, (c) => {
      stderrTail = (stderrTail + String(c)).slice(-2000)
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
    // it can reach the model.
    const prefix = (label !== undefined && label !== null
      ? String(label)
      : currentT('label.adhocConn', { dsn: connLabel(dsn) })) + '\n'
    if (res && res.isError) return { ok: false, text: prefix + scrubSecrets(textOf(res), dsn) }
    if (res && res.structuredContent !== undefined) {
      return { ok: true, text: prefix + scrubSecrets(JSON.stringify(res.structuredContent, null, 2), dsn) }
    }
    return { ok: true, text: prefix + scrubSecrets(textOf(res), dsn) }
  } catch (e) {
    let detail = String((e && e.message) || e)
    if (stderrTail) detail += '\n[dbhub stderr] ' + stderrTail
    return { ok: false, text: scrubSecrets(detail, dsn) }
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
  }
}