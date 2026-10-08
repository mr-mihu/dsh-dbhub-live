// Environment-options tests (store model v3): the read-only flag and the SSH
// tunnel block of one environment entry, plus the browser-side options command
// handler (`applyOptionsOp`).
//
// config.mjs binds its storage paths at import time and is cached by Node, so
// every test that wants a clean store gets a FRESH module instance through a
// unique query string; each instance reads the on-disk credentials.json at
// import. The plain (unqueried) instance is the one lib/index.mjs shares, so
// the handler tests seed that singleton in place.
//
// Desensitization: loopback / documentation hosts and CHANGE_ME secrets only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-envopts-'))
process.env.DSH_HOME = home

const storeDir = join(home, 'storages', 'dsh-dbhub-live')
const storePath = join(storeDir, 'credentials.json')
mkdirSync(storeDir, { recursive: true })

let seq = 0
function freshConfig() {
  seq += 1
  return import('../lib/config.mjs?envopts=' + seq + '-' + Date.now())
}

/** A fresh config instance whose on-disk store starts from `doc` (undefined = empty). */
async function configWith(doc) {
  if (doc === undefined) rmSync(storePath, { force: true })
  else writeFileSync(storePath, JSON.stringify(doc, null, 2))
  return freshConfig()
}

const readStore = () => JSON.parse(readFileSync(storePath, 'utf8'))

const SSH_KEY = {
  host: 'bastion.example.com', port: 2222, user: 'deploy',
  auth: 'key', keyPath: '/home/deploy/.ssh/id_ed25519',
}
const SSH_PASS = {
  host: 'bastion.example.com', user: 'deploy',
  auth: 'password', password: 'CHANGE_ME',
}

// The plain instance is the module instance lib/index.mjs imports, so its
// `store` object is the live singleton `applyOptionsOp` reads and writes.
const base = await import('../lib/config.mjs')
const index = await import('../lib/index.mjs')

/** Reset the shared singleton store to a fixture and persist it. */
function seedBase(fixture) {
  for (const key of Object.keys(base.store)) delete base.store[key]
  Object.assign(base.store, fixture || {})
  base.saveStore(base.store)
}

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── load / list (v2 file, v3 fields) ──────────────────────────────────────

test('a v2 store document loads as not read-only and without a tunnel', async () => {
  const c = await configWith({
    enabled: true,
    'D:/ws/v2': {
      environments: {
        default: { dsn: 'mysql://u:CHANGE_ME@127.0.0.1:3306/app', source: 'user', updatedAt: 1 },
        prod: { dsn: 'postgres://u:CHANGE_ME@192.0.2.10:5432/app' },
      },
    },
  })
  const rows = c.listWorkspaceEnvironments(c.store)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.ro, false, row.env + ' must not be read-only')
    assert.equal(row.ssh, null, row.env + ' must have no tunnel')
    assert.equal(row.persisted, true)
  }
})

test('setWorkspaceEnv persists readOnly: true and listWorkspaceEnvironments reports it', async () => {
  const c = await configWith(undefined)
  const name = c.setWorkspaceEnv('D:/ws/ro', 'prod', ' mysql://u:CHANGE_ME@127.0.0.1:3306/prod ', 'user', { readOnly: true })
  assert.equal(name, 'prod')
  const onDisk = readStore()
  assert.equal(onDisk['D:/ws/ro'].environments.prod.readOnly, true)
  assert.equal(onDisk['D:/ws/ro'].environments.prod.dsn, 'mysql://u:CHANGE_ME@127.0.0.1:3306/prod')
  const row = c.listWorkspaceEnvironments(c.store).find((r) => r.wsPath === 'D:/ws/ro' && r.env === 'prod')
  assert.equal(row.ro, true)
  assert.equal(row.ssh, null)
})

// ── preservation vs explicit clearing (D4) ────────────────────────────────

