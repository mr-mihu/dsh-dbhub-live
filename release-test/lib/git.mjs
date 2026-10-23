// Read-only git facts, shared by the runner and the preflight gate.
//
// stdout is captured through a file descriptor, not a pipe: piped stdio can be
// refused in sandboxed shells (EPERM), and git is too important to this gate to
// silently degrade to "unknown".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from './util.mjs'
import { run } from './proc.mjs'

let counter = 0
async function gitAsync(args) {
  const logFile = path.join(os.tmpdir(), `dsh-release-git-${process.pid}-${counter++}.log`)
  try {
    const res = await run('git', args, { cwd: REPO_ROOT, logFile, timeoutMs: 20_000, label: `git ${args.join(' ')}` })
    const text = fs.readFileSync(logFile, 'utf8')
    // Strip our own "$ …"/[exit] framing, keep git's stdout.
    const body = text.replace(/^[\s\S]*?=====\n/, '').replace(/\n\[exit\][\s\S]*$/, '')
    return { code: res.code, out: body.trim() }
  } finally {
    fs.rmSync(logFile, { force: true })
  }
}

const lastLine = (result) => (result.code === 0 ? result.out.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? null : null)

/** Async git facts. Returns nulls when git is unavailable rather than throwing. */
export async function gitInfoAsync() {
  const [branch, commit, status, tag, tree] = await Promise.all([
    gitAsync(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitAsync(['rev-parse', 'HEAD']),
    gitAsync(['status', '--porcelain']),
    gitAsync(['describe', '--tags', '--exact-match']),
    gitAsync(['rev-parse', 'HEAD^{tree}']),
  ])
  return {
    branch: lastLine(branch),
    commit: lastLine(commit),
    dirty: status.code === 0 ? Boolean(status.out.trim()) : null,
    tag: lastLine(tag),
    // The TREE is what actually ships. Comparing trees (instead of commits) lets
    // a report survive a ff/squash merge that does not change content, while
    // still refusing a report when any file changed.
    tree: lastLine(tree),
  }
}

/** Files changed relative to HEAD, for explaining why a dirty tree matters. */
export async function dirtyFilesAsync(limit = 10) {
  const status = await gitAsync(['status', '--porcelain'])
  return status.out.split('\n').filter(Boolean).slice(0, limit)
}
