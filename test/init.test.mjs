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

test('normalizeStore drops legacy junk and preserves forward fields', async () => {
  const home = prepareHome()
  const storeDir = join(home, 'storages', 'dsh-dbhub-live')
  mkdirSync(storeDir, { recursive: true })
  // A hand-edited / older-version document:
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
    assert.equal(config.store.__proto__.dsn, 'mysql://evil@x/y') // own data prop, not Object.prototype
    assert.equal(config.store.enabled, undefined) // dropped -> default true downstream
    assert.equal(config.store['C:\\ws\\bad'], undefined)
    assert.equal(config.store['C:\\ws\\junk'], undefined)
    assert.equal(config.store['C:\\ws\\good'].dsn, 'mysql://u:p@h/d')   // trimmed
    assert.deepEqual(config.store['C:\\ws\\good'].extra, { future: true }) // preserved
    // one-time migration already wrote the normalized document back
    const onDisk = JSON.parse(readFileSync(join(storeDir, 'credentials.json'), 'utf8'))
    assert.equal(Object.hasOwn(onDisk, 'enabled'), false)
    assert.equal(Object.hasOwn(onDisk, 'C:\\ws\\bad'), false)
    assert.equal(onDisk['C:\\ws\\good'].dsn, 'mysql://u:p@h/d')
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

test('writeToml returns false (never throws) when the storage path is blocked', async () => {
  const home = prepareHome()
  try {
    // Occupy the storage path with a plain file so mkdir/write must fail.
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-dbhub-live'), 'i am a file')
    const config = await freshConfig()
    assert.equal(config.writeToml('[[sources]]\n'), false)
    assert.equal(config.ensureStorageDir(), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})