test('a DSN-only setWorkspaceEnv preserves both the read-only flag and the tunnel', async () => {
  const c = await configWith(undefined)
  const ws = 'D:/ws/keep'
  c.setWorkspaceEnv(ws, 'prod', 'mysql://u:CHANGE_ME@127.0.0.1:3306/one', 'user', { readOnly: true, ssh: SSH_KEY })
  let entry = readStore()[ws].environments.prod
  assert.equal(entry.readOnly, true)
  assert.equal(entry.ssh.host, 'bastion.example.com')

  // The regression the DSN-only dbhub_configure path depends on: NO opts.
  const name = c.setWorkspaceEnv(ws, 'prod', 'mysql://u:CHANGE_ME@127.0.0.1:3307/two', 'user')
  assert.equal(name, 'prod')
  entry = readStore()[ws].environments.prod
  assert.equal(entry.dsn, 'mysql://u:CHANGE_ME@127.0.0.1:3307/two')
  assert.equal(entry.readOnly, true, 'the read-only flag must survive a DSN-only update')
  assert.equal(entry.ssh.host, 'bastion.example.com', 'the tunnel must survive a DSN-only update')
  assert.equal(entry.ssh.port, 2222)
  assert.equal(entry.ssh.keyPath, '/home/deploy/.ssh/id_ed25519')

  const row = c.listWorkspaceEnvironments(c.store).find((r) => r.env === 'prod')
  assert.equal(row.ro, true)
  assert.equal(row.ssh.user, 'deploy')
})

test('readOnly: false and ssh: null delete exactly one field each and keep the DSN', async () => {
  const c = await configWith(undefined)
  const ws = 'D:/ws/clear'
  const dsn = 'mysql://u:CHANGE_ME@127.0.0.1:3306/keep'
  c.setWorkspaceEnv(ws, 'prod', dsn, 'user', { readOnly: true, ssh: SSH_KEY })

  c.setWorkspaceEnv(ws, 'prod', dsn, 'user', { readOnly: false })
  let entry = readStore()[ws].environments.prod
  assert.equal(Object.hasOwn(entry, 'readOnly'), false, 'readOnly: false removes the key')
  assert.ok(entry.ssh, 'the tunnel is preserved when only readOnly is patched')
  assert.equal(entry.dsn, dsn)

  c.setWorkspaceEnv(ws, 'prod', dsn, 'user', { readOnly: true, ssh: SSH_PASS })
  c.setWorkspaceEnv(ws, 'prod', dsn, 'user', { ssh: null })
  entry = readStore()[ws].environments.prod
  assert.equal(Object.hasOwn(entry, 'ssh'), false, 'ssh: null removes the key')
  assert.equal(entry.readOnly, true, 'readOnly is preserved when only ssh is patched')
  assert.equal(entry.dsn, dsn, 'the DSN survives both clears')
})

test('normalizeStore preserves unknown env fields next to readOnly/ssh', async () => {
  const doc = {
    'D:/ws/future': {
      environments: {
        prod: {
          dsn: 'mysql://u:CHANGE_ME@127.0.0.1:3306/f',
          source: 'user',
          updatedAt: 7,
          readOnly: true,
          ssh: SSH_KEY,
          futureFlag: 'kept',
          nested: { a: 1 },
        },
      },
    },
  }
  const c = await configWith(doc)
  const entry = c.store['D:/ws/future'].environments.prod
  assert.equal(entry.futureFlag, 'kept')
  assert.deepEqual(entry.nested, { a: 1 })
  assert.equal(entry.readOnly, true)
  assert.equal(entry.ssh.host, 'bastion.example.com')
  // A normalizing rewrite of the same document is lossless (forward compat).
  const onDisk = readStore()
  assert.deepEqual(c.normalizeStore(onDisk), onDisk)
  assert.equal(onDisk['D:/ws/future'].environments.prod.futureFlag, 'kept')
  assert.equal(onDisk['D:/ws/future'].environments.prod.ssh.host, 'bastion.example.com')
  assert.equal(onDisk['D:/ws/future'].environments.prod.readOnly, true)
})

// ── options-only write / rename ───────────────────────────────────────────

