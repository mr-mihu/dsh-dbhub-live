// dsh-dbhub-live: request-level robustness of the ONE-SHOT executor (PR-3).
//
// Pins the failure modes that let a single wedged dbhub hang a whole
// conversation round, plus the memory/pipe boundaries that did the same in a
// less obvious way:
//   · no request timer          → a live-but-silent dbhub never settles; the
//                                 caller's `finally` is unreachable, so the child
//                                 and its temp TOML leak until the session ends;
//   · `String(chunk)` decoding  → a multi-byte character split across a 64 KiB
//                                 block became U+FFFD inside the reply;
//   · `buf +=` with no caps     → a quadratic copy (32 MiB single line: 3.6 s of
//                                 synchronous time) and unbounded memory;
//   · number-only response ids  → a `"3"` reply was dropped and the request
//                                 stayed pending forever;
//   · no stdin `'error'` listener → writing into a closed pipe is an uncaught
//                                 exception;
//   · npm with an unread stdout → the install never exits, the single-flight guard
//                                 never clears, dbhub is gone for the session.
//
// Test isolation: config.mjs derives the storage dir from DSH_HOME at import
// time, so point it at a temp dir BEFORE importing. Fixtures follow the
// desensitization convention (loopback host, CHANGE_ME password).

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-mcpclient-'))
process.env.DSH_HOME = home
// runtime.mjs prefers a mise-managed dbhub discovered through MISE_DATA_DIR.
delete process.env.MISE_DATA_DIR

const mcp = await import('../lib/mcp.mjs')
const adhoc = await import('../lib/adhoc.mjs')
const cap = await import('../lib/capability.mjs')
const runtime = await import('../lib/runtime.mjs')
const state = await import('../lib/state.mjs')
const { TMP_DIR } = await import('../lib/toml.mjs')

if (!state.isEnabled()) state.setEnabled(true)

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── fixtures ────────────────────────────────────────────────────────────────

const DSN = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'

/**
 * A child that starts, accepts writes and then says NOTHING — the measured
 * failure mode ("dbhub alive, no reply"). `terminate` is counted because the
 * timeout path must kill it, and `waitForExit` answers like a clean exit.
 */
function silentHandle(exitValue) {
  const stdin = new EventEmitter()
  stdin.write = () => {}
  const handle = {
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    terminated: 0,
    terminate() {
      handle.terminated += 1
    },
    // The host contract answers `false` when the signal was already aborted and
    // the child is still alive; `exitValue` lets a test reproduce that.
    waitForExit: async () => (exitValue === undefined ? { exitCode: 0 } : exitValue),
    // Never settles: nothing but the reply (or a timer) can settle a request.
    done: new Promise(() => {}),
  }
  return handle
}

const replyLine = (obj) => JSON.stringify(obj) + '\n'
const emitJson = (handle, obj) => handle.stdout.emit('data', replyLine(obj))

/** The host `subprocess` service, answering `initialize` and nothing else. */
function quietSubprocess(onCall, exitValue) {
  const handles = []
  return {
    handles,
    subprocess: {
      resolveExecutable: async (name) => '/fake/bin/' + name,
      spawn(spec) {
        const handle = silentHandle(exitValue)
        handle.spec = spec
        handle.stdin.write = (text) => {
          const msg = JSON.parse(String(text).trim())
          if (msg.method === 'initialize') {
            emitJson(handle, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } })
            return
          }
          if (onCall) onCall(handle, msg)
        }
        handles.push(handle)
        return handle
      },
    },
  }
}

/** The value following `flag` in a spawn argv (also handles the cmd.exe /c wrap). */
function argAfter(argv, flag) {
  const at = argv.indexOf(flag)
  if (at >= 0) return argv[at + 1]
  const m = new RegExp(flag.replace(/-/g, '\\-') + '\\s+(?:"([^"]*)"|(\\S+))').exec(argv.join(' '))
  return m ? (m[1] !== undefined ? m[1] : m[2]) : undefined
}

const generatedTomlLeftovers = () =>
  (existsSync(TMP_DIR) ? readdirSync(TMP_DIR) : []).filter((n) => /^dbhub-.*\.toml$/.test(n))

/**
 * Reject loudly instead of hanging: a mutation that removes a timer would
 * otherwise leave the whole suite pending instead of failing.
 */
