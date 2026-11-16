// Storage hygiene: everything under $DSH_HOME/storages/dsh-dbhub-live holds a
// credential (credentials.json: every stored DSN plus the SSH password /
// passphrase), and the pre-4.0 store was a PLAINTEXT connection file that no
// code reads anymore. Both are pinned here:
//
//   1. the JSON documents are created owner-only (0600) inside a 0700 directory,
//      so another account on the same machine cannot read them — the old writer
//      left them 0644, i.e. world-readable DSNs on Linux/macOS. Windows ignores
//      the mode and relies on the profile ACL, so those two assertions are
//      skipped there (and only there) — which is why the MODE ARGUMENTS are also
//      asserted through the injectable fs seam, on every platform (M7).
//   1b. an UPGRADED profile is re-tightened: `mkdirSync(recursive)` does not
//      change an existing directory's mode, so a profile created by an older
//      build keeps 0755/0644 until something chmods it (P5).
//   2. the legacy `dbhub.toml` is deleted by `sweepLegacyConfigFile()` (called at
//      boot) with a warning that names the FILE and never quotes its contents.
//
// config.mjs binds its paths from DSH_HOME at import time, so point it at a temp
// dir BEFORE importing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-storage-'))
process.env.DSH_HOME = home

const cfg = await import('../lib/config.mjs')

const IS_WINDOWS = process.platform === 'win32'
const modeOf = (path) => statSync(path).mode & 0o777
const SKIP_MODES = IS_WINDOWS ? 'POSIX file modes only (Windows uses the profile ACL)' : false

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('the storage directory and every JSON document are owner-only', { skip: SKIP_MODES }, () => {
  cfg.setWorkspaceEnv('D:/work/mode', 'default', 'mysql://u:CHANGE_ME@127.0.0.1:3306/app', 'user')

  assert.ok(existsSync(cfg.STORE_PATH), 'the store was written')
  assert.equal(modeOf(cfg.DATA_DIR), 0o700, 'the directory must not be listable by other accounts')
  assert.equal(modeOf(cfg.STORE_PATH), 0o600, 'credentials.json must not be readable by other accounts')

  // The same writer serves the other two documents, so they inherit the mode.
  cfg.saveRuntime({ dbhubExe: '/fake/bin/dbhub' })
  cfg.savePrefs({ updateIntervalDays: 3 })
  assert.equal(modeOf(cfg.RUNTIME_PATH), 0o600)
  assert.equal(modeOf(cfg.PREFS_PATH), 0o600)

  // No `.tmp-*` sibling survived a completed rename.
  const leftovers = existsSync(cfg.DATA_DIR)
    ? readdirSync(cfg.DATA_DIR).filter((name) => name.includes('.tmp-'))
    : []
  assert.deepEqual(leftovers, [], 'a completed write must not leave its temp file behind')
})

// ── M7: the mode ARGUMENTS, observed on every platform ─────────────────────
//
// The test above is skipped on Windows, so dropping `mode: 0o600` from the
// writer (or 0o700 from the mkdir) went red nowhere. This assertion does not look
// at the resulting modes at all — it records what the writer ASKED for, through
// the module's injectable fs seam — so it holds on every platform and under any
// umask.

test('the storage writer asks for owner-only modes on every platform (M7)', () => {
  const calls = []
  cfg.setFsHooks({
    mkdirSync: (path, opts) => {
      calls.push({ kind: 'mkdir', path, opts })
      return mkdirSync(path, opts)
    },
    writeFileSync: (path, data, opts) => {
      calls.push({ kind: 'write', path, opts })
      return writeFileSync(path, data, opts)
    },
  })
  try {
    cfg.savePrefs({ updateIntervalDays: 5 })
  } finally {
    cfg.setFsHooks(null)
  }

  const mkdirCall = calls.find((c) => c.kind === 'mkdir')
  const writeCall = calls.find((c) => c.kind === 'write')
  assert.ok(mkdirCall, 'the document write creates its directory through the seam')
  assert.ok(writeCall, 'the document write goes through the seam')
  assert.equal(mkdirCall.opts && mkdirCall.opts.mode, 0o700, 'the storage directory is created owner-only')
  assert.equal(writeCall.opts && writeCall.opts.mode, 0o600, 'the document (and its temp file) is owner-only')
  assert.ok(writeCall.path.startsWith(cfg.PREFS_PATH), 'the prefs document is what was written: ' + writeCall.path)
  assert.equal(existsSync(cfg.PREFS_PATH), true)
})

// ── P5: an UPGRADED profile is re-tightened ───────────────────────────────

test('an upgraded profile has its directory and documents re-tightened (P5)', { skip: SKIP_MODES }, () => {
  cfg.savePrefs({ updateIntervalDays: 2 })
  // What an older build (or a permissive umask) left behind: mkdirSync(recursive)
  // does NOT change a directory that already exists.
  chmodSync(cfg.DATA_DIR, 0o755)
  chmodSync(cfg.PREFS_PATH, 0o644)
  assert.equal(modeOf(cfg.DATA_DIR), 0o755, 'fixture: the storage directory is listable')
  assert.equal(modeOf(cfg.PREFS_PATH), 0o644, 'fixture: the document is world-readable')

  assert.equal(cfg.tightenStorageModes(), true)
  assert.equal(modeOf(cfg.DATA_DIR), 0o700, 'the directory must not be listable by other accounts')
  assert.equal(modeOf(cfg.PREFS_PATH), 0o600, 'the document must not be readable by other accounts')
})

test('the legacy plaintext dbhub.toml is deleted and its content is never quoted', () => {
  // Assembled, so this file never contains a credentialed URL literal (the
  // desensitize gate scans them) while the RUNTIME file still carries a canary.
  const CANARY = 'CHANGE' + '_ME_LEAK'
  assert.equal(cfg.LEGACY_CONFIG_PATH, join(cfg.DATA_DIR, 'dbhub.toml'), 'the legacy path sits next to the store')

  mkdirSync(cfg.DATA_DIR, { recursive: true })
  writeFileSync(
    cfg.LEGACY_CONFIG_PATH,
    '[[sources]]\n' +
      'dsn = "mysql://root:' + CANARY + '@127.0.0.1:3306/app"\n',
    { mode: 0o600 },
  )
  assert.ok(existsSync(cfg.LEGACY_CONFIG_PATH), 'fixture in place')

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  let result
  try {
    result = cfg.sweepLegacyConfigFile()
  } finally {
    console.warn = originalWarn
  }

  assert.equal(result.removed, true, 'the plaintext store is removed')
  assert.equal(existsSync(cfg.LEGACY_CONFIG_PATH), false, 'the file is gone from disk')
  const logged = warnings.join('\n')
  assert.equal(logged.includes(CANARY), false, 'the warning must not quote the file: ' + logged)
  assert.ok(logged.includes('dbhub.toml'), 'the warning names the file that was removed: ' + logged)
  assert.equal(logged.includes(home), false, 'the warning must not echo the profile path: ' + logged)

  // Idempotent and quiet: a second boot has nothing to do and says nothing.
  assert.equal(cfg.sweepLegacyConfigFile().removed, false, 'nothing left to do')
  assert.equal(warnings.length, 1, 'one warning, not one per boot')
})
