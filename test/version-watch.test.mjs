// Unit tests for the weekly version-drift watch (scripts/version-watch.mjs).
//
// Two layers, both dependency-free:
//   1. the semver comparison the script carries itself (the repository has no
//      dependencies, so there is nothing to borrow), and
//   2. `classify()` — the only place that decides whether a repository version is
//      accounted for by the published dist-tags.
// On top of those, the CLI contract is exercised end to end: the exit codes
// (0 ok / 1 needs a human / 2 could not run), the `GITHUB_OUTPUT` key=value file the
// workflow reads, and the fact that a network failure can never look like `ok`.
//
// The registry is never contacted for real: the success path runs against a
// loopback HTTP server this file starts, the failure path against a port that was
// just released, and the rest through `--dist-tags-json` fixtures.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  ISSUE_TITLE_PREFIX,
  STATUS_EXIT,
  classify,
  compareVersions,
  issueBody,
  issueComment,
  issueText,
  issueTitle,
  packumentUrl,
  parseVersion,
} from '../scripts/version-watch.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'version-watch.mjs')

// ── semver precedence ──────────────────────────────────────────────────────

test('compareVersions — a release outranks every prerelease of the same triplet', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.9'), 1)
  // A prerelease never outranks its own release, however high the counter climbs.
  assert.equal(compareVersions('1.0.0-rc.999', '1.0.0'), -1)
})

test('compareVersions — prerelease identifiers are compared, not string-compared', () => {
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  // The bug this guards: "rc.10" < "rc.9" as text.
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  // Numeric identifiers sort below alphanumeric ones (§11.4.3).
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  // A shorter identifier list sorts below a longer one that shares a prefix.
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-beta'), -1)
})

test('compareVersions — core triplet, leading v, build metadata and whitespace', () => {
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('v5.2.0', '5.2.0'), 0)
  // Build metadata never participates in precedence.
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0+build.6'), 0)
  assert.equal(compareVersions('1.0.0-rc.1+a', '1.0.0-rc.1+b'), 0)
  assert.equal(compareVersions(' 1.0.0 ', '1.0.0'), 0)
})

test('compareVersions — strictly increasing over the semver ladder', () => {
  const ladder = [
    '0.9.0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
  ]
  for (let i = 0; i < ladder.length; i += 1) {
    assert.equal(compareVersions(ladder[i], ladder[i]), 0, `${ladder[i]} must equal itself`)
    for (let j = i + 1; j < ladder.length; j += 1) {
      assert.equal(compareVersions(ladder[i], ladder[j]), -1, `${ladder[i]} < ${ladder[j]}`)
      assert.equal(compareVersions(ladder[j], ladder[i]), 1, `${ladder[j]} > ${ladder[i]}`)
    }
  }
})

test('compareVersions — anything that is not semver throws instead of coercing', () => {
  for (const junk of ['not-a-version', 'x.y.z', '1.0', '1.0.0-', '1.0.0-alpha..1', '', undefined, null, 3]) {
    assert.equal(parseVersion(junk), undefined, `${String(junk)} must not parse`)
    assert.throws(() => compareVersions(junk, '1.0.0'), TypeError)
    assert.throws(() => compareVersions('1.0.0', junk), TypeError)
  }
})

test('parseVersion — keeps the prerelease list and drops build metadata', () => {
  assert.deepEqual(parseVersion('6.0.0-rc.1').prerelease, ['rc', '1'])
  assert.deepEqual(parseVersion('6.0.0+sha.abc').prerelease, [])
  assert.deepEqual(parseVersion('v6.0.0-dev.2').prerelease, ['dev', '2'])
  assert.equal(parseVersion('v6.0.0').major, 6)
})

// ── classification ─────────────────────────────────────────────────────────

test('classify — ok when the repository version matches a published tag', () => {
  const result = classify('1.0.0', { dev: '1.0.0', latest: '1.0.0' })
  assert.equal(result.status, 'ok')
  assert.equal(result.reason, 'equal')
  assert.ok(result.matchedTag, 'the matching tag must be reported')
  assert.equal(result.repoVersion, '1.0.0')
})

test('classify — ok when the repository matches latest while dev is ahead', () => {
  // Normal state: a newer dev build is published, the released version still agrees
  // with package.json.
  const result = classify('1.0.0', { dev: '1.1.0-dev.2', latest: '1.0.0' })
  assert.equal(result.status, 'ok')
  assert.equal(result.reason, 'equal')
  assert.equal(result.matchedTag, 'latest')
})

