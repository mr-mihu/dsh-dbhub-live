// Drag & drop backend: per-workspace display order (`order`), cross-workspace
// move, and row copy. Contract (the UI half drives these):
//
//   { op:'reorder', workspace, order:[...] }          — permutation or badOrder
//   { op:'move', env, workspace, toWorkspace, index } — atomic across both sides
//   { op:'copy', env, workspace, newEnv? }            — clone below the source
//
// The store model is `{ [wsPath]: { environments: {...}, order: string[] } }`.
// These tests pin: order maintenance in the EXISTING ops, zero-write refusals,
// the single write of a move, shared credential references (a copy never mints a
// secret and removing one owner never unsets a value the other still uses), and
// the `/state` shape (order is names only — never a DSN, never a secret).
//
// Desensitization: loopback hosts, CHANGE_ME, synthetic ref names only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-order-'))
process.env.DSH_HOME = home
delete process.env.MISE_DATA_DIR

const cfg = await import('../lib/config.mjs')
const index = await import('../lib/index.mjs')
const mcp = await import('../lib/mcp.mjs')
const { currentT } = await import('../lib/i18n.mjs')

const APP = 'D:/work/app'
const OTHER = 'D:/work/other'
const DSN = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
// The shape the store keeps after the password was split into a credential ref.
const DSN_SPLIT = 'mysql://user@127.0.0.1:3306/app'
const SSH_REF = 'DSH_DBHUB_SSH_' + 'ab12cd34ef'
const DSN_REF = 'DSH_DBHUB_DSN_' + 'cd34ef56ab'

const readStore = () => JSON.parse(readFileSync(cfg.STORE_PATH, 'utf8'))

/** Reset the shared singleton store (and its file) to a fixture / empty. */
function seedStore(doc) {
  for (const key of Object.keys(cfg.store)) delete cfg.store[key]
  Object.assign(cfg.store, cfg.normalizeStore(doc || {}))
  cfg.saveStore(cfg.store)
}

/** The plain config singleton the command handler reads/writes. */
const row = (wsPath, env) => cfg
  .listWorkspaceEnvironments(cfg.store)
  .find((r) => r.wsPath === wsPath && r.env === env)

/** Minimal ctx: the command handler only needs the workspace registry here. */
function makeCtx(creds) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') {
        return { list: async () => [{ path: APP, title: 'app' }, { path: OTHER, title: 'other' }] }
      }
      if (name === 'credentials') return creds
      return undefined
    },
  }
}

/** Drive one card command through the real handler; collect its notices. */
async function runOp(op, creds) {
  const patches = []
  let notice = ''
  const result = await index.handleConfigOp(
    op,
    makeCtx(creds),
    undefined,
    () => {},
    (p) => { patches.push(...(Array.isArray(p) ? p : [])) },
    (text) => { notice = String(text || '') },
  )
  return { patches: result, mirrored: patches, notice }
}

/** A fake credentials service with call bookkeeping (never touches ~/.dsh). */
function fakeCreds(values) {
  const store = new Map(Object.entries(values || {}))
  const calls = { set: [], unset: [], resolve: [] }
  return {
    calls,
    has: (ref) => store.has(ref),
    valueOf: (ref) => store.get(ref),
    async set(ref, value) { calls.set.push({ ref, value }); store.set(ref, value) },
    async unset(ref) { calls.unset.push(ref); store.delete(ref) },
    async resolve(ref) {
      calls.resolve.push(ref)
      return store.has(ref) ? { value: store.get(ref), source: 'test' } : undefined
    },
  }
}

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── reorder ───────────────────────────────────────────────────────────────

