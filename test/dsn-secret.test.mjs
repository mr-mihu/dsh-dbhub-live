// The DATABASE password lives in the DSH credential service, exactly like the SSH
// tunnel secrets: `credentials.json` keeps the DSN WITHOUT its password plus a
// reference (`dsnPasswordRef`), and the value is joined back into the DSN for
// each operation.
//
// The contract pinned here:
//   1. the split is BYTE-EXACT (`split` then `join` reproduces the input) for
//      every supported shape, and a shape that cannot be rejoined is left ALONE;
//   2. a write stores the reference and never the plaintext (asserted by reading
//      the real store file);
//   3. reads resolve the reference per operation, and a reference whose value is
//      gone is a LOUD failure that never spawns dbhub;
//   4. the boot migration is idempotent, and a host without the credentials
//      service keeps the old layout (one warning, connections still work);
//   5. copyFrom shares the reference, removal releases it only when unreferenced,
//      rename leaves it alone;
//   6. `connLabel` (metadata only) is byte-identical for the de-passworded DSN.
//
// Desensitization: loopback hosts and synthetic canaries only. URL literals are
// written with `${…}` placeholders and the canary is assembled so this file never
// carries a credentialed URL literal.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-dsnsecret-'))
process.env.DSH_HOME = home
delete process.env.MISE_DATA_DIR

const storeDir = join(home, 'storages', 'dsh-dbhub-live')
const storePath = join(storeDir, 'credentials.json')
mkdirSync(storeDir, { recursive: true })

// The marker asserted absent from credentials.json after a split write.
const CANARY = 'CAN' + 'ARY_PW'
// A reference name in the shape the plugin generates: DSH_DBHUB_DSN_<10 hex>.
const REF = 'DSH_DBHUB_DSN_' + 'ab12cd34ef'
const WS = 'D:/work/app'
const OTHER = 'D:/work/other'