test('setWorkspaceEnvOptions touches only the options of an existing row', async () => {
  const c = await configWith(undefined)
  const ws = 'D:/ws/opts'
  const dsn = 'postgres://u:CHANGE_ME@192.0.2.20:5432/app'
  c.setWorkspaceEnv(ws, 'prod', dsn, 'collected')
  c.store[ws].environments.prod.updatedAt = 1 // pin an old stamp so the refresh is observable

  const name = c.setWorkspaceEnvOptions(ws, 'prod', { readOnly: true })
  assert.equal(name, 'prod')
  const entry = readStore()[ws].environments.prod
  assert.equal(entry.readOnly, true)
  assert.equal(entry.dsn, dsn, 'the DSN is not touched')
  assert.equal(entry.source, 'collected', 'the source provenance is not touched')
  assert.ok(entry.updatedAt > 1, 'updatedAt is refreshed')
  assert.equal(Object.hasOwn(entry, 'ssh'), false)
  assert.equal(c.listWorkspaceEnvironments(c.store).find((r) => r.env === 'prod').ro, true)
})

test('setWorkspaceEnvOptions on a missing row returns undefined and writes nothing', async () => {
  const c = await configWith(undefined)
  const ws = 'D:/ws/hasrow'
  c.setWorkspaceEnv(ws, 'prod', 'mysql://u:CHANGE_ME@127.0.0.1:3306/x', 'user')
  const before = readFileSync(storePath, 'utf8')
  assert.equal(c.setWorkspaceEnvOptions(ws, 'nope', { readOnly: true }), undefined)
  assert.equal(c.setWorkspaceEnvOptions('D:/ws/absent', 'prod', { readOnly: true }), undefined)
  assert.equal(readFileSync(storePath, 'utf8'), before, 'nothing was written')
})

test('renameWorkspaceEnv carries the options to the new name', async () => {
  const c = await configWith(undefined)
  const ws = 'D:/ws/rename'
  const dsn = 'mysql://u:CHANGE_ME@127.0.0.1:3306/r'
  c.setWorkspaceEnv(ws, 'old', dsn, 'collected', { readOnly: true, ssh: SSH_KEY })
  assert.equal(c.renameWorkspaceEnv(ws, 'old', 'new'), 'new')
  const envs = readStore()[ws].environments
  assert.equal(Object.hasOwn(envs, 'old'), false)
  assert.equal(envs.new.dsn, dsn)
  assert.equal(envs.new.source, 'collected')
  assert.equal(envs.new.readOnly, true)
  assert.equal(envs.new.ssh.host, 'bastion.example.com')
  assert.equal(envs.new.ssh.keyPath, '/home/deploy/.ssh/id_ed25519')
})

// ── normalizeSshOptions matrix ────────────────────────────────────────────

test('normalizeSshOptions accepts complete key/password blocks and rejects incomplete ones', async () => {
  const c = await configWith(undefined)
  const normalize = (raw) => c.normalizeSshOptions(raw)

  assert.deepEqual(normalize(SSH_KEY), {
    host: 'bastion.example.com', port: 2222, user: 'deploy',
    auth: 'key', keyPath: '/home/deploy/.ssh/id_ed25519',
  })
  assert.deepEqual(normalize({ ...SSH_KEY, passphrase: 'CHANGE_ME' }), {
    host: 'bastion.example.com', port: 2222, user: 'deploy',
    auth: 'key', keyPath: '/home/deploy/.ssh/id_ed25519', passphrase: 'CHANGE_ME',
  })
  assert.deepEqual(normalize(SSH_PASS), {
    host: 'bastion.example.com', port: 22, user: 'deploy',
    auth: 'password', password: 'CHANGE_ME',
  })

  const { auth, ...noAuth } = SSH_PASS
  assert.equal(auth, 'password')
  assert.equal(normalize({ ...SSH_PASS, host: '' }), null, 'missing host -> null')
  assert.equal(normalize({ ...SSH_PASS, host: undefined }), null, 'missing host -> null')
  assert.equal(normalize({ ...SSH_PASS, user: '' }), null, 'missing user -> null')
  assert.equal(normalize({ ...SSH_PASS, user: '   ' }), null, 'blank user -> null')
  assert.equal(normalize(noAuth), null, 'missing auth -> null')
  assert.equal(normalize({ ...SSH_PASS, auth: 'agent' }), null, 'unknown auth -> null')
  assert.equal(normalize({ ...SSH_KEY, auth: 'key', keyPath: '' }), null, 'key auth without keyPath -> null')
  assert.equal(normalize({ ...SSH_KEY, keyPath: undefined }), null, 'key auth without keyPath -> null')
  assert.equal(normalize({ ...SSH_PASS, password: '' }), null, 'password auth without password -> null')
  assert.equal(normalize({ ...SSH_PASS, password: undefined }), null, 'password auth without password -> null')
  assert.equal(normalize(null), null)
  assert.equal(normalize(undefined), null)
  assert.equal(normalize('ssh'), null)
  assert.equal(normalize([SSH_PASS]), null)
})