test('reorder persists a permutation and refuses anything else with zero writes', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'alpha', DSN, 'user')
  cfg.setWorkspaceEnv(APP, 'beta', DSN, 'user')
  cfg.setWorkspaceEnv(APP, 'gamma', DSN, 'user')
  assert.deepEqual(cfg.workspaceOrder(APP), ['alpha', 'beta', 'gamma'], 'adds append to the end')

  const ok = await runOp({ op: 'reorder', workspace: APP, order: ['gamma', 'alpha', 'beta'] })
  assert.equal(ok.notice, '')
  assert.deepEqual(readStore()[APP].order, ['gamma', 'alpha', 'beta'])
  assert.deepEqual(cfg.workspaceOrder(APP), ['gamma', 'alpha', 'beta'])
  assert.equal(ok.patches[0].op, 'order')
  assert.deepEqual(ok.patches[0].order, ['gamma', 'alpha', 'beta'])

  // Every shape that is not an exact permutation is refused and the file is
  // byte-identical afterwards.
  const before = readFileSync(cfg.STORE_PATH, 'utf8')
  for (const bad of [
    ['gamma', 'alpha'],             // missing a name
    ['gamma', 'alpha', 'beta', 'x'], // extra name
    ['gamma', 'alpha', 'alpha'],    // duplicate
    'gamma,alpha,beta',             // not an array
    [1, 2, 3],                      // not strings
    ['Gamma', 'ALPHA', 'BETA'],     // unknown spellings
  ]) {
    const refused = await runOp({ op: 'reorder', workspace: APP, order: bad })
    assert.equal(refused.notice, currentT('result.badOrder'), JSON.stringify(bad))
    assert.deepEqual(refused.patches, [])
    assert.equal(readFileSync(cfg.STORE_PATH, 'utf8'), before, 'a bad order must not touch the store')
  }
})

// ── move ──────────────────────────────────────────────────────────────────

test('move transfers the whole row across workspaces in ONE store write', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'prod', DSN, 'user', {
    readOnly: true,
    ssh: { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', passwordRef: SSH_REF },
  })
  cfg.setWorkspaceEnv(APP, 'dev', DSN, 'user')
  cfg.setWorkspaceEnv(OTHER, 'qa', DSN, 'user')

  // Count the atomic persist: one tmp+rename per saveStore.
  let renames = 0
  cfg.setFsHooks({ renameSync: (...args) => { renames += 1; renameSync(...args) } })
  let moved
  try {
    moved = await runOp({ op: 'move', workspace: APP, env: 'dev', toWorkspace: OTHER, index: 0 })
  } finally {
    cfg.setFsHooks(null)
  }
  assert.equal(moved.notice, '')
  assert.equal(renames, 1, 'both sides are persisted by a single write')
  assert.equal(row(APP, 'dev'), undefined, 'the row left the source workspace')
  assert.ok(row(OTHER, 'dev'), 'the row arrived in the target workspace')
  assert.deepEqual(cfg.workspaceOrder(APP), ['prod'])
  assert.deepEqual(cfg.workspaceOrder(OTHER), ['dev', 'qa'])
  assert.equal(moved.patches[0].op, 'remove')
  const addPatch = moved.patches.find((p) => p.op === 'add')
  assert.equal(addPatch.env, 'dev')
  assert.equal(addPatch.path, OTHER)
  assert.equal(addPatch.index, 0)

  // The ROW DATA travelled: options and credential references are the same row,
  // not a stripped copy.
  cfg.setWorkspaceEnv(OTHER, 'deep', DSN, 'user', {
    readOnly: true,
    ssh: { host: '192.0.2.11', port: 22, user: 'ops', auth: 'password', passwordRef: SSH_REF },
    dsnPasswordRef: DSN_REF,
    maxRows: 42,
  })
  await runOp({ op: 'move', workspace: OTHER, env: 'deep', toWorkspace: APP, index: 99 })
  const deep = cfg.store[APP].environments.deep
  assert.equal(deep.ro, undefined)
  assert.equal(deep.readOnly, true)
  assert.equal(deep.ssh.passwordRef, SSH_REF)
  assert.equal(deep.dsnPasswordRef, DSN_REF)
  assert.equal(deep.maxRows, 42, 'the store row is moved verbatim')
  assert.deepEqual(cfg.workspaceOrder(APP), ['prod', 'deep'], 'an out-of-range index appends')

  // Clamping is reported back to the card.
  const clamped = await runOp({ op: 'move', workspace: APP, env: 'deep', toWorkspace: OTHER, index: 99 })
  assert.equal(clamped.notice, '')
  const clampedAdd = clamped.patches.find((p) => p.op === 'add')
  assert.equal(clampedAdd.index, cfg.workspaceOrder(OTHER).length - 1)

  // Moving the LAST environment out drops the source workspace entry entirely.
  await runOp({ op: 'move', workspace: APP, env: 'prod', toWorkspace: OTHER, index: 0 })
  assert.equal(cfg.store[APP], undefined, 'an emptied workspace entry disappears')
  assert.deepEqual(cfg.workspaceOrder(APP), [])
})

