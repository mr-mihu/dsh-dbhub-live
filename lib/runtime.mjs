// dsh-dbhub-live: managed dbhub executable resolution.
//
// There are exactly two ways a `dbhub` executable shows up here:
//   1. the user already has one — PATH or a mise-managed install; and
//   2. the user approved ONE install, prompted from the tool call that needed
//      it (see `installDbhub`), of a PINNED release into a private prefix.
// Nothing else. There is no `npx`-per-call, no boot-time download, and no
// background upgrade: `DBHUB_PINNED_VERSION` below is the only version this
// plugin ever installs by itself, and it changes only in a release that
// re-tested the generated TOML against it. A reviewer (and a user) can read
// this file and know exactly which third-party code can run.
//
// The approva, the prompt and the refusal text live one layer up (tools.mjs),
// where the DSH approval service is reachable; this module only knows how to
// install and how to say "not installed".

import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { DATA_DIR, RUNTIME_DIR, runtime, saveRuntime, ensureStorageDir, scrubSecrets } from './config.mjs'

// ── the pinned runtime ────────────────────────────────────────────────────

/**
 * The ONE dbhub release this plugin installs on its own.
 *
 * 2.1.0 is the release this build was verified against end to end: the MCP
 * handshake (protocolVersion 2025-03-26), `tools/list` (execute_sql +
 * search_objects), a real `execute_sql`, and the generated read-only TOML
 * (`--config`) all work unchanged. The version guard in capability.mjs still
 * accepts a user-installed 1.4.0+ (that dialect is what the TOML was written
 * for), but what WE install is this one. Raising it is a code change with a
 * test run behind it — never a knob, never a "latest".
 */
export const DBHUB_PINNED_VERSION = '2.1.0'

export const DBHUB_PACKAGE = '@bytebase/dbhub'

/** `<package>@<version>` — the exact string handed to npm. */
export const DBHUB_INSTALL_SPEC = DBHUB_PACKAGE + '@' + DBHUB_PINNED_VERSION

/**
 * Connector packages installed ALONGSIDE dbhub as direct roots.
 *
 * dbhub declares its connectors as optionalDependencies, so a plain install of
 * it drags `oracledb`, `cpu-features` (node-gyp) and the AWS SDK in — and pnpm
 * 11+, which every DSH profile uses, refuses to run unapproved dependency build
 * scripts at all. Installing `--omit=optional` plus these four as explicit
 * roots gives exactly the five databases this plugin advertises, with no
 * compiler and no postinstall script anywhere in the tree.
 */
export const DBHUB_DRIVER_PACKAGES = ['mysql2', 'pg', 'mssql', 'mariadb']

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

// ── the one explicit install ──────────────────────────────────────────────

let installingDbhub // single in-flight install guard

/**
 * Total budget for one `npm install`. `graceMs` on the spawn only bounds
 * SIGTERM → SIGKILL, NOT the install: without this a wedged npm (a stuck registry
 * socket, a prompt on an ignored stdin) keeps `installingDbhub` in flight and the
 * single-flight guard then makes dbhub unavailable for the rest of the session.
 */
export const DBHUB_INSTALL_TIMEOUT_MS = 180000

// Test seam (same shape as config.mjs `setFsHooks`): the robustness test shrinks
// the budget so the timeout path is provable in milliseconds. 0 restores default.
let installTimeoutMs = DBHUB_INSTALL_TIMEOUT_MS

/** Override the install budget for tests; `<= 0` or non-finite restores the default. */
export function setInstallTimeoutMs(ms) {
  installTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DBHUB_INSTALL_TIMEOUT_MS
}

/**
 * Install the PINNED dbhub release into a private prefix under the storage dir.
 *
 * Callers must have obtained the user's consent first (tools.mjs asks through
 * the DSH approval service and only then reaches this function). The argv is
 * fixed: the spec carries the version, `--omit=optional` keeps every
 * script-bearing package out of the tree, and the four drivers ride along as
 * explicit roots. Runs once per profile; later calls resolve the binary.
 *
 * @returns the executable path.
 */
