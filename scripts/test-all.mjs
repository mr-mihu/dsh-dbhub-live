#!/usr/bin/env node
// Run every test/*.test.mjs in its OWN node process, in a stable order.
//
// Why not `node --test test/`: the built-in runner spawns a child runner whose
// piped stdio a sandboxed shell can refuse (EPERM), which turns "the suite is
// red" into "the runner could not start". Why not a `for f in test/*.test.mjs`
// shell loop: that is not portable to cmd.exe, so it breaks `prepublishOnly` on
// Windows. A plain spawn per file is cross-platform and keeps one file's failure
// from hiding another's.
//
// Usage: npm run test:unit   (exit 0 = all files green, exit 1 = at least one)
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_DIR = join(ROOT, 'test')

const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('[test] no test/*.test.mjs found — did the directory move?')
  process.exitCode = 1
} else {
  const failed = []
  for (const name of files) {
    const result = spawnSync(process.execPath, [join(TEST_DIR, name)], { cwd: ROOT, stdio: 'inherit' })
    // A killed process reports status null on POSIX; keep it a failure either way.
    if (result.status !== 0) failed.push(`${name} (exit ${result.status ?? result.signal ?? 'unknown'})`)
  }
  if (failed.length > 0) {
    console.error(`[test] ${failed.length} of ${files.length} file(s) failed:`)
    for (const name of failed) console.error(`  - ${name}`)
    process.exitCode = 1
  } else {
    console.log(`[test] ${files.length} file(s) passed`)
  }
}