test('normalizeSshOptions normalizes ports, proxy-jump hops and untrusted text', async () => {
  const c = await configWith(undefined)
  const normalize = (raw) => c.normalizeSshOptions({ ...SSH_PASS, ...raw })

  assert.equal(normalize({ port: '2222' }).port, 2222, 'a numeric string is accepted')
  assert.equal(normalize({ port: 2222 }).port, 2222)
  assert.equal(normalize({ port: 1 }).port, 1)
  assert.equal(normalize({ port: 65535 }).port, 65535)
  assert.equal(normalize({ port: 70000 }).port, 22, 'out of range falls back to 22')
  assert.equal(normalize({ port: 0 }).port, 22, 'out of range falls back to 22')
  assert.equal(normalize({ port: -1 }).port, 22, 'out of range falls back to 22')
  assert.equal(normalize({ port: 'abc' }).port, 22, 'a non-numeric port falls back to 22')
  assert.equal(normalize({ port: '' }).port, 22)
  assert.equal(normalize({ port: null }).port, 22)

  assert.equal(normalize({ proxyJump: 'jump.example.com' }).proxyJump, 'jump.example.com')
  assert.equal(normalize({ proxyJump: 'deploy@jump.example.com:22' }).proxyJump, 'deploy@jump.example.com:22')
  assert.equal(normalize({ proxyJump: 'jump1.example.com, jump2.example.com' }), null, 'multi-hop is unsupported')
  assert.equal(c.sshProxyJumpHops(''), 0)
  assert.equal(c.sshProxyJumpHops('jump.example.com'), 1)
  assert.equal(c.sshProxyJumpHops('a.example.com, b.example.com'), 2)
  assert.equal(c.sshProxyJumpHops(' a.example.com , '), 1, 'blank hops do not count')

  const control = normalize({ host: ' bastion\u0000.example.com\u0007 ', user: 'de\u007fploy' })
  assert.equal(control.host, 'bastion.example.com', 'control characters are stripped and the value trimmed')
  assert.equal(control.user, 'deploy')

  assert.equal(normalize({ host: 'h'.repeat(300) }).host.length, 255, 'host is capped')
  assert.equal(normalize({ user: 'u'.repeat(200) }).user.length, 128, 'user is capped')
  assert.equal(normalize({ password: 'p'.repeat(600) }).password.length, 512, 'password is capped')
  assert.equal(normalize({ proxyJump: 'j'.repeat(2000) }).proxyJump.length, 1024, 'proxyJump is capped')
  assert.equal(
    normalize({ proxyJump: 'j'.repeat(600) + ',' + 'k'.repeat(600) }),
    null,
    'a capped value that still names 2+ hops is refused',
  )
})

// ── describeEnvOptions (secret-free view) ─────────────────────────────────

test('describeEnvOptions never leaks a password', async () => {
  const c = await configWith(undefined)
  const password = 'CHANGE_ME'
  const described = c.describeEnvOptions({
    dsn: 'mysql://u:CHANGE_ME@127.0.0.1:3306/d', readOnly: true, ssh: { ...SSH_PASS, password },
  })
  assert.deepEqual(described, {
    ro: true,
    ssh: {
      host: 'bastion.example.com', port: 22, user: 'deploy', authKind: 'password',
      hasPassword: true, hasPassphrase: false, keyReady: false, proxyJump: '',
    },
  })
  assert.equal(JSON.stringify(described).includes(password), false)
})

