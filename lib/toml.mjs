// dsh-dbhub-live: the ONE-SHOT dbhub TOML generator.
//
// dbhub's `--dsn` flag and `--config <toml>` are mutually exclusive, so the two
// features that only exist in the TOML dialect — per-tool `readonly` and the
// per-source `ssh_*` tunnel — force a generated config file per call. This is
// NOT the resident-toml design that was removed in 4.0: there is no fingerprint,
// no mtime watch, no reuse, no multi-source file. One call → one temp file →
// process exits → file deleted (and a boot-time sweep collects anything a crash
// left behind).
//
// SECRETS NEVER REACH THE FILE. TOML `${VAR}` interpolation reads from the
// SPAWNED CHILD's environment, so the file carries only placeholders and the
// real DSN / tunnel credentials ride `subprocess.spawn({ env })`. A leftover
// file is therefore harmless. Note dbhub substitutes a MISSING variable by
// leaving `${VAR}` in place *without an error*, so every referenced name is
// guaranteed a value here (an empty string still counts).
//
// `[[tools]]` is a WHITELIST, not a patch: as soon as one entry names a source,
// dbhub stops attaching its default `execute_sql` + `search_objects` pair. A
// read-only config must therefore list BOTH, or `dbhub_search_objects` dies with
// "Tool search_objects not found" on that environment.

import { mkdirSync, writeFileSync, unlinkSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, ensureStorageDir, warnOnce } from './config.mjs'

/** Temp directory for generated configs (swept at boot). */
export const TMP_DIR = join(DATA_DIR, 'tmp')

/** Environment-variable names the template may reference. */
export const SECRET_ENV = {
  dsn: 'DSH_DBHUB_SEC_DSN',
  sshPassword: 'DSH_DBHUB_SEC_SSH_PASSWORD',
  sshPassphrase: 'DSH_DBHUB_SEC_SSH_PASSPHRASE',
}

/** Every `${VAR}` the given text references (in order of appearance). */
export function referencedVars(text) {
  const out = []
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  let m
  while ((m = re.exec(String(text || '')))) {
    if (out.indexOf(m[1]) < 0) out.push(m[1])
  }
  return out
}

/** Escape a value for a TOML basic (double-quoted) string. */
export function tomlString(value) {
  return '"' + String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    + '"'
}

let tempSeq = 0

/**
 * Build the TOML text and its secret-carrying environment for one connection.
 *
 * `dsn` is ALWAYS written as a placeholder; the caller must spawn with the
 * returned `env`. Only the fields actually present are emitted, so an empty
 * value never becomes a literal empty TOML value.
 *
 * @param conn - `{ dsn, ro?, ssh? }` (ssh = normalized config from config.mjs).
 * @returns `{ text, env }` — `text` never contains a secret value.
 */
export function buildDbhubToml(conn) {
  const c = conn || {}
  const ssh = c.ssh && typeof c.ssh === 'object' ? c.ssh : null
  const ro = c.ro === true
  const text = []
  const env = {}

  text.push('[[sources]]')
  text.push('id = "default"')
  // The DSN carries the database password: placeholder only.
  const dsn = typeof c.dsn === 'string' ? c.dsn.trim() : ''
  if (dsn) {
    text.push('dsn = "${' + SECRET_ENV.dsn + '}"')
    env[SECRET_ENV.dsn] = dsn
  } else {
    // A missing DSN must still leave the variable DEFINED for the child (dbhub
    // keeps an undefined `${VAR}` verbatim and only fails later, obscurely).
    env[SECRET_ENV.dsn] = ''
  }

  if (ssh) {
    if (ssh.host) text.push('ssh_host = ' + tomlString(ssh.host))
    if (ssh.port) text.push('ssh_port = ' + String(Number(ssh.port) || 22))
    if (ssh.user) text.push('ssh_user = ' + tomlString(ssh.user))
    if (ssh.auth === 'password') {
      // Secret: placeholder; the value goes to the child environment.
      text.push('ssh_password = "${' + SECRET_ENV.sshPassword + '}"')
      env[SECRET_ENV.sshPassword] = String(ssh.password || '')
    } else if (ssh.keyPath) {
      // A key PATH is not a secret (it is a filesystem location); dbhub expands
      // a leading `~/` itself. Base64 key material passes through unchanged.
      text.push('ssh_key = ' + tomlString(ssh.keyPath))
      if (ssh.passphrase) {
        text.push('ssh_passphrase = "${' + SECRET_ENV.sshPassphrase + '}"')
        env[SECRET_ENV.sshPassphrase] = String(ssh.passphrase)
      }
    }
    if (ssh.proxyJump) text.push('ssh_proxy_jump = ' + tomlString(ssh.proxyJump))
  }

  if (ro) {
    // BOTH tools: `[[tools]]` replaces dbhub's default pair (see the header).
    text.push('')
    text.push('[[tools]]')
    text.push('name = "execute_sql"')
    text.push('source = "default"')
    text.push('readonly = true')
    text.push('')
    text.push('[[tools]]')
    text.push('name = "search_objects"')
    text.push('source = "default"')
  }

  return { text: text.join('\n') + '\n', env }
}

/**
 * Write one generated config into the temp directory with owner-only mode.
 * @returns the absolute path (throws only when nothing is writable).
 */
export function writeTempToml(text) {
  if (!ensureStorageDir()) throw new Error('无法创建配置目录 ' + DATA_DIR)
  mkdirSync(TMP_DIR, { recursive: true })
  const name = 'dbhub-' + process.pid + '-' + (tempSeq++) + '-' + Math.random().toString(36).slice(2, 8) + '.toml'
  const path = join(TMP_DIR, name)
  writeFileSync(path, String(text || ''), { mode: 0o600 })
  return path
}

/**
 * Best-effort delete of one generated config. dbhub watches the file it was
 * given, so on Windows the unlink can hit EBUSY while the child is shutting
 * down — the file holds no secrets, so a failure is only worth one warning.
 * @returns whether the file is gone.
 */
export function removeTempToml(path) {
  if (!path) return true
  try {
    unlinkSync(path)
    return true
  } catch (e) {
    if (e && e.code === 'ENOENT') return true
    warnOnce('toml-unlink', '临时 dbhub 配置未能删除（无害：文件中不含任何秘密）：' + String(path))
    return false
  }
}

/**
 * Boot-time garbage collection for configs a crash (or a failed unlink) left
 * behind. Only files older than `maxAgeMs` are touched, so a concurrently
 * running call's file is never removed.
 * @returns the number of files removed.
 */
export function sweepTempToml(maxAgeMs) {
  const budget = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 60 * 60 * 1000
  let removed = 0
  let entries = []
  try {
    entries = readdirSync(TMP_DIR)
  } catch (e) {
    return 0
  }
  const now = Date.now()
  for (const name of entries) {
    if (!/^dbhub-.*\.toml$/.test(name)) continue
    const path = join(TMP_DIR, name)
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      if (now - st.mtimeMs < budget) continue
      rmSync(path, { force: true })
      removed++
    } catch (e) {
      /* locked or raced away — nothing to do */
    }
  }
  return removed
}
