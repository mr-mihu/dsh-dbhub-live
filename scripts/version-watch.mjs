#!/usr/bin/env node
// Version-drift watch for dsh-dbhub-live ITSELF.
//
// One question only: does this repository's package.json still line up with what
// the npm registry publishes for the same package name? The scope is deliberately
// narrow — which DSH release is current belongs to another owner, and folding it in
// here would make a red run ambiguous ("is it us, or them?").
//
// It exists for two real failure modes:
//   * the version was bumped and nobody published it        -> `ahead`
//   * something was published the repository never absorbed -> `behind`
// plus the state where neither side makes sense yet         -> `diverged`
//
// Offline by design: `--dist-tags-json <file>` replaces the registry call and
// `--package <file>` replaces the repository manifest, so the classification is
// testable without a network. No dependencies (the repository has none).
//
// Exit codes: 0 = ok, 1 = somebody should look, 2 = the check could not run
// (network / registry / parse failure). A failure is NEVER downgraded to 0: a watch
// that reports "ok" because it could not reach the registry is worse than no watch.
//
// Usage:
//   node scripts/version-watch.mjs                          # human output + STATUS= line
//   node scripts/version-watch.mjs --json                   # machine output for the workflow
//   node scripts/version-watch.mjs --registry https://registry.npmjs.org
//   node scripts/version-watch.mjs --dist-tags-json tags.json
//   node scripts/version-watch.mjs --github-output "$GITHUB_OUTPUT"
//   node scripts/version-watch.mjs --package fixture/package.json --json
//
// The `--github-output` file (also picked up from $GITHUB_OUTPUT when the flag has
// no value) receives one `key=value` line per field, so the workflow never has to
// parse JSON in shell.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 15_000

// ── semver precedence (self-contained: the repository takes no dependencies) ──

// Accepts `v1.2.3`, `1.2.3-dev.1`, `1.2.3+build.5` and `1.2.3-rc.1+sha`.
const SEMVER_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/
const NUMERIC_ID_RE = /^\d+$/

