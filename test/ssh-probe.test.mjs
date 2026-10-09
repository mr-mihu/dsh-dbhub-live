// dsh-dbhub-live: the SSH-layer probe and the failure-attribution helpers.
//
// 5.1.0-dev.3 answers "is it the tunnel or the database?" with five pieces, all
// pinned here (with the measured dbhub 1.4.0 stderr as the fixture):
//   · `diagnosticTail` keeps the informative END of dbhub's output — the fatal
//     line is printed LAST while the banner comes first, and the ~10 `    at …`
//     stack frames that follow it are dropped, so the line NAMING the reason is
//     what survives the 600-character cap;
//   · `missingSshFields` says WHAT is missing, and `failureLayerOf` /
//     `failureLayerLabel` attribute a failure to the plugin, the SSH layer or the
//     database step (and to nothing when no tunnel is set);
//   · `probeSshTunnel` validates ONLY the tunnel: a loopback TCP connect to the
//     bastion port, the local private-key file for key auth, and then a real
//     dbhub connect THROUGH the tunnel to `127.0.0.1:1` (a port that cannot be
//     listening). The evidence is dbhub's own error text: naming the forwarded
//     target without an authentication/handshake wording proves the tunnel
//     carried the connection (`tunnel`), an SSH-layer signature means the tunnel
//     itself is broken (`ssh`), and neither means the answer is honestly
//     `unknown` rather than a guess;
//   · `mergeSshOptions` (lib/config.mjs) implements the browser path's "blank
//     secret = keep the stored value" rule (the UI cannot echo a secret back);
//   · `scrubSecrets` (lib/config.mjs) collapses the WHOLE userinfo of every
//     URL-shaped connection string, because dbhub's banner masks only the
//     password and prints the user name verbatim.
//
// `handleTestOp` (lib/index.mjs) is NOT exported, so its `{op:'test', kind:'ssh'}`
// branch is covered INDIRECTLY: `apply()` wires the HTTP bridge over a fake ctx,
// the op goes in through `POST /op`, and the report comes back in the published
// `testResult` field.
//
// The fake dbhub never answers MCP, so `runAdhoc`/`probeSshTunnel` resolve a
// failure by design — the assertions are about how the canned stderr is
// attributed, never about a dbhub reply.
//
// Test isolation: config.mjs derives the storage dir from DSH_HOME at import
// time, so point it at a temp dir BEFORE importing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-sshprobe-'))
process.env.DSH_HOME = home
// runtime.mjs prefers a mise-managed dbhub discovered through MISE_DATA_DIR;
// drop it so the fake executable is what every call resolves.
delete process.env.MISE_DATA_DIR

const adhoc = await import('../lib/adhoc.mjs')
const cfg = await import('../lib/config.mjs')
const state = await import('../lib/state.mjs')
const index = await import('../lib/index.mjs')
const { BRIDGE_ROUTES } = await import('../lib/bridge.mjs')
const { currentT } = await import('../lib/i18n.mjs')

// ── fixtures (loopback / RFC 5737 hosts and CHANGE_ME placeholders only) ────

