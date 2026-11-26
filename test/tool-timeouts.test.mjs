// A tool that waits for a HUMAN must not declare a tool-level `timeoutMs`.
//
// `defineTool({ timeoutMs })` makes the harness abort `exec.signal` when the
// deadline passes, and the approval service maps an aborted signal to
// `'cancelled'`. The write dialog (and the password dialog in dbhub_configure)
// then closes itself, and the model is told the user refused — real session
// logs show every cancelled dbhub approval sitting at exactly 60s, which was
// this declaration. Tools that never wait for a human keep their deadline so a
// hung machine cannot pin a turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8')

/** Split the registration source into one chunk per `name: 'dbhub_*'` tool. */
function toolBlocks() {
  const starts = []
  const re = /name: '(dbhub_[a-z_]+)'/g
  let m
  while ((m = re.exec(source)) !== null) starts.push({ name: m[1], at: m.index })
  return starts.map((start, i) => ({
    name: start.name,
    body: source.slice(start.at, i + 1 < starts.length ? starts[i + 1].at : source.length),
  }))
}

const blocks = toolBlocks()
const byName = new Map(blocks.map((b) => [b.name, b]))

test('all four dbhub tools are registered in the source the gate reads', () => {
  for (const name of ['dbhub_configure', 'dbhub_list_sources', 'dbhub_execute_sql', 'dbhub_search_objects']) {
    assert.ok(byName.has(name), `${name} is missing from lib/tools.mjs`)
  }
})

test('the two tools that wait for a human declare no tool-level timeout', () => {
  for (const name of ['dbhub_configure', 'dbhub_execute_sql']) {
    const body = byName.get(name).body
    // Only the registration site matters; a mention inside a comment is fine.
    const hit = body
      .split('\n')
      .filter((line) => /^\s*timeoutMs\s*:/.test(line))
    assert.deepEqual(hit, [], `${name} must not declare timeoutMs — it would cancel the dialog and report 'cancelled'`)
  }
})

test('tools with no human in the loop keep a bounded deadline', () => {
  for (const name of ['dbhub_list_sources', 'dbhub_search_objects']) {
    const body = byName.get(name).body
    const hit = body.split('\n').filter((line) => /^\s*timeoutMs\s*:/.test(line))
    assert.equal(hit.length, 1, `${name} must keep exactly one timeoutMs declaration`)
  }
})