/**
 * Parse a semver string into comparable parts.
 *
 * Lenient about a leading `v` (release tags are written `v6.0.0`) and about build
 * metadata (which never participates in precedence), strict about the core triplet
 * and about empty prerelease identifiers. Returns `undefined` for anything that is
 * not semver — callers treat that as "unknown version", never as 0.0.0.
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], raw: string } | undefined}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return undefined
  const raw = text.trim()
  const match = SEMVER_RE.exec(raw)
  if (!match) return undefined
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some((id) => id === '')) return undefined // `1.2.3-alpha..1` is invalid
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw,
  }
}

/** semver §11: numeric identifiers compare numerically, and numeric < alphanumeric. */
function compareIdentifier(a, b) {
  const an = NUMERIC_ID_RE.test(a)
  const bn = NUMERIC_ID_RE.test(b)
  if (an && bn) {
    const x = Number(a)
    const y = Number(b)
    return x === y ? 0 : x < y ? -1 : 1
  }
  if (an) return -1
  if (bn) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/**
 * semver §11 prerelease precedence: no prerelease outranks a prerelease; shared
 * identifiers are compared one by one; a longer list wins when every shared
 * identifier is equal (`1.0.0-alpha` < `1.0.0-alpha.1`).
 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    const cmp = compareIdentifier(a[i], b[i])
    if (cmp !== 0) return cmp
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Semver precedence between two versions, build metadata ignored.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new TypeError(`not a semver version: ${!pa ? String(a) : String(b)}`)
  return compareParsed(pa, pb)
}

const sameCore = (a, b) => a.major === b.major && a.minor === b.minor && a.patch === b.patch

// ── classification (pure) ────────────────────────────────────────────────────

/** Statuses and their exit codes. Only `ok` is allowed to exit 0. */
export const STATUS_EXIT = Object.freeze({ ok: 0, ahead: 1, behind: 1, diverged: 1 })

/**
 * Decide whether the repository version is accounted for by the published tags.
 *
 * Rules, in the order they are applied (the first match wins):
 *
 *   1. `ok` / `equal`      the repository version equals a dist-tag version. This
 *                          covers the normal post-release state, and also the case
 *                          where `dev` is AHEAD of `latest`: the repository still
 *                          matches the released version, so it is in sync.
 *   2. `ahead`             the repository version is above EVERY tag: the version
 *                          was bumped and the release never happened.
 *   3. `ok` / `iterating`  the repository version is a PRERELEASE of the reference
 *                          tag's core (`<published>-dev.N`), which is exactly the
 *                          versioning flow doc/RELEASE.md prescribes. Reporting this
 *                          as drift would fire on every week of normal development.
 *   4. `behind`            the repository version is below the reference tag: a
 *                          published artifact has no counterpart in the repository.
 *   5. `diverged`          everything else, i.e. the version sits between two tags
 *                          (above the reference but below some other tag).
 *
 * The reference tag is `dev` when published (the integration channel), else
 * `latest`, else the highest tag present.
 *
 * @param {string} repoVersion - `package.json` version.
 * @param {Record<string, string>} distTags - tag name -> version string.
 */
export function classify(repoVersion, distTags) {
  const repo = parseVersion(repoVersion)
  if (!repo) throw new TypeError(`repository version is not semver: ${String(repoVersion)}`)

  const tags = {}
  const ignoredTags = []
  for (const [tag, value] of Object.entries(distTags ?? {})) {
    const parsed = parseVersion(value)
    if (!parsed) {
      ignoredTags.push({ tag, version: String(value), reason: 'not semver' })
      continue
    }
    tags[tag] = { version: parsed.raw, parsed }
  }
  const names = Object.keys(tags)
  if (names.length === 0) throw new Error('the registry reports no usable dist-tags')

  const view = (fields) => ({
    repoVersion: repo.raw,
    tags: Object.fromEntries(names.map((tag) => [tag, tags[tag].version])),
    ignoredTags,
    matchedTag: null,
    reference: null,
    ...fields,
  })

  // 1. exact accounting — build metadata is ignored by the comparison.
  for (const tag of names) {
    if (compareParsed(repo, tags[tag].parsed) === 0) {
      return view({ status: 'ok', reason: 'equal', matchedTag: tag })
    }
  }

  // 2. `dev` is the integration channel, `latest` the released one; fall back to
  // whatever the highest tag is when neither exists (a package with only `beta`).
  const referenceTag = tags.dev ? 'dev' : tags.latest ? 'latest' : highestTag(names, tags)
  const referenceParsed = tags[referenceTag].parsed
  const reference = { tag: referenceTag, version: tags[referenceTag].version }

  // 3. above every published tag.
  if (names.every((tag) => compareParsed(repo, tags[tag].parsed) > 0)) {
    return view({ status: 'ahead', reason: 'ahead-of-all-tags', reference })
  }

  // 4. in-progress iteration on the published baseline. Guarded by "the reference
  // IS the highest tag": if some other tag already published a higher version, the
  // repository is behind reality rather than mid-iteration.
  const referenceIsHighest = names.every((tag) => compareParsed(referenceParsed, tags[tag].parsed) >= 0)
  if (
    referenceIsHighest &&
    referenceParsed.prerelease.length === 0 &&
    repo.prerelease.length > 0 &&
    sameCore(repo, referenceParsed)
  ) {
    return view({ status: 'ok', reason: 'iterating', matchedTag: referenceTag, reference })
  }

  // 5. below the reference.
  if (compareParsed(repo, referenceParsed) < 0) {
    return view({ status: 'behind', reason: 'behind-reference', reference })
  }

  // 6. between the tags: not above all of them, not below the reference, not equal.
  return view({ status: 'diverged', reason: 'between-tags', reference })
}

function highestTag(names, tags) {
  let best = names[0]
  for (const tag of names) {
    if (compareParsed(tags[tag].parsed, tags[best].parsed) > 0) best = tag
  }
  return best
}

// ── registry access ─────────────────────────────────────────────────────────

/**
 * Packument URL for a package name. Scoped names keep the `@` and encode only the
 * separating slash, which is the form the npm registry serves.
 */
export function packumentUrl(registryBase, name) {
  const base = String(registryBase).replace(/\/+$/, '')
  const raw = String(name)
  const segment = raw.startsWith('@') ? raw.replace('/', '%2F') : encodeURIComponent(raw)
  return `${base}/${segment}`
}

/** Accept both a bare `{tag: version}` map and a full packument (`{"dist-tags": …}`). */
function extractDistTags(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const nested = payload['dist-tags']
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested
  const keys = Object.keys(payload)
  // A hand-written fixture may be the bare map itself. Every value must be a version,
  // otherwise a packument that simply lacks `dist-tags` (`{name, version, …}`) would be
  // mistaken for a tag list and silently classify against nothing.
  if (keys.length > 0 && keys.every((key) => parseVersion(payload[key]) !== undefined)) return payload
  return undefined
}

/** Best-effort network failure code: undici nests it under `cause`, sometimes in an AggregateError. */
function networkReason(error) {
  const cause = error?.cause
  const nested = Array.isArray(cause?.errors) ? cause.errors.find((entry) => entry?.code)?.code : undefined
  return cause?.code ?? nested ?? cause?.message ?? error?.name ?? 'fetch failed'
}

async function fetchDistTags(url, timeoutMs) {
  let response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`cannot reach the npm registry (${networkReason(error)}): ${url}`)
  }
  if (!response.ok) throw new Error(`the npm registry answered HTTP ${response.status}: ${url}`)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('the npm registry response is not valid JSON')
  }
  return payload
}

function readDistTagsFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.code ?? error.message}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  const tags = extractDistTags(payload)
  if (!tags) throw new Error(`${file} does not contain a dist-tags object`)
  return tags
}

function readPackage(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.code ?? error.message}`)
  }
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  if (typeof pkg?.name !== 'string' || pkg.name.trim() === '') throw new Error(`${file} has no "name"`)
  if (typeof pkg?.version !== 'string' || pkg.version.trim() === '') throw new Error(`${file} has no "version"`)
  return { name: pkg.name.trim(), version: pkg.version.trim(), file }
}

// ── reporting ──────────────────────────────────────────────────────────────

/** One line a human reads, explaining what the status means for THIS repository. */
function describe(result) {
  const dev = result.tags?.dev ?? '（未发布）'
  const latest = result.tags?.latest ?? '（未发布）'
  const reference = result.reference ? `${result.reference.tag} ${result.reference.version}` : '—'
  switch (result.status) {
    case 'ok':
      return result.reason === 'equal'
        ? `仓库版本与 ${result.matchedTag} tag 一致（已发布）`
        : `仓库版本是已发布基线 ${result.reference.version} 上的预发布迭代（正常开发中）`
    case 'ahead':
      return `仓库版本高于所有已发布 dist-tag（dev ${dev} / latest ${latest}）：版本号抬了但还没发版`
    case 'behind':
      return `仓库版本低于 ${reference}：发布过的东西仓库里没有`
    default:
      return `仓库版本夹在 dist-tag 之间（${reference}，latest ${latest}）：registry 与仓库对不上`
  }
}

const NEXT_STEP = '下一步：npm run release:preflight → 按 doc/RELEASE.md 人工发布（本脚本不发布任何东西）'

// ── issue text (pure — the workflow only moves files around) ────────────────
//
// The prose lives here, not in YAML, for one reason: it is TESTABLE here. A shell
// heredoc inside a workflow cannot be exercised without a network and a GitHub token,
// and "we think the issue body is right" is exactly the kind of assumption that rots.
// `gh` itself is the workflow's business (CI is the only place it runs).

/** Fixed title prefix: one open issue per status, found again by exact title. */
export const ISSUE_TITLE_PREFIX = 'chore: 版本待发布'

/** @param {'ahead'|'behind'|'diverged'} status */
export function issueTitle(status) {
  return `${ISSUE_TITLE_PREFIX}（${status}）`
}

const STATUS_EXPLANATION = {
  ahead: '仓库版本**高于所有已发布 dist-tag**：版本号抬了但没人发版（"代码写完了但忘了发"）。',
  behind: '仓库版本**低于已发布的 tag**：发布过的东西分支里没有（"发了版但仓库没同步"）。',
  diverged: '仓库版本**夹在两个 tag 之间**：registry 与仓库对不上，先确认真实的已发布版本再决定升还是回退。',
}

const ISSUE_NEXT_STEPS = [
  '1. `npm run release:preflight` —— 本地发版闸门（证据 / 矩阵 / 工作树），不绿不发；',
  '2. 按 doc/RELEASE.md 走人工流程（测试版 `--tag dev` + `--prerelease`；正式版命令只给维护者手动执行）；',
  '3. 发完 / 同步完再手动跑一次本工作流（`workflow_dispatch`），确认回到 `ok`。',
]

/** `[{ hash, subject }]` -> one markdown list (never empty, never a dangling header). */
function commitLines(commits) {
  const list = (Array.isArray(commits) ? commits : []).filter((entry) => entry && entry.hash)
  if (list.length === 0) return '- （拿不到提交历史）'
  return list.map((entry) => `- ${entry.hash} ${entry.subject ?? ''}`.trimEnd()).join('\n')
}

/** The version table shared by the issue body and the follow-up comment. */
function versionTable({ repoVersion, tagDev, tagLatest, reason }) {
  return [
    '| 项 | 版本 |',
    '| --- | --- |',
    `| 仓库 \`package.json\` | \`${repoVersion || '?'}\` |`,
    `| npm \`dev\` | \`${tagDev || '（未发布）'}\` |`,
    `| npm \`latest\` | \`${tagLatest || '（未发布）'}\` |`,
    `| 判定依据 | \`${reason}\` |`,
  ].join('\n')
}

