// Process helpers.
//
// All child output is captured through FILE DESCRIPTORS instead of pipes on
// purpose: sandboxed shells (and CI weirdness) can refuse pipe creation
// (EPERM on named pipes), while inherit/ignore/file stdio always works. It
// also gives each target an exact, replayable evidence log on disk.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO_ROOT, ensureDir, isWindows, redact, sleep } from './util.mjs'

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

/**
 * Kill a pid and its children. Best effort, never throws.
 *
 * Note: this must NOT skip when the direct child already exited. A wrapper such
 * as `mise x … -- dsh web` can exit while the real server keeps running as a
 * grandchild; skipping on `child.exitCode !== null` leaked those servers.
 */
export function killPid(pid) {
  const numeric = Number(pid)
  if (!Number.isFinite(numeric) || numeric <= 0) return
  try {
    if (isWindows) {
      // TerminateProcess via process.kill works without elevation; taskkill is
      // kept as a best-effort tree kill because some sandboxes deny it.
      try { process.kill(numeric) } catch {}
      spawn('taskkill', ['/PID', String(numeric), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try { process.kill(-numeric, 'SIGTERM') } catch { try { process.kill(numeric, 'SIGTERM') } catch {} }
      setTimeout(() => {
        try { process.kill(-numeric, 'SIGKILL') } catch {}
      }, 3000).unref()
    }
  } catch {}
}

export function killTree(child) {
  if (!child) return
  killPid(child.pid)
  setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }, 5000).unref()
}

/** Pids currently LISTENING on `port` (Windows; empty elsewhere). */
export async function pidsListeningOn(port) {
  if (!isWindows) return []
  const numeric = Number(port)
  if (!Number.isFinite(numeric) || numeric <= 0) return []
  // Pipes are forbidden in confined sandboxes, so redirect netstat to a file.
  const outFile = path.join(process.env.TEMP || process.env.TMP || '.', `dsh-release-port-${numeric}-${process.pid}.txt`)
  // No shell and no pipes: netstat writes straight to a file descriptor.
  await new Promise((resolve) => {
    let fd
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try { fs.closeSync(fd) } catch {}
      resolve()
    }
    try {
      fd = fs.openSync(outFile, 'w')
      const child = spawn('netstat', ['-ano', '-p', 'tcp'], { stdio: ['ignore', fd, fd], windowsHide: true })
      child.on('close', done)
      child.on('error', done)
    } catch {
      done()
    }
  })
  let pids = []
  try {
    pids = fs.readFileSync(outFile, 'utf8').split(/\r?\n/)
      .filter((line) => /LISTENING/.test(line) && new RegExp(`:${numeric}\\s`).test(line))
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter((pid) => /^\d+$/.test(pid) && Number(pid) > 0)
      .map(Number)
  } catch {}
  try { fs.unlinkSync(outFile) } catch {}
  return [...new Set(pids)]
}

/**
 * Kill whatever still listens on `port` and WAIT until the port is free.
 * Last line of defence for a leaked web server (the pid we hold may be a wrapper
 * such as `mise` that already exited). Must be awaited, otherwise the caller's
 * own process.exit() can cancel the cleanup before it runs.
 */
export async function killPortOwner(port) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pids = await pidsListeningOn(port)
    if (!pids.length) return true
    for (const pid of pids) killPid(pid)
    for (let wait = 0; wait < 10; wait += 1) {
      await sleep(200)
      if (!(await pidsListeningOn(port)).length) return true
    }
  }
  return false
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
