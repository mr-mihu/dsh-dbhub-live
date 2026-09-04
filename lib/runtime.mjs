// dsh-dbhub-live: managed dbhub executable resolution.
//
// When no `dbhub` executable is present (PATH / mise / previous install), the
// plugin installs the MCP server once, on demand, into a private prefix under
// the storage dir, then reuses that binary on every later boot. This is
// deliberately an install-ONCE-at-init design (NOT `npx` on every spawn):
// the ad-hoc tools spawn a fresh dbhub process on EVERY call, so an npx-per-
// call approach would add several hundred ms to every query and break offline.
// The resolved executable path is persisted so later boots skip re-discovery.

import { existsSync, statSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, RUNTIME_DIR, runtime, saveRuntime, ensureStorageDir } from './config.mjs'
import * as options from './options.mjs'

// Auto-update interval and install package are deployment-tunable options
// (Settings -> Plugins -> dsh-dbhub-live); only our own managed install is
// ever refreshed — a dbhub the user installed himself (PATH / mise) is never
// touched.

// ── executable lookup ─────────────────────────────────────────────────────

function findDbhubExe() {
  // 1) a previously managed / mise-installed binary is the fastest path
  if (runtime.dbhubExe) {
    try {
      if (existsSync(runtime.dbhubExe) && statSync(runtime.dbhubExe).isFile()) return runtime.dbhubExe
    } catch (e) {
      runtime.dbhubExe = undefined
      saveRuntime(runtime)
    }
  }
  // 2) mise-managed install (`mise x npm:@bytebase/dbhub` or a manual install)
  const dataDir = process.env.MISE_DATA_DIR
  if (dataDir) {
    try {
      const base = join(dataDir, 'npm-bytebase-dbhub')
      const versions = readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      const cmp = (a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
        return 0
      }
      versions.sort(cmp)
      for (let i = versions.length - 1; i >= 0; i--) {
        for (const bin of ['dbhub.cmd', 'dbhub']) {
          const p = join(base, versions[i], 'node_modules', '.bin', bin)
          try {
            if (existsSync(p) && statSync(p).isFile()) {
              runtime.dbhubExe = p
              saveRuntime(runtime)
              return p
            }
          } catch (e) {
            /* keep looking */
          }
        }
      }
    } catch (e) {
      /* fall through */
    }
  }
  return undefined
}

function dbhubExeInDir(dir) {
  if (!dir) return undefined
  for (const bin of ['dbhub.cmd', 'dbhub']) {
    const p = join(dir, 'node_modules', '.bin', bin)
    try {
      if (existsSync(p) && statSync(p).isFile()) return p
    } catch (e) {
      /* keep looking */
    }
  }
  return undefined
}

