// dsh-dbhub-live: ad-hoc temporary connections.
//
// Each call spawns a fresh throwaway `dbhub --transport stdio --dsn <dsn>`,
// runs one MCP tools/call against an ad-hoc target (ip/account/password/db
// supplied by the model per request), then kills it. Independent per call, so
// two parallel calls can query two different databases at once. Nothing is
// persisted and the persistent multi-source server is untouched.

import { DATA_DIR, maskDsn } from './config.mjs'
import { buildSpawnArgv, resolveDbhubExe } from './runtime.mjs'
import { createMcpClient, disabledMessage } from './mcp.mjs'
import { currentT } from './i18n.mjs'
import * as state from './state.mjs'

/**
 * Detect a surfaced DSN whose password was masked (as in the settings-card
 * summaries). The model sometimes copies a masked DSN into `dbhub_query`;
 * connecting with `****` always fails, so refuse loudly with the right path
 * instead of burning an auth round-trip.
 * @param dsn - the ad-hoc DSN string.
 * @returns whether the password position looks masked (`:**…` before @).
 */
export function isMaskedDsn(dsn) {
  return typeof dsn === 'string' && /\/\/[^/@]*:\*{2,}@/.test(dsn)
}

export async function runAdhoc(subprocess, dsn, rawName, mcpArgs, exec) {
  if (!state.isEnabled()) {
    return { ok: false, text: disabledMessage() }
  }
  if (!dsn || typeof dsn !== 'string' || !dsn.trim()) {
    return { ok: false, text: currentT('result.dsnMissing') }
  }
  if (isMaskedDsn(dsn)) {
    return { ok: false, text: currentT('result.masked') }
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
    const prefix = currentT('label.adhocConn', { dsn: maskDsn(dsn) }) + '\n'
    if (res && res.isError) return { ok: false, text: textOf(res) }
    if (res && res.structuredContent !== undefined) {
      return { ok: true, text: prefix + JSON.stringify(res.structuredContent, null, 2) }
    }
    return { ok: true, text: prefix + textOf(res) }
  } catch (e) {
    let detail = String((e && e.message) || e)
    if (stderrTail) detail += '\n[dbhub stderr] ' + stderrTail
    return { ok: false, text: detail }
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