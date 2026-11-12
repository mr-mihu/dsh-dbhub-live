// Session-permission gate tests: `dbhub_execute_sql` must respect the composer's
// permission mode, while the environment's own read-only switch keeps its hard
// refusal (dbhub's `[[tools]] readonly` stays the judge there).
//
// Two halves, deliberately:
//   1. the PURE classifier (`classifySql`) — every boundary the gate relies on:
//      comments (including a `;` inside one), a `;` inside quoted literals,
//      escaped and doubled quotes, backtick identifiers, multi-statement mixes,
//      `WITH … SELECT` vs `WITH … INSERT`, empty input and comments-only;
//   2. the END-TO-END gate through a fake dbhub + fake ctx: the four combinations
//      (environment read-only ON; session read-only / workspace-write / full
//      access) × read/write, the approval call count and its arguments, the
//      degradation paths (no `sandboxPolicy` service, `resolve` throwing, no
//      `approval` service, a throwing `approval.request`), and the hard rule
//      that a REFUSED write spawns nothing at all.
//
// Test isolation: config.mjs binds its storage paths at import time, so
// DSH_HOME points at a temp dir BEFORE importing. Desensitization convention:
// loopback host, CHANGE_ME secret.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-gate-'))
process.env.DSH_HOME = home
// runtime.mjs prefers a mise-managed dbhub; the fake subprocess is the one and
// only executable this file may resolve.
delete process.env.MISE_DATA_DIR

const storeDir = join(home, 'storages', 'dsh-dbhub-live')
mkdirSync(storeDir, { recursive: true })