const DSN = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
/** A tunnelled descriptor: `conn.ssh` is what turns attribution on. */
const SSH_CONN = {
  dsn: DSN,
  ro: false,
  ssh: { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', password: 'CHANGE_ME' },
}
const STORED_PASSWORD = { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', password: 'CHANGE_ME' }

// MEASURED dbhub 1.4.0 stderr (sanitized: absolute paths and the build hash are
// low-entropy placeholders). A tunnel probe against a closed target, exactly as
// dbhub prints it: the fatal line, ~10 `    at …` frames, then the tunnel-error
// property dbhub sets on that error object (named verbatim in the fixture
// below). Both the attribution and the tail have to survive this shape; dbhub
// masks the password itself with eight stars, but the user name is printed
// verbatim.
const DBHUB_SSH_CAPTURE = [
  'Configuration source: dbhub-1234-1-abc123.toml',
  'Connecting to 1 database source(s)...',
  '  - default: mysql://probe:********@127.0.0.1:1/probe',
  'Fatal error: Error: SSH connection error: connect ECONNREFUSED 127.0.0.1:1',
  '    at Client.onError (file:///opt/dbhub/dist/chunk-ABCDEF.js:399:16)',
  '    at Client.emit (node:events:514:28)',
  '    at Socket.<anonymous> (/opt/dbhub/node_modules/ssh2/lib/client.js:805:12)',
  '    at Socket.emit (node:events:514:28)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {',
  '  __dbhubSSHTunnelError: true',
  '}',
].join('\n')
const STORED_KEY = { host: '192.0.2.10', port: 2222, user: 'ops', auth: 'key', keyPath: '~/.ssh/id_ed25519', passphrase: 'CHANGE_ME' }
const PLUGIN_FAIL = '启动临时 dbhub 失败'

// A fresh DSH_HOME has no credentials.json, so state.mjs starts enabled; make
// that explicit so every probe below really reaches its dbhub step.
if (!state.isEnabled()) state.setEnabled(true)

test.after(async () => {
  for (const server of [...liveServers]) await server.close()
  rmSync(home, { recursive: true, force: true })
})

// ── fake host services ─────────────────────────────────────────────────────

/**
 * A recording stand-in for the host `subprocess` service. It never runs a real
 * binary: `spawn` records the exact spec (`runAdhoc` awaits `waitForExit`) and
 * the canned `stderr` is emitted the moment the MCP client subscribes — which
 * is how `runAdhoc` builds its "[dbhub stderr] …" detail. `spawnThrows` models
 * the plugin-side failure path ("启动临时 dbhub 失败: …").
 */
function recorder(opts = {}) {
  const specs = []
  return {
    specs,
    subprocess: {
      resolveExecutable: async (name) => '/fake/bin/' + name,
      spawn(spec) {
        specs.push(spec)
        if (opts.spawnThrows) throw new Error(String(opts.spawnThrows))
        return {
          stdin: { write() {} },
          stdout: { on() {} },
          stderr: {
            on(event, handler) {
              if (event === 'data' && opts.stderr) handler(opts.stderr)
            },
          },
          done: Promise.resolve({ exitCode: 1 }),
          terminate() {},
          waitForExit: async () => ({ exitCode: 1 }),
        }
      },
    },
  }
}

// ── real loopback listeners ────────────────────────────────────────────────
//
// `tcpReachable` is tested for real. Every server opened here is tracked and
// closed in `test.after` as well as at the end of its own test, so a leaked
// listener can never keep this file from exiting.

const liveServers = new Set()

/** Start a throwaway loopback server on an ephemeral port. */
function listenOnce() {
  return new Promise((resolve, reject) => {
    const sockets = new Set()
    const server = createServer((socket) => {
      // The probe connects and destroys immediately: an ECONNRESET on the
      // server side must never surface as an unhandled 'error' event.
      socket.on('error', () => {})
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const handle = {
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) {
              try {
                socket.destroy()
              } catch (e) {
                /* already gone */
              }
            }
            server.close(() => {
              liveServers.delete(handle)
              done()
            })
          }),
      }
      liveServers.add(handle)
      resolve(handle)
    })
  })
}

/** A port that was just bound and released: connecting to it must fail. */
async function closedPort() {
  const server = await listenOnce()
  const port = server.port
  await server.close()
  return port
}

// ── diagnosticTail ─────────────────────────────────────────────────────────

test('diagnosticTail keeps the END of a diagnostic and trims blank edges', () => {
  const banner = '\n  Configuration source: file  \r\nConnecting to 1 database source…   \n\n\nfatal: access denied\n\n'
  // \r dropped, trailing spaces trimmed per line, leading/trailing blank lines
  // removed — the interior line structure (and indentation) survives.
  assert.equal(
    adhoc.diagnosticTail(banner),
    '  Configuration source: file\nConnecting to 1 database source…\n\n\nfatal: access denied',
  )

  assert.equal(adhoc.diagnosticTail(''), '')
  assert.equal(adhoc.diagnosticTail(undefined), '')
  assert.equal(adhoc.diagnosticTail(null), '')
  assert.equal(adhoc.diagnosticTail('   \n\n  \n'), '', 'whitespace-only output collapses to nothing')
  assert.equal(adhoc.diagnosticTail('one line'), 'one line')
})

test('diagnosticTail drops stack frames so the reason survives the cap', () => {
  // Measured on dbhub 1.4.0: a plain tail-of-N-chars keeps the ~10 `    at …`
  // frames and cuts the very line that names the reason.
  const tail = adhoc.diagnosticTail(DBHUB_SSH_CAPTURE)
  assert.ok(tail.includes('SSH connection error'), tail)
  assert.ok(tail.includes('__dbhubSSHTunnelError: true'), tail, 'the trailing marker survives')
  assert.equal(/\n\s*at /.test(tail), false, 'no stack frame survives')
  assert.equal(tail.includes('.js:'), false, 'frame paths go too')

  // Dropped frames do not eat the cap.
  const padded = '    at Client.onError (file:///opt/dbhub/dist/chunk-ABCDEF.js:399:16)\n'.repeat(40) + DBHUB_SSH_CAPTURE
  const capped = adhoc.diagnosticTail(padded)
  assert.ok(capped.length <= adhoc.DIAG_TAIL_MAX + 1, 'still capped')
  assert.ok(capped.includes('SSH connection error'))
  assert.equal(/\n\s*at /.test(capped), false)
})

