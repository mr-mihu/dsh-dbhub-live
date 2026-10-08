// dbhub_configure's options-only path, the §7.5 decision table and the D7
// security asymmetry (lib/tools.mjs runOptionsOnly / pendingOptionsOf):
//
//   * the model may TIGHTEN an environment (readOnly:true) and may NEVER RELAX
//     it — readOnly:false is refused before anything is read or written, and it
//     must not open a dialog either (that would be a social-engineering channel);
//   * an options-only call needs a home for the option: a persisted row, or an
//     auto-discovered row that gets PROMOTED in the same explicit action (D10);
//     with neither, the plugin says so and persists nothing;
//   * options that accompany connection facts ride the SAME store write as the
//     connection, so a same-endpoint call must leave the DSN byte-identical.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-opts-'))
process.env.DSH_HOME = home

// Plain imports = the very singletons lib/tools.mjs uses (see copy-from.test.mjs).
const cfg = await import('../lib/config.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const { currentT } = await import('../lib/i18n.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs?opts=' + Date.now())

// One workspace per case: distinct store keys, so no case can leak into another.
const WS_A = 'D:/work/a' // readOnly:true on an existing row
const WS_B = 'D:/work/b' // readOnly:false — the security red line
const WS_C = 'D:/work/c' // options with no row and no auto-discovery
const WS_D = 'D:/work/d' // auto-discovered -> promoted on an explicit options write
const WS_E = 'D:/work/e' // SSH facts + connection facts keep the original DSN

const REGISTRY = [
  { path: WS_A, title: 'a' },
  { path: WS_B, title: 'b' },
  { path: WS_C, title: 'c' },
  { path: WS_D, title: 'd' },
  { path: WS_E, title: 'e' },
]

const AUTO_ENV = WS_D + '/.env'
const AUTO_DSN = 'mysql://127.0.0.1:3306/auto'

// `mise env` fails IMMEDIATELY (a failed handle settles at once, so no case
// burns the 2.5 s discovery budget), while a dbhub probe completes the MCP
// handshake: the probe-first loop's SUCCESS branches are what cases 1 and 5
// assert (option applied without rebuilding the DSN / without a dialog).
function failHandle() {
  return {
    stdin: { write() {} },
    stdout: { on() {} },
    stderr: { on() {} },
    done: Promise.resolve({ exitCode: 1 }),
    terminate() {},
    waitForExit: async () => ({ exitCode: 1 }),
  }
}
function okHandle() {
  let onData = null
  return {
    stdin: {
      write(chunk) {
        let req
        try {
          req = JSON.parse(String(chunk))
        } catch (e) {
          return
        }
        const result =
          req.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'ok' }] }
            : {
                protocolVersion: '2025-03-26',
                capabilities: {},
                serverInfo: { name: 'fake-dbhub', version: '1.4.0' },
              }
        queueMicrotask(() => {
          if (onData) onData(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
        })
      },
    },
    stdout: {
      on(event, handler) {
        if (event === 'data') onData = handler
      },
    },
    stderr: { on() {} },
    done: new Promise(() => {}), // stays alive: no early settle for a live probe
    terminate() {},
    waitForExit: async () => ({ exitCode: 0 }),
  }
}
const subprocess = {
  resolveExecutable: async (name) => '/nonexistent/' + name,
  spawn: ({ argv }) => (String((argv && argv[0]) || '').includes('dbhub') ? okHandle() : failHandle()),
}

const dialogs = []
const fakeQuestions = {
  ask: async (params) => {
    dialogs.push(params)
    return { answers: [] } // reached at all = an unexpected dialog
  },
}
const fakeFs = {
  resolve: async (name, opts) => {
    if (name === '.env' && opts && opts.cwd === WS_D) return AUTO_ENV
    throw new Error('no .env')
  },
  readText: async (target) => (target === AUTO_ENV ? 'DSN=' + AUTO_DSN + '\n' : ''),
}

const captured = {}
const ctx = {
  tools: {
    register: (def) => {
      captured[def.name] = def
      return () => {}
    },
  },
  get: (name) => {
    if (name === 'userQuestions') return fakeQuestions
    if (name === 'fs') return fakeFs
    if (name === 'workspaceRegistry') return { list: async () => REGISTRY }
    return undefined
  },
  inject: () => {},
}
registerCoreTools(ctx, subprocess)