test('a same-workspace move repositions within the order', async () => {
  seedStore({})
  for (const env of ['a', 'b', 'c']) cfg.setWorkspaceEnv(APP, env, DSN, 'user')
  const res = await runOp({ op: 'move', workspace: APP, env: 'a', toWorkspace: APP, index: 2 })
  assert.equal(res.notice, '')
  assert.deepEqual(cfg.workspaceOrder(APP), ['b', 'c', 'a'])
  assert.equal(res.patches[0].op, 'remove')
  assert.equal(res.patches[1].path, APP)
})

test('move refuses unknown target/env and a target-name collision without writing', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'prod', DSN, 'user')
  cfg.setWorkspaceEnv(OTHER, 'prod', DSN, 'user')
  const before = readFileSync(cfg.STORE_PATH, 'utf8')

  const unknownWs = await runOp({ op: 'move', workspace: APP, env: 'prod', toWorkspace: 'D:/work/nope', index: 0 })
  assert.equal(unknownWs.notice, currentT('result.wsNotFound', { ws: 'D:/work/nope' }))
  assert.deepEqual(unknownWs.patches, [])

  const blankWs = await runOp({ op: 'move', workspace: APP, env: 'prod', toWorkspace: '  ', index: 0 })
  assert.equal(blankWs.notice, currentT('result.wsNotFound', { ws: '-' }), 'a blank target never means "the first workspace"')

  const unknownEnv = await runOp({ op: 'move', workspace: APP, env: 'ghost', toWorkspace: OTHER, index: 0 })
  assert.equal(unknownEnv.notice, currentT('result.unknownEnv', { env: 'ghost' }))

  const collision = await runOp({ op: 'move', workspace: APP, env: 'prod', toWorkspace: OTHER, index: 0 })
  assert.equal(collision.notice, currentT('result.copyCollision', { env: 'prod' }), 'never auto-renamed')

  assert.equal(readFileSync(cfg.STORE_PATH, 'utf8'), before, 'every refusal is zero-write')
})

// ── copy ──────────────────────────────────────────────────────────────────

test('copy clones the row below its source with -copy-1 / -copy-2 naming', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'prod', DSN, 'user', {
    readOnly: true,
    ssh: { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', passwordRef: SSH_REF },
    dsnPasswordRef: DSN_REF,
    maxRows: 77,
  })
  cfg.setWorkspaceEnv(APP, 'tail', DSN, 'user')
  const source = cfg.store[APP].environments.prod
  const updatedAtBefore = source.updatedAt

  const first = await runOp({ op: 'copy', workspace: APP, env: 'prod' })
  assert.equal(first.notice, '')
  assert.equal(first.patches[0].env, 'prod-copy-1')
  assert.deepEqual(cfg.workspaceOrder(APP), ['prod', 'prod-copy-1', 'tail'], 'the copy sits right below its source')
  const copy = cfg.store[APP].environments['prod-copy-1']
  assert.equal(copy.dsn, source.dsn)
  assert.equal(copy.readOnly, true, 'read-only is copied')
  assert.equal(copy.ssh.passwordRef, SSH_REF, 'the tunnel reference is shared, not re-minted')
  assert.equal(copy.dsnPasswordRef, DSN_REF, 'the DSN reference is shared')
  assert.equal(copy.source, 'copy')
  assert.ok(copy.updatedAt >= updatedAtBefore)
  assert.equal('maxRows' in copy, false, 'the deprecated per-row cap is never copied')

  const second = await runOp({ op: 'copy', workspace: APP, env: 'prod' })
  assert.equal(second.patches[0].env, 'prod-copy-2')
  const third = await runOp({ op: 'copy', workspace: APP, env: 'prod-copy-1' })
  assert.equal(third.patches[0].env, 'prod-copy-1-copy-1', 'the suffix follows the SOURCE name')

  const explicit = await runOp({ op: 'copy', workspace: APP, env: 'prod', newEnv: 'renamed-copy' })
  assert.equal(explicit.patches[0].env, 'renamed-copy')
  assert.deepEqual(cfg.workspaceOrder(APP).indexOf('renamed-copy'), cfg.workspaceOrder(APP).indexOf('prod') + 1)

  // A max-length source name still yields a DISTINCT, in-limit copy name (the
  // naive `<name>-copy-1` would be truncated back onto the source and loop).
  const longName = 'e'.repeat(cfg.ENV_NAME_MAX)
  cfg.setWorkspaceEnv(APP, longName, DSN, 'user')
  const longCopy = await runOp({ op: 'copy', workspace: APP, env: longName })
  const generated = longCopy.patches[0].env
  assert.notEqual(generated, longName)
  assert.ok(generated.length <= cfg.ENV_NAME_MAX)
  assert.ok(generated.endsWith('-copy-1'), generated)
})

