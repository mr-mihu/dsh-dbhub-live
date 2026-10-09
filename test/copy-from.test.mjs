// dbhub_configure's `copyFrom` path (lib/tools.mjs runCopyFrom): reusing another
// workspace's connection must create a REAL row in THIS workspace, and the model
// must never be told "source not found" for a handle the plugin itself published.
//
// Regression this file locks down: `runCopyFrom` was called with the executing
// context in the `target` position, so `target.path` was undefined and EVERY copy
// failed (or wrote under an undefined workspace key). The copy is done host-side
// only: the DSN is read from the source row and written to the target row, and
// the model sees neither the DSN nor the password.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-copy-'))
process.env.DSH_HOME = home

// Plain imports on purpose: lib/tools.mjs (imported below with a cache-busting
// query) resolves './config.mjs' / './mcp.mjs' / './state.mjs' / './i18n.mjs'
// WITHOUT a query, so these are the very singletons the plugin uses.
const cfg = await import('../lib/config.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const { currentT } = await import('../lib/i18n.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs?copy=' + Date.now())

const APP = 'D:/work/app'
const OTHER = 'D:/work/other'
const SRC_DSN = 'mysql://127.0.0.1:3306/app'

// A probe that always fails (exit 1) is all these cases need: nothing real may
// run, and the copy itself is the regression under test. The probe outcome is
// only appended to the reply.
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

const REGISTRY = [
  { path: APP, title: 'app' },
  { path: OTHER, title: 'other' },
]

const dialogs = []
const fakeQuestions = {
  ask: async (params) => {
    dialogs.push(params)
    return undefined // a copy must never need a dialog anyway
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

const exec = { agent: { session: { header: { cwd: APP } } }, signal: undefined }

test.before(() => {
  if (!state.isEnabled()) state.setEnabled(true)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('copyFrom brings another workspace connection into THIS workspace', async () => {
  cfg.setWorkspaceEnv(OTHER, 'default', SRC_DSN, 'user')

  // The handle the model would have read out of dbhub_list_sources — the copy
  // must accept exactly that.
  const listed = await captured.dbhub_list_sources.execute({}, exec)
  assert.equal(listed.ok, true, listed.text)
  const otherId = mcp.sourceIdOf({ title: 'other', wsPath: OTHER, env: 'default' })
  assert.ok(listed.text.includes(otherId), 'the source handle must be listed')

  dialogs.length = 0
  const res = await captured.dbhub_configure.execute({ copyFrom: otherId, env: 'prod' }, exec)

  assert.equal(res.ok, true, res.text)
  assert.notEqual(res.text, currentT('result.noSource', { src: otherId }))
  assert.ok(!res.text.includes(currentT('result.noSource', { src: otherId })), res.text)

  const row = cfg
    .listWorkspaceEnvironments(cfg.store)
    .find((r) => r.wsPath === APP && r.env === 'prod')
  assert.ok(row, 'the copied row must live in the CURRENT workspace')
  assert.equal(row.dsn, SRC_DSN, 'the source DSN is copied host-side, verbatim')
  assert.equal(row.source, 'copied')
  assert.equal(dialogs.length, 0, 'a host-side copy needs no user input')

  // The source row is untouched.
  const source = cfg
    .listWorkspaceEnvironments(cfg.store)
    .find((r) => r.wsPath === OTHER && r.env === 'default')
  assert.equal(source.dsn, SRC_DSN)
})

test('copying a row onto itself is refused without rewriting the row', async () => {
  const selfDsn = 'mysql://127.0.0.1:3306/self'
  cfg.setWorkspaceEnv(APP, 'self', selfDsn, 'user')
  const selfId = mcp.sourceIdOf({ title: 'app', wsPath: APP, env: 'self' })

  const res = await captured.dbhub_configure.execute({ copyFrom: selfId, env: 'self' }, exec)

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.copySelf', { title: 'app', env: 'self' }))

  const row = cfg
    .listWorkspaceEnvironments(cfg.store)
    .find((r) => r.wsPath === APP && r.env === 'self')
  assert.equal(row.dsn, selfDsn)
  assert.equal(row.source, 'user', 'a refused self-copy must not rewrite the row')
})

test('renameFrom combined with copyFrom is refused as an argument conflict', async () => {
  const before = JSON.stringify(cfg.store[APP] || {})

  const res = await captured.dbhub_configure.execute(
    { renameFrom: 'default', copyFrom: 'other', env: 'prod2' },
    exec,
  )

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.argConflict'))
  assert.equal(JSON.stringify(cfg.store[APP] || {}), before, 'a refused call writes nothing')
})