test('describeEnvOptions reports key readiness without leaking the key path', async () => {
  const c = await configWith(undefined)
  const missing = '/nonexistent-dsh/id_ed25519'
  const described = c.describeEnvOptions({
    readOnly: false, ssh: { ...SSH_KEY, keyPath: missing, passphrase: 'CHANGE_ME', proxyJump: 'jump.example.com' },
  })
  assert.deepEqual(described, {
    ro: false,
    ssh: {
      host: 'bastion.example.com', port: 2222, user: 'deploy', authKind: 'key',
      hasPassword: false, hasPassphrase: true, keyReady: false, proxyJump: 'jump.example.com',
    },
  })
  const json = JSON.stringify(described)
  assert.equal(json.includes(missing), false, 'the key path must never cross')
  assert.equal(json.includes('CHANGE_ME'), false, 'the passphrase must never cross')

  // A key path that really exists in the temp home reports keyReady: true.
  const keyFile = join(home, 'id_ed25519')
  writeFileSync(keyFile, 'KEY-CHANGE_ME')
  const ready = c.describeEnvOptions({ ssh: { ...SSH_KEY, keyPath: keyFile } })
  assert.equal(ready.ssh.keyReady, true)
  assert.equal(JSON.stringify(ready).includes(keyFile), false, 'even a ready path stays host-side')
})

// ── resolveWorkspaceEnvs carries the options ──────────────────────────────

test('resolveWorkspaceEnvs carries ro/ssh for persisted environments', async () => {
  const c = await configWith(undefined)
  const ws = 'D:/ws/resolve'
  c.setWorkspaceEnv(ws, 'prod', 'mysql://u:CHANGE_ME@127.0.0.1:3306/p', 'user', { readOnly: true, ssh: SSH_PASS })
  c.setWorkspaceEnv(ws, 'dev', 'mysql://u:CHANGE_ME@127.0.0.1:3306/d', 'user')
  const subprocess = { resolveExecutable: async () => { throw new Error('no mise') } }
  const fs = { resolve: async () => { throw new Error('no .env') } }
  const rows = await c.resolveWorkspaceEnvs(subprocess, fs, ws, undefined)
  assert.deepEqual(rows.map((r) => r.env).sort(), ['dev', 'prod'])
  const prod = rows.find((r) => r.env === 'prod')
  assert.equal(prod.source, 'persisted(user)')
  assert.equal(prod.ro, true)
  assert.equal(prod.ssh.host, 'bastion.example.com')
  assert.equal(prod.ssh.auth, 'password')
  assert.equal(prod.ssh.password, 'CHANGE_ME') // secrets stay host-side in this shape
  const dev = rows.find((r) => r.env === 'dev')
  assert.equal(dev.ro, false)
  assert.equal(dev.ssh, null)
})

// ── applyOptionsOp (browser-side options command handler) ─────────────────

test('applyOptionsOp on an existing row patches options and never adds a row', async () => {
  const ws = { path: 'D:/ws/handler', title: 'handler' }
  seedBase({
    [ws.path]: {
      environments: {
        prod: {
          dsn: 'mysql://u:CHANGE_ME@127.0.0.1:3306/prod', source: 'user', updatedAt: 1, ssh: SSH_PASS,
        },
      },
    },
  })
  const res = await index.applyOptionsOp(
    { op: 'options', env: 'prod', readOnly: true, ssh: null },
    ws,
    async () => { throw new Error('lookupAuto must not run for a persisted row') },
  )
  assert.deepEqual(res.patches, [{ op: 'options', path: ws.path, env: 'prod', ro: true, ssh: null }])
  assert.equal(res.patches.some((p) => p.op === 'add'), false)
  const entry = readStore()[ws.path].environments.prod
  assert.equal(entry.readOnly, true)
  assert.equal(Object.hasOwn(entry, 'ssh'), false, 'ssh: null cleared the stored tunnel')
  assert.equal(entry.dsn, 'mysql://u:CHANGE_ME@127.0.0.1:3306/prod')
  // The shared in-memory singleton the handler wrote through agrees too.
  const row = base.listWorkspaceEnvironments(base.store).find((r) => r.wsPath === ws.path && r.env === 'prod')
  assert.equal(row.ro, true)
  assert.equal(row.ssh, null)
})