function withDeadline(promise, ms) {
  let timer = null
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('deadline of ' + ms + 'ms expired — the call never settled')),
      ms,
    )
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// ── P0-7: request-level timeout ────────────────────────────────────────────

test('a silent child rejects the request with MCP_TIMEOUT (method + budget only)', async () => {
  const handle = silentHandle()
  const client = mcp.createMcpClient(handle, null, null)
  const started = Date.now()
  await assert.rejects(
    // 40 ms budget: the shape under test is the timer, not dbhub's speed.
    withDeadline(client.request('tools/call', { name: 'execute_sql', arguments: { sql: 'SELECT 1' } }, { timeoutMs: 40 }), 3000),
    (err) => {
      assert.equal(err.code, 'MCP_TIMEOUT')
      assert.match(err.message, /tools\/call/, 'the message names the method')
      assert.match(err.message, /40/, 'the message names the budget in ms')
      // Zero knowledge: the error is diagnostic only — never the params.
      assert.equal(err.message.includes('SELECT 1'), false)
      assert.equal(err.message.includes('CHANGE_ME'), false)
      return true
    },
  )
  assert.ok(Date.now() - started >= 30, 'the rejection came from the timer')
})

test('runAdhoc kills the silent child on MCP_TIMEOUT and still deletes the temp config', async () => {
  const { subprocess, handles } = quietSubprocess(null)
  const res = await withDeadline(
    adhoc.runAdhoc(
      subprocess,
      { dsn: DSN, ro: true, ssh: null },
      'execute_sql',
      { sql: 'SELECT 1' },
      { mcpTimeoutMs: 40 },
    ),
    5000,
  )
  assert.equal(res.ok, false)
  // The localized report says WHAT happened (no dbhub echo, no params, no DSN).
  assert.ok(res.text.includes('没有回包'), res.text)
  assert.equal(res.text.includes('SELECT 1'), false, 'the report never carries the statement')
  assert.equal(res.text.includes('CHANGE_ME'), false, 'the report never carries the password')
  assert.equal(res.text.includes('mysql://user'), false, 'the report never carries the DSN')

  const handle = handles[0]
  // TWO terminations: the catch kills the wedged child before assembling the
  // report, the `finally` does it again as the unconditional cleanup.
  assert.ok(handle.terminated >= 2, 'a timed-out child is terminated immediately, then by finally')

  // The one-shot config is still removed (the timeout must not skip cleanup).
  const tomlPath = argAfter(handle.spec.argv, '--config')
  assert.ok(tomlPath, 'the read-only shape generated a temp config')
  assert.equal(existsSync(tomlPath), false, 'the temp config is deleted when the call settles')
  assert.deepEqual(generatedTomlLeftovers(), [])
})

// ── P1-10: UTF-8 across block boundaries ───────────────────────────────────

test('a multi-byte character split across two stdout blocks is decoded intact (P1-10)', async () => {
  const handle = silentHandle()
  const client = mcp.createMcpClient(handle, null, null)
  const pending = client.request('tools/call', { name: 'execute_sql' }, { timeoutMs: 2000 })

  const text = '中文结果'
  const buf = Buffer.from(replyLine({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }), 'utf8')
  // Cut INSIDE the first 3-byte character: per-chunk `String(chunk)` decoding
  // produced U+FFFD here.
  const cut = buf.indexOf(Buffer.from('中', 'utf8')) + 1
  assert.ok(cut > 0 && cut < buf.length)
  handle.stdout.emit('data', buf.subarray(0, cut))
  handle.stdout.emit('data', buf.subarray(cut))

  const res = await withDeadline(pending, 2000)
  assert.equal(res.content[0].text, text)
  assert.equal(res.content[0].text.includes('\uFFFD'), false, 'no replacement character in the reply')
})

// ── oversized responses ────────────────────────────────────────────────────