const base = await import('../lib/config.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const i18n = await import('../lib/i18n.mjs')
const { registerCoreTools, classifySql, APPROVAL_SQL_HEAD_MAX } = await import('../lib/tools.mjs')

const DSN = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
const WS = 'D:/ws/gate'

if (!state.isEnabled()) state.setEnabled(true)

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

const seed = (env, extra) => {
  for (const key of Object.keys(base.store)) delete base.store[key]
  base.store[WS] = {
    environments: { [env]: { dsn: DSN, source: 'user', updatedAt: 1, ...(extra || {}) } },
  }
  base.saveStore(base.store)
}

/** Entries left in the temp-TOML directory (`[]` while it does not exist). */
function tmpEntries() {
  try {
    return readdirSync(join(storeDir, 'tmp'))
  } catch (e) {
    return []
  }
}

// ── the pure classifier ───────────────────────────────────────────────────

const READS = [
  '',
  '   ',
  '-- only a comment',
  '/* only a block comment */',
  'SELECT 1',
  '  select 1',
  'SHOW TABLES',
  'DESCRIBE app',
  'DESC app',
  'EXPLAIN SELECT 1',
  'VALUES (1)',
  'TABLE app',
  'PRAGMA table_info(app)',
  'WITH x AS (SELECT 1) SELECT * FROM x',
  'WITH x AS (SELECT 1), y AS (SELECT 2) SELECT * FROM y',
  'WITH RECURSIVE x(n) AS (SELECT 1) SELECT * FROM x',
  '-- lead\nSELECT 1',
  '/* lead */ SELECT 1',
  'SELECT 1 -- ; DROP TABLE app',
  'SELECT 1 # ; DROP TABLE app',
  'SELECT 1 /* ; DROP TABLE app */',
  "SELECT '; DROP TABLE app' AS s",
  "SELECT 1 FROM app WHERE name = 'a;b'",
  "SELECT 'it''s; DROP TABLE app'",
  "SELECT 'it\\'s; DROP TABLE app'",
  'SELECT `weird;name` FROM app',
  'SELECT 1 /*!80000 + 2 */',
]

const WRITES = [
  ['INSERT INTO app VALUES (1)', 'INSERT'],
  ['UPDATE app SET a = 1', 'UPDATE'],
  ['DELETE FROM app', 'DELETE'],
  ['DROP TABLE app', 'DROP'],
  ['TRUNCATE TABLE app', 'TRUNCATE'],
  ['REPLACE INTO app VALUES (1)', 'REPLACE'],
  ['CALL cleanup()', 'CALL'],
  ['EXEC cleanup', 'EXEC'],
  ['CREATE TABLE app (a int)', 'CREATE'],
  ['ALTER TABLE app ADD b int', 'ALTER'],
  ['MERGE INTO app USING src ON 1 = 1', 'MERGE'],
  ['GRANT SELECT ON app TO u', 'GRANT'],
  ['REVOKE SELECT ON app FROM u', 'REVOKE'],
  ['COPY app FROM x', 'COPY'],
  ['VACUUM', 'VACUUM'],
  ['ANALYZE app', 'ANALYZE'],
  ['SET NAMES utf8', 'SET'],
  ['USE app', 'USE'],
  ['BEGIN', 'BEGIN'],
  ['COMMIT', 'COMMIT'],
  ['WITH x AS (SELECT 1) INSERT INTO app SELECT * FROM x', 'INSERT'],
  // A `WITH` whose main statement cannot be located is a write: the keyword stays
  // `WITH` so the prompt still says what kind of statement it was.
  ['WITH x AS (SELECT 1) foo', 'WITH'],
  ['/*!40101 DROP TABLE app */', 'DROP'],
  ['/*!40101 SET NAMES utf8 */', 'SET'],
  // A statement that does not START with a word is not provably a read, so it is
  // a write (the conservative direction: one extra prompt, never a silent write).
  ['(SELECT 1) UNION (SELECT 2)', 'UNKNOWN'],
]

test('the classifier reads only statements that START with a read keyword', () => {
  for (const sql of READS) {
    assert.equal(classifySql(sql).writes, false, 'must be a read: ' + JSON.stringify(sql))
    assert.equal(classifySql(sql).keyword, '')
  }
})

test('every non-read statement — and every unknown one — is a write', () => {
  for (const [sql, keyword] of WRITES) {
    const verdict = classifySql(sql)
    assert.equal(verdict.writes, true, 'must be a write: ' + sql)
    assert.equal(verdict.keyword, keyword, 'keyword of: ' + sql)
  }
})

test('one write in a multi-statement text makes the WHOLE call a write', () => {
  assert.equal(classifySql('SELECT 1; DROP TABLE app').writes, true)
  assert.equal(classifySql('SELECT 1; DROP TABLE app').keyword, 'DROP')
  assert.equal(classifySql('SELECT 1; SELECT 2').writes, false)
  // A separator inside a comment or a literal is not a separator.
  assert.equal(classifySql('SELECT 1 /* ; DROP TABLE app */').writes, false)
  assert.equal(classifySql("SELECT '; DROP TABLE app'").writes, false)
  // …while a real separator after a quoted literal still splits.
  assert.equal(classifySql('SELECT `a;b` FROM app; DROP TABLE app').writes, true)
})

test('the offending statement is described by keyword + collapsed prefix only', () => {
  const verdict = classifySql('  -- note\n  DROP   TABLE\n  app  ')
  assert.equal(verdict.writes, true)
  assert.equal(verdict.keyword, 'DROP')
  assert.equal(verdict.statement, 'DROP TABLE app', 'comments are gone and whitespace is collapsed')
  assert.ok(APPROVAL_SQL_HEAD_MAX > 0 && APPROVAL_SQL_HEAD_MAX <= 120)
})

// ── end-to-end gate ───────────────────────────────────────────────────────

/** A fake dbhub child that answers initialize and one tools/call. */
function fakeDbhub(receiptText) {
  const calls = []
  let spawns = 0
  const subprocess = {
    resolveExecutable: async (name) => '/fake/bin/' + name,
    spawn() {
      spawns += 1
      const stdin = new EventEmitter()
      const handle = {
        stdin,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        terminate() {},
        waitForExit: async () => ({ exitCode: 0 }),
        done: new Promise(() => {}),
      }
      const reply = (msg, result) => handle.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
      stdin.write = (text) => {
        const msg = JSON.parse(String(text).trim())
        if (msg.method === 'initialize') return reply(msg, { protocolVersion: '2025-03-26', capabilities: {} })
        if (msg.method === 'tools/call') {
          calls.push(msg.params)
          return reply(msg, { content: [{ type: 'text', text: receiptText }] })
        }
        return undefined
      }
      return handle
    },
  }
  return { subprocess, calls, spawnCount: () => spawns }
}

/**
 * Fake plugin ctx. `mode` is what `sandboxPolicy.resolve()` answers; the flags
 * remove a service or make it throw, so every degradation path is reachable.
 */
function harness(opts) {
  const o = opts || {}
  const captured = {}
  const approvals = []
  const resolves = []
  const services = {
    workspaceRegistry: { list: async () => [{ path: WS, title: 'gate' }] },
  }
  if (!o.policyMissing) {
    services.sandboxPolicy = {
      resolve(request) {
        resolves.push(request)
        if (o.policyThrows) throw new Error('unusable session cwd')
        return { mode: o.mode }
      },
    }
  }
  if (!o.approvalMissing) {
    services.approval = {
      async request(request) {
        approvals.push(request)
        if (o.approvalThrows) throw new Error('no open turn')
        return o.outcome === undefined ? 'allowed-once' : o.outcome
      },
    }
  }
  const ctx = {
    tools: { register: (def) => { captured[def.name] = def; return () => {} } },
    get: (name) => services[name],
    inject: () => {},
  }
  return { captured, ctx, approvals, resolves }
}

const RECEIPT = JSON.stringify({ statements: [{ sql: 'x', rows: [{ n: 1 }], count: 1 }], source_id: 'default' })

/**
 * Run one `dbhub_execute_sql` call through the real tool.
 * @returns `{ out, calls, spawns, approvals, resolves, exec }`.
 */
async function runTool(sql, opts) {
  const o = opts || {}
  const env = o.env || 'default'
  seed(env, env === 'ro' ? { readOnly: true } : undefined)
  const { subprocess, calls, spawnCount } = fakeDbhub(RECEIPT)
  const { captured, ctx, approvals, resolves } = harness(o)
  registerCoreTools(ctx, subprocess)
  const sourceId = mcp.sourceIdOf({ title: 'gate', wsPath: WS, env })
  const exec = {
    agent: { session: { header: { cwd: WS } } },
    ...(o.noCallId ? {} : { callId: 'call-1' }),
    name: 'dbhub_execute_sql',
    signal: undefined,
  }
  const out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql }, exec)
  return { out, calls, spawns: spawnCount(), approvals, resolves, exec }
}

