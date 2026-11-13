// dsh-dbhub-live: query-result export (CSV / JSON) into host-local files.
//
// The plugin has no result card to hang a button on, so exporting is a TOOL
// ARGUMENT: `dbhub_execute_sql` accepts an optional `export: 'csv' | 'json'`.
// When it is set, the rows of THIS call are written to files under the plugin's
// data directory and the receipt carries a summary plus the absolute path(s)
// instead of inlining the rows — that is the whole point: a large result then
// costs the model context almost nothing.
//
// Two properties drive this module's shape:
//   * ZERO KNOWLEDGE — file names, payload and summary may only carry the source
//     HANDLE, row counts and paths; never a DSN, host or account. The JSON
//     payload omits the DSN entirely.
//   * FAIL-SOFT — writing is the one fallible step, and a failed write must never
//     turn a successful query into a failed one (the caller falls back to the
//     ordinary inline receipt). `setExportFsHooks` is the test seam that makes
//     that path reachable without an unwritable disk (same idea as
//     `config.setFsHooks`, which pins owner-only modes).
//
// Everything except `writeExportFiles` is a pure function, so the CSV dialect,
// the column order and the file-name sanitization are pinned by unit tests.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, shortHash } from './config.mjs'

/** Where export files live: next to the store, inside the plugin's data dir. */
export const EXPORT_DIR = join(DATA_DIR, 'exports')

/** Longest ASCII stem a file name may carry (before the timestamp and seq). */
export const EXPORT_STEM_MAX = 64

/** The one true spelling of the accepted formats. */
export const EXPORT_FORMATS = ['csv', 'json']

// ── injectable fs seam (the export writer only) ───────────────────────────
//
// Production always uses node:fs. Tests swap a primitive for a throwing stub to
// exercise the caller's FAIL-SOFT path (a permission/disk error must never turn
// a good query into a failed call) — the same seam idea as `config.setFsHooks`.

const NODE_FS = { mkdirSync, writeFileSync, chmodSync }
let fsHooks = NODE_FS

/**
 * Replace a subset of the file primitives used by `writeExportFiles`.
 * @param hooks - `{ mkdirSync?, writeFileSync?, chmodSync? }`, or `null` to
 *   restore node:fs. Unlisted primitives keep the real implementation.
 */
export function setExportFsHooks(hooks) {
  fsHooks = hooks ? { ...NODE_FS, ...hooks } : NODE_FS
}

/**
 * Normalize a caller-supplied `export` argument.
 * @returns `'csv'` / `'json'`, or `''` when the value is absent/unusable (an
 *   unusable value must behave exactly like "no export", never like an error).
 */
export function exportFormatOf(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return EXPORT_FORMATS.includes(raw) ? raw : ''
}

// ── file names ────────────────────────────────────────────────────────────
//
// `<sanitized source handle>-<yyyymmdd-hhmmss>-<seq>.<csv|json>`
//
// The handle comes from `sourceIdOf` and is normally pure ASCII, but a source id
// may carry a non-ASCII environment name (中文, emoji), so it is projected to a
// path-SAFE ASCII form: everything outside `[A-Za-z0-9_-]` is percent-escaped
// per UTF-8 byte. That is injective (two different handles can never collide),
// reversible, and structurally incapable of producing `/`, `\`, `.`, `..` or a
// control character. A handle longer than EXPORT_STEM_MAX keeps a readable head
// plus `shortHash` of the ORIGINAL text, so two long handles that differ only
// past the cap still get different names.

/** Windows device names a file stem may not equal (case-insensitive). */
const RESERVED_STEM_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * ASCII-safe, path-safe, length-capped file stem for one source handle.
 * @param sourceId - the source HANDLE (metadata, never a DSN).
 * @returns a non-empty stem with no path separators, no dots and no control
 *   characters, at most EXPORT_STEM_MAX characters long.
 */
