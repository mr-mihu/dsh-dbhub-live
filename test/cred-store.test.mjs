// SSH secrets live in the DSH credential service (`ctx.get('credentials')`,
// backed by $DSH_HOME/.credentials.yaml), NOT in this plugin's credentials.json.
// The plugin store keeps only a reference name (`ssh.passwordRef` /
// `ssh.passphraseRef`, shaped like an environment variable).
//
// This file pins the whole contract with a fake credentials service (a plain
// object stub — never the real ~/.dsh):
//   · a write stores the reference and never the plaintext;
//   · reads resolve the reference per operation (no caching);
//   · the boot migration moves legacy plaintext rows, idempotently;
//   · a host without the service keeps the old plaintext layout (warn once);
//   · a reference whose value is gone is a LOUD failure (never an empty secret,
//     and never a dbhub spawn);
//   · "blank = keep the stored value" keeps the reference and unsets nothing;
//   · removing a row releases an unreferenced ref, but never a shared one;
//   · copyFrom shares the reference instead of minting a new secret.
//
// Desensitization: loopback hosts, CHANGE_ME / synthetic canaries only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-credstore-'))
process.env.DSH_HOME = home
delete process.env.MISE_DATA_DIR

const storeDir = join(home, 'storages', 'dsh-dbhub-live')
const storePath = join(storeDir, 'credentials.json')
mkdirSync(storeDir, { recursive: true })

// The marker asserted absent from credentials.json after an encrypted write.
const CANARY = 'CANARY_PW'
// A reference name in the shape the plugin generates: DSH_DBHUB_SSH_<10 hex>.
// Split so the literal stays a plain SCREAMING_SNAKE token for check:secrets.
const REF = 'DSH_DBHUB_SSH_' + 'ab12cd34ef'
const DSN = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
const WS = 'D:/work/app'
const OTHER = 'D:/work/other'
const SSH_PASSWORD = {
  host: '192.0.2.10',
  port: 22,
  user: 'ops',
  auth: 'password',
  password: CANARY,
}

const cfg = await import('../lib/config.mjs')
const index = await import('../lib/index.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const { currentT } = await import('../lib/i18n.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs?credstore=' + Date.now())

let seq = 0
/** A fresh config module instance (own store singleton, same temp DSH_HOME). */
function freshConfig() {
  seq += 1
  return import('../lib/config.mjs?credstore=' + seq + '-' + Date.now())
}

/** Replace the shared singleton store with a fixture and persist it. */
function seedStore(doc) {
  for (const key of Object.keys(cfg.store)) delete cfg.store[key]
  Object.assign(cfg.store, cfg.normalizeStore(doc || {}))
  cfg.saveStore(cfg.store)
}

const findRow = (wsPath, env) => cfg
  .listWorkspaceEnvironments(cfg.store)
  .find((r) => r.wsPath === wsPath && r.env === env)

/**
 * A fake credentials service. Values live in a Map; every call is recorded so a
 * test can assert "no new secret was minted" / "this ref was unset".
 */
function fakeCreds(values) {
  const store = new Map(Object.entries(values || {}))
  const calls = { set: [], unset: [], resolve: [] }
  return {
    calls,
    has: (ref) => store.has(ref),
    valueOf: (ref) => store.get(ref),
    async set(ref, value) {
      calls.set.push({ ref, value })
      store.set(ref, value)
    },
    async unset(ref) {
      calls.unset.push(ref)
      store.delete(ref)
    },
    async resolve(ref) {
      calls.resolve.push(ref)
      return store.has(ref) ? { value: store.get(ref), source: 'test' } : undefined
    },
  }
}

/** A ctx exposing only the optional services the code under test reads. */
function makeCtx({ creds, workspaces } = {}) {
  return {
    get(name) {
      if (name === 'credentials') return creds
      if (name === 'workspaceRegistry') return { list: async () => workspaces || [{ path: WS, title: 'app' }] }
      if (name === 'fs') {
        return { resolve: async () => { throw new Error('no .env') }, readText: async () => '' }
      }
      return undefined
    },
  }
}

/** Recording subprocess stub (never runs a real binary). */
function recorder() {
  const specs = []
  const subprocess = {
    resolveExecutable: async (name) => '/fake/bin/' + name,
    spawn(spec) {
      specs.push(spec)
      return {
        stdin: { write() {} },
        stdout: { on() {} },
        stderr: { on() {} },
        done: Promise.resolve({ exitCode: 1 }),
        terminate() {},
        waitForExit: async () => ({ exitCode: 1 }),
      }
    },
  }
  return { specs, subprocess }
}

/** Spawn specs that tried to start a dbhub process (mise/npm are not counted). */
const dbhubSpawns = (specs) => specs.filter((s) => String((s.argv && s.argv[0]) || '').includes('dbhub'))

if (!state.isEnabled()) state.setEnabled(true)

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── write path: reference in the store, value in the credential service ────

test('an options write stores the reference only — the plaintext never reaches credentials.json', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', DSN, 'user')
  const creds = fakeCreds()

  const res = await index.applyOptionsOp(
    { env: 'prod', ssh: SSH_PASSWORD },
    { path: WS, title: 'app' },
    async () => undefined,
    creds,
  )
  assert.equal(res.error, undefined)
  assert.ok(res.patches.length >= 1, 'the options write must report a patch')

  // The assertion the user asked for: read the REAL file and look for the value.
  const text = readFileSync(storePath, 'utf8')
  assert.equal(text.includes(CANARY), false, 'credentials.json must not contain the SSH password')
  assert.ok(text.includes(REF.slice(0, 14)), 'credentials.json must carry the reference prefix')

  const row = findRow(WS, 'prod')
  assert.match(row.ssh.passwordRef, /^DSH_DBHUB_SSH_[0-9a-f]{8,12}$/)
  assert.equal('password' in row.ssh, false, 'only the reference is stored')
  assert.equal(creds.calls.set.length, 1)
  assert.equal(creds.calls.set[0].value, CANARY, 'the value went to the credential service')
  assert.equal(creds.has(row.ssh.passwordRef), true)

  // No browser-facing patch may carry the secret or the reference name.
  const patches = JSON.stringify(res.patches)
  assert.equal(patches.includes(CANARY), false)
  assert.equal(patches.includes('DSH_DBHUB_SSH_'), false)

  // The secret-free view reports "a secret exists" and leaks nothing else.
  const described = cfg.describeEnvOptions(cfg.store[WS].environments.prod)
  assert.equal(described.ssh.hasPassword, true)
  assert.equal(JSON.stringify(described).includes(CANARY), false)
  assert.equal(JSON.stringify(described).includes('passwordRef'), false)

  // Same for the published summary (the browser/model-facing shape).
  const summary = JSON.stringify(mcp.summarizeRows([row]))
  assert.equal(summary.includes(CANARY), false)
  assert.equal(summary.includes('DSH_DBHUB_SSH_'), false)
  assert.equal(JSON.parse(summary)[0].ssh.hasPassword, true)
})