const WRITE_SQL = 'DROP TABLE app'
const READ_SQL = 'SELECT 1'

test('environment read-only ON: unchanged — no gate, no approval, dbhub decides', async () => {
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const r = await runTool(WRITE_SQL, { env: 'ro', mode })
    assert.equal(r.approvals.length, 0, 'the session gate must not fire when the env switch is on: ' + mode)
    assert.equal(r.calls.length, 1, 'dbhub is still spawned (README: dbhub owns this refusal): ' + mode)
  }
})

test('session read-only: reads run, writes are refused locally with zero spawn', async () => {
  const read = await runTool(READ_SQL, { mode: 'read-only' })
  assert.equal(read.out.ok, true)
  assert.equal(read.calls.length, 1, 'a read is allowed in a read-only session')
  assert.equal(read.approvals.length, 0)

  const before = tmpEntries()
  const write = await runTool(WRITE_SQL, { mode: 'read-only' })
  assert.equal(write.out.ok, false)
  assert.ok(String(write.out.text).includes('仅可查看'), write.out.text)
  assert.ok(String(write.out.text).includes('切换'), 'the refusal tells the user what to change: ' + write.out.text)
  assert.equal(write.calls.length, 0, 'a refused write never reaches dbhub')
  assert.equal(write.spawns, 0, 'a refused write never spawns dbhub')
  assert.equal(write.approvals.length, 0, 'read-only mode does not ask, it refuses')
  assert.deepEqual(tmpEntries(), before, 'a refused write writes no temporary TOML')
})

