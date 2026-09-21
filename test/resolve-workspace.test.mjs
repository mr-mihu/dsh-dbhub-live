// Workspace-scoped source resolution: two workspaces that carry look-alike
// connections must never blur into one target, and a Chinese environment name
// must produce its own handle.
//
// Regression this file locks down:
//   * `envSlug` collapsed EVERY purely non-ASCII name onto one slug, so `线上`
//     and `测试` shared a source id and calls silently hit the wrong database;
//   * a bare handle that matched rows in several workspaces was resolved by
//     list order (the first row won) instead of by the CURRENT workspace.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-ws-'))
process.env.DSH_HOME = home

// Two workspaces with the SAME title, each with a default + a Chinese-named
// environment. Written before the modules are imported (config binds the store
// singleton at import time).
const WS_A = 'C:\\ws\\alpha'
const WS_B = 'C:\\ws\\beta'
const storeDir = join(home, 'storages')
mkdirSync(join(storeDir, 'dsh-dbhub-live'), { recursive: true })
writeFileSync(join(storeDir, 'workspace.json'), JSON.stringify({
  tables: {
    workspaces: {
      w1: { path: WS_A, title: 'TestApp' },
      w2: { path: WS_B, title: 'TestApp' },
    },
  },
}, null, 2))
writeFileSync(join(storeDir, 'dsh-dbhub-live', 'credentials.json'), JSON.stringify({
  [WS_A]: {
    environments: {
      default: { dsn: 'mysql://u:p@a-host/main', source: 'user' },
      '线上': { dsn: 'mysql://u:p@a-host/online', source: 'user' },
    },
  },
  [WS_B]: {
    environments: {
      default: { dsn: 'mysql://u:p@b-host/main', source: 'user' },
      '线上': { dsn: 'mysql://u:p@b-host/online', source: 'user' },
    },
  },
}, null, 2))

const cfg = await import('../lib/config.mjs?ws=' + Date.now())
const mcp = await import('../lib/mcp.mjs?ws=' + Date.now())

const ctx = { get: () => undefined }
const subprocess = { resolveExecutable: async () => { throw new Error('no mise') } }

const idA = mcp.sourceIdOf({ title: 'TestApp', wsPath: WS_A, env: 'default' })
const idB = mcp.sourceIdOf({ title: 'TestApp', wsPath: WS_B, env: 'default' })

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('Chinese environment names get their own stable source id', async () => {
  const online = mcp.sourceIdOf({ title: 'TestApp', wsPath: WS_A, env: '线上' })
  const qa = mcp.sourceIdOf({ title: 'TestApp', wsPath: WS_A, env: '测试' })
  assert.notEqual(online, qa, 'two Chinese env names must not share a source id')
  assert.notEqual(online, idA)
  assert.equal(online, mcp.sourceIdOf({ title: 'TestApp', wsPath: WS_A, env: '线上' }))
  assert.match(online, /^testapp_[a-z0-9]+_env-[a-z0-9]+$/)
})

test('the same workspace title yields distinct ids (the path hash separates them)', () => {
  assert.notEqual(idA, idB)
})

test('an exact source id always wins, whichever workspace it belongs to', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, idB)
  assert.ok(hit && !hit.ambiguous)
  assert.equal(hit.row.wsPath, WS_B)
  assert.equal(hit.row.dsn, 'mysql://u:p@b-host/main')
})

test('a bare environment name resolves inside the CURRENT workspace', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, '线上', { preferredWsPath: WS_A })
  assert.ok(hit && !hit.ambiguous, 'the current workspace row must win over the look-alike')
  assert.equal(hit.row.wsPath, WS_A)
  assert.equal(hit.row.dsn, 'mysql://u:p@a-host/online')
})

test('without a current workspace, a cross-workspace match is reported as ambiguous', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, '线上')
  assert.ok(hit && hit.ambiguous, 'a tie across workspaces must never be resolved by list order')
  assert.equal(hit.ambiguous.length, 2)
  for (const c of hit.ambiguous) {
    assert.equal(c.env, '线上')
    assert.ok(c.id && c.title === 'TestApp' && c.path)
  }
})

test('title_<raw env> (the display form) follows the same current-workspace rule', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, 'testapp_线上', { preferredWsPath: WS_B })
  assert.ok(hit && !hit.ambiguous)
  assert.equal(hit.row.wsPath, WS_B)
})

test('a bare title still cannot pick an environment (ambiguous within one workspace)', async () => {
  const hit = await mcp.resolveSource(ctx, subprocess, 'testapp', { preferredWsPath: WS_A })
  assert.ok(hit && hit.ambiguous)
  assert.deepEqual(hit.ambiguous.map((c) => c.env).sort(), ['default', '线上'])
})

test('unknown references stay undefined', async () => {
  assert.equal(await mcp.resolveSource(ctx, subprocess, 'nope_nope'), undefined)
  assert.equal(await mcp.resolveSource(ctx, subprocess, idA, { preferredWsPath: WS_A }).then((h) => h.row.wsPath), WS_A)
})