// ── read path: resolve per operation, value from the service ───────────────

test('resolveEnvSecrets calls resolve(ref) and returns the credential value; nothing is cached', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', DSN, 'user', {
    ssh: { host: SSH_PASSWORD.host, port: 22, user: 'ops', auth: 'password', passwordRef: REF },
  })
  const creds = fakeCreds({ [REF]: CANARY })
  const row = findRow(WS, 'prod')

  const first = await cfg.resolveEnvSecrets(creds, row)
  assert.equal(first.ssh.password, CANARY)
  assert.equal('passwordRef' in first.ssh, false, 'the resolved block carries the value, not the ref')
  assert.equal(row.ssh.passwordRef, REF, 'the stored row is never mutated by a read')

  // DSH re-resolves on every operation: a second call must ask the service again.
  const second = await cfg.resolveEnvSecrets(creds, row)
  assert.equal(second.ssh.password, CANARY)
  assert.deepEqual(creds.calls.resolve, [REF, REF])
})

// ── boot migration of legacy plaintext rows ────────────────────────────────

const legacyDoc = () => ({
  [WS]: {
    environments: {
      prod: { dsn: DSN, source: 'user', updatedAt: 1, ssh: { ...SSH_PASSWORD } },
      untouched: { dsn: DSN, source: 'user', updatedAt: 1 },
    },
  },
})