export function safeExportStem(sourceId) {
  const raw = String(sourceId === undefined || sourceId === null ? '' : sourceId)
  let encoded = ''
  for (const ch of raw) {
    // Keep the readable ASCII alphabet source ids already use.
    if (/[A-Za-z0-9_-]/.test(ch)) {
      encoded += ch
      continue
    }
    for (const byte of Buffer.from(ch, 'utf8')) {
      encoded += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  if (!encoded) encoded = 'source'
  let stem = encoded
  if (encoded.length > EXPORT_STEM_MAX) {
    // Keep the cap on the WHOLE stem: head + '-' + short hash.
    const hash = shortHash(raw)
    const head = Math.max(1, EXPORT_STEM_MAX - hash.length - 1)
    stem = encoded.slice(0, head) + '-' + hash
  }
  // A percent-encoded stem can never be a device name or end in a dot, but the
  // lowercase ASCII path can collide with one (`con`, `nul`…): a write would fail
  // on Windows for a reason that has nothing to do with the query.
  if (RESERVED_STEM_RE.test(stem)) stem = '_' + stem
  return stem
}

/** `yyyymmdd-hhmmss` in UTC (deterministic regardless of the host timezone). */
export function exportStampOf(at) {
  const d = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
    + '-' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds())
}

/**
 * The file name of one export part.
 * @param opts - `{ sourceId, format, seq, at }`; `seq` is 1-based.
 */
export function exportFileName(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const format = exportFormatOf(o.format) || 'csv'
  const seq = Number.isSafeInteger(o.seq) && o.seq > 0 ? o.seq : 1
  return safeExportStem(o.sourceId) + '-' + exportStampOf(o.at) + '-' + String(seq) + '.' + format
}

// ── CSV (pure) ────────────────────────────────────────────────────────────
//
// RFC 4180: fields containing `,` `"` CR or LF are wrapped in double quotes with
// inner quotes doubled; the record separator is CRLF; the file ends right after
// the last record (no extra blank line). The header is escaped like any other
// field.
//
// The column set is the UNION of every row's keys in FIRST-APPEARANCE order —
// deliberately not sorted: the row objects arrive in the database's own column
// order, and sorting would silently reorder a table's columns.

/**
 * One CSV field.
 * `null`/`undefined` → empty; objects/arrays → JSON; boolean/number → String.
 */
export function csvField(value) {
  let text
  if (value === undefined || value === null) text = ''
  else if (typeof value === 'string') text = value
  else if (typeof value === 'object') {
    const json = JSON.stringify(value)
    text = json === undefined ? '' : json
  } else text = String(value)
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}

/**
 * The column order of a result set: every key of every row, in first-appearance
 * order (a later row may add a column the first row did not have).
 */
export function csvColumns(rows) {
  const columns = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      columns.push(key)
    }
  }
  return columns
}

/**
 * One CSV document.
 *
 * dbhub returns `rows` as an array of objects and no separate column list, so
 * the header is DERIVED from the rows; an empty result set therefore has no
 * column names to write and produces an empty file (`opts.columns` exists for
 * callers that do know them, e.g. tests pinning "header only").
 *
 * @param rows - array of row objects.
 * @param opts - `{ columns?: string[], bom?: boolean }`; no BOM by default (a
 *   BOM would break naive `head`/`cut` pipelines and every tool that reads the
 *   file as UTF-8 already).
 */
export function csvTextOf(rows, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const list = Array.isArray(rows) ? rows : []
  const columns = Array.isArray(o.columns) ? o.columns.map(String) : csvColumns(list)
  const lines = [columns.map((c) => csvField(c)).join(',')]
  for (const row of list) {
    const objects = row && typeof row === 'object' && !Array.isArray(row) ? row : {}
    lines.push(columns.map((c) => csvField(objects[c])).join(','))
  }
  const text = lines.join('\r\n')
  return o.bom === true ? '\uFEFF' + text : text
}

// ── JSON (pure) ───────────────────────────────────────────────────────────

/**
 * The exported payload: `{ source, statements: [{ sql, rows, count }],
 * exportedAt }`. The DSN is NOT part of it (the source HANDLE is), so the file
 * is safe to hand to the user.
 *
 * `count` is dbhub's own number and is preserved verbatim; when the caller's
 * explicit `maxRows` truncated `rows`, `count` still reports the original total
 * (the receipt carries the truncation notice).
 */