// Windows `cmd.exe /c` wrapping for .cmd/.bat shims: the subprocess service
// spawns argv directly, so a shim needs a cmd shell to run inside.
export function buildSpawnArgv(subprocess, exe, args) {
  if (process.platform !== 'win32') return [exe, ...args]
  if (!/\.(cmd|bat)$/i.test(exe)) return [exe, ...args]
  const quote = (s) => (/[\s&|<>^"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)
  return ['cmd.exe', '/c', [quote(exe), ...args.map(quote)].join(' ')]
}

// ── auto-install ──────────────────────────────────────────────────────────

let installingDbhub // single in-flight install guard

// Install the dbhub MCP server once, into a private prefix under the storage
// dir. Uses `npm install --prefix <RUNTIME_DIR>` (deterministic, offline-safe
// afterwards) rather than `npx <pkg>` per call. The package/version is a
// configurable option (default installs the latest).
async function installDbhub(subprocess, signal) {
  if (installingDbhub) return installingDbhub
  if (!subprocess) {
    throw new Error('subprocess 服务不可用，无法自动安装 dbhub')
  }
  installingDbhub = (async () => {
    let npmExe
    try {
      npmExe = await subprocess.resolveExecutable('npm', undefined, signal)
    } catch (e) {
      throw new Error('未找到 npm，无法自动安装 dbhub（请先安装 Node.js/npm，或手动把 dbhub 加入 PATH 后重试）')
    }
    // The storage dir may have been cleaned while running; npm needs it as cwd.
    if (!ensureStorageDir()) {
      throw new Error('无法创建 dbhub 运行时目录 ' + DATA_DIR + '（写入被拦截）')
    }
    const dbhubPackage = options.get('dbhubPackage') || '@bytebase/dbhub'
    const args = [
      'install',
      dbhubPackage,
      '--prefix', RUNTIME_DIR,
      '--no-save', '--no-fund', '--no-audit',
      '--loglevel=error',
    ]
    let handle
    try {
      handle = subprocess.spawn({
        argv: buildSpawnArgv(subprocess, npmExe, args),
        cwd: DATA_DIR,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 180000,
        signal,
      })
    } catch (e) {
      throw new Error('启动 npm 安装失败: ' + String((e && e.message) || e))
    }
    let errTail = ''
    if (handle.stderr) {
      handle.stderr.on('data', (c) => {
        errTail = (errTail + String(c)).slice(-2000)
      })
    }
    try {
      const outcome = await handle.done
      if (outcome.exitCode !== 0 || outcome.signal) {
        throw new Error(
          '自动安装 dbhub 失败 (npm exit ' + outcome.exitCode + ')' + (errTail ? ': ' + errTail : ''),
        )
      }
    } finally {
      try {
        handle.terminate()
      } catch (e) {
        /* ignore */
      }
    }
    const exe = dbhubExeInDir(RUNTIME_DIR)
    if (!exe) {
      throw new Error('npm 安装完成，但未在 ' + RUNTIME_DIR + ' 下找到 dbhub 可执行文件')
    }
    runtime.dbhubInstallAt = Date.now()
    console.log('[dsh-dbhub-live] 已自动安装 dbhub (' + dbhubPackage + ') → ' + exe)
    return exe
  })()
  try {
    const exe = await installingDbhub
    return exe
  } finally {
    installingDbhub = undefined
  }
}

// Resolve the dbhub executable: persisted → mise → PATH → install-on-demand.
export async function resolveDbhubExe(subprocess, signal) {
  const cached = findDbhubExe()
  if (cached) return cached
  if (subprocess) {
    try {
      const exe = await subprocess.resolveExecutable('dbhub', undefined, signal)
      runtime.dbhubExe = exe
      saveRuntime(runtime)
      return exe
    } catch (e) {
      /* not on PATH — fall through to install */
    }
  }
  const installed = await installDbhub(subprocess, signal)
  runtime.dbhubExe = installed
  saveRuntime(runtime)
  return installed
}

// Is the current executable one WE auto-installed (as opposed to a dbhub the
// user installed himself via PATH / mise)? Only ours is eligible for auto-
// update — we must never silently upgrade a user-managed binary.
export function isAutoManagedExe() {
  const exe = runtime.dbhubExe
  if (!exe || typeof exe !== 'string') return false
  const dir = RUNTIME_DIR.replace(/[\\/]+$/, '')
  const e = exe.replace(/[\\/]+$/, '')
  return e.toLowerCase().startsWith(dir.toLowerCase())
}

// Refresh the auto-installed dbhub to the latest version, but only when a
// configured interval has elapsed. Runs `npm install` into the SAME prefix,
// which upgrades the binary in place — the resolved path stays valid, so
// concurrently-running queries keep using a working dbhub throughout.
// Never blocks boot: callers should NOT await it.
export async function maybeRefreshDbhub(subprocess) {
  if (!isAutoManagedExe()) return
  if (!(runtime.dbhubInstallAt > 0)) return
  const intervalDays = options.get('updateIntervalDays')
  if (!(intervalDays > 0)) return // auto-update disabled
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000
  if (Date.now() - runtime.dbhubInstallAt < intervalMs) return
  try {
    await installDbhub(subprocess, undefined)
    console.log('[dsh-dbhub-live] dbhub 已自动更新到最新版')
  } catch (e) {
    // Non-fatal: keep using the existing (older) binary.
    console.error('[dsh-dbhub-live] dbhub 自动更新失败（沿用现有版本）: ' + String((e && e.message) || e))
  }
}