test('applyOptionsOp promotes an auto-discovered environment through lookupAuto', async () => {
  const ws = { path: 'D:/ws/promote', title: 'promote' }
  seedBase({})
  const seen = []
  const dsn = 'postgres://u:CHANGE_ME@192.0.2.30:5432/auto'
  const res = await index.applyOptionsOp({ op: 'options', env: 'default', readOnly: true }, ws, async (envName) => {
    seen.push(envName)
    return { env: envName, dsn }
  })
  assert.deepEqual(seen, ['default'])
  assert.deepEqual(res.patches, [
    { op: 'add', path: ws.path, title: ws.title, env: 'default', dsn, source: 'promoted', ro: true, ssh: null },
    { op: 'options', path: ws.path, env: 'default', ro: true, ssh: null },
  ])
  const entry = readStore()[ws.path].environments.default
  assert.equal(entry.dsn, dsn)
  assert.equal(entry.source, 'promoted')
  assert.equal(entry.readOnly, true)
  const row = base.listWorkspaceEnvironments(base.store).find((r) => r.wsPath === ws.path && r.env === 'default')
  assert.equal(row.persisted, true)
  assert.equal(row.ro, true)
})

test('applyOptionsOp without a row and without an auto discovery writes nothing', async () => {
  const ws = { path: 'D:/ws/none', title: 'none' }
  seedBase({ [ws.path]: { environments: { other: { dsn: 'mysql://u:CHANGE_ME@127.0.0.1:3306/o' } } } })
  const before = readFileSync(storePath, 'utf8')
  const res = await index.applyOptionsOp({ op: 'options', env: 'default', readOnly: true }, ws, async () => undefined)
  assert.deepEqual(res, { patches: [], error: 'needConnFirst' })
  assert.equal(readFileSync(storePath, 'utf8'), before, 'nothing was written')
})

test('applyOptionsOp rejects an invalid ssh block before writing anything', async () => {
  const ws = { path: 'D:/ws/badssh', title: 'badssh' }
  seedBase({ [ws.path]: { environments: { prod: { dsn: 'mysql://u:CHANGE_ME@127.0.0.1:3306/p', source: 'user' } } } })
  const before = readFileSync(storePath, 'utf8')
  const res = await index.applyOptionsOp(
    { op: 'options', env: 'prod', ssh: { host: 'bastion.example.com', auth: 'password', password: 'CHANGE_ME' } },
    ws,
    async () => undefined,
  )
  assert.deepEqual(res, { patches: [], error: 'badSsh' })
  assert.equal(readFileSync(storePath, 'utf8'), before, 'nothing was written')
})

test('applyOptionsOp renames and applies options in one call', async () => {
  const ws = { path: 'D:/ws/renameop', title: 'renameop' }
  const dsn = 'mysql://u:CHANGE_ME@127.0.0.1:3306/move'
  seedBase({ [ws.path]: { environments: { old: { dsn, source: 'user', updatedAt: 1, ssh: SSH_KEY } } } })
  const res = await index.applyOptionsOp(
    { op: 'options', env: 'old', newEnv: 'new', readOnly: true },
    ws,
    async () => undefined,
  )
  assert.deepEqual(res.patches, [
    { op: 'rename', path: ws.path, env: 'new', from: 'old' },
    {
      op: 'options', path: ws.path, env: 'new', ro: true,
      ssh: { host: 'bastion.example.com', port: 2222, user: 'deploy', auth: 'key', keyPath: '/home/deploy/.ssh/id_ed25519' },
    },
  ])
  assert.equal(res.patches.some((p) => p.op === 'rename'), true)
  const envs = readStore()[ws.path].environments
  assert.equal(Object.hasOwn(envs, 'old'), false)
  assert.equal(envs.new.dsn, dsn, 'the connection travels with the name')
  assert.equal(envs.new.readOnly, true)
  assert.equal(envs.new.ssh.host, 'bastion.example.com', 'the tunnel travels with the name')
})