test('migration moves a legacy plaintext secret into a reference, and is idempotent', async () => {
  rmSync(storePath, { force: true })
  writeFileSync(storePath, JSON.stringify(legacyDoc(), null, 2))
  const c = await freshConfig()
  const creds = fakeCreds()

  const first = await c.migrateSshSecrets(creds)
  assert.equal(first.migrated, 1)
  const afterFirst = readFileSync(storePath, 'utf8')
  assert.equal(afterFirst.includes(CANARY), false, 'the migrated file carries no plaintext')
  const ref = JSON.parse(afterFirst)[WS].environments.prod.ssh.passwordRef
  assert.match(ref, /^DSH_DBHUB_SSH_[0-9a-f]{8,12}$/)
  assert.equal(creds.valueOf(ref), CANARY, 'the value now lives in the credential service')

  const setCalls = creds.calls.set.length
  const second = await c.migrateSshSecrets(creds)
  assert.equal(second.migrated, 0, 'a row that already has a reference is skipped')
  assert.equal(creds.calls.set.length, setCalls, 'no second reference is minted')
  assert.equal(readFileSync(storePath, 'utf8'), afterFirst, 'an idempotent run rewrites nothing')

  // The migrated row still resolves for execution.
  const row = c.listWorkspaceEnvironments(c.store).find((r) => r.env === 'prod')
  const conn = await c.resolveEnvSecrets(creds, row)
  assert.equal(conn.ssh.password, CANARY)
})

// ── no credentials service: old behaviour, one warning, usable connection ──

test('without the credentials service migration skips (plaintext kept) and warns once', async () => {
  rmSync(storePath, { force: true })
  writeFileSync(storePath, JSON.stringify(legacyDoc(), null, 2))
  const c = await freshConfig()
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let encryptResult
  try {
    const migrated = await c.migrateSshSecrets(undefined)
    assert.equal(migrated.migrated, 0)
    assert.equal(migrated.skipped, true)
    // The shared write helper (add/set/options all funnel through it) keeps the
    // plaintext when there is nowhere safe to put the value.
    encryptResult = await c.encryptSshSecrets(undefined, { ...SSH_PASSWORD })
    encryptResult = await c.encryptSshSecrets(undefined, { ...SSH_PASSWORD })
  } finally {
    console.warn = original
  }
  const unreadable = warnings.filter((line) => line.includes(currentT('log.credUnavailable')))
  assert.equal(unreadable.length, 1, 'the unavailable-service warning is emitted once')

  // Nothing was migrated: the file still carries the plaintext and no ref.
  const text = readFileSync(storePath, 'utf8')
  assert.ok(text.includes(CANARY), 'the legacy plaintext is preserved')
  assert.equal(text.includes('passwordRef'), false)
  assert.equal(encryptResult.password, CANARY, 'the write path degrades to plaintext')

  // …and the connection still works without any credential service.
  const row = c.listWorkspaceEnvironments(c.store).find((r) => r.env === 'prod')
  const conn = await c.resolveEnvSecrets(undefined, row)
  assert.equal(conn.ssh.password, CANARY)
})

test('a card write without the credentials service still stores plaintext (no ref)', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', DSN, 'user')
  // No service at all: the documented fallback keeps the pre-6.0 layout.
  await index.applyOptionsOp(
    { env: 'prod', ssh: SSH_PASSWORD },
    { path: WS, title: 'app' },
    async () => undefined,
    undefined,
  )
  const row = findRow(WS, 'prod')
  assert.equal(row.ssh.password, CANARY)
  assert.equal(row.ssh.passwordRef, undefined)
})

test('a failing credential write degrades to plaintext instead of dropping the secret', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', DSN, 'user')
  const failing = {
    calls: { set: [], unset: [] },
    async set(ref) {
      this.calls.set.push(ref)
      const err = new Error('credential store is not writable')
      err.code = 'EACCES'
      throw err
    },
    async unset() {},
    async resolve() {
      return undefined
    },
  }
  const res = await index.applyOptionsOp(
    { env: 'prod', ssh: SSH_PASSWORD },
    { path: WS, title: 'app' },
    async () => undefined,
    failing,
  )
  assert.equal(res.error, undefined, 'the options write itself still succeeds')
  const row = findRow(WS, 'prod')
  assert.equal(row.ssh.password, CANARY, 'the secret is kept rather than lost')
  assert.equal(row.ssh.passwordRef, undefined, 'no reference without a stored value')
  assert.equal(failing.calls.set.length, 1, 'it really tried the credential store')
})

// ── a reference with no value is a LOUD failure, never an empty secret ─────

