// PR-5: source identity must be INJECTIVE inside one workspace, and a write must
// never strip unknown store fields.
//
// Measured before the fix (P1-12): `envSlug('prod')` / `envSlug('PROD')` /
// `envSlug('Prod')` all produced `prod`, `!!!` and a real environment named `env`
// both produced `env`, and two names that only differ past the ENV_NAME_MAX cap
// produced the same store key. Two rows of one workspace then carried the SAME
// source id, so `resolveSource` answered `{ambiguous}` forever — the model could
// not reach EITHER connection.
//
// Measured before the fix (P1-13): `setWorkspaceEnv` rebuilt the workspace entry
// (`{ environments }`) and the environment entry from scratch, so one write
// erased every field this build does not know — undoing the "unknown fields are
// preserved" promise that `normalizeStore` makes on load.
//
// Desensitization: loopback / documentation hosts and CHANGE_ME secrets only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-ident-'))
process.env.DSH_HOME = home

const storeDir = join(home, 'storages', 'dsh-dbhub-live')
const storePath = join(storeDir, 'credentials.json')
mkdirSync(storeDir, { recursive: true })

let seq = 0
/** A fresh config.mjs instance (it binds its storage paths at import time). */
function freshConfig() {
  seq += 1
  return import('../lib/config.mjs?ident=' + seq + '-' + Date.now())
}

/** A fresh config instance whose on-disk store starts from `doc`. */
async function configWith(doc) {
  if (doc === undefined) rmSync(storePath, { force: true })
  else writeFileSync(storePath, JSON.stringify(doc, null, 2))
  return freshConfig()
}

const readStore = () => JSON.parse(readFileSync(storePath, 'utf8'))

// The plain instances are the ones lib/index.mjs and lib/mcp.mjs share, so the
// resolver test below can seed their singletons in place.
const cfgPlain = await import('../lib/config.mjs')
const mcp = await import('../lib/mcp.mjs')

const WS = 'C:\\ws\\ident'
const idOf = (env) => mcp.sourceIdOf({ title: 'App', wsPath: WS, env })
const SSH_KEY = {
  host: 'bastion.example.com', port: 2222, user: 'deploy',
  auth: 'key', keyPath: '/home/deploy/.ssh/id_ed25519',
}

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── published ids must not move ───────────────────────────────────────────

test('the published source ids of default / lowercase / non-ASCII environments are byte-identical', () => {
  // Fixed literals on purpose: these handles are already in users' habits, stored
  // replies and model context. Any change here is a compatibility break, so the
  // assertion must not recompute the value it is checking.
  assert.equal(cfgPlain.envSlug('default'), '')
  assert.equal(cfgPlain.envSlug('prod'), 'prod')
  assert.equal(cfgPlain.envSlug('test'), 'test')
  assert.equal(cfgPlain.envSlug('dev'), 'dev')
  assert.equal(cfgPlain.envSlug('开发'), 'env-gma9')
  assert.equal(cfgPlain.envSlug('线上'), 'env-lzjf')
  // and the assembled ids (`<title>_<pathHash>[_<envSlug>]`)
  assert.equal(idOf('default'), 'app_kajw0l')
  assert.equal(idOf('prod'), 'app_kajw0l_prod')
  assert.equal(idOf('test'), 'app_kajw0l_test')
  assert.equal(idOf('dev'), 'app_kajw0l_dev')
  assert.equal(idOf('开发'), 'app_kajw0l_env-gma9')
  assert.equal(idOf('线上'), 'app_kajw0l_env-lzjf')
})

// ── injectivity (P1-12) ───────────────────────────────────────────────────

