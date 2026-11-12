// Connection aliases: the short, typable display name behind the composer's
// `@` references (`@app_prod 的表在 @billing_prod 里`).
//
// The alias is assigned over the WHOLE row set in lib/collect.mjs — the single
// implementation point; the browser half and the policy catalog only read it.
// What is asserted here:
//   1. shape: one alias per row, aligned with the input order, never empty;
//   2. uniqueness across ALL workspaces — the same environment name in two
//      workspaces never collapses onto one menu entry (two connections behind
//      one name would make the reference unpickable);
//   3. determinism: the same row SET produces the same aliases regardless of the
//      order the discovery walk happened to append them;
//   4. hygiene: no whitespace and no `@` (the alias is typed right after `@`);
//   5. readability: ASCII and non-ASCII names both keep their own text, and a
//      distinctive trailing part of a long name is not thrown away.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module graph derives the storage directory from DSH_HOME at import time.
const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-alias-'))
process.env.DSH_HOME = home

const { assignConnectionAliases } = await import('../lib/collect.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

/** `[title, env, path?]` triples → live-row shape ({ title, env, wsPath }). */
const rowsOf = (triples) => triples.map(([title, env, path]) => ({ title, env, wsPath: path }))

/** Alias per row identity, so two input orders can be compared as maps. */
const byIdentity = (list) => {
  const aliases = assignConnectionAliases(list)
  const out = {}
  list.forEach((r, i) => {
    out[String(r.title) + '|' + String(r.env) + '|' + String(r.wsPath)] = aliases[i]
  })
  return out
}

test('a lone row is named after its environment (the default env included)', () => {
  assert.deepEqual(assignConnectionAliases([]), [])
  assert.deepEqual(assignConnectionAliases(rowsOf([['app', 'prod']])), ['prod'])
  assert.deepEqual(assignConnectionAliases(rowsOf([['app', 'default']])), ['default'])
  assert.deepEqual(assignConnectionAliases(rowsOf([['app', '线上']])), ['线上'])
})

test('the same environment name in two workspaces gets workspace-prefixed aliases', () => {
  // The reported shape: `prod` exists in two workspaces, so neither may keep the
  // bare name — a single `@prod` menu entry could only ever mean one of them.
  const aliases = assignConnectionAliases(rowsOf([
    ['app', 'prod', 'p1'],
    ['billing', 'prod', 'p2'],
    ['app', 'default', 'p1'],
  ]))
  assert.deepEqual(aliases, ['app_prod', 'billing_prod', 'default'])
})

test('a composite that is still taken is disambiguated with -2, -3', () => {
  // Two workspaces with the SAME title and environment: the workspace prefix
  // cannot separate them, so the suffix does. The order is the sorted path, so
  // the same path always gets the same alias.
  assert.deepEqual(assignConnectionAliases(rowsOf([
    ['app', 'prod', 'p1'],
    ['app', 'prod', 'p2'],
  ])), ['app_prod', 'app_prod-2'])
  assert.deepEqual(assignConnectionAliases(rowsOf([
    ['app', 'prod', 'p2'],
    ['app', 'prod', 'p1'],
  ])), ['app_prod-2', 'app_prod'])
})

test('an unambiguous environment name is reserved before composites are handed out', () => {
  // A row whose environment is literally `app_prod` owns that name; the
  // colliding `prod` row is the one that moves.
  const rows = rowsOf([
    ['app', 'prod', 'p1'],
    ['billing', 'prod', 'p2'],
    ['app', 'app_prod', 'p1'],
  ])
  assert.deepEqual(assignConnectionAliases(rows), ['app_prod-2', 'billing_prod', 'app_prod'])
})

test('non-ASCII environment names stay readable and unique', () => {
  assert.deepEqual(assignConnectionAliases(rowsOf([
    ['应用', '线上', 'p1'],
    ['报表', '线上', 'p2'],
    ['应用', '测试', 'p1'],
  ])), ['应用_线上', '报表_线上', '测试'])
})

test('a long environment name is kept whole and still separates look-alikes', () => {
  const long = 'x'.repeat(64)
  const aliases = assignConnectionAliases(rowsOf([
    ['app', long, 'p1'],
    ['billing', long, 'p2'],
    ['app', long.slice(0, 63) + 'y', 'p1'],
  ]))
  assert.equal(aliases.length, 3)
  assert.equal(new Set(aliases).size, 3, JSON.stringify(aliases))
  assert.equal(aliases[0], 'app_' + long)
  assert.equal(aliases[1], 'billing_' + long)
  assert.equal(aliases[2].length, 64, 'the near-miss name is not truncated into a collision')
})

test('blank names fall back instead of producing an empty alias', () => {
  assert.deepEqual(assignConnectionAliases(rowsOf([['', '']])), ['env'])
  assert.deepEqual(assignConnectionAliases(rowsOf([['', ''], ['', '']])), ['ws_env', 'ws_env-2'])
})

test('no alias ever contains whitespace or the @ marker', () => {
  const rows = rowsOf([
    ['my app', 'my env', 'p1'],
    ['b@d', 'a@b', 'p2'],
    ['  ', '   ', 'p3'],
    ['app\tx', 'prod\n2', 'p4'],
  ])
  const aliases = assignConnectionAliases(rows)
  for (const alias of aliases) {
    assert.ok(alias.length > 0, 'an alias is never empty')
    assert.doesNotMatch(alias, /[\s@]/, JSON.stringify(alias))
  }
  assert.equal(new Set(aliases).size, aliases.length, JSON.stringify(aliases))
})

test('the assignment does not depend on the order the rows were discovered', () => {
  const rows = rowsOf([
    ['app', 'prod', 'p1'],
    ['app', 'prod', 'p2'],
    ['billing', 'prod', 'p2'],
    ['billing', 'prod', 'p1'],
    ['app', 'app_prod', 'p1'],
    ['docs', 'default', 'p3'],
  ])
  const shuffled = [rows[4], rows[3], rows[0], rows[5], rows[2], rows[1]]
  assert.deepEqual(byIdentity(shuffled), byIdentity(rows))
  // ... and the result really is unique, which is what the menu needs.
  const aliases = assignConnectionAliases(rows)
  assert.equal(new Set(aliases).size, aliases.length, JSON.stringify(aliases))
})

test('the assignment never depends on scan order for a large set', () => {
  const rows = rowsOf(Array.from({ length: 30 }, (_, i) => ['ws' + (i % 7), 'prod', 'p' + i]))
  const aliases = assignConnectionAliases(rows)
  assert.equal(new Set(aliases).size, aliases.length, 'every connection has its own alias')
  const reversed = rows.slice().reverse()
  assert.deepEqual(byIdentity(reversed), byIdentity(rows))
})

test('the full row set is summarized with one alias per row', async () => {
  // summarizeRows is the single place the alias enters the published view
  // (`/state` → `workspaces`); a browser half never computes its own.
  const mcp = await import('../lib/mcp.mjs')
  const summaries = mcp.summarizeRows([
    { wsPath: 'D:/work/app', title: 'app', env: 'prod', dsn: 'mysql://127.0.0.1:3306/a' },
    { wsPath: 'D:/work/billing', title: 'billing', env: 'prod', dsn: 'mysql://127.0.0.1:3306/b' },
  ])
  assert.deepEqual(summaries.map((s) => s.alias), ['app_prod', 'billing_prod'])
  // Alias is display text only: the immutable identity is still srcId.
  const srcIds = summaries.map((s) => s.srcId)
  assert.equal(new Set(srcIds).size, 2, 'the handles stay distinct')
  assert.ok(srcIds[0].startsWith('app_') && srcIds[1].startsWith('billing_'), JSON.stringify(srcIds))
  assert.equal(JSON.stringify(summaries).includes('password'), false)
})