export function exportPayloadOf(source, statements, exportedAt) {
  const at = exportedAt instanceof Date
    ? exportedAt.toISOString()
    : String(exportedAt === undefined || exportedAt === null ? '' : exportedAt)
  return {
    source: String(source === undefined || source === null ? '' : source),
    statements: (Array.isArray(statements) ? statements : []).map((st) => {
      const rows = st && Array.isArray(st.rows) ? st.rows : []
      const count = st && typeof st.count === 'number' && Number.isFinite(st.count) ? st.count : rows.length
      return { sql: st && typeof st.sql === 'string' ? st.sql : '', rows, count }
    }),
    exportedAt: at,
  }
}

/** Pretty JSON text of one export payload (the file's exact bytes). */
export function exportJsonText(payload) {
  return JSON.stringify(payload, null, 2)
}

// ── writer ────────────────────────────────────────────────────────────────

/** Best-effort owner-only mode on the export directory (POSIX only). */
function tightenExportDir() {
  if (process.platform === 'win32') return
  try {
    fsHooks.chmodSync(EXPORT_DIR, 0o700)
  } catch (e) {
    /* best-effort: a filesystem that refuses chmod must not break the export */
  }
}

/** `-2`, `-3`… inserted before the extension, for a same-second collision. */
function suffixedName(fileName, attempt) {
  const dot = fileName.lastIndexOf('.')
  return dot < 0
    ? fileName + '-' + String(attempt + 1)
    : fileName.slice(0, dot) + '-' + String(attempt + 1) + fileName.slice(dot)
}

/**
 * Write one text document under EXPORT_DIR.
 *
 * `flag: 'wx'` makes the write FAIL when the name is already taken, so a
 * same-second export can never silently overwrite an earlier one; the retry adds
 * a numeric suffix instead. Owner-only mode is requested at creation and pinned
 * afterwards (a network volume may keep the target's attributes).
 * @returns the absolute path written.
 */
function writeOne(fileName, text) {
  for (let attempt = 0; ; attempt += 1) {
    const path = join(EXPORT_DIR, attempt === 0 ? fileName : suffixedName(fileName, attempt))
    try {
      fsHooks.writeFileSync(path, text, { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if (e && e.code === 'EEXIST' && attempt < 3) continue
      throw e
    }
    try {
      fsHooks.chmodSync(path, 0o600)
    } catch (e) {
      /* best-effort (Windows has no POSIX mode to enforce) */
    }
    return path
  }
}

/**
 * Write one export set to disk. THROWS on failure; the caller is the fail-soft
 * boundary (it falls back to the ordinary inline receipt plus one notice).
 *
 * `csv` = one file per statement (`…-1.csv`, `…-2.csv`, …), `json` = ONE file
 * holding the whole `{ source, statements, exportedAt }` payload.
 *
 * @param opts - `{ sourceId, format, statements, at }`.
 * @returns `{ format, files: [{ path, rows }], totalRows }` — paths absolute.
 */
export function writeExportFiles(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const format = exportFormatOf(o.format)
  if (!format) {
    const err = new TypeError('unsupported export format')
    err.code = 'badExportFormat'
    throw err
  }
  const statements = Array.isArray(o.statements) ? o.statements : []
  const at = o.at instanceof Date ? o.at : new Date()
  fsHooks.mkdirSync(EXPORT_DIR, { recursive: true, mode: 0o700 })
  tightenExportDir()
  if (format === 'json') {
    const payload = exportPayloadOf(o.sourceId, statements, at)
    const rows = payload.statements.reduce((sum, st) => sum + st.rows.length, 0)
    const path = writeOne(exportFileName({ sourceId: o.sourceId, format, seq: 1, at }), exportJsonText(payload))
    return { format, files: [{ path, rows }], totalRows: rows }
  }
  const files = []
  let totalRows = 0
  for (let i = 0; i < statements.length; i += 1) {
    const rows = statements[i] && Array.isArray(statements[i].rows) ? statements[i].rows : []
    const fileName = exportFileName({ sourceId: o.sourceId, format, seq: i + 1, at })
    files.push({ path: writeOne(fileName, csvTextOf(rows)), rows: rows.length })
    totalRows += rows.length
  }
  return { format, files, totalRows }
}
