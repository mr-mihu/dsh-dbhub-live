// Unit tests for the ad-hoc connection guard: surfaced (masked) DSNs must be
// refused loudly so the model never burns a failed auth round-trip with `****`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-adhoc-'))
process.env.DSH_HOME = home
const adhoc = await import('../lib/adhoc.mjs?adhoc=' + Date.now())

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('isMaskedDsn detects masked passwords', () => {
  assert.equal(adhoc.isMaskedDsn('mysql://root:****@10.253.0.3:3307/tx_zdsf_main_pro'), true)
  assert.equal(adhoc.isMaskedDsn('postgres://u:****@h/db'), true)
  assert.equal(adhoc.isMaskedDsn('mysql://root:**@h/db'), true)
})

test('isMaskedDsn tolerates real DSNs', () => {
  assert.equal(adhoc.isMaskedDsn('mysql://root:hbtx.1234@10.253.0.3:3307/tx_zdsf_main_pro'), false)
  assert.equal(adhoc.isMaskedDsn('sqlite:///C:/data/x.db'), false)
  assert.equal(adhoc.isMaskedDsn(''), false)
  assert.equal(adhoc.isMaskedDsn(undefined), false)
})