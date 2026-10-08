// dsh-dbhub-live: spawn contract of the ONE-SHOT ad-hoc executor (lib/adhoc.mjs).
//
// Every tool call spawns a disposable `dbhub --transport stdio …`, runs one MCP
// call and kills it. These tests pin the two spawn shapes decided per call:
//   · plain connection        → `--dsn <dsn>` (the DSN rides argv);
//   · read-only and/or tunnel → a one-shot generated TOML (`--config <tmp>`)
//                               whose placeholders resolve from the CHILD's
//                               environment, never from the file.
// Also pinned: the temp-file lifecycle (written before the spawn, deleted after
// the call), the probe budget tiers (strictly below the client watchdogs in
// lib/client.js), and dbhub's read-only rejection classifier.
//
// The fake dbhub never answers MCP, so `runAdhoc` resolves `{ ok: false }` by
// design — the assertions are about the SPAWNED SPEC and the files, never about
// a dbhub reply. Test isolation: config.mjs derives the storage dir from
// DSH_HOME at import time, so point it at a temp dir BEFORE importing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-adhoctoml-'))
process.env.DSH_HOME = home
// runtime.mjs prefers a mise-managed dbhub discovered through MISE_DATA_DIR;
// drop it so the fake executable is what every call resolves.
delete process.env.MISE_DATA_DIR

const adhoc = await import('../lib/adhoc.mjs')
const state = await import('../lib/state.mjs')
const { disabledMessage } = await import('../lib/mcp.mjs')
const { DATA_DIR } = await import('../lib/config.mjs')
const { TMP_DIR } = await import('../lib/toml.mjs')

// A fresh DSH_HOME has no credentials.json, so state.mjs starts enabled; make
// that explicit so every spawn test below really reaches the spawn.
if (!state.isEnabled()) state.setEnabled(true)

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── fixtures (loopback / RFC 5737 hosts and CHANGE_ME placeholders only) ────

