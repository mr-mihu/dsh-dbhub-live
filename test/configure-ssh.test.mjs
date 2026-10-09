// dbhub_configure's SSH tunnel surface (lib/tools.mjs resolveSshRequest and the
// options-only write it feeds). §7.5's last rows:
//
//   * the model may NAME a tunnel (host/port/user/auth kind/key path) but never
//     CARRY its secret: a password is collected in a UI dialog, stored host-side,
//     and must not appear in the tool result either;
//   * a model-argument mistake (no user, multi-hop ProxyJump) is refused without
//     a dialog and without a write;
//   * a dismissed dialog cancels the whole call;
//   * sshOff clears ONLY the tunnel: the connection and the safety switch stay.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-ssh-'))
process.env.DSH_HOME = home

// Plain imports = the very singletons lib/tools.mjs uses (see copy-from.test.mjs).
const cfg = await import('../lib/config.mjs')
const state = await import('../lib/state.mjs')
const { currentT } = await import('../lib/i18n.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs?ssh=' + Date.now())

// One workspace per case, so a leaked write can never masquerade as a pass.
const WS_P = 'D:/work/p' // password auth -> dialog -> stored secret
const WS_M = 'D:/work/m' // missing sshUser
const WS_X = 'D:/work/x' // user cancels the dialog
const WS_O = 'D:/work/o' // sshOff keeps DSN + read-only
const WS_J = 'D:/work/j' // multi-hop ProxyJump
const WS_K = 'D:/work/k' // key auth with a model-supplied key path

const REGISTRY = [WS_P, WS_M, WS_X, WS_O, WS_J, WS_K].map((path) => ({
  path,
  title: path.slice(-1),
}))

// Failed probe (exit 1): the option write happens before the probe and its
// outcome is only appended to the reply, so every case asserts store state.
const subprocess = {
  resolveExecutable: async (name) => '/nonexistent/' + name,
  spawn: () => ({
    stdin: { write() {} },
    stdout: { on() {} },
    stderr: { on() {} },
    done: Promise.resolve({ exitCode: 1 }),
    terminate() {},
    waitForExit: async () => ({ exitCode: 1 }),
  }),
}