test('an unresolvable reference fails explicitly and spawns no dbhub (send + probe)', async () => {
  seedStore({
    [WS]: {
      environments: {
        prod: { dsn: DSN, source: 'user', updatedAt: 1, ssh: { host: SSH_PASSWORD.host, port: 22, user: 'ops', auth: 'password', passwordRef: REF } },
      },
    },
  })
  const creds = fakeCreds() // the ref exists in the row, but the value is gone

  // (a) the descriptor helper refuses instead of handing out an empty password.
  await assert.rejects(
    () => cfg.resolveEnvSecrets(creds, findRow(WS, 'prod')),
    (err) => err && err.code === 'sshSecretMissing',
  )

  // (b) dbhub_execute_sql: explicit answer, ZERO dbhub spawns.
  const { specs, subprocess } = recorder()
  const tools = {}
  registerCoreTools({
    tools: { register: (def) => { tools[def.name] = def; return () => {} } },
    get(name) {
      if (name === 'credentials') return creds
      if (name === 'workspaceRegistry') return { list: async () => [{ path: WS, title: 'app' }] }
      if (name === 'fs') return { resolve: async () => { throw new Error('no .env') }, readText: async () => '' }
      return undefined
    },
    inject: () => {},
  }, subprocess)
  const exec = { agent: { session: { header: { cwd: WS } } }, signal: undefined }
  // Warm the row cache so resolution is answered from the store (no walk).
  await tools.dbhub_list_sources.execute({}, exec)
  const before = dbhubSpawns(specs).length
  const srcId = mcp.sourceIdOf({ title: 'app', wsPath: WS, env: 'prod' })
  const sent = await tools.dbhub_execute_sql.execute({ source: srcId, sql: 'SELECT 1' }, exec)
  assert.equal(sent.ok, false)
  assert.equal(sent.text, currentT('result.sshSecretMissing'))
  assert.equal(dbhubSpawns(specs).length, before, 'a missing secret must not start dbhub')

  // (c) the card connection test reports the same message and spawns nothing.
  const { specs: probeSpecs, subprocess: probeSubprocess } = recorder()
  const reports = []
  await index.handleConfigOp(
    { op: 'test', workspace: WS, env: 'prod', nonce: 'n1' },
    { get: makeCtx({ creds }).get },
    probeSubprocess,
    (json) => reports.push(JSON.parse(json)),
    () => {},
    () => {},
  )
  assert.equal(reports.length, 1, 'the card always receives a report')
  assert.equal(reports[0].nonce, 'n1')
  assert.equal(reports[0].ok, false)
  assert.equal(reports[0].message, currentT('result.sshSecretMissing'))
  assert.equal(dbhubSpawns(probeSpecs).length, 0, 'the probe must not start dbhub')
  assert.equal(reports[0].message.includes(CANARY), false)
})

// ── blank secret = keep the stored reference (nothing set, nothing unset) ──

test('a blank secret keeps the reference untouched (no set, no unset)', async () => {
  seedStore({
    [WS]: {
      environments: {
        prod: { dsn: DSN, source: 'user', updatedAt: 1, ssh: { host: SSH_PASSWORD.host, port: 22, user: 'ops', auth: 'password', passwordRef: REF } },
      },
    },
  })
  const creds = fakeCreds({ [REF]: CANARY })

  const res = await index.applyOptionsOp(
    // The card never echoes the secret back: host/user/auth only.
    { env: 'prod', ssh: { host: '192.0.2.11', user: 'ops', auth: 'password' } },
    { path: WS, title: 'app' },
    async () => undefined,
    creds,
  )
  assert.equal(res.error, undefined)
  const row = findRow(WS, 'prod')
  assert.equal(row.ssh.passwordRef, REF, 'the stored reference is unchanged')
  assert.equal(row.ssh.host, '192.0.2.11', 'the non-secret field still updated')
  assert.equal(creds.calls.set.length, 0)
  assert.equal(creds.calls.unset.length, 0)
  assert.equal(creds.valueOf(REF), CANARY, 'the credential is still there')
})

// ── removal: release only refs no other row uses ───────────────────────────

test('removing a row unsets an unreferenced ref, but keeps a shared one', async () => {
  seedStore({})
  const refSsh = { host: SSH_PASSWORD.host, port: 22, user: 'ops', auth: 'password', passwordRef: REF }
  cfg.setWorkspaceEnv(WS, 'prod', DSN, 'user', { ssh: refSsh })
  // copyFrom's write: the SAME block is stored again — the ref is shared.
  cfg.setWorkspaceEnv(WS, 'copy', DSN, 'copied', { ssh: refSsh })
  const creds = fakeCreds({ [REF]: CANARY })
  const ctx = { get: makeCtx({ creds }).get }

  await index.handleConfigOp({ op: 'remove', workspace: WS, env: 'prod' }, ctx, undefined, () => {}, () => {}, () => {})
  assert.equal(findRow(WS, 'prod'), undefined)
  assert.equal(creds.calls.unset.length, 0, 'a ref still used by another row must not be unset')
  assert.equal(creds.valueOf(REF), CANARY)

  await index.handleConfigOp({ op: 'remove', workspace: WS, env: 'copy' }, ctx, undefined, () => {}, () => {}, () => {})
  assert.equal(findRow(WS, 'copy'), undefined)
  assert.deepEqual(creds.calls.unset, [REF], 'the last owner releases the credential')
  assert.equal(creds.has(REF), false)
})