test('classify — ok while iterating on the published baseline (doc/RELEASE.md flow)', () => {
  // <published>-dev.N / -rc.N is how this repository versions work in progress, so it
  // must not be reported as drift — otherwise the watch fires every week.
  const result = classify('6.0.0-rc.1', { dev: '6.0.0', latest: '5.2.0' })
  assert.equal(result.status, 'ok')
  assert.equal(result.reason, 'iterating')
  assert.deepEqual(result.reference, { tag: 'dev', version: '6.0.0' })
})

test('classify — a registry with only `latest` still classifies', () => {
  assert.equal(classify('1.0.0', { latest: '1.0.0' }).status, 'ok')
  assert.equal(classify('1.0.0', { latest: '1.0.0' }).reason, 'equal')
  // Iterating on latest works without a dev tag at all.
  const iterating = classify('1.0.0-dev.2', { latest: '1.0.0' })
  assert.equal(iterating.status, 'ok')
  assert.equal(iterating.reason, 'iterating')
  assert.deepEqual(iterating.reference, { tag: 'latest', version: '1.0.0' })
  // ... and the reference for drift is latest when dev is missing.
  assert.equal(classify('0.9.0', { latest: '1.0.0' }).status, 'behind')
  assert.deepEqual(classify('0.9.0', { latest: '1.0.0' }).reference, { tag: 'latest', version: '1.0.0' })
})

test('classify — ahead when the version is above every published tag', () => {
  const bumped = classify('1.1.0', { dev: '1.0.0', latest: '1.0.0' })
  assert.equal(bumped.status, 'ahead')
  assert.equal(bumped.reason, 'ahead-of-all-tags')
  // A practical patch bump is ahead too — that is the "wrote it, never published it" case.
  assert.equal(classify('1.0.1', { dev: '1.0.0', latest: '1.0.0' }).status, 'ahead')
  assert.equal(classify('1.0.1', { latest: '1.0.0' }).status, 'ahead')
  // Two identical tags: a bump above them is ahead, a prerelease of them is not.
  assert.equal(classify('1.0.1-dev.1', { dev: '1.0.0', latest: '1.0.0' }).status, 'ahead')
  assert.equal(classify('1.0.0-dev.1', { dev: '1.0.0', latest: '1.0.0' }).status, 'ok')
})

test('classify — behind when the repository is below the published dev build', () => {
  const result = classify('1.0.0-rc.1', { dev: '1.0.0-rc.2', latest: '0.9.0' })
  assert.equal(result.status, 'behind')
  assert.equal(result.reason, 'behind-reference')
  assert.deepEqual(result.reference, { tag: 'dev', version: '1.0.0-rc.2' })
})

test('classify — behind when the repository is obviously behind', () => {
  const result = classify('0.9.0', { dev: '1.0.0', latest: '1.0.0' })
  assert.equal(result.status, 'behind')
  assert.deepEqual(result.reference, { tag: 'dev', version: '1.0.0' })
})

test('classify — diverged when the version sits between two tags', () => {
  // dev below the repository, latest above it: neither side accounts for 1.1.0.
  const result = classify('1.1.0', { dev: '1.0.0', latest: '1.2.0' })
  assert.equal(result.status, 'diverged')
  assert.equal(result.reason, 'between-tags')
  assert.deepEqual(result.reference, { tag: 'dev', version: '1.0.0' })
})

test('classify — diverged when another tag (not dev/latest) is above the repository', () => {
  const result = classify('1.2.0', { dev: '1.0.0', latest: '1.0.0', next: '1.4.0' })
  assert.equal(result.status, 'diverged')
})

test('classify — a tag that is not semver is reported, never silently trusted', () => {
  const result = classify('1.0.0', { dev: '1.0.0', broken: 'latest-ish' })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.ignoredTags, [{ tag: 'broken', version: 'latest-ish', reason: 'not semver' }])
  // With nothing usable left there is no verdict to give — the caller must fail loudly.
  assert.throws(() => classify('1.0.0', { broken: 'latest-ish' }), /no usable dist-tags/)
  assert.throws(() => classify('1.0.0', {}), /no usable dist-tags/)
  assert.throws(() => classify('1.0.0', undefined), /no usable dist-tags/)
})