test('session workspace-write: reads run unanswered, writes ask exactly once', async () => {
  const read = await runTool(READ_SQL, { mode: 'workspace-write' })
  assert.equal(read.out.ok, true)
  assert.equal(read.calls.length, 1)
  assert.equal(read.approvals.length, 0, 'a read never prompts')

  const write = await runTool(WRITE_SQL, { mode: 'workspace-write', outcome: 'allowed-once' })
  assert.equal(write.out.ok, true)
  assert.equal(write.approvals.length, 1, 'exactly one prompt per write call')
  // The policy probe is asked about THIS call's session, not about the process.
  assert.deepEqual(write.resolves, [{ session: write.exec.agent.session }])
  const req = write.approvals[0]
  assert.equal(req.agent, write.exec.agent, 'the request rides this call agent')
  assert.equal(req.toolName, 'dbhub_execute_sql')
  assert.equal(req.callId, 'call-1')
  assert.equal(req.displayReason, req.reason, 'the presentation copy is the localized reason')
  assert.ok(String(req.reason).includes('gate'), 'the prompt names the source handle: ' + req.reason)
  assert.ok(String(req.reason).includes('DROP'), 'the prompt names the statement type: ' + req.reason)
  assert.equal(String(req.reason).includes(DSN), false, 'no DSN in the prompt')
  assert.equal(String(req.reason).includes('CHANGE_ME'), false, 'no password in the prompt')
  assert.equal(String(req.reason).includes('\n'), false, 'the reason is one line (it becomes a card title)')
  assert.equal(write.calls.length, 1, 'approval grants the write, dbhub then runs it')
})

test('a long statement is echoed only as a scrubbed prefix, never whole', async () => {
  const longName = 'a_' + 'x'.repeat(APPROVAL_SQL_HEAD_MAX + 40)
  const r = await runTool('DROP TABLE ' + longName, { mode: 'workspace-write', outcome: 'allowed-once' })
  assert.equal(r.approvals.length, 1)
  const reason = String(r.approvals[0].reason)
  const head = classifySql('DROP TABLE ' + longName).statement.slice(0, APPROVAL_SQL_HEAD_MAX)
  assert.ok(reason.includes(head), 'the prefix is shown: ' + reason)
  assert.equal(reason.includes(longName), false, 'the tail of a long statement is cut: ' + reason)
})

test('the approval request omits callId when the call has none', async () => {
  const r = await runTool(WRITE_SQL, { mode: 'workspace-write', noCallId: true })
  assert.equal(r.approvals.length, 1)
  assert.equal('callId' in r.approvals[0], false, 'callId is only forwarded when present')
})

test('a rejected / cancelled / unavailable approval is a localized refusal with zero spawn', async () => {
  for (const [outcome, needle] of [
    ['rejected', '用户拒绝'],
    ['cancelled', '用户拒绝'],
    ['unavailable', '无法弹窗'],
  ]) {
    const before = tmpEntries()
    const r = await runTool(WRITE_SQL, { mode: 'workspace-write', outcome })
    assert.equal(r.out.ok, false, outcome)
    assert.ok(String(r.out.text).includes(needle), outcome + ': ' + r.out.text)
    if (outcome === 'unavailable') {
      assert.ok(String(r.out.text).includes('从不询问'), 'the refusal explains the never-ask policy')
    }
    assert.ok(String(r.out.text).includes('不要改用'), 'the refusal forbids routing around the plugin')
    assert.equal(r.calls.length, 0, outcome + ': dbhub must not run')
    assert.equal(r.spawns, 0, outcome + ': dbhub must not spawn')
    assert.deepEqual(tmpEntries(), before, outcome + ': no temporary TOML either')
  }
})