test('an unterminated line beyond MAX_LINE_BYTES rejects with MCP_TOO_LARGE', async () => {
  const handle = silentHandle()
  const client = mcp.createMcpClient(handle, null, null)
  const pending = client.request('tools/call', { name: 'execute_sql' }, { timeoutMs: 5000 })
  // No newline at all: this is the "no boundary, unlimited memory" case.
  handle.stdout.emit('data', 'x'.repeat(mcp.MAX_LINE_BYTES + 1024))
  await assert.rejects(withDeadline(pending, 5000), (err) => {
    assert.equal(err.code, 'MCP_TOO_LARGE')
    assert.equal(err.limitKind, 'line')
    assert.equal(err.limitBytes, mcp.MAX_LINE_BYTES)
    assert.match(err.message, /single line/)
    return true
  })
  // The stream is unusable afterwards: no later request may be served from it.
  await assert.rejects(withDeadline(client.request('tools/call', {}), 2000), (err) => err.code === 'MCP_TOO_LARGE')
})

test('runAdhoc terminates the child and reports an oversized response', async () => {
  const junk = 'x'.repeat(mcp.MAX_LINE_BYTES + 1024)
  const { subprocess, handles } = quietSubprocess((handle) => {
    if (!handle.spec.argv.includes('--config')) return
    handle.stdout.emit('data', junk)
  })
  const res = await withDeadline(
    adhoc.runAdhoc(subprocess, { dsn: DSN, ro: true, ssh: null }, 'execute_sql', { sql: 'SELECT 1' }, {}),
    10000,
  )
  assert.equal(res.ok, false)
  assert.ok(res.text.includes('超出上限'), res.text)
  assert.ok(res.text.includes('8 MiB'), 'the report names the limit: ' + res.text)
  assert.equal(res.text.includes('x'.repeat(64)), false, 'the junk payload is never echoed')
  const handle = handles[0]
  assert.ok(handle.terminated >= 2, 'an oversized response kills the child immediately, then via finally')
  const tomlPath = argAfter(handle.spec.argv, '--config')
  assert.equal(existsSync(tomlPath), false)
})

// ── P2-18: waitForExit may report "still running" ──────────────────────────

test('a child still alive after waitForExit is terminated again and warned about (P2-18)', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    // `false` = the host contract's "signal already aborted, process is still up".
    const { subprocess, handles } = quietSubprocess(null, false)
    const res = await withDeadline(
      adhoc.runAdhoc(subprocess, { dsn: DSN }, 'execute_sql', { sql: 'SELECT 1' }, { mcpTimeoutMs: 40 }),
      5000,
    )
    assert.equal(res.ok, false)
    const handle = handles[0]
    // timeout catch (1) + finally (2) + the "still alive" retry (3).
    assert.ok(handle.terminated >= 3, 'a process reported as still running is terminated once more')
    assert.ok(
      warnings.some((line) => line.includes('仍未结束')),
      'the user is told (once) that the process may still be running: ' + warnings.join(' | '),
    )
    assert.equal(warnings.join(' ').includes('mysql://'), false, 'the warning carries no DSN')
  } finally {
    console.warn = originalWarn
  }
})

// ── P2-30: string response ids ─────────────────────────────────────────────

test('a reply whose id is a STRING still settles the request (P2-30)', async () => {
  const handle = silentHandle()
  const client = mcp.createMcpClient(handle, null, null, { requestTimeoutMs: 1500 })
  const first = client.request('initialize', {})
  const second = client.request('tools/call', { name: 'execute_sql' })
  // dbhub may echo the id as a string; the number-only gate dropped the reply and
  // the request stayed pending until the timer fired.
  emitJson(handle, { jsonrpc: '2.0', id: '1', result: { protocolVersion: '2025-03-26' } })
  emitJson(handle, { jsonrpc: '2.0', id: '2', result: { content: [{ type: 'text', text: 'ok' }] } })
  assert.equal((await withDeadline(first, 1200)).protocolVersion, '2025-03-26')
  assert.equal((await withDeadline(second, 1200)).content[0].text, 'ok')
})

// ── P2-31: stdin error ─────────────────────────────────────────────────────

test('a stdin error settles every pending request and never escapes as uncaught (P2-31)', async () => {
  const handle = silentHandle()
  const client = mcp.createMcpClient(handle, null, null, { requestTimeoutMs: 5000 })
  const a = client.request('initialize', {})
  const b = client.request('tools/call', { name: 'execute_sql' })
  // An EventEmitter 'error' with no listener THROWS: this emit is itself the
  // assertion that createMcpClient attached one.
  handle.stdin.emit('error', new Error('EPIPE'))
  await assert.rejects(withDeadline(a, 1000), /EPIPE/)
  await assert.rejects(withDeadline(b, 1000), /EPIPE/)
})