test('classify — a repository version that is not semver throws', () => {
  assert.throws(() => classify('6.0', { latest: '1.0.0' }), /not semver/)
  assert.throws(() => classify(undefined, { latest: '1.0.0' }), /not semver/)
})

test('STATUS_EXIT — only `ok` may exit 0', () => {
  assert.deepEqual(STATUS_EXIT, { ok: 0, ahead: 1, behind: 1, diverged: 1 })
  for (const [status, code] of Object.entries(STATUS_EXIT)) {
    if (status !== 'ok') assert.notEqual(code, 0, `${status} must not exit 0`)
  }
})

// ── issue text (pure: the workflow only files these strings) ───────────────

const COMMITS = [
  { hash: 'ac524ae', subject: 'feat: 数据库口令也拆进 DSH 凭据库' },
  { hash: 'a647fb9', subject: 'fix: 插件不可用时给自救指引' },
]

test('issueTitle — one fixed title shape per status (the idempotency key)', () => {
  assert.equal(issueTitle('ahead'), 'chore: 版本待发布（ahead）')
  assert.equal(issueTitle('behind'), 'chore: 版本待发布（behind）')
  assert.equal(issueTitle('diverged'), 'chore: 版本待发布（diverged）')
  // Different statuses must never share a title, or the "already open" search would
  // comment on the wrong issue instead of opening the one that is missing.
  assert.notEqual(issueTitle('ahead'), issueTitle('behind'))
  assert.ok(issueTitle('ahead').startsWith(ISSUE_TITLE_PREFIX))
})

