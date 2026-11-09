// Regression test for the source-resolution bug: a suffix source id
// (`<ws>_<hash>_demo`) was falling back to the SHORTER base id
// (`<ws>_<hash>`, the default env) because the prefix-match fallback
// (`wanted.includes(k.id)`) visited the default row first. Calls against
// `…_demo` therefore hit the DEFAULT connection's DSN. Resolution must be
// exact-first so a configured demo row wins.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-src-'))
process.env.DSH_HOME = home

// A workspace registry file (listWorkspaces file fallback) + a store with
// default AND demo environments for one workspace. Written BEFORE the modules
// are imported: config.mjs binds the store singleton at import time.
const WS_PATH = 'C:\\ws\\testapp'
const storeDir = join(home, 'storages')
const wsFile = join(storeDir, 'workspace.json')
mkdirSync(join(storeDir, 'dsh-dbhub-live'), { recursive: true })
writeFileSync(wsFile, JSON.stringify({
  tables: {
    workspaces: {
      w1: { path: WS_PATH, title: 'TestApp' },
    },
  },
}, null, 2))
const cfgFile = join(storeDir, 'dsh-dbhub-live', 'credentials.json')
writeFileSync(cfgFile, JSON.stringify({
  [WS_PATH]: {
    environments: {
      default: { dsn: 'mysql://u:p@h/main', source: 'user' },
      demo: { dsn: 'mysql://u:p@h/demo', source: 'user' },
    },
  },
}, null, 2))

const cfg = await import('../lib/config.mjs?src=' + Date.now())
const mcp = await import('../lib/mcp.mjs?src=' + Date.now())

// No services: registry/fs unavailable -> file fallback; mise unavailable ->
// no auto-discovery. Enough to walk the persisted rows.
const ctx = { get: () => undefined }
const subprocess = { resolveExecutable: async () => { throw new Error('no mise') } }

const baseId = cfg.slugify('TestApp') + '_' + cfg.shortHash(WS_PATH)
const demoId = baseId + '_demo'

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('demo source id resolves to the demo row (exact-first, not the default prefix)', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, demoId)
  assert.ok(hit, 'demo source should resolve')
  assert.equal(hit.id, demoId)
  assert.equal(hit.row.env, 'demo')
  assert.equal(hit.row.dsn, 'mysql://u:p@h/demo')
})

test('bare source id still resolves to the default row', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, baseId)
  assert.ok(hit)
  assert.equal(hit.id, baseId)
  assert.equal(hit.row.env, 'default')
  assert.equal(hit.row.dsn, 'mysql://u:p@h/main')
})

test('title_env display form resolves to the demo row', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, 'testapp_demo')
  assert.ok(hit)
  assert.equal(hit.row.env, 'demo')
})

test('unknown source resolves to undefined', async () => {
  assert.equal(await mcp.resolveSource(ctx, subprocess, 'nope_nope_nope'), undefined)
  assert.equal(await mcp.resolveSource(ctx, subprocess, ''), undefined)
  assert.equal(await mcp.resolveSource(ctx, subprocess, undefined), undefined)
})

test('a MISSING handle never falls back to the base row (no substring match)', async () => {
  // The old `wanted.includes(k.id)` fallback was a prefix match: a handle that
  // merely CONTAINED a real id resolved to that row — so `testapp_1nb1w50_dmeo`
  // (the demo env, misspelled) sent the query to the DEFAULT connection's DSN.
  // A near miss must be "not found", never "whichever row it resembles".
  const wrongEnv = await mcp.resolveSource(ctx, subprocess, baseId + '_dmeo')
  assert.equal(wrongEnv, undefined, 'a misspelled environment suffix must not resolve')
  const wrongId = await mcp.resolveSource(ctx, subprocess, 'testap_' + cfg.shortHash(WS_PATH) + '_demo')
  assert.equal(wrongId, undefined, 'a misspelled workspace slug must not resolve')
  const noSuchEnv = await mcp.resolveSource(ctx, subprocess, baseId + '_staging')
  assert.equal(noSuchEnv, undefined, 'a suffix naming a nonexistent environment must not resolve')
  const suffixedDefault = await mcp.resolveSource(ctx, subprocess, baseId + '_default')
  assert.equal(suffixedDefault, undefined, '`default` has no slug suffix, so `<base>_default` names nothing')
  // A trailing fragment, an extra segment and a truncated hash are all near
  // misses: none of them is the row it resembles.
  assert.equal(await mcp.resolveSource(ctx, subprocess, baseId + '_demo_extra'), undefined)
  assert.equal(await mcp.resolveSource(ctx, subprocess, baseId.slice(0, -1)), undefined)
  assert.equal(await mcp.resolveSource(ctx, subprocess, baseId + '_DEMO2'), undefined)
  // Exact handles still work, including the case-insensitive form the resolver
  // has always accepted (handles are lowercase ASCII by construction): a model
  // echoing the title's original casing is not a different connection.
  const exact = await mcp.resolveSource(ctx, subprocess, demoId)
  assert.equal(exact.row.env, 'demo')
  const cased = await mcp.resolveSource(ctx, subprocess, 'TESTAPP_' + cfg.shortHash(WS_PATH).toUpperCase() + '_DEMO')
  assert.equal(cased.row.env, 'demo', 'case-only variants of a REAL handle stay resolvable')
})