test('diagnosticTail cuts from the FRONT once the text exceeds the cap', () => {
  const long = 'A'.repeat(700) + 'END'
  const cut = adhoc.diagnosticTail(long, 100)
  assert.equal(cut, '…' + long.slice(-100))
  assert.equal(cut.length, 101, 'one leading ellipsis plus at most `max` characters')
  assert.ok(cut.startsWith('…'), 'a cut is marked on the side that was dropped')
  assert.ok(cut.endsWith('END'), 'the informative END is what is kept')

  // The default cap is DIAG_TAIL_MAX, and a non-positive/invalid max means "default".
  const big = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n')
  assert.ok(big.length > adhoc.DIAG_TAIL_MAX)
  assert.equal(adhoc.diagnosticTail(big), '…' + big.slice(-adhoc.DIAG_TAIL_MAX))
  assert.equal(adhoc.diagnosticTail(big, 0), '…' + big.slice(-adhoc.DIAG_TAIL_MAX))
  assert.equal(adhoc.diagnosticTail(big, Number.NaN), '…' + big.slice(-adhoc.DIAG_TAIL_MAX))
})

test('the probe constants describe a closed loopback target', () => {
  assert.equal(adhoc.DIAG_TAIL_MAX, 600)
  assert.equal(adhoc.SSH_PROBE_DSN, 'mysql://probe:CHANGE_ME@127.0.0.1:1/probe')
  assert.equal(adhoc.SSH_TCP_TIMEOUT_MS, 5000)
  assert.equal(adhoc.SSH_PROBE_DSN.startsWith('mysql://probe:'), true)
  assert.equal(adhoc.SSH_PROBE_DSN.includes('127.0.0.1:1/'), true, 'port 1 cannot be listening')
})

// ── failure-layer attribution ──────────────────────────────────────────────

test('failureLayerOf is internal for a plugin-side failure, ssh/db for a tunnel', () => {
  // Plugin-side messages win even when a tunnel is configured: they were
  // produced before dbhub could even try the tunnel.
  for (const text of [
    PLUGIN_FAIL + ': spawn refused',
    '生成临时 dbhub 配置失败: bad template',
    '无法获取 dbhub: ENOENT',
    'dsh-dbhub-live 已禁用：所有 dbhub 工具暂不可用。',
  ]) {
    assert.equal(adhoc.failureLayerOf(text, SSH_CONN), 'internal', text)
    assert.equal(adhoc.failureLayerOf(text, DSN), 'internal', text)
  }

  // Every signature the SSH layer is recognized by.
  for (const signature of [
    'All configured authentication methods failed',
    'authentication methods failed',
    'Cannot parse privateKey',
    'Encrypted private key detected',
    'a passphrase is required (no passphrase given)',
    'handshake failed',
    'ssh_host is invalid',
    'ssh_user is invalid',
    'SSH tunnel requires a password',
    'proxy jump is not supported',
    'the jump host is unreachable',
    'ssh2: stream error',
  ]) {
    assert.equal(adhoc.failureLayerOf(signature, SSH_CONN), 'ssh', signature)
  }

  // No SSH signature = the failure happened after the tunnel was up.
  assert.equal(adhoc.failureLayerOf('connect ECONNREFUSED 127.0.0.1:1', SSH_CONN), 'db')
  assert.equal(adhoc.failureLayerOf('Access denied for user', SSH_CONN), 'db')
  assert.equal(adhoc.failureLayerOf('', SSH_CONN), 'db', 'a silent tunnel failure is still attributed to a layer')
  assert.equal(adhoc.failureLayerOf(undefined, SSH_CONN), 'db')

  // No tunnel: no attribution at all, whatever the text says.
  assert.equal(adhoc.failureLayerOf('All configured authentication methods failed', DSN), '')
  assert.equal(adhoc.failureLayerOf('connect ECONNREFUSED 127.0.0.1:1', { dsn: DSN, ro: true, ssh: null }), '')
  assert.equal(adhoc.failureLayerOf('connect ECONNREFUSED 127.0.0.1:1', undefined), '')

  // The measured dbhub 1.4.0 capture: dbhub's own error carries
  // `__dbhubSSHTunnelError: true`, so this IS the SSH layer — and with no
  // tunnel configured there is nothing to attribute.
  assert.equal(adhoc.failureLayerOf(DBHUB_SSH_CAPTURE, { dsn: adhoc.SSH_PROBE_DSN, ssh: SSH_CONN.ssh }), 'ssh')
  assert.equal(adhoc.failureLayerOf(DBHUB_SSH_CAPTURE, { dsn: adhoc.SSH_PROBE_DSN }), '')
})

test('probeSshTunnel agrees with failureLayerOf on the measured capture (no split verdict)', async () => {
  // Regression: the capture's BANNER line names the forwarded target
  // (`- default: mysql://…@127.0.0.1:1/probe`) in EVERY run, so a
  // "names the target ⇒ tunnel is up" rule consulted first turned a real SSH
  // failure into "your tunnel works". The SSH signature must win.
  const server = await listenOnce()
  try {
    const { subprocess } = recorder({ stderr: DBHUB_SSH_CAPTURE })
    const block = { host: '127.0.0.1', port: server.port, user: 'ops', auth: 'password', password: 'CHANGE_ME' }
    const res = await adhoc.probeSshTunnel(subprocess, block)
    assert.equal(res.ok, false, res.message)
    assert.equal(res.layer, 'ssh', res.message)
    assert.equal(adhoc.failureLayerOf(DBHUB_SSH_CAPTURE, { dsn: adhoc.SSH_PROBE_DSN, ssh: block }), 'ssh')
    assert.ok(res.message.includes('SSH connection error'), 'the reason is carried through')
  } finally {
    await server.close()
  }
})