export async function installDbhub(subprocess, signal) {
  if (installingDbhub) return installingDbhub
  if (!subprocess) {
    throw new Error('subprocess 服务不可用，无法安装 dbhub')
  }
  installingDbhub = (async () => {
    let npmExe
    try {
      npmExe = await subprocess.resolveExecutable('npm', undefined, signal)
    } catch (e) {
      throw new Error('未找到 npm，无法安装 dbhub（请先安装 Node.js/npm，或手动把 dbhub 加入 PATH 后重试）')
    }
    // The storage dir may have been cleaned while running; npm needs it as cwd.
    if (!ensureStorageDir()) {
      throw new Error('无法创建 dbhub 运行时目录 ' + DATA_DIR + '（写入被拦截）')
    }
    const args = [
      'install',
      DBHUB_INSTALL_SPEC,
      ...DBHUB_DRIVER_PACKAGES,
      '--prefix', RUNTIME_DIR,
      '--no-save', '--no-fund', '--no-audit',
      '--omit=optional',
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
    // npm's stderr is quoted into the model-visible failure message below, so it
    // is decoded across chunk boundaries (a split multibyte character would show
    // as U+FFFD) and scrubbed before it can reach that text: npm echoes proxy
    // URLs (`https://user:token@…`) and absolute paths on install failures.
    const errDecoder = new StringDecoder('utf8')
    let errTail = ''
    if (handle.stderr) {
      handle.stderr.on('data', (c) => {
        const piece = typeof c === 'string' ? c : errDecoder.write(c)
        errTail = (errTail + piece).slice(-2000)
      })
    }
    // stdout had NO reader at all: `--loglevel=error` still prints progress and a
    // summary, and once the 64 KiB pipe filled npm blocked forever on write — the
    // install never exited and the single-flight promise never settled. Drain it
    // and throw the content away: the install failure message quotes npm's STDERR
    // only, so keeping a stdout tail would be dead weight in memory.
    const outDecoder = new StringDecoder('utf8')
    if (handle.stdout) {
      handle.stdout.on('data', (c) => {
        outDecoder.write(String(c))
      })
    }
    let timer = null
    try {
      const cap = installTimeoutMs
      // Source order matters: the timeout rejects, and the `finally` below clears
      // the timer and terminates the child on every path.
      const outcome = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            handle.terminate()
          } catch (e) {
            /* ignore */
          }
          const err = new Error(
            '安装 dbhub 超时：npm 在 ' + Math.max(1, Math.round(cap / 1000)) + ' 秒内没有结束，已终止安装进程（稍后可重试）',
          )
          err.code = 'DBHUB_INSTALL_TIMEOUT'
          err.timeoutMs = cap
          reject(err)
        }, cap)
        handle.done.then(resolve, (e) => reject(e instanceof Error ? e : new Error(String(e))))
      })
      if (outcome.exitCode !== 0 || outcome.signal) {
        // Scrub before quoting: this message reaches the model through
        // `result.dbhubFetchFailed`, and npm's own text can carry a proxy URL
        // with credentials or the user's absolute paths.
        const tail = errTail ? ': ' + scrubSecrets(errTail, undefined, []) : ''
        throw new Error('安装 dbhub 失败 (npm exit ' + outcome.exitCode + ')' + tail)
      }
    } finally {
      if (timer) clearTimeout(timer)
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
    runtime.dbhubExe = exe
    saveRuntime(runtime)
    console.log('[dsh-dbhub-live] 已安装 dbhub (' + DBHUB_INSTALL_SPEC + ') → ' + exe)
    return exe
  })()
  try {
    const exe = await installingDbhub
    return exe
  } finally {
    installingDbhub = undefined
  }
}

/**
 * Resolve an ALREADY INSTALLED dbhub: persisted path → mise → PATH.
 *
 * Never installs. Throws `code:'DBHUB_NOT_INSTALLED'` when there is none, which
 * the tool layer turns into one approval prompt (and, on refusal, into a
 * message that names the pinned version instead of a silent download).
 */
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
      /* not on PATH — report, do not install */
    }
  }
  const err = new Error('dbhub is not installed')
  err.code = 'DBHUB_NOT_INSTALLED'
  throw err
}

// Is the current executable one WE installed (as opposed to a dbhub the user
// installed himself via PATH / mise)? Only ours may be replaced by a later
// approved install into the same prefix.
export function isAutoManagedExe() {
  const exe = runtime.dbhubExe
  if (!exe || typeof exe !== 'string') return false
  let rel
  try {
    // `path.relative` IS the boundary check: a sibling prefix that merely shares
    // the textual prefix (`…/dbhub-runtime2/…`, `…/dbhub-runtime-other/…`) comes
    // back as `..\dbhub-runtime2\…` instead of passing a `startsWith` test.
    rel = relative(RUNTIME_DIR, exe)
  } catch (e) {
    return false
  }
  if (!rel) return false // the directory itself is not an executable
  if (rel === '..' || rel.startsWith('..' + sep)) return false // outside the prefix
  if (isAbsolute(rel)) return false // different drive / volume: definitely not ours
  return true
}

/**
 * What the settings page shows about the runtime: the pinned release, whether a
 * binary is present, and whether it is the plugin's own install. Purely
 * descriptive — reading it never installs, probes or upgrades anything.
 */
export function dbhubRuntimeInfo() {
  const exe = typeof runtime.dbhubExe === 'string' ? runtime.dbhubExe : ''
  return {
    pinnedVersion: DBHUB_PINNED_VERSION,
    installSpec: DBHUB_INSTALL_SPEC,
    exe,
    present: Boolean(exe),
    managed: isAutoManagedExe(),
  }
}
