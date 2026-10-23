// Process helpers.
//
// All child output is captured through FILE DESCRIPTORS instead of pipes on
// purpose: sandboxed shells (and CI weirdness) can refuse pipe creation
// (EPERM on named pipes), while inherit/ignore/file stdio always works. It
// also gives each target an exact, replayable evidence log on disk.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureDir, isWindows, redact, sleep } from './util.mjs'

export const LOG_SECTION = (title) => `\n===== ${title} =====\n`

/**
 * Run a command to completion with stdout+stderr appended to `logFile`.
 * Returns { code, signal, durationMs }. Never throws on non-zero exit.
 */
export function run(cmd, args, { cwd = process.cwd(), env = process.env, logFile, timeoutMs = 15 * 60_000, label = cmd } = {}) {
  ensureDir(path.dirname(logFile))
  const started = Date.now()
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'a')
    fs.writeSync(fd, LOG_SECTION(`$ ${label} ${args.join(' ')}`.trim()))
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        // A detached process group lets us kill the whole tree (pnpm/npm children).
        detached: !isWindows,
      })
    } catch (error) {
      fs.writeSync(fd, `\nspawn failed: ${error.message}\n`)
      fs.closeSync(fd)
      resolve({ code: -1, signal: null, durationMs: 0, spawnError: error.message })
      return
    }

    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { fs.closeSync(fd) } catch {}
      resolve({ code, signal, durationMs: Date.now() - started })
    }

    const timer = setTimeout(() => {
      fs.writeSync(fd, `\n[timeout] ${label} exceeded ${timeoutMs}ms — killing\n`)
      killTree(child)
      finish(-2, 'timeout')
    }, timeoutMs)

    child.on('error', (error) => {
      fs.writeSync(fd, `\nspawn error: ${error.message}\n`)
      finish(-1, null)
    })
    child.on('exit', (code, signal) => {
      fs.writeSync(fd, `\n[exit] code=${code} signal=${signal ?? ''}\n`)
      finish(code, signal)
    })
  })
}

/** Start a long-lived process (the web server) with detached=false; caller stops it. */
export function start(cmd, args, { cwd = process.cwd(), env = process.env, logFile, label = cmd } = {}) {
  ensureDir(path.dirname(logFile))
  const fd = fs.openSync(logFile, 'a')
  fs.writeSync(fd, LOG_SECTION(`$ ${label} ${args.join(' ')}`.trim()))
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    detached: !isWindows,
  })
  child.on('exit', (code, signal) => {
    try { fs.writeSync(fd, `\n[exit] code=${code} signal=${signal ?? ''}\n`) } catch {}
    try { fs.closeSync(fd) } catch {}
  })
  return child
}

/** Kill a process and its children. Best effort, never throws. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (isWindows) {
      // taskkill without stdio capture: spawn with 'ignore' is allowed in sandboxes.
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }, 3000).unref()
    }
  } catch {}
  setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }, 5000).unref()
}

/** Read a file if it exists, else ''. */
export function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/** Poll until predicate(content) is truthy, or timeout. Returns { ok, content }. */
export async function waitForFile(file, predicate, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const content = readIfExists(file)
    if (content) {
      const hit = predicate(content)
      if (hit) return { ok: true, content, hit }
    }
    await sleep(intervalMs)
  }
  return { ok: false, content: readIfExists(file), hit: null }
}

/** Redacted copy of a log file for evidence bundles. */
export function redactedLog(file) {
  return redact(readIfExists(file))
}