// ── P2-19: capability detection cache ──────────────────────────────────────

test('capability detection reads the manifest once per executable (P2-19)', () => {
  const managedInstall = (version) => {
    const dir = mkdtempSync(join(home, 'cap-'))
    const pkgDir = join(dir, 'node_modules', '@bytebase', 'dbhub')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@bytebase/dbhub', version }))
    return join(dir, 'node_modules', '.bin', 'dbhub.cmd')
  }
  const exe = managedInstall('1.4.0')
  let reads = 0
  cap.setFsHooks({
    readFileSync(path, encoding) {
      reads += 1
      return readFileSync(path, encoding)
    },
  })
  try {
    const first = cap.detectDbhubCapabilities(exe)
    const second = cap.detectDbhubCapabilities(exe)
    assert.equal(first.version, '1.4.0')
    assert.deepEqual(second, first)
    assert.equal(reads, 1, 'the second detection must be served from the cache')

    // A DIFFERENT executable is a different key: the cache must not be blind.
    assert.equal(cap.detectDbhubCapabilities(managedInstall('0.9.0')).version, '0.9.0')
    assert.equal(reads, 2)
  } finally {
    cap.setFsHooks(null)
  }
})

// ── P2-13: install budget + stdout drain ───────────────────────────────────

test('an npm install that never exits trips the install budget and clears the guard (P2-13)', async () => {
  const handles = []
  let terminated = 0
  const subprocess = {
    resolveExecutable: async () => 'C:/fake/bin/npm.cmd',
    spawn(spec) {
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const handle = {
        spec,
        stdout,
        stderr,
        // npm never exits: exactly what a full, unread stdout pipe produces.
        done: new Promise(() => {}),
        terminate() {
          terminated += 1
        },
      }
      // Push some output through both pipes: with no reader the stdout pipe fills
      // and blocks the writer, which is the hang under test.
      stdout.emit('data', 'npm output '.repeat(512))
      stderr.emit('data', 'npm warning')
      handles.push(handle)
      return handle
    },
  }
  runtime.setInstallTimeoutMs(40)
  try {
    await assert.rejects(withDeadline(runtime.installDbhub(subprocess), 5000), (err) => {
      assert.equal(err.code, 'DBHUB_INSTALL_TIMEOUT')
      assert.match(err.message, /超时/)
      return true
    })
    assert.equal(handles.length, 1)
    assert.ok(terminated >= 1, 'the wedged npm process is terminated')
    assert.equal(handles[0].stdout.listenerCount('data'), 1, 'stdout MUST have a reader')

    // The single-flight guard is cleared in `finally`; otherwise every later call
    // joins a promise that never settles and dbhub stays unavailable.
    await assert.rejects(withDeadline(runtime.installDbhub(subprocess), 5000), /超时/)
    assert.equal(handles.length, 2, 'the second call really retried')
  } finally {
    runtime.setInstallTimeoutMs(0)
  }
})

test('a failed npm install scrubs credentials out of its message', async () => {
  // npm prints the proxy URL it used, and that URL can carry a password. The text
  // ends up in `result.dbhubFetchFailed`, which the MODEL reads — so the tail has
  // to be scrubbed before it is quoted, not merely trimmed.
  const canary = 'CHANGE_ME' + '_NPMTOKEN'
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  let terminated = 0
  const subprocess = {
    resolveExecutable: async () => 'npm',
    spawn: () => {
      const done = new Promise((resolve) => {
        setTimeout(() => {
          stderr.emit('data', 'npm error network https://deploy:' + canary + '@registry.example.invalid/pkg')
          resolve({ exitCode: 1, signal: null })
        }, 5)
      })
      return {
        stdout,
        stderr,
        done,
        terminate() {
          terminated += 1
        },
      }
    },
  }
  await assert.rejects(withDeadline(runtime.installDbhub(subprocess), 5000), (err) => {
    assert.match(err.message, /npm exit 1/)
    assert.ok(!err.message.includes(canary), 'the proxy credential must not reach the message')
    assert.match(err.message, /\*\*\*\*/, 'the userinfo is folded, not dropped silently')
    return true
  })
  assert.ok(terminated >= 1, 'the failed install process is terminated')
})
