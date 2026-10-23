// Boot a real `dsh web` on an isolated home and find its ready line.
import net from 'node:net'
import { REPO_ROOT, sleep, tail } from './util.mjs'
import { readIfExists, start, killTree } from './proc.mjs'
import { cliInvocation } from './cli-source.mjs'
import { dshEnv, workspaceDir } from './home.mjs'

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const READY_RE = /dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w.-]+))/
const FAIL_RE = /(?:^|\n)\s*(?:Error|TypeError|ReferenceError):|\[fatal\]|cannot find module/i

/**
 * Start the web app and wait until it prints the ready URL.
 * Returns { child, base, url, token, readyMs, logTail }.
 */
export async function bootServer({ version, cli, port, logFile, timeoutMs = 120_000 }) {
  const started = Date.now()
  const invocation = cliInvocation(cli, ['web', '--port', String(port), '--no-open'])
  const child = start(invocation.cmd, invocation.args, {
    cwd: workspaceDir(version),
    env: dshEnv(version),
    logFile,
    label: `dsh@${version} web --port ${port}`,
  })
  let text = ''
  while (Date.now() - started < timeoutMs) {
    text = readIfExists(logFile)
    const match = READY_RE.exec(text)
    if (match) {
      return {
        child,
        base: `http://127.0.0.1:${match[2]}`,
        url: match[1],
        token: match[3],
        readyMs: Date.now() - started,
        logTail: tail(text, 2000),
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`dsh web exited before ready (code ${child.exitCode}) after ${Date.now() - started}ms:\n${tail(text)}`)
    }
    if (FAIL_RE.test(text)) {
      throw new Error(`dsh web logged a fatal error before ready:\n${tail(text)}`)
    }
    await sleep(200)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the "dsh web:" ready line:\n${tail(text)}`)
}

export function stopServer(child) {
  killTree(child)
}