test('failureLayerLabel is a localized prefix, empty when nothing is known', () => {
  assert.equal(adhoc.failureLayerLabel('connect ECONNREFUSED 127.0.0.1:1', SSH_CONN), currentT('result.layerDb'))
  assert.equal(adhoc.failureLayerLabel('All configured authentication methods failed', SSH_CONN), currentT('result.layerSsh'))
  assert.equal(adhoc.failureLayerLabel(PLUGIN_FAIL + ': x', SSH_CONN), currentT('result.layerInternal'))
  assert.equal(adhoc.failureLayerLabel('connect ECONNREFUSED 127.0.0.1:1', DSN), '', 'no tunnel, no prefix')
  for (const key of ['result.layerSsh', 'result.layerDb', 'result.layerInternal']) {
    assert.ok(currentT(key).length > 0, `${key} must be localized`)
  }
})

// ── tcpReachable ───────────────────────────────────────────────────────────

test('tcpReachable succeeds against a live loopback listener and fails once closed', async () => {
  const server = await listenOnce()
  try {
    assert.deepEqual(await adhoc.tcpReachable('127.0.0.1', server.port), { ok: true, code: '' })
  } finally {
    await server.close()
  }
  const miss = await adhoc.tcpReachable('127.0.0.1', server.port)
  assert.equal(miss.ok, false)
  assert.equal(miss.code, 'ECONNREFUSED', 'a released loopback port refuses the connect')
  assert.equal(typeof miss.code, 'string')
})

// ── probeSshTunnel: one case per layer ─────────────────────────────────────

test('probeSshTunnel: an unusable block is settled as `config` without any spawn', async () => {
  const { subprocess, specs } = recorder()
  const blocks = [
    undefined,
    null,
    {},
    { host: '127.0.0.1' },
    { host: '127.0.0.1', user: 'ops' },
    { host: '127.0.0.1', user: 'ops', auth: 'password' },
    { host: '127.0.0.1', user: 'ops', auth: 'key' },
    { host: '127.0.0.1', user: 'ops', auth: 'key', keyPath: 'x', proxyJump: 'a:22,b:22' },
  ]
  for (const bad of blocks) {
    const res = await adhoc.probeSshTunnel(subprocess, bad)
    assert.equal(res.ok, false)
    assert.equal(res.layer, 'config')
    // The answer names WHAT is missing instead of a generic "incomplete" — or, for
    // a complete-but-multi-hop block, the reason normalize actually rejected.
    const missing = adhoc.missingSshFields(bad)
    assert.equal(res.message, missing
      ? currentT('result.sshTestBadConfig', { missing })
      : currentT('result.sshTestMultiHop'))
    assert.equal(res.message.includes('{missing}'), false, 'the placeholder is always resolved')
    // Never a dangling "missing ." sentence.
    assert.equal(res.message.includes('缺少 。'), false, res.message)
  }

  // …and the list itself, spelled out field by field.
  const list = (...keys) => keys.map((key) => currentT(key)).join('、')
  assert.equal(adhoc.missingSshFields({}), list('field.host', 'field.user', 'field.authKind'))
  assert.equal(adhoc.missingSshFields(null), list('field.host', 'field.user', 'field.authKind'))
  assert.equal(adhoc.missingSshFields({ host: '127.0.0.1' }), list('field.user', 'field.authKind'))
  assert.equal(adhoc.missingSshFields({ host: '127.0.0.1', user: 'ops', auth: 'key' }), list('field.keyPath'))
  assert.equal(adhoc.missingSshFields({ host: '127.0.0.1', user: 'ops', auth: 'password' }), list('field.password'))
  assert.equal(
    adhoc.missingSshFields({ host: '127.0.0.1', user: 'ops', auth: 'password', password: 'CHANGE_ME' }),
    '',
    'a complete block is missing nothing',
  )

  assert.equal(specs.length, 0, 'an unusable ssh block never reaches dbhub')
})

test('probeSshTunnel: a closed bastion port is settled as `reach`', async () => {
  const port = await closedPort()
  const { subprocess, specs } = recorder()
  const res = await adhoc.probeSshTunnel(subprocess, { host: '127.0.0.1', port, user: 'ops', auth: 'password', password: 'CHANGE_ME' })
  const code = (await adhoc.tcpReachable('127.0.0.1', port)).code

  assert.equal(res.ok, false)
  assert.equal(res.layer, 'reach')
  assert.equal(res.message, currentT('result.sshTestUnreachable', { host: '127.0.0.1', port: String(port), code }))
  assert.ok(res.message.includes('127.0.0.1'))
  assert.ok(res.message.includes(String(port)))
  assert.equal(specs.length, 0, 'an unreachable bastion is answered before dbhub is spawned')
})