test('names that share an ASCII projection get pairwise distinct source ids', () => {
  const names = [
    'default', 'prod', 'PROD', 'Prod', 'dev', 'dev!', '!!!', 'env', 'test',
    '开发', '线上', '线上 env',
    'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(63) + 'b', 'a'.repeat(65),
  ]
  const ids = names.map(idOf)
  assert.equal(new Set(ids).size, ids.length, 'every (workspace, env) pair must own a unique source id')
  // The pairs the incident actually produced, asserted one by one so a future
  // "simplification" of the hashing fails with a readable message.
  assert.notEqual(cfgPlain.envSlug('prod'), cfgPlain.envSlug('PROD'))
  assert.notEqual(cfgPlain.envSlug('PROD'), cfgPlain.envSlug('Prod'))
  assert.notEqual(cfgPlain.envSlug('dev'), cfgPlain.envSlug('dev!'))
  assert.notEqual(cfgPlain.envSlug('!!!'), cfgPlain.envSlug('env'))
  assert.notEqual(cfgPlain.envSlug('prod'), cfgPlain.envSlug('prod-anything'))
  // Deterministic: the same name always maps onto the same handle.
  assert.equal(cfgPlain.envSlug('Prod'), cfgPlain.envSlug('Prod'))
  assert.equal(idOf('!!!'), idOf('!!!'))
  // Readable prefix is kept, the hash is what makes it unique.
  for (const n of ['PROD', 'Prod', 'dev!', '!!!']) {
    assert.match(cfgPlain.envSlug(n), /^(prod|dev|env)-[a-z0-9]+$/, n)
  }
  // The 64-char cap: a longer name differs only PAST the cap, so the handle must
  // hash the ORIGINAL name (two distinct long names used to share one store key).
  assert.equal(cfgPlain.envSlug('a'.repeat(65)), cfgPlain.envSlug('a'.repeat(64)) + '-' + cfgPlain.shortHash('a'.repeat(65)))
  assert.notEqual(cfgPlain.envSlug('a'.repeat(64)), cfgPlain.envSlug('a'.repeat(65)))
})

test('two rows of one workspace resolve separately instead of answering {ambiguous}', async () => {
  // End-to-end through resolveSource: the regression was that BOTH rows carried
  // the same id, so `pickBest` always had two candidates for one handle.
  for (const key of Object.keys(cfgPlain.store)) delete cfgPlain.store[key]
  cfgPlain.store[WS] = {
    environments: {
      default: { dsn: 'mysql://u:p@127.0.0.1:3306/main', source: 'user' },
      PROD: { dsn: 'mysql://u:p@127.0.0.1:3306/prod_upper', source: 'user' },
      Prod: { dsn: 'mysql://u:p@127.0.0.1:3306/prod_mixed', source: 'user' },
    },
  }
  cfgPlain.saveStore(cfgPlain.store)
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { w1: { path: WS, title: 'App' } } },
  }, null, 2))
  const ctx = { get: () => undefined }
  const subprocess = { resolveExecutable: async () => { throw new Error('no mise') } }

  const upper = await mcp.resolveSource(ctx, subprocess, idOf('PROD'))
  const mixed = await mcp.resolveSource(ctx, subprocess, idOf('Prod'))
  assert.ok(upper && !upper.ambiguous, 'PROD must resolve to exactly one row')
  assert.ok(mixed && !mixed.ambiguous, 'Prod must resolve to exactly one row')
  assert.equal(upper.id, idOf('PROD'))
  assert.equal(mixed.id, idOf('Prod'))
  assert.notEqual(upper.id, mixed.id)
  assert.equal(upper.row.env, 'PROD')
  assert.equal(mixed.row.env, 'Prod')
  // ... and each handle reaches its OWN connection (never the neighbour's).
  assert.match(upper.row.dsn, /prod_upper$/)
  assert.match(mixed.row.dsn, /prod_mixed$/)
})

// ── truncation collision is refused, the store stays untouched ────────────