test('issueBody — names the versions, the rule, the commits and the next step', () => {
  const body = issueBody({
    status: 'ahead',
    reason: 'ahead-of-all-tags',
    repoVersion: '6.1.0',
    tagDev: '6.0.0',
    tagLatest: '5.2.0',
    commits: COMMITS,
    today: '2026-01-05',
  })
  assert.match(body, /^## 版本漂移：`ahead`（2026-01-05）$/m)
  // Every number a maintainer needs in order to act, in one place.
  assert.match(body, /`6\.1\.0`/)
  assert.match(body, /`6\.0\.0`/)
  assert.match(body, /`5\.2\.0`/)
  assert.match(body, /ahead-of-all-tags/)
  // The status-specific explanation and the manual-publish instruction.
  assert.match(body, /高于所有已发布 dist-tag/)
  assert.match(body, /本工作流不发布任何东西/)
  // Commits are listed, and the release gate is named (never `npm publish`).
  assert.match(body, /### 最近 5 条提交/)
  assert.match(body, /- ac524ae feat: 数据库口令也拆进 DSH 凭据库/)
  assert.match(body, /- a647fb9/)
  assert.match(body, /npm run release:preflight/)
  assert.match(body, /doc\/RELEASE\.md/)
  assert.doesNotMatch(body, /npm publish(?![^\n]*人工)/)
})

test('issueBody — the status actually changes the explanation, and ok is refused', () => {
  const base = { reason: 'x', repoVersion: '1.0.0', tagDev: '2.0.0', tagLatest: '1.0.0', commits: [], today: '2026-01-05' }
  const ahead = issueBody({ ...base, status: 'ahead' })
  const behind = issueBody({ ...base, status: 'behind' })
  const diverged = issueBody({ ...base, status: 'diverged' })
  assert.match(ahead, /版本号抬了但没人发版/)
  assert.match(behind, /发布过的东西分支里没有/)
  assert.match(diverged, /夹在两个 tag 之间/)
  assert.notEqual(ahead, behind)
  // An `ok` result must never be able to become an issue.
  assert.throws(() => issueBody({ ...base, status: 'ok' }), /must never produce an issue/)
  assert.throws(() => issueComment({ ...base, status: 'ok' }), /must never produce an issue/)
})

test('issueBody — missing versions and commits degrade to readable placeholders', () => {
  const body = issueBody({
    status: 'behind',
    reason: 'behind-reference',
    repoVersion: '',
    tagDev: '',
    tagLatest: '',
    commits: [],
    today: '2026-01-05',
  })
  assert.match(body, /\| 仓库 `package\.json` \| `\?` \|/)
  assert.match(body, /（未发布）/)
  // No empty list under the header: the fallback line is explicit about what is missing.
  assert.match(body, /- （拿不到提交历史）/)
  // `issueText` is the single entry point the workflow consumes.
  const files = issueText({ status: 'behind', reason: 'behind-reference', repoVersion: '1.0.0', today: '2026-01-05' })
  assert.equal(files.title, 'chore: 版本待发布（behind）')
  assert.equal(files.body, issueBody({ status: 'behind', reason: 'behind-reference', repoVersion: '1.0.0', today: '2026-01-05' }))
  assert.match(files.comment, /2026-01-05 复查：仍为 `behind`/)
})

test('issueComment — a dated re-check, not a second issue', () => {
  const comment = issueComment({
    status: 'diverged',
    reason: 'between-tags',
    repoVersion: '5.5.0',
    tagDev: '5.0.0',
    tagLatest: '6.0.0',
    today: '2026-02-09',
  })
  assert.match(comment, /^### 2026-02-09 复查：仍为 `diverged`$/m)
  assert.match(comment, /`5\.5\.0`/)
  assert.match(comment, /`5\.0\.0`/)
  assert.match(comment, /`6\.0\.0`/)
  assert.match(comment, /仍未处理/)
  // It must not re-open the case: no new title, no next-step list.
  assert.doesNotMatch(comment, /^## 版本漂移/m)
  assert.doesNotMatch(comment, /下一步/)
})

// ── registry URL ───────────────────────────────────────────────────────────

test('packumentUrl — plain, trailing-slash and scoped package names', () => {
  assert.equal(packumentUrl('https://registry.npmjs.org', 'dsh-dbhub-live'), 'https://registry.npmjs.org/dsh-dbhub-live')
  assert.equal(packumentUrl('https://registry.npmjs.org/', 'dsh-dbhub-live'), 'https://registry.npmjs.org/dsh-dbhub-live')
  assert.equal(packumentUrl('https://registry.npmjs.org//', 'dsh-dbhub-live'), 'https://registry.npmjs.org/dsh-dbhub-live')
  // Scoped names keep the @ and encode only the separating slash.
  assert.equal(packumentUrl('https://registry.npmjs.org', '@scope/pkg'), 'https://registry.npmjs.org/@scope%2Fpkg')
})

// ── CLI contract (exit codes, GITHUB_OUTPUT, failure is never `ok`) ────────

/** A throwaway directory for manifests, dist-tag fixtures and output files. */
function fixtureDir() {
  return mkdtempSync(join(tmpdir(), 'dbhub-vw-'))
}

/** Write a minimal manifest and return its path. */
function writeManifest(dir, version, name = 'dsh-dbhub-live') {
  const file = join(dir, 'package.json')
  writeFileSync(file, `${JSON.stringify({ name, version }, null, 2)}\n`)
  return file
}

/** Write a dist-tags fixture and return its path. */
function writeTags(dir, tags, file = 'tags.json') {
  const target = join(dir, file)
  writeFileSync(target, `${JSON.stringify(tags, null, 2)}\n`)
  return target
}

/**
 * Run the script and collect its output through a FILE, never a pipe: a sandboxed
 * shell may refuse the named pipes `spawn(stdio: 'pipe')` needs, which would turn
 * every assertion into "could not start" (same reason as test/gates.test.mjs).
 * Async spawn (not spawnSync) so a loopback registry can answer while it runs.
 */
function runNode(file, args = [], env = undefined) {
  return new Promise((resolveRun) => {
    const logDir = mkdtempSync(join(tmpdir(), 'dbhub-vw-log-'))
    const logFile = join(logDir, 'out.log')
    const fd = openSync(logFile, 'w')
    const finish = (code, extra = '') => {
      try {
        closeSync(fd)
      } catch {
        // already closed by the error branch
      }
      let out
      try {
        out = readFileSync(logFile, 'utf8')
      } catch {
        out = ''
      }
      rmSync(logDir, { recursive: true, force: true })
      resolveRun({ code, out: `${out}${extra}` })
    }
    const child = spawn(process.execPath, [file, ...args], {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      env: env ? { ...process.env, ...env } : process.env,
    })
    child.on('error', (error) => finish(null, `\nspawn failed: ${error.message}`))
    child.on('close', (code) => finish(code))
  })
}

function runScript(args, env = undefined) {
  return runNode(SCRIPT, args, env)
}

/** Parse the `key=value` lines the workflow consumes. */
function readOutputs(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('='))
  return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
}

test('version-watch — ok exits 0 and publishes the fields the workflow reads', async () => {
  const dir = fixtureDir()
  try {
    const manifest = writeManifest(dir, '6.0.0-rc.1')
    const tags = writeTags(dir, { dev: '6.0.0', latest: '5.2.0' })
    const output = join(dir, 'github-output.txt')
    const run = await runScript(['--package', manifest, '--dist-tags-json', tags, '--json', '--github-output', output])

    assert.equal(run.code, 0, run.out)
    const payload = JSON.parse(run.out)
    assert.equal(payload.status, 'ok')
    assert.equal(payload.reason, 'iterating')
    assert.equal(payload.exitCode, 0)
    assert.deepEqual(payload.tags, { dev: '6.0.0', latest: '5.2.0' })
    assert.equal(payload.source, 'file')
    assert.deepEqual(readOutputs(output), {
      status: 'ok',
      exit_code: '0',
      reason: 'iterating',
      repo_version: '6.0.0-rc.1',
      tag_dev: '6.0.0',
      tag_latest: '5.2.0',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — ahead exits 1, prints STATUS= and still writes the output file', async () => {
  const dir = fixtureDir()
  try {
    const manifest = writeManifest(dir, '6.1.0')
    const tags = writeTags(dir, { dev: '6.0.0', latest: '5.2.0' })
    const output = join(dir, 'github-output.txt')
    const run = await runScript(['--package', manifest, '--dist-tags-json', tags, '--github-output', output])

    assert.equal(run.code, 1, run.out)
    assert.match(run.out, /^STATUS=ahead$/m)
    // Human output must name the versions a maintainer needs to act on.
    assert.match(run.out, /6\.1\.0/)
    assert.match(run.out, /6\.0\.0/)
    assert.match(run.out, /npm run release:preflight/)
    assert.equal(readOutputs(output).status, 'ahead')
    assert.equal(readOutputs(output).exit_code, '1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — behind and diverged exit 1 with their own status', async () => {
  const dir = fixtureDir()
  try {
    const output = join(dir, 'github-output.txt')
    const behind = await runScript([
      '--package', writeManifest(dir, '5.9.0'),
      '--dist-tags-json', writeTags(dir, { dev: '6.0.0', latest: '6.0.0' }, 'behind.json'),
      '--github-output', output,
    ])
    assert.equal(behind.code, 1, behind.out)
    assert.match(behind.out, /^STATUS=behind$/m)
    assert.equal(readOutputs(output).status, 'behind')

    const diverged = await runScript([
      '--package', writeManifest(dir, '5.5.0'),
      '--dist-tags-json', writeTags(dir, { dev: '5.0.0', latest: '6.0.0' }, 'diverged.json'),
      '--github-output', output,
    ])
    assert.equal(diverged.code, 1, diverged.out)
    assert.match(diverged.out, /^STATUS=diverged$/m)
    assert.equal(readOutputs(output).status, 'diverged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A loopback port that was just released, so connecting to it is refused. */
async function closedPort() {
  const server = createServer(() => {})
  const error = await new Promise((resolveListen) => {
    server.once('error', resolveListen)
    server.listen(0, '127.0.0.1', () => resolveListen(null))
  })
  if (error) return { skipped: `loopback bind unavailable: ${error.code ?? error.message}` }
  const { port } = server.address()
  await new Promise((resolveClose) => server.close(resolveClose))
  return { port }
}

test('version-watch — an unreachable registry exits 2 and never claims ok', async (t) => {
  const dir = fixtureDir()
  try {
    const refused = await closedPort()
    if (refused.skipped) {
      t.skip(refused.skipped)
      return
    }
    const manifest = writeManifest(dir, '6.0.0-rc.1')
    const output = join(dir, 'github-output.txt')
    const run = await runScript([
      '--package', manifest,
      '--registry', `http://127.0.0.1:${refused.port}/`,
      '--timeout-ms', '5000',
      '--json', '--github-output', output,
    ])
    assert.equal(run.code, 2, run.out)
    const payload = JSON.parse(run.out)
    assert.equal(payload.status, 'error')
    assert.equal(payload.exitCode, 2)
    assert.match(payload.error, /cannot reach the npm registry/)
    // The workflow reads these, so they must be present and must say "not ok".
    const written = readOutputs(output)
    assert.equal(written.status, 'error')
    assert.equal(written.exit_code, '2')
    assert.notEqual(written.status, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — a registry response without dist-tags is an error, not ok', async () => {
  const dir = fixtureDir()
  try {
    const manifest = writeManifest(dir, '6.0.0-rc.1')
    const empty = join(dir, 'no-tags.json')
    writeFileSync(empty, `${JSON.stringify({ name: 'dsh-dbhub-live' })}\n`)
    const noTags = await runScript(['--package', manifest, '--dist-tags-json', empty, '--json'])
    assert.equal(noTags.code, 2, noTags.out)
    assert.match(JSON.parse(noTags.out).error, /does not contain a dist-tags object/)

    const broken = join(dir, 'broken.json')
    writeFileSync(broken, 'not json at all\n')
    const badJson = await runScript(['--package', manifest, '--dist-tags-json', broken])
    assert.equal(badJson.code, 2, badJson.out)
    assert.match(badJson.out, /^STATUS=error$/m)

    const junkVersion = writeManifest(dir, '6.0', 'dsh-dbhub-live')
    const badVersion = await runScript(['--package', junkVersion, '--dist-tags-json', writeTags(dir, { latest: '6.0.0' })])
    assert.equal(badVersion.code, 2, badVersion.out)
    assert.match(badVersion.out, /^STATUS=error$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Start a loopback registry, run `body(baseUrl)` against it, always close it.
 * Returns `{ skipped }` when the sandbox refuses to listen, so the case is reported
 * as SKIPPED rather than silently passing.
 */
async function withRegistry(body) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, accept: req.headers.accept })
    if (req.url === '/dsh-dbhub-live') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'dsh-dbhub-live', 'dist-tags': { dev: '6.0.0', latest: '5.2.0' } }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  const listenError = await new Promise((resolveListen) => {
    server.once('error', resolveListen)
    server.listen(0, '127.0.0.1', () => resolveListen(null))
  })
  if (listenError) return { skipped: `loopback registry cannot listen: ${listenError.code ?? listenError.message}` }
  try {
    const { port } = server.address()
    return await body(`http://127.0.0.1:${port}`, requests)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

test('version-watch — reads a live registry response over HTTP (loopback)', async (t) => {
  const dir = fixtureDir()
  try {
    const outcome = await withRegistry(async (base, requests) => {
      const manifest = writeManifest(dir, '6.0.0-rc.1')
      const run = await runScript(['--package', manifest, '--registry', base, '--json'])
      return { run, requests }
    })
    if (outcome.skipped) {
      t.skip(outcome.skipped)
      return
    }
    const { run, requests } = outcome
    assert.equal(run.code, 0, run.out)
    const payload = JSON.parse(run.out)
    assert.equal(payload.status, 'ok')
    assert.equal(payload.source, 'registry')
    assert.deepEqual(payload.tags, { dev: '6.0.0', latest: '5.2.0' })
    // The packument path is the package name, and only JSON is asked for.
    assert.equal(requests.length, 1, JSON.stringify(requests))
    assert.equal(requests[0].url, '/dsh-dbhub-live')
    assert.match(requests[0].accept ?? '', /application\/json/)

    // A 404 (package never published) must fail the check, not pass it.
    const unknown = await withRegistry(async (base) => {
      const manifest = writeManifest(dir, '6.0.0-rc.1', 'not-published-yet')
      return runScript(['--package', manifest, '--registry', base, '--json'])
    })
    if (!unknown.skipped) {
      assert.equal(unknown.code, 2, unknown.out)
      assert.match(JSON.parse(unknown.out).error, /HTTP 404/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — --help and a bad argument never exit 1 (that means "drift")', async () => {
  const help = await runScript(['--help'])
  assert.equal(help.code, 0, help.out)
  assert.match(help.out, /--dist-tags-json/)

  const unknown = await runScript(['--nope'])
  assert.equal(unknown.code, 2, unknown.out)

  const noValue = await runScript(['--registry'])
  assert.equal(noValue.code, 2, noValue.out)
})

test('version-watch — --issue-dir writes the three files the workflow files from', async () => {
  const dir = fixtureDir()
  try {
    const manifest = writeManifest(dir, '6.1.0')
    const tags = writeTags(dir, { dev: '6.0.0', latest: '5.2.0' })
    const issueDir = join(dir, 'issue')
    const run = await runScript(['--package', manifest, '--dist-tags-json', tags, '--json', '--issue-dir', issueDir])

    assert.equal(run.code, 1, run.out)
    const payload = JSON.parse(run.out)
    assert.equal(payload.issue.title, 'chore: 版本待发布（ahead）')

    // Files first: the workflow reads these, so the names are part of the contract.
    const title = readFileSync(join(issueDir, 'title.txt'), 'utf8').trim()
    const body = readFileSync(join(issueDir, 'body.md'), 'utf8')
    const comment = readFileSync(join(issueDir, 'comment.md'), 'utf8')
    assert.equal(title, 'chore: 版本待发布（ahead）')
    assert.match(body, /^## 版本漂移：`ahead`（\d{4}-\d{2}-\d{2}）$/m)
    assert.match(body, /`6\.1\.0`/)
    assert.match(comment, /复查：仍为 `ahead`/)
    // The payload points at what was written, so the log is self-explanatory.
    assert.equal(payload.issue.files.title, join(issueDir, 'title.txt'))
    assert.ok(payload.issue.files.body.endsWith('body.md'))
    assert.ok(payload.issue.files.comment.endsWith('comment.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — --issue-dir writes nothing for ok or for a failed check', async () => {
  const dir = fixtureDir()
  try {
    // ok: in sync, so there is nothing to file and no stale text to inherit.
    const okManifest = writeManifest(dir, '6.0.0-rc.1')
    const okTags = writeTags(dir, { dev: '6.0.0', latest: '5.2.0' }, 'ok-tags.json')
    const okDir = join(dir, 'issue-ok')
    const okRun = await runScript(['--package', okManifest, '--dist-tags-json', okTags, '--json', '--issue-dir', okDir])
    assert.equal(okRun.code, 0, okRun.out)
    assert.equal(JSON.parse(okRun.out).issue, undefined)
    assert.equal(existsSync(okDir), false, 'an ok status must not leave issue files behind')

    // exit 2: a broken check has no verdict, so it must not produce prose either.
    const badDir = join(dir, 'issue-bad')
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, 'not json\n')
    const badRun = await runScript(['--package', okManifest, '--dist-tags-json', broken, '--json', '--issue-dir', badDir])
    assert.equal(badRun.code, 2, badRun.out)
    assert.equal(JSON.parse(badRun.out).issue, undefined)
    assert.equal(existsSync(badDir), false, 'a failed check must not leave issue files behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — a bare --github-output uses $GITHUB_OUTPUT', async () => {
  const dir = fixtureDir()
  try {
    const manifest = writeManifest(dir, '6.1.0')
    const tags = writeTags(dir, { dev: '6.0.0', latest: '5.2.0' })
    const output = join(dir, 'github-output.txt')
    // The flag without a value must resolve to the Actions-provided path.
    const run = await runScript(['--package', manifest, '--dist-tags-json', tags, '--github-output'], { GITHUB_OUTPUT: output })
    assert.equal(run.code, 1, run.out)
    assert.equal(readOutputs(output).status, 'ahead')

    // ... and with neither a value nor the variable it is a usage error, not silence.
    const noEnv = await runScript(['--package', manifest, '--dist-tags-json', tags, '--github-output'], { GITHUB_OUTPUT: '' })
    assert.equal(noEnv.code, 2, noEnv.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — importing the module runs no CLI (and prints nothing)', async () => {
  // The unit tests above import `classify`/`compareVersions`. If the CLI also ran on
  // import, the test process itself would hit the npm registry and inherit the script's
  // exit code — a suite made red by a version instead of by a test. This fixture prints
  // exactly one token, so any extra output (the human report or the JSON payload) fails.
  const dir = fixtureDir()
  try {
    const entry = join(dir, 'import-only.mjs')
    writeFileSync(
      entry,
      `import { classify } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}\n` +
        `process.stdout.write(String(classify('1.0.0', { latest: '1.0.0' }).status))\n`,
    )
    const run = await runNode(entry)
    assert.equal(run.code, 0, run.out)
    assert.equal(run.out.trim(), 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-watch — the repository manifest itself is parseable by the script', () => {
  // Guards the wiring the weekly job depends on: the real package.json is the input,
  // so a version field that is not semver would turn the watch into a permanent error.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(parseVersion(pkg.version), `package.json version "${pkg.version}" must be semver`)
  assert.ok(pkg.name, 'package.json must declare the npm name the registry call uses')
})