test('probeSshTunnel: key auth checks the local private-key file (`key`)', async () => {
  const server = await listenOnce()
  const keyDir = mkdtempSync(join(tmpdir(), 'dsh-dbhub-nokey-'))
  try {
    // The bastion port is REACHABLE, so this must get past step 1; the key file
    // deliberately does not exist under the temp dir (never a real user path).
    const keyPath = join(keyDir, 'id_ed25519')
    const { subprocess, specs } = recorder()
    const res = await adhoc.probeSshTunnel(subprocess, { host: '127.0.0.1', port: server.port, user: 'ops', auth: 'key', keyPath })

    assert.equal(res.ok, false)
    assert.equal(res.layer, 'key')
    assert.equal(res.message, currentT('result.sshTestKeyMissing', { path: keyPath }))
    assert.ok(res.message.includes('id_ed25519'))
    assert.equal(specs.length, 0, 'a missing key is reported without spawning dbhub')
  } finally {
    rmSync(keyDir, { recursive: true, force: true })
    await server.close()
  }
})

test('probeSshTunnel: an SSH signature from dbhub is `ssh`', async () => {
  const server = await listenOnce()
  try {
    const signature = 'Error: All configured authentication methods failed'
    const { subprocess, specs } = recorder({ stderr: signature })
    const res = await adhoc.probeSshTunnel(subprocess, {
      host: '127.0.0.1', port: server.port, user: 'ops', auth: 'password', password: 'CHANGE_ME',
    })

    assert.equal(specs.length, 1, 'the SSH failure came from a spawned dbhub')
    assert.equal(specs[0].argv.join(' ').includes('--config'), true, 'a tunnel always uses the one-shot TOML shape')
    assert.equal(specs[0].env.DSH_DBHUB_SEC_SSH_PASSWORD, 'CHANGE_ME')
    assert.equal(res.ok, false)
    assert.equal(res.layer, 'ssh')
    const prefix = currentT('result.sshTestAuthFail', { host: '127.0.0.1', port: String(server.port), msg: '' })
    assert.ok(res.message.startsWith(prefix), res.message)
    assert.ok(res.message.includes(signature), 'the dbhub tail is kept for the user')
    assert.equal(res.message.includes('CHANGE_ME'), false, 'no tunnel secret in the report')
  } finally {
    await server.close()
  }
})

test('probeSshTunnel: a database-step failure proves the tunnel (`tunnel`)', async () => {
  const server = await listenOnce()
  try {
    const { subprocess, specs } = recorder({ stderr: 'failed to connect: connect ECONNREFUSED 127.0.0.1:1' })
    const res = await adhoc.probeSshTunnel(subprocess, {
      host: '127.0.0.1', port: server.port, user: 'ops', auth: 'password', password: 'CHANGE_ME',
    })

    assert.equal(specs.length, 1)
    assert.equal(res.ok, true, 'the probe proves the SSH layer, never the database behind it')
    assert.equal(res.layer, 'tunnel')
    assert.equal(res.message, currentT('result.sshTestOk', { host: '127.0.0.1', port: String(server.port) }))
  } finally {
    await server.close()
  }
})

test('probeSshTunnel: an unclassifiable failure is `unknown`, never guessed', async () => {
  const server = await listenOnce()
  try {
    // No SSH signature and no mention of the forwarded `127.0.0.1:1`: nothing is
    // proven either way, and the honest answer is "could not classify".
    const { subprocess, specs } = recorder({ stderr: 'dbhub stopped for an unknown reason' })
    const res = await adhoc.probeSshTunnel(subprocess, {
      host: '127.0.0.1', port: server.port, user: 'ops', auth: 'password', password: 'CHANGE_ME',
    })

    assert.equal(specs.length, 1)
    assert.equal(res.ok, false, 'neither the tunnel nor the database step is proven')
    assert.equal(res.layer, 'unknown')
    const prefix = currentT('result.sshTestUnknown', { host: '127.0.0.1', port: String(server.port), msg: '' })
    assert.ok(res.message.startsWith(prefix), res.message)
    assert.ok(res.message.includes('dbhub stopped for an unknown reason'), 'the raw tail is included')
  } finally {
    await server.close()
  }
})

test('probeSshTunnel: a plugin-side spawn failure is `internal`', async () => {
  const server = await listenOnce()
  try {
    const { subprocess, specs } = recorder({ spawnThrows: 'spawn refused' })
    const res = await adhoc.probeSshTunnel(subprocess, {
      host: '127.0.0.1', port: server.port, user: 'ops', auth: 'password', password: 'CHANGE_ME',
    })

    assert.equal(specs.length, 1, 'the spawn was attempted and refused')
    assert.equal(res.ok, false)
    assert.equal(res.layer, 'internal')
    assert.ok(res.message.includes(currentT('result.sshTestInternal', { msg: '' })), res.message)
    assert.ok(res.message.includes(PLUGIN_FAIL + ': spawn refused'), res.message)
  } finally {
    await server.close()
  }
})