test('a write that only collides through the length cap is refused with an actionable code', async () => {
  const cfg = await configWith(undefined)
  const capped = 'e'.repeat(cfg.ENV_NAME_MAX)
  assert.equal(cfg.setWorkspaceEnv(WS, capped, 'mysql://u:p@127.0.0.1:3306/one', 'user'), capped)
  const before = readStore()
  // 65 chars: normalizes (truncates) onto the row that is already there.
  const tooLong = capped + '2'
  assert.throws(
    () => cfg.setWorkspaceEnv(WS, tooLong, 'mysql://u:p@127.0.0.1:3306/two', 'user'),
    (e) => e && e.code === 'envNameTruncated',
    'a truncating collision must be refused, not silently merged',
  )
  assert.deepEqual(readStore(), before, 'a refused write must not touch the store')
  // The refusal also cannot be bypassed through a "confirmed" rename.
  cfg.setWorkspaceEnv(WS, 'other', 'mysql://u:p@127.0.0.1:3306/other', 'user')
  const beforeRename = readStore()
  assert.throws(
    () => cfg.renameWorkspaceEnv(WS, 'other', capped + '3', { confirm: true }),
    (e) => e && e.code === 'envNameTruncated',
  )
  assert.deepEqual(readStore(), beforeRename, 'the refused rename must not touch the store')
  // A truncating name that does NOT hit an existing key is still allowed (this is
  // how such a row is created in the first place) ...
  assert.equal(cfg.setWorkspaceEnv(WS, 'f'.repeat(70), 'mysql://u:p@127.0.0.1:3306/three', 'user'), 'f'.repeat(64))
  // ... and once it exists, later updates use the capped name the card displays
  // (no truncation involved, so no refusal): the row must stay reachable.
  assert.equal(cfg.setWorkspaceEnv(WS, 'f'.repeat(64), 'mysql://u:p@127.0.0.1:3306/three2', 'user'), 'f'.repeat(64))
  const rows = cfg.listWorkspaceEnvironments(cfg.store).filter((r) => r.wsPath === WS)
  assert.match(rows.find((r) => r.env === 'f'.repeat(64)).dsn, /three2$/)
})

test('a short name that normalizes onto an existing key still updates that row', async () => {
  // Only the LENGTH cap is guarded: `prod ` / `prod` are the same key by design
  // (the card sends back the name it displays), so this must keep working.
  const cfg = await configWith({ [WS]: { environments: { prod: { dsn: 'mysql://u:p@127.0.0.1:3306/one', source: 'user' } } } })
  assert.equal(cfg.setWorkspaceEnv(WS, ' prod ', 'mysql://u:p@127.0.0.1:3306/two', 'user'), 'prod')
  const doc = readStore()
  assert.equal(doc[WS].environments.prod.dsn, 'mysql://u:p@127.0.0.1:3306/two')
  assert.equal(Object.keys(doc[WS].environments).length, 1)
})

test('the options and remove writers refuse a truncating name and leave the store untouched (D7)', async () => {
  // Same data-safety class as the DSN writer above, but reachable through the
  // read-only chip / the delete button: a 65-character name normalizes (caps) onto
  // the stored 64-character row, and these two writers used to act on that other
  // environment — flipping its read-only flag, or deleting it outright.
  const cfg = await configWith(undefined)
  const capped = 'g'.repeat(cfg.ENV_NAME_MAX)
  assert.equal(cfg.setWorkspaceEnv(WS, capped, 'mysql://u:p@127.0.0.1:3306/one', 'user'), capped)
  cfg.setWorkspaceEnv(WS, 'keep', 'mysql://u:p@127.0.0.1:3306/two', 'user')
  const before = readStore()
  const tooLong = capped + '2'

  assert.throws(
    () => cfg.setWorkspaceEnvOptions(WS, tooLong, { readOnly: true }),
    (e) => e && e.code === 'envNameTruncated',
    'an options write must not address the capped row',
  )
  assert.deepEqual(readStore(), before, 'the refused options write must not touch the store')
  assert.equal(readStore()[WS].environments[capped].readOnly, undefined)

  assert.throws(
    () => cfg.removeWorkspaceEnv(WS, tooLong),
    (e) => e && e.code === 'envNameTruncated',
    'a remove must not delete the capped row',
  )
  assert.deepEqual(readStore(), before, 'the refused remove must not touch the store')
  assert.ok(readStore()[WS].environments[capped], 'the 64-character row is still there')

  // The other direction: the REAL capped name the card displays still works.
  assert.equal(cfg.setWorkspaceEnvOptions(WS, capped, { readOnly: true }), capped)
  assert.equal(readStore()[WS].environments[capped].readOnly, true)
  assert.equal(cfg.removeWorkspaceEnv(WS, capped), true)
  assert.equal(Object.prototype.hasOwnProperty.call(readStore()[WS].environments, capped), false)
  assert.ok(readStore()[WS].environments.keep, 'only the named row is removed')
})