/**
 * The body of a new drift issue.
 *
 * Refuses `ok`: an issue is only ever filed for a status a human has to act on, so a
 * caller mistake must be a crash rather than a "everything is fine" issue.
 *
 * @param {{ status: string, reason: string, repoVersion: string, tagDev?: string,
 *           tagLatest?: string, commits?: {hash: string, subject: string}[], today: string }} input
 */
export function issueBody({ status, reason, repoVersion, tagDev, tagLatest, commits, today }) {
  if (status === 'ok') throw new Error('an ok result must never produce an issue')
  return [
    `## 版本漂移：\`${status}\`（${today}）`,
    '',
    '每周自动检查：仓库 `package.json` 的版本 vs npm registry 的 `dist-tags`。**本工作流不发布任何东西**，发布仍按 [doc/RELEASE.md](../blob/dev/doc/RELEASE.md) 人工执行。',
    '',
    versionTable({ repoVersion, tagDev, tagLatest, reason }),
    '',
    STATUS_EXPLANATION[status] ?? STATUS_EXPLANATION.diverged,
    '',
    '### 最近 5 条提交',
    '',
    commitLines(commits),
    '',
    '### 下一步',
    '',
    ...ISSUE_NEXT_STEPS,
    '',
    '_由 `.github/workflows/version-watch.yml` 自动生成；不自动发布、不自动关 issue。_',
    '',
  ].join('\n')
}

/** The comment appended to an already-open issue (idempotent follow-up, dated). */
export function issueComment({ status, reason, repoVersion, tagDev, tagLatest, today }) {
  if (status === 'ok') throw new Error('an ok result must never produce an issue comment')
  return [
    `### ${today} 复查：仍为 \`${status}\``,
    '',
    versionTable({ repoVersion, tagDev, tagLatest, reason }),
    '',
    '仍未处理：`npm run release:preflight` → 按 doc/RELEASE.md 人工发布或同步。',
    '',
  ].join('\n')
}

/** Everything the workflow files — one pure call, so the whole text is unit-tested. */
export function issueText(input) {
  return {
    title: issueTitle(input.status),
    body: issueBody(input),
    comment: issueComment(input),
  }
}

/** Write the three files the workflow consumes. Paths are returned for the payload. */
function writeIssueFiles(dir, input) {
  mkdirSync(dir, { recursive: true })
  const text = issueText(input)
  const files = {
    title: join(dir, 'title.txt'),
    body: join(dir, 'body.md'),
    comment: join(dir, 'comment.md'),
  }
  writeFileSync(files.title, `${text.title}\n`)
  writeFileSync(files.body, text.body)
  writeFileSync(files.comment, text.comment)
  return { title: text.title, files }
}

/** Last N commits as `{hash, subject}`; an empty list when git is unavailable. */
function readRecentCommits(count = 5) {
  try {
    const out = execFileSync('git', ['log', `-${count}`, '--pretty=%h\t%s'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t')
        return tab === -1 ? { hash: line.trim(), subject: '' } : { hash: line.slice(0, tab), subject: line.slice(tab + 1) }
      })
  } catch {
    return []
  }
}