// ── mergeSshOptions: "blank secret = keep the stored value" ────────────────

test('mergeSshOptions keeps the stored password when the form sends a blank one', () => {
  // The card cannot echo a secret back, so a user editing only the host — or
  // pressing "test the tunnel" on a saved row — sends no/blank password.
  const blank = cfg.mergeSshOptions({ host: '127.0.0.1', user: 'ops', auth: 'password', password: '' }, STORED_PASSWORD)
  assert.equal(blank.host, '127.0.0.1', 'non-secret fields overwrite')
  assert.equal(blank.port, 22, 'a blank port falls back to the stored one')
  assert.equal(blank.user, 'ops')
  assert.equal(blank.password, 'CHANGE_ME', 'the stored secret is kept')

  const omitted = cfg.mergeSshOptions({ host: '127.0.0.1', user: 'ops', auth: 'password' }, STORED_PASSWORD)
  assert.equal(omitted.password, 'CHANGE_ME', 'an omitted secret key behaves like a blank one')

  // Whatever the merge produced must still be a usable block.
  assert.deepEqual(cfg.normalizeSshOptions(blank), {
    host: '127.0.0.1', port: 22, user: 'ops', auth: 'password', password: 'CHANGE_ME',
  })
})

test('mergeSshOptions falls back to the stored value for every blank non-secret field', () => {
  const merged = cfg.mergeSshOptions({ host: '', port: '', user: '', auth: 'password' }, STORED_PASSWORD)
  assert.equal(merged.host, STORED_PASSWORD.host)
  assert.equal(merged.port, STORED_PASSWORD.port)
  assert.equal(merged.user, STORED_PASSWORD.user)
  assert.equal(merged.password, 'CHANGE_ME')
  assert.deepEqual(cfg.normalizeSshOptions(merged), cfg.normalizeSshOptions(STORED_PASSWORD))
})

test('mergeSshOptions drops the other kind\'s secret when the auth kind switches', () => {
  // key → password: the passphrase AND the key path go away.
  const toPassword = cfg.mergeSshOptions(
    { host: '192.0.2.10', user: 'ops', auth: 'password', password: 'CHANGE_ME' },
    STORED_KEY,
  )
  assert.equal('keyPath' in toPassword, false, 'the key path must not survive the switch')
  assert.equal('passphrase' in toPassword, false, 'the passphrase must not survive the switch')
  assert.equal(toPassword.password, 'CHANGE_ME')
  assert.deepEqual(cfg.normalizeSshOptions(toPassword), {
    host: '192.0.2.10', port: 2222, user: 'ops', auth: 'password', password: 'CHANGE_ME',
  })

  // password → key: the password goes away, and the new key path is required.
  const toKey = cfg.mergeSshOptions(
    { host: '192.0.2.10', user: 'ops', auth: 'key', keyPath: '~/.ssh/id_ed25519' },
    STORED_PASSWORD,
  )
  assert.equal('password' in toKey, false, 'the password must not survive the switch')
  assert.equal(toKey.keyPath, '~/.ssh/id_ed25519')
  assert.equal('passphrase' in toKey, false, 'no passphrase was given, none is invented')
  assert.deepEqual(cfg.normalizeSshOptions(toKey), {
    host: '192.0.2.10', port: 22, user: 'ops', auth: 'key', keyPath: '~/.ssh/id_ed25519',
  })

  // The same kind keeps its secret; a switch with nothing stored invents none.
  const sameKind = cfg.mergeSshOptions({ host: '192.0.2.10', user: 'ops', auth: 'key' }, STORED_KEY)
  assert.equal(sameKind.keyPath, '~/.ssh/id_ed25519')
  assert.equal(sameKind.passphrase, 'CHANGE_ME')
  assert.equal('password' in cfg.mergeSshOptions({ host: '192.0.2.10', user: 'ops', auth: 'password' }, null), false)
  assert.equal(cfg.normalizeSshOptions(cfg.mergeSshOptions({ host: '192.0.2.10', user: 'ops', auth: 'password' }, null)), null)
})

test('mergeSshOptions passes a non-object through and keeps a single ProxyJump hop', () => {
  assert.equal(cfg.mergeSshOptions(null, STORED_PASSWORD), null)
  assert.equal(cfg.mergeSshOptions('nope', STORED_PASSWORD), 'nope')
  assert.deepEqual(cfg.mergeSshOptions([], STORED_PASSWORD), [])

  const jumped = cfg.mergeSshOptions(
    { host: '192.0.2.10', user: 'ops', auth: 'password', proxyJump: 'bastion.example.com:22' },
    STORED_PASSWORD,
  )
  assert.equal(jumped.proxyJump, 'bastion.example.com:22')
  assert.equal(cfg.normalizeSshOptions(jumped).proxyJump, 'bastion.example.com:22')
})