const execFor = (wsPath) => ({ agent: { session: { header: { cwd: wsPath } } }, signal: undefined })
const configure = (args, wsPath) => captured.dbhub_configure.execute(args, execFor(wsPath))
const rowOf = (wsPath, env) =>
  cfg.listWorkspaceEnvironments(cfg.store).find((r) => r.wsPath === wsPath && r.env === env)

test.before(() => {
  if (!state.isEnabled()) state.setEnabled(true)
  cfg.resetAutoDsnCache()
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('readOnly:true on an existing row tightens the switch with zero dialogs', async () => {
  const dsn = 'mysql://127.0.0.1:3306/a'
  cfg.setWorkspaceEnv(WS_A, 'default', dsn, 'user')
  dialogs.length = 0

  const res = await configure({ readOnly: true }, WS_A)

  assert.equal(res.ok, true, res.text)
  const row = rowOf(WS_A, 'default')
  assert.equal(row.ro, true, 'the read-only flag is persisted')
  assert.equal(row.dsn, dsn, 'an options-only write never touches the DSN')
  assert.equal(row.source, 'user')
  assert.equal(dialogs.length, 0, 'tightening a safety switch needs no user input')
  assert.ok(res.text.includes(currentT('result.readOnlyOn', { env: 'default' })), res.text)
  // The option write still runs the host-side check of the EFFECTIVE connection.
  assert.ok(res.text.includes(currentT('result.savedProbeOk')), res.text)
})

test('readOnly:false is refused and writes nothing (user-only action)', async () => {
  cfg.setWorkspaceEnv(WS_B, 'default', 'mysql://127.0.0.1:3306/b', 'user')
  const snapshot = JSON.stringify(cfg.store[WS_B])
  dialogs.length = 0

  const res = await configure({ readOnly: false }, WS_B)

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.readOnlyUserOnly'))
  assert.equal(
    JSON.stringify(cfg.store[WS_B]),
    snapshot,
    'the store must be byte-identical after a refused relax',
  )
  assert.equal(dialogs.length, 0, 'a refused relax must not even prompt the user')
})

test('options with no row and no auto-discovery are refused with guidance', async () => {
  dialogs.length = 0

  const res = await configure({ readOnly: true }, WS_C)

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.needConnFirst'))
  assert.equal(cfg.store[WS_C], undefined, 'nothing may be persisted without a connection')
  assert.equal(dialogs.length, 0)
})

test('options on an auto-discovered environment promote it to a persisted row', async () => {
  assert.equal(cfg.store[WS_D], undefined, 'precondition: the connection is not persisted')

  const res = await configure({ readOnly: true }, WS_D)

  assert.equal(res.ok, true, res.text)
  const row = rowOf(WS_D, 'default')
  assert.ok(row, 'the promotion must persist the auto-discovered connection')
  assert.equal(row.dsn, AUTO_DSN)
  assert.equal(row.source, 'promoted')
  assert.equal(row.ro, true)
  assert.ok(res.text.includes(currentT('result.promotedNotice')), res.text)
})

test('SSH facts on an existing row keep the original DSN when the endpoint is unchanged', async () => {
  const dsn = 'mysql://u:p@127.0.0.1:3306/e'
  cfg.setWorkspaceEnv(WS_E, 'default', dsn, 'user')
  dialogs.length = 0

  const res = await configure(
    {
      sshHost: 'bastion.example.com',
      sshUser: 'deploy',
      sshAuthKind: 'key',
      sshKeyPath: '~/.ssh/id_ed25519',
      host: '127.0.0.1',
      database: 'e',
    },
    WS_E,
  )

  assert.equal(res.ok, true, res.text)
  const row = rowOf(WS_E, 'default')
  assert.equal(row.dsn, dsn, 'a same-endpoint call must not rebuild the DSN')
  assert.ok(row.ssh, 'the tunnel is persisted with the connection facts')
  assert.equal(row.ssh.host, 'bastion.example.com')
  assert.equal(row.ssh.auth, 'key')
  assert.equal(dialogs.length, 0, 'a model-supplied key path needs no dialog')
  // The unchanged endpoint means the EXISTING row (with its stored password) was
  // verified in place — no re-entry, no rebuilt DSN.
  assert.ok(
    res.text.includes(
      currentT('result.existingOk', {
        env: 'default',
        conn: 'mysql://127.0.0.1:3306/e',
        srcId: mcp.sourceIdOf({ title: 'e', wsPath: WS_E, env: 'default' }),
      }),
    ),
    res.text,
  )
})