/** `GITHUB_OUTPUT` lines: one `key=value` per field, never multi-line. */
function outputLines(payload) {
  const clean = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  return [
    `status=${clean(payload.status)}`,
    `exit_code=${clean(payload.exitCode)}`,
    `reason=${clean(payload.reason)}`,
    `repo_version=${clean(payload.repo?.version)}`,
    `tag_dev=${clean(payload.tags?.dev)}`,
    `tag_latest=${clean(payload.tags?.latest)}`,
  ]
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `version-watch — is this repository's version accounted for by npm dist-tags?

  --json                     print the machine-readable result (for the workflow)
  --package <file>           manifest to read (default: the repository package.json)
  --registry <url>           npm registry base (default: ${DEFAULT_REGISTRY})
  --dist-tags-json <file>    read dist-tags from a file instead of the registry
  --issue-dir <dir>          write title.txt / body.md / comment.md for a non-ok
                             status (the workflow files them; this script never does)
  --github-output [<file>]   append key=value lines (default: $GITHUB_OUTPUT)
  --timeout-ms <n>           network timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --help                     this text

Exit codes: 0 = ok, 1 = needs a human (ahead/behind/diverged), 2 = could not run.
`

function parseArgs(argv) {
  const options = {
    json: false,
    help: false,
    packageFile: join(ROOT, 'package.json'),
    registry: DEFAULT_REGISTRY,
    distTagsFile: '',
    issueDir: '',
    githubOutput: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      i += 1
      return next
    }
    switch (flag) {
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      case '--package':
        options.packageFile = resolve(value())
        break
      case '--registry':
        options.registry = value()
        break
      case '--dist-tags-json':
        options.distTagsFile = resolve(value())
        break
      case '--issue-dir':
        options.issueDir = resolve(value())
        break
      case '--github-output': {
        // The flag may stand alone and fall back to the Actions-provided path.
        const next = argv[i + 1]
        if (inline !== undefined) options.githubOutput = resolve(inline)
        else if (next !== undefined && !next.startsWith('--')) {
          i += 1
          options.githubOutput = resolve(next)
        } else options.githubOutput = process.env.GITHUB_OUTPUT || ''
        if (!options.githubOutput) throw new Error('--github-output has no value and $GITHUB_OUTPUT is not set')
        break
      }
      case '--timeout-ms': {
        const text = value()
        const parsed = Number(text)
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--timeout-ms needs a positive number, got ${text}`)
        options.timeoutMs = parsed
        break
      }
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[version-watch] ${error.message}`)
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const emit = (payload) => {
    if (options.githubOutput) {
      try {
        writeFileSync(options.githubOutput, `${outputLines(payload).join('\n')}\n`)
      } catch (error) {
        console.error(`[version-watch] cannot write ${options.githubOutput}: ${error.code ?? error.message}`)
      }
    }
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2))
      return
    }
    if (payload.status === 'error') {
      console.error(`[version-watch] error: ${payload.error}`)
      console.error('STATUS=error')
      return
    }
    console.log(`${payload.repo.name}@${payload.repo.version} (${payload.repo.file})`)
    for (const [tag, version] of Object.entries(payload.tags)) console.log(`  ${tag.padEnd(8)} ${version}`)
    for (const entry of payload.ignoredTags) console.log(`  ${entry.tag.padEnd(8)} ${entry.version} （忽略：不是 semver）`)
    console.log(`status: ${payload.status} — ${payload.message}`)
    if (payload.status !== 'ok') console.log(NEXT_STEP)
    if (payload.issue) console.log(`issue: ${payload.issue.title} → ${payload.issue.files.body}`)
    console.log(`STATUS=${payload.status}`)
  }

  const common = {
    generatedAt: new Date().toISOString(),
    registry: options.distTagsFile ? null : options.registry,
    source: options.distTagsFile ? 'file' : 'registry',
  }

  try {
    const pkg = readPackage(options.packageFile)
    const tags = options.distTagsFile
      ? readDistTagsFile(options.distTagsFile)
      : extractDistTags(await fetchDistTags(packumentUrl(options.registry, pkg.name), options.timeoutMs))
    if (!tags) throw new Error(`the npm registry response for ${pkg.name} has no dist-tags`)

    const result = classify(pkg.version, tags)
    const exitCode = STATUS_EXIT[result.status] ?? 2
    const payload = { ...common, ...result, repo: pkg, exitCode, message: describe(result) }
    if (options.issueDir && exitCode === 1) {
      // Only a status a human must act on gets issue text; `ok` and failures get none.
      payload.issue = writeIssueFiles(options.issueDir, {
        status: result.status,
        reason: result.reason,
        repoVersion: pkg.version,
        tagDev: result.tags.dev ?? '',
        tagLatest: result.tags.latest ?? '',
        commits: readRecentCommits(),
        today: new Date().toISOString().slice(0, 10),
      })
    }
    emit(payload)
    return exitCode
  } catch (error) {
    const message = error?.message ?? String(error)
    emit({
      ...common,
      status: 'error',
      reason: 'check-failed',
      repo: { name: '', version: '', file: options.packageFile },
      tags: {},
      ignoredTags: [],
      matchedTag: null,
      reference: null,
      exitCode: 2,
      error: message,
    })
    return 2
  }
}

const ENTRY_URL = import.meta.url

/**
 * Is this module the process entry point?
 *
 * The comparison logic is imported by `test/version-watch.test.mjs`, so the CLI must
 * not run on import: it would fetch the registry inside the test process and then set
 * THAT process's exit code (a red suite caused by a version, not by the tests).
 */
function isDirectRun() {
  const arg = process.argv[1]
  if (!arg) return false
  let url
  try {
    url = pathToFileURL(arg).href
  } catch {
    return false
  }
  if (url === ENTRY_URL) return true
  return process.platform === 'win32' && url.toLowerCase() === ENTRY_URL.toLowerCase()
}

if (isDirectRun()) process.exitCode = await main(process.argv.slice(2))