test('normalizeSshOptions: defaults, control-character stripping and hard rejects', () => {
  const base = { host: '127.0.0.1', user: 'ops', auth: 'password', password: 'p' }
  assert.deepEqual(cfg.normalizeSshOptions(base), { host: '127.0.0.1', port: 22, user: 'ops', auth: 'password', password: 'p' })
  assert.equal(cfg.normalizeSshOptions({ ...base, port: 'abc' }).port, 22, 'a non-numeric port falls back to 22')
  assert.equal(cfg.normalizeSshOptions({ ...base, port: 70000 }).port, 22, 'an out-of-range port falls back to 22')
  assert.equal(cfg.normalizeSshOptions({ ...base, port: '2222' }).port, 2222)
  assert.equal(
    cfg.normalizeSshOptions({ ...base, host: '127.0.0.1\u0000\u001b', user: 'o\u0007ps' }).user,
    'ops',
    'control characters are stripped, not stored',
  )

  for (const bad of [
    null,
    undefined,
    'nope',
    [],
    { user: 'ops', auth: 'password', password: 'p' },
    { host: '127.0.0.1', auth: 'password', password: 'p' },
    { host: '127.0.0.1', user: 'ops', auth: 'agent', password: 'p' },
    { host: '127.0.0.1', user: 'ops', auth: 'password' },
    { host: '127.0.0.1', user: 'ops', auth: 'key' },
  ]) {
    assert.equal(cfg.normalizeSshOptions(bad), null, JSON.stringify(bad))
  }
})

// ── scrubSecrets ───────────────────────────────────────────────────────────

test('scrubSecrets collapses the whole userinfo of a URL-shaped connection string', () => {
  const out = cfg.scrubSecrets('mysql://root:secret.pw@127.0.0.1:3306/app', 'mysql://root:secret.pw@127.0.0.1:3306/app')
  assert.equal(out, 'mysql://****:****@127.0.0.1:3306/app')
  assert.equal(out.includes('root'), false, 'the user name is a secret too')
  assert.equal(out.includes('secret.pw'), false)
  assert.ok(out.includes('://****:****@'))

  // dbhub's own banner masks only the password (`mysql://root:****@host:3306/db`)
  // — that exact text is what lands in a connection-test diagnostic.
  const banner = cfg.scrubSecrets('Configuration source: mysql://root:****@127.0.0.1:3306/app', undefined)
  assert.equal(banner, 'Configuration source: mysql://****:****@127.0.0.1:3306/app')
  assert.equal(banner.includes('root'), false)

  // The measured capture: dbhub masks the password itself (eight stars) but
  // prints the user name, so the whole userinfo has to collapse. The DATABASE
  // name is metadata and legitimately survives.
  const scrubbed = cfg.scrubSecrets(DBHUB_SSH_CAPTURE, adhoc.SSH_PROBE_DSN)
  assert.ok(scrubbed.includes('  - default: mysql://****:****@127.0.0.1:1/probe'), scrubbed)
  assert.equal(/probe:/.test(scrubbed), false, 'the user name is gone (the database name stays)')
  assert.ok(scrubbed.includes('SSH connection error'), 'the reason is untouched')
})

test('scrubSecrets strips a bare userinfo and leaves a metadata label alone', () => {
  const bare = cfg.scrubSecrets('mysql://ops@127.0.0.1:3306/app', undefined)
  assert.equal(bare, 'mysql://****:****@127.0.0.1:3306/app')
  assert.equal(bare.includes('ops'), false)

  // A DSN without userinfo is a plain metadata label: it must pass through
  // byte for byte (it is exactly the `connLabel` the model already sees).
  const label = 'mysql://127.0.0.1:3306/app'
  assert.equal(cfg.scrubSecrets(label, label), label)
  assert.equal(cfg.scrubSecrets(label, undefined), label)
  assert.equal(cfg.scrubSecrets('postgres://127.0.0.1:5432/app', undefined), 'postgres://127.0.0.1:5432/app')
})

test('scrubSecrets still masks password tokens and every extra secret', () => {
  assert.equal(cfg.scrubSecrets('password=secret.pw and passwd:CHANGE_ME', undefined), 'password=**** and passwd:****')
  assert.equal(cfg.scrubSecrets('pwd=CHANGE_ME', undefined), 'pwd=****')
  assert.equal(cfg.scrubSecrets('mysql://root:secret.pw@127.0.0.1:3306/app', undefined), 'mysql://****:****@127.0.0.1:3306/app')

  // extraSecrets carries what a generated TOML put in the child environment
  // (the SSH login password / key passphrase).
  const text = 'tunnel login used CHANGE_ME for user ops'
  assert.equal(cfg.scrubSecrets(text, undefined, ['CHANGE_ME']), 'tunnel login used **** for user ops')
  assert.equal(cfg.scrubSecrets(text, undefined, ['', null, undefined]), text, 'empty extras are ignored')
})

