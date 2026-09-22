// Init-hardening tests: legacy/incompatible store & runtime documents must be
// normalized on load (and migrated back to disk once), deleted storage dirs
// must be recreated on write, and write failures must never throw.
//
// config.mjs binds its storage paths at import time and is cached by Node, so
// each test imports a fresh instance via a unique query string.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let seq = 0

function freshConfig() {
  seq += 1
  return import('../lib/config.mjs?init=' + seq + '-' + Date.now())
}

function prepareHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-init-'))
  process.env.DSH_HOME = home
  return home
}

test('normalizeStore migrates v1 entries and drops legacy junk', async () => {
  const home = prepareHome()
  const storeDir = join(home, 'storages', 'dsh-dbhub-live')
  mkdirSync(storeDir, { recursive: true })
  // A hand-edited / older-version document (v1 bare-dsn entries):
  writeFileSync(join(storeDir, 'credentials.json'), JSON.stringify({
    enabled: 'yes',                                  // non-boolean -> dropped
    'C:\\ws\\bad': { dsn: '   ' },                   // empty dsn -> dropped
    'C:\\ws\\junk': null,                            // non-object -> dropped
    'C:\\ws\\good': { dsn: ' mysql://u:p@h/d ', source: 'user', updatedAt: 123, extra: { future: true } },
    ['__proto__']: { dsn: 'mysql://evil@x/y' },      // must not pollute the prototype
  }, null, 2))
  const config = await freshConfig()
  try {
    assert.equal(Object.getPrototypeOf(config.store), Object.prototype)
    assert.equal(config.store.__proto__.environments.default.dsn, 'mysql://evil@x/y') // own data prop
    assert.equal(config.store.enabled, undefined) // dropped -> default true downstream
    assert.equal(config.store['C:\\ws\\bad'], undefined)
    assert.equal(config.store['C:\\ws\\junk'], undefined)
    const good = config.store['C:\\ws\\good']
    assert.equal(good.environments.default.dsn, 'mysql://u:p@h/d')   // v1 -> environments.default, trimmed
    assert.deepEqual(good.environments.default.extra, { future: true }) // preserved
    // one-time migration already wrote the normalized document back
    const onDisk = JSON.parse(readFileSync(join(storeDir, 'credentials.json'), 'utf8'))
    assert.equal(Object.hasOwn(onDisk, 'enabled'), false)
    assert.equal(Object.hasOwn(onDisk, 'C:\\ws\\bad'), false)
    assert.equal(onDisk['C:\\ws\\good'].environments.default.dsn, 'mysql://u:p@h/d')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('normalizeStore keeps v2 multi-environment entries and lists rows', async () => {
  const home = prepareHome()
  const storeDir = join(home, 'storages', 'dsh-dbhub-live')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'credentials.json'), JSON.stringify({
    enabled: true,
    'C:\\ws\\multi': {
      environments: {
        default: { dsn: 'mysql://u:p@h/d', source: 'user' },
        prod: { dsn: 'postgres://u:p@198.51.100.1/db', source: 'user', updatedAt: 1 },
        '': { dsn: 'mysql://x@y/z' },              // empty env name is kept as-is (host normalizes on write)
        broken: { dsn: '   ' },                    // dropped
      },
    },
  }, null, 2))
  const config = await freshConfig()
  try {
    const envs = config.store['C:\\ws\\multi'].environments
    assert.deepEqual(Object.keys(envs).sort(), ['', 'default', 'prod'])
    assert.equal(envs.default.dsn, 'mysql://u:p@h/d')
    assert.equal(envs.prod.dsn, 'postgres://u:p@198.51.100.1/db')
    const rows = config.listWorkspaceEnvironments(config.store)
    assert.equal(rows.length, 3)
    assert.equal(rows.find((r) => r.env === 'prod').wsPath, 'C:\\ws\\multi')
    assert.ok(rows.every((r) => r.persisted === true))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('setWorkspaceEnv / removeWorkspaceEnv persist and drop entries', async () => {
  const home = prepareHome()
  const storeDir = join(home, 'storages', 'dsh-dbhub-live')
  const config = await freshConfig()
  try {
    const envName = config.setWorkspaceEnv('C:\\ws\\a', 'prod', ' mysql://u:p@h/prod ', 'user')
    assert.equal(envName, 'prod')
    let onDisk = JSON.parse(readFileSync(join(storeDir, 'credentials.json'), 'utf8'))
    assert.equal(onDisk['C:\\ws\\a'].environments.prod.dsn, 'mysql://u:p@h/prod')
    config.setWorkspaceEnv('C:\\ws\\a', '', 'mysql://u:p@h/dev', 'collected')
    onDisk = JSON.parse(readFileSync(join(storeDir, 'credentials.json'), 'utf8'))
    assert.equal(Object.keys(onDisk['C:\\ws\\a'].environments).sort().join(','), 'default,prod')
    assert.equal(config.removeWorkspaceEnv('C:\\ws\\a', 'prod'), true)
    onDisk = JSON.parse(readFileSync(join(storeDir, 'credentials.json'), 'utf8'))
    assert.equal(Object.keys(onDisk['C:\\ws\\a'].environments).join(','), 'default')
    // removing the last environment drops the whole workspace entry
    assert.equal(config.removeWorkspaceEnv('C:\\ws\\a', 'default'), true)
    onDisk = JSON.parse(readFileSync(join(storeDir, 'credentials.json'), 'utf8'))
    assert.equal(Object.hasOwn(onDisk, 'C:\\ws\\a'), false)
    // removing a never-persisted env is a no-op
    assert.equal(config.removeWorkspaceEnv('nope', 'default'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('normalizeRuntime drops invalid entries; migration rewrites the file', async () => {
  const home = prepareHome()
  const storeDir = join(home, 'storages', 'dsh-dbhub-live')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'runtime.json'), JSON.stringify({
    dbhubExe: 42,                       // invalid -> dropped
    dbhubInstallAt: -5,                 // invalid -> dropped
    unknown: 'kept',                    // forward field preserved
  }, null, 2))
  const config = await freshConfig()
  try {
    assert.equal(config.runtime.dbhubExe, undefined)
    assert.equal(config.runtime.dbhubInstallAt, undefined)
    assert.equal(config.runtime.unknown, 'kept')
    const onDisk = JSON.parse(readFileSync(join(storeDir, 'runtime.json'), 'utf8'))
    assert.deepEqual(onDisk, { unknown: 'kept' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('saveStore recreates a deleted storage directory', async () => {
  const home = prepareHome()
  const storeDir = join(home, 'storages', 'dsh-dbhub-live')
  const config = await freshConfig()
  try {
    rmSync(storeDir, { recursive: true, force: true })
    assert.ok(!existsSync(storeDir))
    config.saveStore({ enabled: true })
    assert.ok(existsSync(join(storeDir, 'credentials.json')))
    assert.equal(JSON.parse(readFileSync(join(storeDir, 'credentials.json'), 'utf8')).enabled, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('saveStore returns false (never throws) when the storage path is blocked', async () => {
  const home = prepareHome()
  try {
    // Occupy the storage path with a plain file so mkdir/write must fail.
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-dbhub-live'), 'i am a file')
    const config = await freshConfig()
    assert.equal(config.ensureStorageDir(), false)
    assert.equal(config.saveStore({ enabled: true }), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})