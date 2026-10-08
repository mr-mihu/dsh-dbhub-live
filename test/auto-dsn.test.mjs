// Auto-discovery robustness (lib/config.mjs): one workspace's `mise env` must
// never hang the discovery walk, and a directory's answer is reused for a short
// window so repeated walks (the card mirror and every model-facing list/execute)
// do not re-spawn it.
//
// The live failure this guards: a `mise env` that never exited blocked the walk
// forever; `dbhub_list_sources` walks synchronously, so the model's tool call hung
// and was reported as "Interrupted" while the settings card still showed its
// cached rows.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-autodsn-'))
process.env.DSH_HOME = home

const cfg = await import('../lib/config.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

/** A subprocess stand-in whose `mise env` never finishes. */
function hangingSubprocess(counter, timeoutMs) {
  return {
    resolveExecutable: async () => 'mise',
    spawn: () => {
      counter.spawns += 1
      let terminated = false
      return {
        stdout: { on() {} },
        done: new Promise(() => {}), // never settles
        terminate() { terminated = true; counter.terminated += 1 },
        get wasTerminated() { return terminated },
      }
    },
    timeoutMs,
  }
}

/** A subprocess stand-in that answers `mise env` with a DSN map. */
function answeringSubprocess(counter, output) {
  return {
    resolveExecutable: async () => 'mise',
    spawn: () => {
      counter.spawns += 1
      return {
        stdout: { on(_event, handler) { handler(Buffer.from(output)) } },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    },
  }
}

const fsStub = { resolve: async () => { throw new Error('no .env') } }

test('a hanging mise env gives up instead of blocking the walk', async () => {
  const counter = { spawns: 0, terminated: 0 }
  const sub = hangingSubprocess(counter)
  const started = Date.now()
  const result = await cfg.runMiseEnv(sub, 'D:/work/hang', undefined, 40)
  const elapsed = Date.now() - started
  assert.equal(result, undefined)
  assert.equal(counter.spawns, 1)
  assert.equal(counter.terminated, 1, 'the abandoned process is terminated')
  assert.ok(elapsed < 2000, `must return promptly, took ${elapsed}ms`)
})

test('a refused executable is not an error', async () => {
  const result = await cfg.runMiseEnv({ resolveExecutable: async () => { throw new Error('no mise') } }, 'D:/work/none', undefined, 40)
  assert.equal(result, undefined)
})

test('auto-discovery is cached for a short window, then probed again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  cfg.resetAutoDsnCache()
  // a persisted env WITHOUT a default is what triggers auto-discovery
  const wsPath = 'D:/work/cached'
  cfg.setWorkspaceEnv(wsPath, 'prod', 'mysql://u:p@127.0.0.1:3306/db', 'user')
  const counter = { spawns: 0 }
  const sub = answeringSubprocess(counter, 'DSN=mysql://u:p@127.0.0.1:3307/auto\n')

  const first = await cfg.resolveWorkspaceEnvs(sub, fsStub, wsPath)
  assert.equal(counter.spawns, 1)
  assert.equal(first.some((r) => r.env === 'default' && r.source === '工作区 mise env'), true)

  const second = await cfg.resolveWorkspaceEnvs(sub, fsStub, wsPath)
  assert.equal(counter.spawns, 1, 'the second walk reuses the cached probe')
  assert.deepEqual(second, first)

  t.mock.timers.tick(11000) // past the TTL
  await cfg.resolveWorkspaceEnvs(sub, fsStub, wsPath)
  assert.equal(counter.spawns, 2, 'after the TTL the directory is probed again')
  t.mock.timers.reset()
  cfg.resetAutoDsnCache()
})

test('a persisted default skips auto-discovery entirely', async () => {
  cfg.resetAutoDsnCache()
  const wsPath = 'D:/work/withdefault'
  cfg.setWorkspaceEnv(wsPath, 'default', 'mysql://u:p@127.0.0.1:3306/main', 'user')
  const counter = { spawns: 0 }
  const rows = await cfg.resolveWorkspaceEnvs(answeringSubprocess(counter, 'DSN=mysql://u:p@127.0.0.1:3307/auto\n'), fsStub, wsPath)
  assert.equal(counter.spawns, 0, 'no probe when the default environment is configured')
  assert.deepEqual(rows.map((r) => r.env), ['default'])
})