// ── the handleTestOp SSH branch (indirect: it is not exported) ──────────────

/**
 * The bare minimum `apply(ctx, config)` needs to wire BOTH channels: a tool
 * registry, a workspace registry, one `inject(['settings'])` scope (the legacy
 * namespace) and one `inject(['connection'])` scope whose `fetch.register`
 * records the HTTP routes.
 */
function hostCtx({ subprocess, workspaces }) {
  const tools = []
  const routes = []
  const settings = {
    register: () => ({ replace: async () => {}, watch: () => () => {} }),
    describe: () => [],
  }
  const scopeFor = (names) => {
    const scope = { effect: (fn) => { try { fn() } catch (e) { /* contained */ } return () => {} } }
    if (names.includes('settings')) scope.settings = settings
    if (names.includes('connection')) scope.connection = { fetch: { register: (route) => { routes.push(route) } } }
    return scope
  }
  const ctx = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    get(name) {
      if (name === 'subprocess') return subprocess
      if (name === 'workspaceRegistry') return { list: async () => workspaces }
      if (name === 'fs') return { resolve: async () => { throw new Error('no .env') } }
      return undefined
    },
    inject: (names, callback) => { callback(scopeFor(names)); return () => {} },
    effect: (fn) => { try { fn() } catch (e) { /* contained */ } return () => {} },
    on: () => {},
  }
  return { ctx, tools, routes }
}

/** POST one card command through the bridge route and decode the reply. */
async function postOp(route, op) {
  const response = await route.fetch(new Request('http://127.0.0.1' + BRIDGE_ROUTES.op, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op }),
  }))
  assert.equal(response.status, 200)
  return response.json()
}

test('the {op:"test", kind:"ssh"} branch merges the stored secret and reports via testResult', async () => {
  const WS = 'D:/work/probe'
  assert.equal(typeof index.handleTestOp, 'undefined', 'handleTestOp is internal — this is the indirect path')

  // The saved row carries the secret; the "form" echoes no password back.
  const port = await closedPort()
  cfg.setWorkspaceEnv(WS, 'default', DSN, 'user')
  cfg.setWorkspaceEnv(WS, 'tunnel', DSN, 'user', {
    ssh: { host: '127.0.0.1', port, user: 'ops', auth: 'password', password: 'CHANGE_ME' },
  })
  cfg.setWorkspaceEnv(WS, 'broken', DSN, 'user')

  const { subprocess } = recorder()
  const { ctx, tools, routes } = hostCtx({ subprocess, workspaces: [{ path: WS, title: 'probe' }] })
  await index.apply(ctx, undefined)
  assert.equal(tools.length, 4, 'apply still registers the four constant tools')
  assert.equal(routes.length, 4, 'apply still wires the four bridge routes')
  const opRoute = routes.find((route) => route.path === BRIDGE_ROUTES.op)
  assert.ok(opRoute, 'the /op route must be registered')

  // (a) A saved row whose stored password is not echoed back: the merge makes
  // the block usable, so the probe gets past `config` and reaches the network.
  const first = await postOp(opRoute, {
    op: 'test',
    kind: 'ssh',
    workspace: WS,
    env: 'tunnel',
    nonce: 'probe-1',
    ssh: { host: '127.0.0.1', port, user: 'ops', auth: 'password' },
  })
  assert.deepEqual(first.patches, [], 'an SSH-layer test changes no rows')
  const report = JSON.parse(first.value.testResult)
  assert.equal(report.nonce, 'probe-1', 'the report is addressed to the nonce the card sent')
  assert.equal(report.ok, false)
  const code = (await adhoc.tcpReachable('127.0.0.1', port)).code
  assert.equal(
    report.message,
    currentT('result.sshTestUnreachable', { host: '127.0.0.1', port: String(port), code }),
    'a `config` answer here would mean the stored secret was NOT merged',
  )
  assert.equal(report.message.includes('CHANGE_ME'), false, 'the report never echoes the secret')

  // (b) An incomplete block with no saved ssh row: the branch reports the
  // localized "incomplete configuration" answer (naming the missing fields)
  // instead of probing. The merge turned `{host}` into `{host, port, user:'',
  // auth:''}`, so what is missing is the user and the auth kind.
  const second = await postOp(opRoute, {
    op: 'test', kind: 'ssh', workspace: WS, env: 'broken', nonce: 'probe-2', ssh: { host: '127.0.0.1' },
  })
  const broken = JSON.parse(second.value.testResult)
  assert.equal(broken.nonce, 'probe-2')
  assert.equal(broken.ok, false)
  assert.equal(
    broken.message,
    currentT('result.sshTestBadConfig', { missing: currentT('field.user') + '、' + currentT('field.authKind') }),
  )
  assert.deepEqual(second.patches, [])
})