// ── copyFrom shares the reference instead of minting a new secret ──────────

test('copyFrom shares the source reference (no new secret is created)', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(OTHER, 'default', DSN, 'user', {
    ssh: { host: SSH_PASSWORD.host, port: 22, user: 'ops', auth: 'password', passwordRef: REF },
  })
  const creds = fakeCreds({ [REF]: CANARY })
  const { specs, subprocess } = recorder()
  const tools = {}
  registerCoreTools({
    tools: { register: (def) => { tools[def.name] = def; return () => {} } },
    get(name) {
      if (name === 'credentials') return creds
      if (name === 'workspaceRegistry') return { list: async () => [{ path: WS, title: 'app' }, { path: OTHER, title: 'other' }] }
      if (name === 'fs') return { resolve: async () => { throw new Error('no .env') }, readText: async () => '' }
      if (name === 'userQuestions') return { ask: async () => undefined }
      return undefined
    },
    inject: () => {},
  }, subprocess)
  const exec = { agent: { session: { header: { cwd: WS } } }, signal: undefined }
  await tools.dbhub_list_sources.execute({}, exec)
  const sourceId = mcp.sourceIdOf({ title: 'other', wsPath: OTHER, env: 'default' })

  const copied = await tools.dbhub_configure.execute({ copyFrom: sourceId, env: 'prod' }, exec)
  assert.equal(copied.ok, true, copied.text)
  const row = findRow(WS, 'prod')
  assert.ok(row, 'the copied row exists in the current workspace')
  assert.equal(row.ssh.passwordRef, REF, 'the reference is shared verbatim')
  assert.equal(creds.calls.set.length, 0, 'copying must not mint a second secret')
  // Still resolvable for the probe that ran right after the copy.
  assert.ok(dbhubSpawns(specs).length >= 1, 'the post-copy probe still runs through the tunnel')
  assert.equal(copied.text.includes(CANARY), false, 'the model-facing text carries no secret')
})

// ── rename leaves the reference alone ──────────────────────────────────────

test('rename does not touch the credential reference', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', DSN, 'user', {
    ssh: { host: SSH_PASSWORD.host, port: 22, user: 'ops', auth: 'password', passwordRef: REF },
  })
  const creds = fakeCreds({ [REF]: CANARY })
  const ctx = { get: makeCtx({ creds }).get }

  await index.handleConfigOp(
    { op: 'rename', workspace: WS, env: 'prod', newEnv: 'prod2' },
    ctx,
    undefined,
    () => {},
    () => {},
    () => {},
  )
  const row = findRow(WS, 'prod2')
  assert.ok(row, 'the row moved')
  assert.equal(row.ssh.passwordRef, REF)
  assert.equal(creds.calls.set.length, 0)
  assert.equal(creds.calls.unset.length, 0)
})

// ── the model path must not re-ask for a secret it already has ─────────────

test('dbhub_configure with a stored reference does not prompt for the password again', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', DSN, 'user', {
    ssh: { host: SSH_PASSWORD.host, port: 22, user: 'ops', auth: 'password', passwordRef: REF },
  })
  const creds = fakeCreds({ [REF]: CANARY })
  const dialogs = []
  const { subprocess } = recorder()
  const tools = {}
  registerCoreTools({
    tools: { register: (def) => { tools[def.name] = def; return () => {} } },
    get(name) {
      if (name === 'credentials') return creds
      if (name === 'workspaceRegistry') return { list: async () => [{ path: WS, title: 'app' }] }
      if (name === 'fs') return { resolve: async () => { throw new Error('no .env') }, readText: async () => '' }
      if (name === 'userQuestions') return { ask: async (params) => { dialogs.push(params); return undefined } }
      return undefined
    },
    inject: () => {},
  }, subprocess)
  const exec = { agent: { session: { header: { cwd: WS } } }, signal: undefined }

  const res = await tools.dbhub_configure.execute({ env: 'prod', sshHost: '192.0.2.11' }, exec)
  assert.equal(res.ok, true, res.text)
  assert.equal(dialogs.length, 0, 'a stored secret must not trigger a password dialog')
  const row = findRow(WS, 'prod')
  assert.equal(row.ssh.passwordRef, REF, 'the reference survives the edit')
  assert.equal(creds.calls.set.length, 0)
  assert.equal(res.text.includes(CANARY), false)
})