// ── unknown store fields survive a write (P1-13) ──────────────────────────

function seededDoc() {
  return {
    [WS]: {
      // A field a NEWER build may store next to `environments`.
      futureWorkspaceFlag: { kept: true, n: 3 },
      environments: {
        prod: {
          dsn: 'mysql://u:p@127.0.0.1:3306/one',
          source: 'user',
          // ... and one it may store on an environment entry.
          futureEnvFlag: 7,
        },
      },
    },
  }
}

test('load keeps workspace-level unknown fields (they are not stripped before a write)', async () => {
  const cfg = await configWith(seededDoc())
  assert.deepEqual(cfg.store[WS].futureWorkspaceFlag, { kept: true, n: 3 }, 'load must not drop the field')
  assert.equal(cfg.store[WS].environments.prod.futureEnvFlag, 7)
})

test('every store write keeps unknown fields on both levels', async () => {
  const cfg = await configWith(seededDoc())
  // ① DSN write
  cfg.setWorkspaceEnv(WS, 'prod', 'mysql://u:p@127.0.0.1:3306/two', 'user')
  let doc = readStore()
  assert.deepEqual(doc[WS].futureWorkspaceFlag, { kept: true, n: 3 })
  assert.equal(doc[WS].environments.prod.futureEnvFlag, 7)
  // ② options write
  cfg.setWorkspaceEnvOptions(WS, 'prod', { readOnly: true })
  doc = readStore()
  assert.deepEqual(doc[WS].futureWorkspaceFlag, { kept: true, n: 3 })
  assert.equal(doc[WS].environments.prod.futureEnvFlag, 7)
  assert.equal(doc[WS].environments.prod.readOnly, true)
  // ③ rename — the environment-level field travels with the row
  assert.equal(cfg.renameWorkspaceEnv(WS, 'prod', 'qa').renamed, true)
  doc = readStore()
  assert.deepEqual(doc[WS].futureWorkspaceFlag, { kept: true, n: 3 })
  assert.equal(doc[WS].environments.qa.futureEnvFlag, 7)
  assert.equal(doc[WS].environments.qa.dsn, 'mysql://u:p@127.0.0.1:3306/two')
  // ④ remove one of two environments
  cfg.setWorkspaceEnv(WS, 'other', 'mysql://u:p@127.0.0.1:3306/three', 'user')
  cfg.removeWorkspaceEnv(WS, 'qa')
  doc = readStore()
  assert.deepEqual(doc[WS].futureWorkspaceFlag, { kept: true, n: 3 })
  assert.deepEqual(Object.keys(doc[WS].environments), ['other'])
})

test('explicit false / null still DELETE the option fields after the spread', async () => {
  // The spread of the previous entry restores `readOnly` / `ssh`, so "delete"
  // cannot be expressed by not assigning: `false` / `null` must remove the key.
  const cfg = await configWith({
    [WS]: { environments: { prod: { dsn: 'mysql://u:p@127.0.0.1:3306/one', source: 'user', readOnly: true, ssh: SSH_KEY } } },
  })
  cfg.setWorkspaceEnv(WS, 'prod', 'mysql://u:p@127.0.0.1:3306/two', 'user', { readOnly: false, ssh: null })
  let row = readStore()[WS].environments.prod
  assert.equal('readOnly' in row, false, 'readOnly:false must delete the flag')
  assert.equal('ssh' in row, false, 'ssh:null must delete the tunnel')
  // An omitted patch keeps them: a DSN-only update must not clear a safety switch.
  cfg.setWorkspaceEnv(WS, 'prod', 'mysql://u:p@127.0.0.1:3306/three', 'user', { readOnly: true, ssh: SSH_KEY })
  cfg.setWorkspaceEnv(WS, 'prod', 'mysql://u:p@127.0.0.1:3306/four', 'user')
  row = readStore()[WS].environments.prod
  assert.equal(row.readOnly, true)
  assert.equal(row.ssh.host, 'bastion.example.com')
  assert.equal(row.dsn, 'mysql://u:p@127.0.0.1:3306/four')
})