test('copy refuses an explicit collision / unknown source without writing', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'prod', DSN, 'user')
  cfg.setWorkspaceEnv(APP, 'tail', DSN, 'user')
  const before = readFileSync(cfg.STORE_PATH, 'utf8')

  const collision = await runOp({ op: 'copy', workspace: APP, env: 'prod', newEnv: 'tail' })
  assert.equal(collision.notice, currentT('result.copyCollision', { env: 'tail' }))
  assert.deepEqual(collision.patches, [])

  const ghost = await runOp({ op: 'copy', workspace: APP, env: 'ghost' })
  assert.equal(ghost.notice, currentT('result.unknownEnv', { env: 'ghost' }))
  assert.equal(readFileSync(cfg.STORE_PATH, 'utf8'), before, 'refusals write nothing')
})

test('the copy shares the credential reference: deleting the original keeps the value alive', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'prod', DSN_SPLIT, 'user', {
    ssh: { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', passwordRef: SSH_REF },
    dsnPasswordRef: DSN_REF,
  })
  const creds = fakeCreds({ [SSH_REF]: 'CHANGE_ME', [DSN_REF]: 'DB_CANARY' })

  const copied = await runOp({ op: 'copy', workspace: APP, env: 'prod' }, creds)
  assert.equal(copied.patches[0].env, 'prod-copy-1')
  assert.equal(creds.calls.set.length, 0, 'copying never mints a new secret')

  // Removing the ORIGINAL must not unset references the copy still names.
  const removed = await runOp({ op: 'remove', workspace: APP, env: 'prod' }, creds)
  assert.equal(removed.notice, '')
  assert.equal(row(APP, 'prod'), undefined)
  assert.deepEqual(creds.calls.unset, [], 'the shared refs stay while the copy exists')

  // The copy still resolves the same values through the shared refs.
  const copyRow = row(APP, 'prod-copy-1')
  assert.equal(copyRow.ssh.passwordRef, SSH_REF)
  const resolved = await cfg.resolveEnvSecrets(creds, {
    dsn: copyRow.dsn,
    ro: false,
    ssh: copyRow.ssh,
    dsnPasswordRef: copyRow.dsnPasswordRef,
  })
  // Joined at runtime so no test fixture ever spells a credentialed URL.
  const expectedDsn = DSN_SPLIT.replace('user@', 'user:' + 'DB_CANARY' + '@')
  assert.equal(resolved.dsn, expectedDsn)
  assert.equal(resolved.ssh.password, 'CHANGE_ME')

  // Removing the last owner releases them.
  await runOp({ op: 'remove', workspace: APP, env: 'prod-copy-1' }, creds)
  assert.deepEqual(creds.calls.unset.sort(), [DSN_REF, SSH_REF].sort())
})

// ── the existing ops maintain order ───────────────────────────────────────

test('rename / remove / add keep the display order in step', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'prod', DSN, 'user')
  cfg.setWorkspaceEnv(APP, 'dev', DSN, 'user')
  assert.deepEqual(cfg.workspaceOrder(APP), ['prod', 'dev'])

  // add: appended; updating an existing name does not move it.
  cfg.setWorkspaceEnv(APP, 'qa', DSN, 'user')
  cfg.setWorkspaceEnv(APP, 'prod', 'mysql://user:CHANGE_ME@127.0.0.1:3306/app2', 'user')
  assert.deepEqual(cfg.workspaceOrder(APP), ['prod', 'dev', 'qa'])

  const renamed = await runOp({ op: 'rename', workspace: APP, env: 'dev', newEnv: 'staging' })
  assert.equal(renamed.notice, '')
  assert.deepEqual(cfg.workspaceOrder(APP), ['prod', 'staging', 'qa'], 'the name changes in place')

  const removed = await runOp({ op: 'remove', workspace: APP, env: 'prod' })
  assert.equal(removed.notice, '')
  assert.deepEqual(cfg.workspaceOrder(APP), ['staging', 'qa'], 'the removed name leaves the order')

  // The stored order survives a reload (normalizeStore keeps it byte-for-byte).
  assert.deepEqual(cfg.normalizeStore(readStore()), readStore())
})