const dialogs = []
let responder = async () => undefined
const fakeQuestions = {
  ask: async (params) => {
    dialogs.push(params)
    return responder(params)
  },
}
const fakeFs = {
  resolve: async () => {
    throw new Error('no .env')
  },
  readText: async () => '',
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

const HOST = 'bastion.example.com'

test.before(() => {
  if (!state.isEnabled()) state.setEnabled(true)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('a password-auth tunnel stores the user-entered password and never echoes it', async () => {
  cfg.setWorkspaceEnv(WS_P, 'default', 'mysql://u:p@127.0.0.1:3306/p', 'user')
  dialogs.length = 0
  responder = async () => ({ answers: [{ id: 'sshPassword', custom: 'CHANGE_ME' }] })

  const res = await configure(
    { sshHost: HOST, sshUser: 'deploy', sshAuthKind: 'password' },
    WS_P,
  )

  assert.equal(res.ok, true, res.text)
  const row = rowOf(WS_P, 'default')
  assert.ok(row.ssh, 'the tunnel is persisted')
  assert.equal(row.ssh.auth, 'password')
  assert.equal(row.ssh.password, 'CHANGE_ME', 'the dialog secret is stored host-side')
  assert.equal(row.ssh.host, HOST)

  assert.equal(dialogs.length, 1, 'exactly one password dialog')
  assert.equal(dialogs[0].questions[0].id, 'sshPassword')

  // Zero-knowledge surface: the reply may describe the tunnel, never its secret.
  assert.ok(!res.text.includes('CHANGE_ME'), 'the stored password must not be echoed to the model')
  assert.ok(res.text.includes(HOST), res.text)
  assert.ok(res.text.includes('deploy'), res.text)
})

test('an SSH request without a user is refused before anything is written', async () => {
  cfg.setWorkspaceEnv(WS_M, 'default', 'mysql://127.0.0.1:3306/m', 'user')
  const snapshot = JSON.stringify(cfg.store[WS_M])
  dialogs.length = 0
  responder = async () => undefined

  const res = await configure(
    { sshHost: HOST, sshAuthKind: 'key', sshKeyPath: '~/.ssh/id_ed25519' },
    WS_M,
  )

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.sshMissingUser'))
  assert.equal(JSON.stringify(cfg.store[WS_M]), snapshot, 'nothing may be written')
  assert.equal(dialogs.length, 0, 'a missing host/user is a model-argument error, not a dialog')
})

test('a dismissed SSH dialog cancels the call and writes nothing', async () => {
  cfg.setWorkspaceEnv(WS_X, 'default', 'mysql://127.0.0.1:3306/x', 'user')
  const snapshot = JSON.stringify(cfg.store[WS_X])
  dialogs.length = 0
  responder = async () => undefined // the user closed/cancelled the ask

  const res = await configure(
    { sshHost: HOST, sshUser: 'deploy', sshAuthKind: 'password' },
    WS_X,
  )

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.modeCanceled'))
  assert.equal(dialogs.length, 1)
  assert.equal(JSON.stringify(cfg.store[WS_X]), snapshot, 'a cancel writes nothing')
})

test('sshOff removes the tunnel while the DSN and read-only flag survive', async () => {
  const dsn = 'mysql://u:p@127.0.0.1:3306/o'
  cfg.setWorkspaceEnv(WS_O, 'default', dsn, 'user', {
    readOnly: true,
    ssh: {
      host: HOST,
      port: 22,
      user: 'deploy',
      auth: 'key',
      keyPath: '~/.ssh/id_ed25519',
    },
  })

  const res = await configure({ sshOff: true }, WS_O)

  assert.equal(res.ok, true, res.text)
  const entry = cfg.store[WS_O].environments.default
  assert.equal('ssh' in entry, false, 'the ssh field must be DELETED, not blanked')
  assert.equal(entry.dsn, dsn, 'the connection string is untouched')
  assert.equal(entry.readOnly, true, 'the safety switch survives sshOff')

  const row = rowOf(WS_O, 'default')
  assert.equal(row.ssh, null)
  assert.equal(row.ro, true)
  assert.ok(res.text.includes(currentT('result.sshCleared', { env: 'default' })), res.text)
})

test('a multi-hop ProxyJump is refused and nothing is written', async () => {
  cfg.setWorkspaceEnv(WS_J, 'default', 'mysql://127.0.0.1:3306/j', 'user')
  const snapshot = JSON.stringify(cfg.store[WS_J])
  dialogs.length = 0

  const res = await configure(
    {
      sshHost: HOST,
      sshUser: 'deploy',
      sshAuthKind: 'key',
      sshKeyPath: '~/.ssh/id_ed25519',
      sshProxyJump: 'a:22,b:22',
    },
    WS_J,
  )

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.sshMultiHopUnsupported'))
  assert.equal(JSON.stringify(cfg.store[WS_J]), snapshot, 'a refused tunnel writes nothing')
  assert.equal(dialogs.length, 0)
})

test('key auth with a model-supplied key path needs no dialog and stores no secret', async () => {
  cfg.setWorkspaceEnv(WS_K, 'default', 'mysql://u:p@127.0.0.1:3306/k', 'user')
  dialogs.length = 0
  responder = async () => undefined

  const res = await configure(
    { sshHost: HOST, sshUser: 'deploy', sshAuthKind: 'key', sshKeyPath: '~/.ssh/id_ed25519' },
    WS_K,
  )

  assert.equal(res.ok, true, res.text)
  assert.equal(dialogs.length, 0, 'a key path is not a secret: no dialog')
  const row = rowOf(WS_K, 'default')
  assert.equal(row.ssh.auth, 'key')
  assert.equal(row.ssh.keyPath, '~/.ssh/id_ed25519')
  assert.equal(row.ssh.password, undefined)
  assert.equal(row.ssh.passphrase, undefined, 'no passphrase was given, none is stored')

  assert.ok(res.text.includes(HOST), res.text)
  assert.ok(res.text.includes('deploy'), res.text)
  assert.ok(!res.text.includes('CHANGE_ME'), 'no secret may surface in the reply')
})