const DSN = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
const SSH_PASSWORD = { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', password: 'CHANGE_ME' }
const SSH_KEY = { host: '192.0.2.11', port: 2222, user: 'ops', auth: 'key', keyPath: '~/.ssh/id_ed25519', passphrase: 'CHANGE_ME' }

// ── fake host services ─────────────────────────────────────────────────────

/**
 * A recording stand-in for the host `subprocess` service. It never runs a real
 * binary: `spawn` records the exact spec `runAdhoc` passed and returns a handle
 * shaped like the real one (`createMcpClient` needs stdout.on + done; `runAdhoc`
 * awaits waitForExit). The child never answers, so `runAdhoc` settles
 * `{ ok: false }`.
 */
function recorder(opts = {}) {
  const specs = []
  const errors = []
  const exeFor = opts.exeFor || ((name) => '/fake/bin/' + name)
  return {
    specs,
    errors,
    subprocess: {
      resolveExecutable: async (name) => exeFor(name),
      spawn(spec) {
        specs.push(spec)
        const handle = {
          stdin: { write() {} },
          stdout: { on() {} },
          stderr: { on() {} },
          done: Promise.resolve({ exitCode: 0 }),
          terminate() {},
          waitForExit: async () => ({ exitCode: 0 }),
        }
        if (opts.onSpawn) {
          // An assertion thrown here would be swallowed by runAdhoc's own spawn
          // try/catch (it turns any throw into "启动临时 dbhub 失败"), so record
          // it and re-assert after the call has settled.
          try {
            opts.onSpawn(spec, specs.length - 1)
          } catch (e) {
            errors.push(e)
          }
        }
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

// ── state guard ────────────────────────────────────────────────────────────

test('a fresh DSH_HOME starts enabled (runAdhoc refuses to run otherwise)', () => {
  assert.equal(state.isEnabled(), true)
})

test('runAdhoc refuses to spawn while the plugin is disabled', async () => {
  state.setEnabled(false)
  try {
    const { subprocess, specs } = recorder()
    const res = await adhoc.runAdhoc(subprocess, { dsn: DSN }, 'execute_sql', { sql: 'SELECT 1' }, {})
    assert.equal(res.ok, false)
    assert.equal(res.text, disabledMessage())
    assert.equal(specs.length, 0, 'nothing is spawned while the plugin is disabled')
  } finally {
    state.setEnabled(true)
  }
})

// ── shape 1: plain connection → `--dsn` ────────────────────────────────────

test('a plain connection spawns `--dsn <dsn>` and never a generated config', async () => {
  const { subprocess, specs, errors } = recorder()
  const res = await adhoc.runAdhoc(subprocess, { dsn: DSN, ro: false, ssh: null }, 'execute_sql', { sql: 'SELECT 1' }, {})
  assert.deepEqual(errors, [])
  assert.equal(specs.length, 1)
  const spec = specs[0]
  assert.ok(spec.argv.includes('--dsn'), `argv must carry --dsn: ${spec.argv.join(' ')}`)
  assert.ok(spec.argv.includes(DSN), 'the real DSN rides argv on the plain path')
  assert.equal(spec.argv.join(' ').includes('--config'), false, '--dsn and --config are mutually exclusive')
  assert.equal(spec.cwd, DATA_DIR)
  assert.equal(spec.env, undefined, 'a plain call adds no child environment')
  assert.equal(res.ok, false, 'the fake dbhub never answers MCP')
  assert.equal(typeof res.text, 'string')
})

test('a bare DSN string (no options) uses the same plain shape', async () => {
  const { subprocess, specs } = recorder()
  await adhoc.runAdhoc(subprocess, DSN, 'execute_sql', { sql: 'SELECT 1' }, {})
  assert.ok(specs[0].argv.includes('--dsn'))
  assert.ok(specs[0].argv.includes(DSN))
  assert.equal(specs[0].env, undefined)
})

test('a .cmd shim is wrapped by buildSpawnArgv and still carries the DSN', async () => {
  const { subprocess, specs } = recorder({ exeFor: (name) => 'C:/fake/bin/' + name + '.cmd' })
  await adhoc.runAdhoc(subprocess, { dsn: DSN }, 'execute_sql', { sql: 'SELECT 1' }, {})
  const spec = specs[0]
  if (process.platform === 'win32') {
    assert.equal(spec.argv[0], 'cmd.exe', 'a Windows shim needs a cmd shell')
    assert.equal(spec.argv[1], '/c')
  } else {
    assert.equal(spec.argv[0], 'C:/fake/bin/dbhub.cmd', 'POSIX spawns the shim directly')
  }
  assert.ok(spec.argv.join(' ').includes('--dsn'))
  assert.ok(spec.argv.join(' ').includes(DSN))
})

// ── shape 2: read-only / tunnel → generated TOML ───────────────────────────

test('a read-only connection generates a --config file that exists during the spawn', async () => {
  let pathSeen = ''
  let textDuringSpawn = ''
  const { subprocess, specs, errors } = recorder({
    onSpawn: (spec) => {
      assert.equal(spec.argv.includes('--dsn'), false, '--dsn must not be combined with --config')
      pathSeen = argAfter(spec.argv, '--config')
      assert.ok(pathSeen, 'the read-only shape must use --config <path>')
      assert.equal(existsSync(pathSeen), true, 'the generated config exists while dbhub starts')
      textDuringSpawn = readFileSync(pathSeen, 'utf8')
    },
  })
  const res = await adhoc.runAdhoc(
    subprocess, { dsn: DSN, ro: true, ssh: null }, 'search_objects', { object_type: 'table' }, {},
  )
  assert.deepEqual(errors, [], 'all in-spawn assertions held')

  // (a) the TOML replaces dbhub's default tool pair with BOTH tools: `[[tools]]`
  // is a whitelist, so a missing search_objects would kill that tool entirely.
  assert.equal((textDuringSpawn.match(/\[\[tools\]\]/g) || []).length, 2, 'exactly two [[tools]] sections')
  assert.ok(textDuringSpawn.includes('name = "search_objects"'))
  assert.ok(textDuringSpawn.includes('name = "execute_sql"'))
  assert.ok(/readonly\s*=\s*true/.test(textDuringSpawn))

  // (b) the file holds placeholders only — no DSN, no password.
  assert.equal(textDuringSpawn.includes(DSN), false, 'the DSN must never be written to the file')
  assert.equal(textDuringSpawn.includes('CHANGE_ME'), false, 'no password in the file')
  assert.ok(textDuringSpawn.includes('${DSH_DBHUB_SEC_DSN}'), 'the DSN is a placeholder')

  // The real value travels in the CHILD's environment instead.
  assert.equal(specs[0].env.DSH_DBHUB_SEC_DSN, DSN)

  // The `finally` cleanup ran: the one-shot file is gone when the call settles.
  assert.ok(pathSeen)
  assert.equal(existsSync(pathSeen), false, 'the generated config is deleted when the call settles')
  assert.deepEqual(generatedTomlLeftovers(), [], 'no generated config is left behind')
  assert.equal(res.ok, false, 'the fake dbhub never answers MCP')
})

test('a tunnelled connection carries its secrets in the child env, merged over process.env', async () => {
  let textDuringSpawn = ''
  const { subprocess, specs, errors } = recorder({
    onSpawn: (spec) => {
      const path = argAfter(spec.argv, '--config')
      textDuringSpawn = readFileSync(path, 'utf8')
    },
  })
  const res = await adhoc.runAdhoc(subprocess, { dsn: DSN, ro: false, ssh: SSH_PASSWORD }, 'execute_sql', { sql: 'SELECT 1' }, {})
  assert.deepEqual(errors, [])
  const spec = specs[0]
  const env = spec.env
  assert.ok(env, 'the tunnel shape must carry a child environment')

  // The two secrets, with the REAL values, in the child's environment.
  assert.equal(env.DSH_DBHUB_SEC_DSN, DSN)
  assert.equal(env.DSH_DBHUB_SEC_SSH_PASSWORD, 'CHANGE_ME')
  assert.equal('DSH_DBHUB_SEC_SSH_PASSPHRASE' in env, false, 'password auth needs no passphrase')

  // Merged, not replaced: every ambient entry survives, and only the two secret
  // names are added.
  for (const key of Object.keys(process.env)) {
    assert.equal(key in env, true, `the ambient ${key} must survive the merge`)
  }
  assert.deepEqual(
    Object.keys(env).filter((k) => !(k in process.env)).sort(),
    ['DSH_DBHUB_SEC_DSN', 'DSH_DBHUB_SEC_SSH_PASSWORD'].sort(),
  )
  assert.equal(env.DSH_HOME, home)

  // The tunnel fields themselves stay in the file; only the secret is a placeholder.
  assert.ok(textDuringSpawn.includes('ssh_host = "192.0.2.10"'))
  assert.ok(textDuringSpawn.includes('ssh_user = "ops"'))
  assert.ok(textDuringSpawn.includes('${DSH_DBHUB_SEC_SSH_PASSWORD}'))
  assert.equal(textDuringSpawn.includes('CHANGE_ME'), false, 'the tunnel password never lands in the file')
  assert.equal(res.ok, false)
})

test('key auth carries the passphrase (never a password variable)', async () => {
  let textDuringSpawn = ''
  const { subprocess, specs, errors } = recorder({
    onSpawn: (spec) => {
      textDuringSpawn = readFileSync(argAfter(spec.argv, '--config'), 'utf8')
    },
  })
  await adhoc.runAdhoc(subprocess, { dsn: DSN, ssh: SSH_KEY }, 'execute_sql', { sql: 'SELECT 1' }, {})
  assert.deepEqual(errors, [])
  const env = specs[0].env
  assert.equal(env.DSH_DBHUB_SEC_DSN, DSN)
  assert.equal(env.DSH_DBHUB_SEC_SSH_PASSPHRASE, 'CHANGE_ME')
  assert.equal('DSH_DBHUB_SEC_SSH_PASSWORD' in env, false)
  // A key PATH is a location, not a secret: it stays a plain TOML value.
  assert.ok(textDuringSpawn.includes('ssh_key = "~/.ssh/id_ed25519"'))
  assert.ok(textDuringSpawn.includes('${DSH_DBHUB_SEC_SSH_PASSPHRASE}'))
})

// ── descriptor helpers ─────────────────────────────────────────────────────

test('normalizeConn/needsToml coerce a bare DSN and keep the descriptor shape', () => {
  assert.deepEqual(adhoc.normalizeConn('  ' + DSN + '  '), { dsn: DSN, ro: false, ssh: null })
  assert.deepEqual(adhoc.normalizeConn(undefined), { dsn: '', ro: false, ssh: null })
  assert.deepEqual(adhoc.normalizeConn(null), { dsn: '', ro: false, ssh: null })
  assert.deepEqual(adhoc.normalizeConn({ dsn: DSN, ro: 'yes' }), { dsn: DSN, ro: false, ssh: null }, 'ro is strict')
  const ssh = { host: '192.0.2.10', user: 'ops', auth: 'password', password: 'CHANGE_ME' }
  assert.deepEqual(adhoc.normalizeConn({ dsn: DSN, ro: true, ssh }), { dsn: DSN, ro: true, ssh })
  assert.equal(adhoc.normalizeConn({ dsn: DSN, ssh: 'nope' }).ssh, null, 'a non-object ssh block is dropped')

  assert.equal(adhoc.needsToml(DSN), false)
  assert.equal(adhoc.needsToml({ dsn: DSN }), false)
  assert.equal(adhoc.needsToml({ dsn: DSN, ro: true }), true)
  assert.equal(adhoc.needsToml({ dsn: DSN, ssh }), true)
  assert.equal(adhoc.needsToml('  ' + DSN + '  '), false)
})

test('secretsOf returns the tunnel secret values and nothing for a plain connection', () => {
  assert.deepEqual(adhoc.secretsOf(DSN), [], 'a bare DSN carries no extra secret')
  assert.deepEqual(adhoc.secretsOf({ dsn: DSN, ro: true }), [], 'read-only adds no secret')
  assert.deepEqual(adhoc.secretsOf({ dsn: DSN, ssh: SSH_PASSWORD }), ['CHANGE_ME'])
  assert.deepEqual(adhoc.secretsOf({ dsn: DSN, ssh: SSH_KEY }), ['CHANGE_ME'])
  assert.deepEqual(adhoc.secretsOf({ dsn: DSN, ssh: { auth: 'key', keyPath: '~/.ssh/id_ed25519' } }), [], 'a key path is not a secret')
  assert.deepEqual(
    adhoc.secretsOf({ dsn: DSN, ssh: { password: 'CHANGE_ME', passphrase: 'CHANGE_ME' } }),
    ['CHANGE_ME', 'CHANGE_ME'],
    'password first, then passphrase',
  )
})

// ── probe budgets vs the client watchdogs ──────────────────────────────────

test('the host probe budgets stay strictly below the client watchdogs', () => {
  assert.equal(adhoc.PROBE_TIMEOUT_MS, 25000)
  assert.equal(adhoc.PROBE_TIMEOUT_SSH_MS, 45000)
  assert.equal(adhoc.hostTimeoutFor(DSN), 25000, 'a bare DSN is a plain connection')
  assert.equal(adhoc.hostTimeoutFor({ dsn: DSN }), 25000)
  assert.equal(adhoc.hostTimeoutFor({ dsn: DSN, ro: true }), 25000, 'read-only alone does not need the SSH tier')
  assert.equal(adhoc.hostTimeoutFor({ dsn: DSN, ssh: SSH_PASSWORD }), 45000)
  assert.equal(adhoc.hostTimeoutFor({ dsn: DSN, ro: true, ssh: SSH_KEY }), 45000)

  // Read the browser budget straight out of the handwritten bundle: the Host
  // must answer before the client gives up on it.
  const clientSrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const watchdog = (name) => {
    const m = new RegExp('\\b' + name + '\\s*=\\s*(\\d+)').exec(clientSrc)
    assert.ok(m, `lib/client.js must declare ${name}`)
    return Number(m[1])
  }
  const PRETEST_WATCHDOG_MS = watchdog('PRETEST_WATCHDOG_MS')
  const PRETEST_WATCHDOG_SSH_MS = watchdog('PRETEST_WATCHDOG_SSH_MS')
  const TEST_WATCHDOG_MS = watchdog('TEST_WATCHDOG_MS')
  const TEST_WATCHDOG_SSH_MS = watchdog('TEST_WATCHDOG_SSH_MS')
  assert.ok(adhoc.PROBE_TIMEOUT_MS < PRETEST_WATCHDOG_MS, `${adhoc.PROBE_TIMEOUT_MS} < ${PRETEST_WATCHDOG_MS}`)
  assert.ok(adhoc.PROBE_TIMEOUT_MS < TEST_WATCHDOG_MS, `${adhoc.PROBE_TIMEOUT_MS} < ${TEST_WATCHDOG_MS}`)
  assert.ok(adhoc.PROBE_TIMEOUT_SSH_MS < PRETEST_WATCHDOG_SSH_MS, `${adhoc.PROBE_TIMEOUT_SSH_MS} < ${PRETEST_WATCHDOG_SSH_MS}`)
  assert.ok(adhoc.PROBE_TIMEOUT_SSH_MS < TEST_WATCHDOG_SSH_MS, `${adhoc.PROBE_TIMEOUT_SSH_MS} < ${TEST_WATCHDOG_SSH_MS}`)
})

test('probeConnection caps the probe per connection tier and reports a one-line failure', async () => {
  // The cap reaches the spawned signal through AbortSignal.timeout; capture it.
  const originalTimeout = AbortSignal.timeout
  const caps = []
  AbortSignal.timeout = (ms) => {
    caps.push(ms)
    return originalTimeout.call(AbortSignal, ms)
  }
  try {
    const plain = recorder()
    const plainRes = await adhoc.probeConnection(plain.subprocess, { dsn: DSN })
    const tunnel = recorder()
    const tunnelRes = await adhoc.probeConnection(tunnel.subprocess, { dsn: DSN, ssh: SSH_PASSWORD })
    assert.deepEqual(plain.errors, [])
    assert.deepEqual(tunnel.errors, [])
    assert.deepEqual(caps, [adhoc.PROBE_TIMEOUT_MS, adhoc.PROBE_TIMEOUT_SSH_MS], 'each tier gets its own host cap')
    assert.equal(tunnel.specs[0].argv.join(' ').includes('--config'), true, 'the tunnelled probe uses the TOML shape')

    for (const res of [plainRes, tunnelRes]) {
      assert.equal(res.ok, false, 'the fake dbhub never answers')
      assert.equal(typeof res.message, 'string')
      assert.ok(res.message.length > 0)
      assert.equal(res.message.includes('\n'), false, 'the report is collapsed to one short line')
      assert.ok(res.message.includes('dbhub exited'), 'the dbhub failure surfaces in the report')
      assert.equal(res.message.includes('CHANGE_ME'), false, 'no secret in the report')
    }
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

// ── dbhub's read-only rejection classifier ─────────────────────────────────

test('readOnlyViolation matches dbhub\'s real refusal and not an ordinary auth error', () => {
  assert.equal(adhoc.readOnlyViolation('READONLY_VIOLATION: write statements are not allowed here'), true)
  assert.equal(adhoc.readOnlyViolation('Read-only mode is enabled for this source'), true)
  assert.equal(adhoc.readOnlyViolation('error: readonly_violation'), true)
  assert.equal(adhoc.readOnlyViolation('Access denied for user \'user\'@\'127.0.0.1\' (using password: YES)'), false)
  assert.equal(adhoc.readOnlyViolation('ER_ACCESS_DENIED_ERROR: Access denied'), false)
  assert.equal(adhoc.readOnlyViolation('ECONNREFUSED 127.0.0.1:3306'), false)
  assert.equal(adhoc.readOnlyViolation(''), false)
  assert.equal(adhoc.readOnlyViolation(undefined), false)
  assert.equal(adhoc.readOnlyViolation(null), false)
})