test('session full access: a write runs without any prompt', async () => {
  const r = await runTool(WRITE_SQL, { mode: 'danger-full-access' })
  assert.equal(r.out.ok, true)
  assert.equal(r.approvals.length, 0)
  assert.equal(r.calls.length, 1)
})

test('no sandboxPolicy service: the plugin keeps its old behaviour (no gate)', async () => {
  const r = await runTool(WRITE_SQL, { policyMissing: true })
  assert.equal(r.out.ok, true, 'headless/SDK deployments must not break')
  assert.equal(r.calls.length, 1)
  assert.equal(r.approvals.length, 0)
})

test('sandboxPolicy.resolve() throwing disables the gate and warns exactly once', async () => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    const first = await runTool(WRITE_SQL, { policyThrows: true, mode: 'read-only' })
    const second = await runTool(WRITE_SQL, { policyThrows: true, mode: 'read-only' })
    assert.equal(first.out.ok, true, 'a broken permission probe must not block the call')
    assert.equal(second.out.ok, true)
    assert.equal(first.calls.length, 1)
  } finally {
    console.warn = original
  }
  const gateWarnings = warnings.filter((line) => line.includes('会话权限'))
  assert.equal(gateWarnings.length, 1, 'exactly one warning for the whole process: ' + JSON.stringify(warnings))
  assert.equal(gateWarnings[0].includes(WS), false, 'the warning carries no path')
  assert.equal(gateWarnings[0].includes(DSN), false, 'the warning carries no DSN')
})

test('no approval service (or a throwing one) fails CLOSED on a write', async () => {
  for (const opts of [{ mode: 'workspace-write', approvalMissing: true }, { mode: 'workspace-write', approvalThrows: true }]) {
    const before = tmpEntries()
    const r = await runTool(WRITE_SQL, opts)
    assert.equal(r.out.ok, false, JSON.stringify(opts))
    assert.ok(String(r.out.text).includes('写操作已拒绝'), r.out.text)
    assert.equal(r.calls.length, 0)
    assert.equal(r.spawns, 0)
    assert.deepEqual(tmpEntries(), before)
  }
})

test('search_objects is untouched by the gate (it is a read by construction)', async () => {
  seed('default')
  const { subprocess, calls } = fakeDbhub(RECEIPT)
  const { captured, ctx } = harness({ mode: 'read-only' })
  registerCoreTools(ctx, subprocess)
  const sourceId = mcp.sourceIdOf({ title: 'gate', wsPath: WS, env: 'default' })
  const out = await captured.dbhub_search_objects.execute(
    { source: sourceId, object_type: 'table' }, { agent: { session: { header: { cwd: WS } } } },
  )
  assert.equal(out.ok, true)
  assert.equal(calls.length, 1, 'search_objects keeps spawning regardless of the session mode')
})

// ── copy gate ─────────────────────────────────────────────────────────────

test('the session-permission copy exists in both locales and stays English in en', () => {
  for (const key of [
    'result.sessionReadOnly', 'result.writeDenied', 'result.writeNoApproval',
    'result.writeApprovalError', 'approval.writeReason',
    'log.policyResolveFailed', 'log.approvalRequestFailed',
  ]) {
    assert.notEqual(i18n.tFor('zh', key), key, 'missing zh key: ' + key)
    assert.notEqual(i18n.tFor('en', key), key, 'missing en key: ' + key)
    assert.equal(/[\u4e00-\u9fff]/.test(i18n.tFor('en', key)), false, 'en copy must stay English: ' + key)
  }
  const en = i18n.tFor('en', 'approval.writeReason', { src: 'app_ab12', kind: 'DROP', head: 'DROP TABLE app' })
  assert.ok(en.includes('app_ab12') && en.includes('DROP'), en)
})