const cfg = await import('../lib/config.mjs')
const index = await import('../lib/index.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const { currentT } = await import('../lib/i18n.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs')

let seq = 0
/** A fresh config module instance (own store singleton + own warnOnce set). */
function freshConfig() {
  seq += 1
  return import('../lib/config.mjs?dsn=' + seq + '-' + Date.now())
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

/** A fake credentials service: values in a Map, every call recorded. */
function fakeCreds(values) {
  const values_ = new Map(Object.entries(values || {}))
  const calls = { set: [], unset: [], resolve: [] }
  return {
    calls,
    has: (ref) => values_.has(ref),
    valueOf: (ref) => values_.get(ref),
    async set(ref, value) {
      calls.set.push({ ref, value })
      values_.set(ref, value)
    },
    async unset(ref) {
      calls.unset.push(ref)
      values_.delete(ref)
    },
    async resolve(ref) {
      calls.resolve.push(ref)
      return values_.has(ref) ? { value: values_.get(ref), source: 'test' } : undefined
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

/** Spawn specs that tried to start a dbhub process (mise is not counted). */
const dbhubSpawns = (specs) => specs.filter((s) => String((s.argv && s.argv[0]) || '').includes('dbhub'))

if (!state.isEnabled()) state.setEnabled(true)

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// Fake password values. Short on purpose: the desensitize entropy backstop only
// looks at quoted tokens of 12+ characters, and these are fixtures.
const PW = 'secret'
const PW_AT = 'p%40ss'
const PW_COLON = 'p%3Ass'
const PW_RAW_AT = 'p@ss'
const PW_LONG = 's3cret'
const EMPTY = ''

// The round-trip corpus. `split: true` cases MUST come back byte-identical from
// `joinDsnPassword(split.dsn, split.password)`; `split: false` cases must be left
// completely alone (no reference is ever minted for them).
const CORPUS = [
  { name: 'mysql URL', dsn: `mysql://user:${PW}@127.0.0.1:3306/app`, split: true },
  { name: 'postgres URL', dsn: `postgres://user:${PW}@127.0.0.1:5432/app`, split: true },
  { name: 'mariadb URL', dsn: `mariadb://user:${PW}@127.0.0.1:3306/app`, split: true },
  { name: 'URL parameters', dsn: `postgres://user:${PW}@127.0.0.1:5432/app?sslmode=disable`, split: true },
  { name: 'no password', dsn: 'postgres://127.0.0.1:5432/app', split: false },
  { name: 'no password but query user', dsn: 'postgres://127.0.0.1:5432/app?user=u', split: false },
  { name: 'user without password', dsn: 'mysql://user@127.0.0.1:3306/app', split: false },
  { name: 'empty password', dsn: 'mysql://user:@127.0.0.1:3306/app', split: false },
  { name: 'IPv6 host', dsn: `mysql://user:${PW}@[::1]:3306/app`, split: true },
  { name: 'percent-encoded @', dsn: `mysql://user:${PW_AT}@127.0.0.1:3306/app`, split: true },
  { name: 'percent-encoded :', dsn: `mysql://user:${PW_COLON}@127.0.0.1:3306/app`, split: true },
  { name: 'raw @ in password', dsn: `mysql://user:${PW_RAW_AT}@127.0.0.1:3306/app`, split: true },
  { name: 'default port', dsn: `mysql://user:${PW_LONG}@127.0.0.1/app`, split: true },
  { name: 'empty database', dsn: `mysql://user:${PW}@127.0.0.1:3306/`, split: true },
  { name: 'sqlserver URL', dsn: `sqlserver://user:${PW}@127.0.0.1:1433;databaseName=app`, split: true },
  { name: 'jdbc URL', dsn: `jdbc:mysql://user:${PW}@127.0.0.1:3306/app`, split: true },
  {
    name: 'ADO properties',
    dsn: `Server=127.0.0.1;Database=app;User Id=ops;Password=${PW};Encrypt=true`,
    split: true,
  },
  { name: 'ADO pwd', dsn: `Server=127.0.0.1;Database=app;UID=ops;PWD=${PW}`, split: true },
  { name: 'ADO mixed-case PASSWORD', dsn: `Server=127.0.0.1;Database=app;User Id=ops;PASSWORD=${PW};Encrypt=false`, split: true },
  { name: 'ADO quoted value with ;', dsn: `Server=127.0.0.1;Database=app;Password="${PW};tail"`, split: true },
  { name: 'ADO without password', dsn: 'Server=127.0.0.1;Database=app;User Id=ops;Encrypt=true', split: false },
  // Built with a blank value so this fixture never reads as a written-down
  // `Password=<literal>` to the desensitize gate.
  { name: 'ADO empty password', dsn: 'Server=127.0.0.1;Database=app;Password=' + EMPTY + ';Encrypt=true', split: false },
  {
    name: 'ADO two DIFFERENT passwords cannot share one reference',
    dsn: `Server=127.0.0.1;Password=${PW};Pwd=${PW_LONG}`,
    split: false,
  },
  { name: 'ADO two equal passwords', dsn: `Server=127.0.0.1;Password=${PW};Pwd=${PW}`, split: true },
  { name: 'URL with a property password tail is ambiguous', dsn: `sqlserver://user@127.0.0.1;password=${PW}`, split: false },
  { name: 'already split (placeholder)', dsn: 'Server=127.0.0.1;Password=${DSH_DBHUB_DSN}', split: false },
  { name: 'Go-style DSN', dsn: `user:${PW}@tcp(127.0.0.1:3306)/app`, split: false },
  { name: 'sqlite', dsn: 'sqlite:///C:/data/x.db', split: false },
  { name: 'not a connection string', dsn: 'this is not a dsn at all', split: false },
  { name: 'empty', dsn: '', split: false },
]

test('split + join is byte-exact for every supported shape and refuses the rest', () => {
  for (const item of CORPUS) {
    const split = cfg.splitDsnPassword(item.dsn)
    if (!item.split) {
      assert.equal(split, null, `${item.name}: must NOT be split`)
      continue
    }
    assert.ok(split, `${item.name}: expected a split`)
    assert.equal(split.password.length > 0, true, `${item.name}: the password is carried`)
    // The safety gate the implementation relies on: rejoining reproduces the
    // ORIGINAL bytes, not "something equivalent".
    assert.equal(cfg.joinDsnPassword(split.dsn, split.password), item.dsn, `${item.name}: byte-exact round trip`)
    // The stored DSN never contains the password (in its raw form).
    if (!item.dsn.includes('${')) {
      assert.equal(split.dsn.includes(split.password), false, `${item.name}: the password is gone from the stored DSN`)
    }
  }
  // A few exact shapes, so a refactor cannot keep the round-trip contract while
  // silently changing what the store holds.
  assert.equal(
    cfg.splitDsnPassword(`mysql://user:${PW}@127.0.0.1:3306/app`).dsn,
    'mysql://user@127.0.0.1:3306/app',
  )
  assert.equal(
    cfg.splitDsnPassword(`Server=127.0.0.1;Database=app;User Id=ops;Password=${PW};Encrypt=true`).dsn,
    'Server=127.0.0.1;Database=app;User Id=ops;Password=${DSH_DBHUB_DSN};Encrypt=true',
  )
  // Property values keep their exact quoting so the value token IS the credential.
  const quoted = cfg.splitDsnPassword(`Server=h;Password="${PW};tail"`)
  assert.equal(quoted.password, `"${PW};tail"`)
})

test('connLabel output is identical for the de-passworded DSN', () => {
  for (const item of CORPUS) {
    if (!item.split) continue
    const split = cfg.splitDsnPassword(item.dsn)
    assert.equal(
      cfg.connLabel(split.dsn),
      cfg.connLabel(item.dsn),
      `${item.name}: the metadata label must not change when the password moves out`,
    )
  }
  assert.equal(cfg.connLabel('mysql://user@127.0.0.1:3306/app'), 'mysql://127.0.0.1:3306/app')
  assert.equal(cfg.describeConn('mysql://user@127.0.0.1:3306/app').database, 'app')
  assert.equal(cfg.dsnUser('mysql://user@127.0.0.1:3306/app'), 'user')
})

// ── write path: the reference lands in the store, the value in the service ──

test('a card write splits the DSN, stores only the reference, and resolves it back', async () => {
  seedStore({})
  const creds = fakeCreds()
  const dsn = `mysql://user:${CANARY}@127.0.0.1:3306/app`
  const patches = await index.handleConfigOp(
    { op: 'set', workspace: WS, env: 'prod', dsn },
    makeCtx({ creds }),
    undefined,
    () => {},
    () => {},
    () => {},
  )
  assert.equal(patches.length, 1)

  // Read the REAL file: the canary must not be there, the reference must be.
  const text = readFileSync(storePath, 'utf8')
  assert.equal(text.includes(CANARY), false, 'credentials.json must not contain the database password')
  assert.ok(text.includes('DSH_DBHUB_DSN_'), 'credentials.json carries the reference')

  const row = findRow(WS, 'prod')
  assert.match(row.dsnPasswordRef, /^DSH_DBHUB_DSN_[0-9a-f]{8,12}$/)
  assert.equal(row.dsn, 'mysql://user@127.0.0.1:3306/app', 'the stored DSN is de-passworded')
  assert.equal(creds.calls.set.length, 1, 'the value went to the credential service')
  assert.equal(creds.calls.set[0].value, CANARY)
  assert.equal(creds.has(row.dsnPasswordRef), true)

  // The browser-facing patches are metadata only (no DSN, no ref).
  const patchText = JSON.stringify(patches)
  assert.equal(patchText.includes(CANARY), false)
  assert.equal(patchText.includes('DSH_DBHUB_DSN_'), false)

  // Execution/probing resolves the reference on every operation.
  const conn = await cfg.resolveEnvSecrets(creds, row)
  assert.equal(conn.dsn, dsn, 'the password is joined back byte-exactly')
  const again = await cfg.resolveEnvSecrets(creds, row)
  assert.equal(again.dsn, dsn)
  assert.deepEqual(creds.calls.resolve.slice(-2), [row.dsnPasswordRef, row.dsnPasswordRef], 'never cached')

  // The published summary is metadata only, carries no ref, and is not flagged.
  const summary = mcp.summarizeRows([row])[0]
  const summaryText = JSON.stringify(summary)
  assert.equal(summaryText.includes(CANARY), false)
  assert.equal(summaryText.includes('DSH_DBHUB_DSN_'), false)
  assert.equal(summary.passwordUnsplit, undefined)
  assert.equal(summary.conn, 'mysql://127.0.0.1:3306/app')
})

test('a property-style DSN round-trips through the store and the credential value', async () => {
  seedStore({})
  const creds = fakeCreds()
  const dsn = `Server=127.0.0.1;Database=app;User Id=ops;Password=${CANARY};Encrypt=true`
  await index.handleConfigOp(
    { op: 'add', workspace: WS, env: 'ado', dsn },
    makeCtx({ creds }),
    undefined,
    () => {},
    () => {},
    () => {},
  )
  const text = readFileSync(storePath, 'utf8')
  assert.equal(text.includes(CANARY), false)
  const row = findRow(WS, 'ado')
  assert.equal(row.dsn, 'Server=127.0.0.1;Database=app;User Id=ops;Password=${DSH_DBHUB_DSN};Encrypt=true')
  assert.match(row.dsnPasswordRef, /^DSH_DBHUB_DSN_/)
  assert.equal((await cfg.resolveEnvSecrets(creds, row)).dsn, dsn)
})

test('a write that cannot split keeps the DSN and warns once (no reference)', async () => {
  const c = await freshConfig()
  seedStore({})
  const creds = fakeCreds()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  let res
  try {
    // Two DIFFERENT property passwords: one reference cannot represent both.
    const dsn = `Server=127.0.0.1;Password=${PW};Pwd=${PW_LONG}`
    res = await c.encryptDsnPassword(creds, dsn)
    await c.encryptDsnPassword(creds, dsn)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(res.dsnPasswordRef, undefined, 'no reference is minted for an unsafe split')
  assert.ok(res.dsn.includes('Password='), 'the original DSN is kept')
  assert.equal(creds.calls.set.length, 0)
  const unsplitWarnings = warnings.filter((line) => line.includes(currentT('log.dsnUnsplit')))
  assert.equal(unsplitWarnings.length, 1, 'one warning for the whole process, not one per write')
  // The message names the situation, never a value or a path.
  assert.equal(unsplitWarnings[0].includes(CANARY), false)
  assert.equal(unsplitWarnings[0].includes(home), false)
})

// ── a reference with no value is a LOUD failure, never an empty password ──

test('an unresolvable database password fails explicitly and spawns no dbhub (send + probe)', async () => {
  seedStore({
    [WS]: {
      environments: {
        prod: { dsn: 'mysql://user@127.0.0.1:3306/app', source: 'user', updatedAt: 1, dsnPasswordRef: REF },
      },
    },
  })
  const creds = fakeCreds() // the ref exists in the row, but the value is gone

  // (a) the descriptor helper refuses instead of handing out a password-less DSN.
  await assert.rejects(
    () => cfg.resolveEnvSecrets(creds, findRow(WS, 'prod')),
    (err) => err && err.code === 'dsnSecretMissing',
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
  await tools.dbhub_list_sources.execute({}, exec) // warm the row cache
  const before = dbhubSpawns(specs).length
  const srcId = mcp.sourceIdOf({ title: 'app', wsPath: WS, env: 'prod' })
  const sent = await tools.dbhub_execute_sql.execute({ source: srcId, sql: 'SELECT 1' }, exec)
  assert.equal(sent.ok, false)
  assert.equal(sent.text, currentT('result.dsnSecretMissing'))
  assert.equal(dbhubSpawns(specs).length, before, 'a missing password must not start dbhub')

  // (c) the card connection test reports the same message and spawns nothing.
  const { specs: probeSpecs, subprocess: probeSubprocess } = recorder()
  const reports = []
  await index.handleConfigOp(
    { op: 'test', workspace: WS, env: 'prod', nonce: 'n1' },
    makeCtx({ creds }),
    probeSubprocess,
    (json) => reports.push(JSON.parse(json)),
    () => {},
    () => {},
  )
  assert.equal(reports.length, 1, 'the card always receives a report')
  assert.equal(reports[0].nonce, 'n1')
  assert.equal(reports[0].ok, false)
  assert.equal(reports[0].message, currentT('result.dsnSecretMissing'))
  assert.equal(dbhubSpawns(probeSpecs).length, 0, 'the probe must not start dbhub')
})

// ── boot migration: move the password out of old rows ──────────────────────

const legacyDoc = () => ({
  [WS]: {
    environments: {
      prod: { dsn: `mysql://user:${CANARY}@127.0.0.1:3306/app`, source: 'user', updatedAt: 1 },
    },
  },
})

test('migration moves a plaintext DSN password into a reference, and is idempotent', async () => {
  rmSync(storePath, { force: true })
  writeFileSync(storePath, JSON.stringify(legacyDoc(), null, 2))
  const c = await freshConfig()
  const creds = fakeCreds()

  const first = await c.migrateSecrets(creds)
  assert.equal(first.migratedDsn, 1)
  const afterFirst = readFileSync(storePath, 'utf8')
  assert.equal(afterFirst.includes(CANARY), false, 'the migrated file carries no plaintext password')
  const ref = JSON.parse(afterFirst)[WS].environments.prod.dsnPasswordRef
  assert.match(ref, /^DSH_DBHUB_DSN_[0-9a-f]{8,12}$/)
  assert.equal(creds.valueOf(ref), CANARY, 'the value now lives in the credential service')

  const setCalls = creds.calls.set.length
  const second = await c.migrateSecrets(creds)
  assert.equal(second.migratedDsn, 0, 'a row that already has a reference is skipped')
  assert.equal(creds.calls.set.length, setCalls, 'no second reference is minted')
  assert.equal(readFileSync(storePath, 'utf8'), afterFirst, 'an idempotent run rewrites nothing')

  // The migrated row still resolves for execution.
  const row = c.listWorkspaceEnvironments(c.store).find((r) => r.env === 'prod')
  assert.equal((await c.resolveEnvSecrets(creds, row)).dsn, `mysql://user:${CANARY}@127.0.0.1:3306/app`)
})

test('without the credentials service migration skips (plaintext kept) and warns once', async () => {
  rmSync(storePath, { force: true })
  writeFileSync(storePath, JSON.stringify(legacyDoc(), null, 2))
  const c = await freshConfig()
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let migrated
  try {
    migrated = await c.migrateSecrets(undefined)
    await c.migrateSecrets(undefined)
  } finally {
    console.warn = original
  }
  assert.equal(migrated.migratedDsn, 0)
  assert.equal(migrated.skipped, true)

  const unreadable = warnings.filter((line) => line.includes(currentT('log.credUnavailable')))
  assert.equal(unreadable.length, 1, 'the unavailable-service warning is emitted once')

  // Nothing was migrated: the file still carries the plaintext and no ref.
  const text = readFileSync(storePath, 'utf8')
  assert.ok(text.includes(CANARY), 'the legacy plaintext is preserved')
  assert.equal(text.includes('dsnPasswordRef'), false)

  // …and the connection still works without any credential service.
  const row = c.listWorkspaceEnvironments(c.store).find((r) => r.env === 'prod')
  const conn = await c.resolveEnvSecrets(undefined, row)
  assert.equal(conn.dsn, `mysql://user:${CANARY}@127.0.0.1:3306/app`)
})

test('a failing credential write during migration keeps the plaintext and warns once', async () => {
  rmSync(storePath, { force: true })
  writeFileSync(storePath, JSON.stringify(legacyDoc(), null, 2))
  const c = await freshConfig()
  const failing = {
    calls: { set: [] },
    async set(ref) {
      this.calls.set.push(ref)
      const err = new Error('credential store is not writable')
      err.code = 'EACCES'
      throw err
    },
    async unset() {},
    async resolve() { return undefined },
  }
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let migrated
  try {
    migrated = await c.migrateSecrets(failing)
  } finally {
    console.warn = original
  }
  assert.equal(migrated.migratedDsn, 0)
  assert.equal(failing.calls.set.length, 1, 'it really tried the credential store')
  const text = readFileSync(storePath, 'utf8')
  assert.ok(text.includes(CANARY), 'the plaintext stays so the connection keeps working')
  assert.equal(text.includes('dsnPasswordRef'), false, 'no reference without a stored value')
  const failedWarnings = warnings.filter((line) => line.includes(currentT('log.dsnSecretMigrateFailed')))
  assert.equal(failedWarnings.length, 1)
  assert.equal(failedWarnings[0].includes(CANARY), false, 'the warning carries no value')
})

test('a row whose password cannot be split is flagged on the card, never leaked', async () => {
  seedStore({})
  // What a host without the credentials service ends up with: the password is
  // still inside the DSN (the split succeeded but there was nowhere to store it).
  cfg.setWorkspaceEnv(WS, 'prod', `mysql://user:${CANARY}@127.0.0.1:3306/app`, 'user')
  const row = findRow(WS, 'prod')
  const summary = mcp.summarizeRows([row])[0]
  assert.equal(summary.passwordUnsplit, true, 'the card can tell the user the value is still local')
  const text = JSON.stringify(summary)
  assert.equal(text.includes(CANARY), false, 'the flag is a boolean status, not the value')
  assert.equal(text.includes('dsnPasswordRef'), false, 'no reference detail is published')
})

// ── lifecycle: copy shares, remove releases, rename leaves it alone ────────

test('promoting an auto-discovered environment splits its password', async () => {
  seedStore({})
  const creds = fakeCreds()
  const autoDsn = `mysql://user:${CANARY}@127.0.0.1:3306/auto`
  const res = await index.applyOptionsOp(
    { env: 'default', readOnly: true },
    { path: WS, title: 'app' },
    async () => ({ env: 'default', dsn: autoDsn }),
    creds,
  )
  assert.equal(res.error, undefined)
  const row = findRow(WS, 'default')
  assert.ok(row, 'the option write promoted the row')
  assert.equal(row.ro, true)
  assert.equal(row.dsn, 'mysql://user@127.0.0.1:3306/auto', 'the stored DSN carries no password')
  assert.match(row.dsnPasswordRef, /^DSH_DBHUB_DSN_/)
  assert.equal(readFileSync(storePath, 'utf8').includes(CANARY), false)
  assert.equal((await cfg.resolveEnvSecrets(creds, row)).dsn, autoDsn)
})

test('copyFrom shares the source reference (no new secret is created)', async () => {
  seedStore({})
  // A properly split source row: the stored DSN has no password, the value lives
  // under REF (this is what every new write produces).
  cfg.setWorkspaceEnv(OTHER, 'default', 'mysql://user@127.0.0.1:3306/src', 'user', { dsnPasswordRef: REF })
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
  assert.equal(row.dsnPasswordRef, REF, 'the reference is shared verbatim')
  assert.equal(row.dsn, 'mysql://user@127.0.0.1:3306/src')
  assert.equal(creds.calls.set.length, 0, 'copying must not mint a second secret')
  assert.ok(dbhubSpawns(specs).length >= 1, 'the post-copy probe still resolves the shared password')
  // The probe really received the ASSEMBLED DSN: the password is joined back for
  // the child process (host-side argv), while the model-facing text stays clean.
  const probeSpec = dbhubSpawns(specs)[dbhubSpawns(specs).length - 1]
  assert.equal(String(probeSpec.argv.join(' ')).includes(CANARY), true, 'the child gets the joined DSN')
  assert.equal(copied.text.includes(CANARY), false, 'the model-facing text carries no secret')
})

test('removing a row unsets an unreferenced password ref, but keeps a shared one', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', 'mysql://user@127.0.0.1:3306/a', 'user', { dsnPasswordRef: REF })
  // The copy shares the SAME reference (copyFrom's write).
  cfg.setWorkspaceEnv(WS, 'copy', 'mysql://user@127.0.0.1:3306/a', 'copied', { dsnPasswordRef: REF })
  const creds = fakeCreds({ [REF]: CANARY })
  const ctx = makeCtx({ creds })

  await index.handleConfigOp({ op: 'remove', workspace: WS, env: 'prod' }, ctx, undefined, () => {}, () => {}, () => {})
  assert.equal(findRow(WS, 'prod'), undefined)
  assert.equal(creds.calls.unset.length, 0, 'a ref still used by another row must not be unset')
  assert.equal(creds.valueOf(REF), CANARY)

  await index.handleConfigOp({ op: 'remove', workspace: WS, env: 'copy' }, ctx, undefined, () => {}, () => {}, () => {})
  assert.equal(findRow(WS, 'copy'), undefined)
  assert.deepEqual(creds.calls.unset, [REF], 'the last owner releases the credential')
  assert.equal(creds.has(REF), false)
})

test('rename moves the row but does not touch the password reference', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', 'mysql://user@127.0.0.1:3306/a', 'user', { dsnPasswordRef: REF })
  const creds = fakeCreds({ [REF]: CANARY })

  await index.handleConfigOp(
    { op: 'rename', workspace: WS, env: 'prod', newEnv: 'prod2' },
    makeCtx({ creds }),
    undefined,
    () => {},
    () => {},
    () => {},
  )
  const row = findRow(WS, 'prod2')
  assert.ok(row, 'the row moved')
  assert.equal(row.dsnPasswordRef, REF)
  assert.equal(creds.calls.set.length, 0)
  assert.equal(creds.calls.unset.length, 0)
})

test('changing the DSN drops the old reference and releases it', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(WS, 'prod', 'mysql://user:CHANGE_ME@127.0.0.1:3306/old', 'user')
  const creds = fakeCreds()
  const ctx = makeCtx({ creds })

  // First write: the old plaintext password is split and stored.
  await index.handleConfigOp({ op: 'set', workspace: WS, env: 'prod', dsn: `mysql://user:${CANARY}@127.0.0.1:3306/new` }, ctx, undefined, () => {}, () => {}, () => {})
  const oldRef = findRow(WS, 'prod').dsnPasswordRef
  assert.ok(oldRef)
  assert.equal(creds.valueOf(oldRef), CANARY)

  // Second write: a NEW password replaces the row; the old ref must be released.
  await index.handleConfigOp({ op: 'set', workspace: WS, env: 'prod', dsn: `mysql://user:${PW}@127.0.0.1:3306/new2` }, ctx, undefined, () => {}, () => {}, () => {})
  const row = findRow(WS, 'prod')
  assert.notEqual(row.dsnPasswordRef, oldRef)
  assert.equal(creds.has(oldRef), false, 'the replaced reference is released')
  assert.equal(creds.valueOf(row.dsnPasswordRef), PW)
  assert.equal((await cfg.resolveEnvSecrets(creds, row)).dsn, `mysql://user:${PW}@127.0.0.1:3306/new2`)

  // Third write: a DSN with NO password drops the reference entirely (and
  // releases the value) — a stored DSN never outlives a password it replaced.
  const secondRef = row.dsnPasswordRef
  await index.handleConfigOp({ op: 'set', workspace: WS, env: 'prod', dsn: 'mysql://user@127.0.0.1:3306/plain' }, ctx, undefined, () => {}, () => {}, () => {})
  const plain = findRow(WS, 'prod')
  assert.equal(plain.dsnPasswordRef, undefined)
  assert.equal(creds.has(secondRef), false, 'the now-unused reference is released')
  assert.equal((await cfg.resolveEnvSecrets(creds, plain)).dsn, 'mysql://user@127.0.0.1:3306/plain')
})