test('legacy data without order reads in name order; a new name still appends', async () => {
  seedStore({
    [APP]: {
      environments: {
        prod: { dsn: DSN, source: 'user', updatedAt: 1 },
        zeta: { dsn: DSN, source: 'user', updatedAt: 1 },
      },
    },
  })
  assert.deepEqual(cfg.workspaceOrder(APP), ['prod', 'zeta'], 'the name-order fallback needs no migration')
  cfg.setWorkspaceEnv(APP, 'aaa', DSN, 'user')
  assert.deepEqual(
    cfg.workspaceOrder(APP),
    ['prod', 'zeta', 'aaa'],
    'a brand-new name appends to the end — it is never sorted into the unmentioned tail',
  )
})

// ── load-time cleaning ────────────────────────────────────────────────────

test('normalizeStore cleans `order` (strings, trim, dedupe) and keeps unknown fields', () => {
  const doc = {
    [APP]: {
      futureWorkspaceFlag: { kept: true },
      order: ['beta', 'alpha', 'beta', 7, '', '  alpha  '],
      environments: {
        alpha: { dsn: DSN, source: 'user' },
        beta: { dsn: DSN, source: 'user' },
      },
    },
  }
  const normalized = cfg.normalizeStore(doc)
  assert.deepEqual(normalized[APP].order, ['beta', 'alpha'])
  assert.deepEqual(normalized[APP].futureWorkspaceFlag, { kept: true }, 'unknown workspace fields survive')
  assert.deepEqual(cfg.workspaceOrderOf(normalized[APP].environments, normalized[APP].order), ['beta', 'alpha'])
  // A non-array order is dropped rather than kept as an unknown field.
  const invalid = cfg.normalizeStore({ [APP]: { order: 'beta,alpha', environments: { alpha: { dsn: DSN } } } })
  assert.equal('order' in invalid[APP], false)
})

// ── /state surface ────────────────────────────────────────────────────────

test('/state exposes the stored order on every row of a workspace — names only', async () => {
  seedStore({})
  cfg.setWorkspaceEnv(APP, 'prod', DSN, 'user', { ssh: { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', passwordRef: SSH_REF } })
  cfg.setWorkspaceEnv(APP, 'dev', DSN, 'user')
  await runOp({ op: 'reorder', workspace: APP, order: ['dev', 'prod'] })

  // Rows as a walk would hand them over (persisted rows + one auto-only workspace).
  const rows = [
    { wsPath: APP, title: 'app', env: 'dev', dsn: DSN, source: 'persisted(user)', persisted: true, ro: false, ssh: null, maxRows: 0 },
    { wsPath: APP, title: 'app', env: 'prod', dsn: DSN, source: 'persisted(user)', persisted: true, ro: false, ssh: null, maxRows: 0 },
    { wsPath: OTHER, title: 'other', env: 'default', dsn: 'mysql://127.0.0.1:3306/env', source: '工作目录 .env', persisted: false, ro: false, ssh: null, maxRows: 0 },
  ]
  const summaries = mcp.summarizeRows(rows)
  const appRows = summaries.filter((r) => r.path === APP)
  assert.equal(appRows.length, 2)
  for (const r of appRows) assert.deepEqual(r.order, ['dev', 'prod'], 'every row of the group carries the order')
  const autoRow = summaries.find((r) => r.path === OTHER)
  assert.equal('order' in autoRow, false, 'a workspace with no persisted rows carries no order')

  const text = JSON.stringify(summaries)
  assert.equal(text.includes('CHANGE_ME'), false, 'no credential value on the wire')
  assert.equal(text.includes('"dsn"'), false, 'no DSN on the wire')
  assert.equal(text.includes(SSH_REF), false, 'no credential reference on the wire')
  assert.equal(text.includes(DSN_REF), false)
})
