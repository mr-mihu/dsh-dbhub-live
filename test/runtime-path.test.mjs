// P2-17: `isAutoManagedExe` decides whether the auto-update may `npm install`
// over the resolved dbhub. It used a raw STRING prefix comparison, so a prefix
// that merely starts with our runtime directory's name — `…/dbhub-runtime2/…`,
// `…/dbhub-runtime-other/…` — counted as "ours" and an auto-update would have
// rewritten a prefix the user manages (or one created by a second profile).
//
// The check is a path boundary, so it must be expressed as one: `path.relative`
// returns `..\…` for a sibling, which is exactly the discriminator.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-rtpath-'))
process.env.DSH_HOME = home

const cfg = await import('../lib/config.mjs')
const rt = await import('../lib/runtime.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

const exeIn = (dir) => join(dir, 'node_modules', '.bin', 'dbhub.cmd')

/** Point the resolved executable at `exe` and report the verdict. */
function verdict(exe) {
  cfg.runtime.dbhubExe = exe
  return rt.isAutoManagedExe()
}

test('only a path INSIDE the managed runtime prefix is auto-managed', () => {
  assert.equal(verdict(exeIn(cfg.RUNTIME_DIR)), true, 'the managed install itself')
  assert.equal(verdict(join(cfg.RUNTIME_DIR, 'deep', 'er', 'dbhub.exe')), true, 'nested inside the prefix')
  // The sibling directory whose NAME starts with ours: `…/dbhub-runtime2/…`.
  const sibling2 = join(dirname(cfg.RUNTIME_DIR), basename(cfg.RUNTIME_DIR) + '2')
  assert.equal(verdict(exeIn(sibling2)), false, 'a prefix that only starts with our name is not ours')
  const siblingOther = join(dirname(cfg.RUNTIME_DIR), basename(cfg.RUNTIME_DIR) + '-other')
  assert.equal(verdict(exeIn(siblingOther)), false, 'a name-prefixed sibling is not ours')
  // The prefix itself is not an executable, and its parent is not inside it.
  assert.equal(verdict(cfg.RUNTIME_DIR), false)
  assert.equal(verdict(join(dirname(cfg.RUNTIME_DIR), 'dbhub.cmd')), false)
  // A user-managed dbhub (PATH / mise) is never ours.
  assert.equal(verdict(join(home, '.local', 'bin', 'dbhub')), false)
  // Non-values never claim the prefix.
  assert.equal(verdict(''), false)
  assert.equal(verdict(undefined), false)
  assert.equal(verdict(null), false)
  assert.equal(verdict(42), false)
})
