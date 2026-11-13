#!/usr/bin/env node
// Generate / verify everything derived from the support matrix:
//   doc/SUPPORT-MATRIX.md          — the evidence table (Chinese, detailed)
//   release-test/mise.toml         — pre-install list for mise (no activation)
//   README.md / README.en.md       — the "supported version range" section,
//                                    collapsed detail under a one-line range
//
// One source of truth (release-test/matrix.json + release-test/evidence-summary.json),
// three renderings, so a claim cannot drift from what was tested.
//
//   node release-test/support-matrix.mjs --write           # refresh evidence + regenerate
//   node release-test/support-matrix.mjs --check           # fail if structure is stale (CI)
//   node release-test/support-matrix.mjs --check-evidence  # fail if the local reports moved on
//   node release-test/support-matrix.mjs                   # print the document
//
// WHY THE EVIDENCE IS A COMMITTED FILE: the rendered documents used to embed
// whatever `.release-test/reports/` happened to hold, and that directory is
// gitignored (it is reproducible output, and it contains per-machine homes and
// caches). A clean checkout therefore recomputed "未验证" against documents that
// said "已通过", so `--check` could never pass in CI. The distilled evidence now
// lives in `release-test/evidence-summary.json` — committed, free of paths and
// secrets — and every rendering depends on shipped inputs only. `--write` is the
// only thing that reads `.release-test/`; `--check` never does.
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, readJson } from './lib/util.mjs'
import { loadMatrix, matrixClaimWarnings, matrixHash } from './lib/matrix.mjs'
import { packageMeta } from './lib/artifact.mjs'
import { latestRun, listRuns } from './lib/runs.mjs'
import { loadVerdict } from './lib/verdict.mjs'
import { compareVersions } from './lib/semver.mjs'

const OUT_DOC = path.join(REPO_ROOT, 'doc', 'SUPPORT-MATRIX.md')
const OUT_MISE = path.join(REPO_ROOT, 'release-test', 'mise.toml')
const EVIDENCE_FILE = path.join(REPO_ROOT, 'release-test', 'evidence-summary.json')
const READMES = [
  { file: path.join(REPO_ROOT, 'README.md'), lang: 'zh' },
  { file: path.join(REPO_ROOT, 'README.en.md'), lang: 'en' },
]
const BEGIN = '<!-- release-test:versions:begin -->'
const END = '<!-- release-test:versions:end -->'

const argv = process.argv.slice(2)
const mode = argv.includes('--write')
  ? 'write'
  : argv.includes('--check-evidence')
    ? 'check-evidence'
    : argv.includes('--check')
      ? 'check'
      : 'print'

const pkg = packageMeta()
const matrix = loadMatrix()
const matrixHashValue = matrixHash(matrix)
const declared = matrix.targets.filter((t) => t.tier === 'declared')
const advisory = matrix.targets.filter((t) => t.tier === 'advisory')

// --- peer range, derived from the declared targets ---------------------------
// NO DSH peer range — on purpose.
//
// A `peerDependencies` range cannot be both "minimum 0.2.1" and "any future
// release": node-semver only admits a prerelease when a comparator carries a
// prerelease on the SAME major.minor.patch tuple, so every new DSH prerelease
// line (0.2.2, 0.2.3, …) would need a new branch — the manifest would then reject
// the newest harness until someone edited it, which is exactly the "plugin blocks
// a brand-new DSH" failure this project must not have. The two old DSH packages
// are also no longer part of a modern harness and are not imported here.
//
// What actually guards compatibility: the host FEATURE-PROBES the bridge at
// runtime, and `engines.dsh` refuses an unsupported host at activation time. Keep the
// two library peers (cordis / schemastery): they describe what the host provides,
// and their `^` ranges already span every release we test.
const FRAMEWORK_PEERS = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']

function peerDepsUpToDate() {
  const current = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).peerDependencies ?? {}
  const names = Object.keys(current).sort()
  return (
    names.length === FRAMEWORK_PEERS.length &&
    FRAMEWORK_PEERS.every((name) => typeof current[name] === 'string' && current[name].length > 0)
  )
}

const claims = matrixClaimWarnings(matrix)

/**
 * Distil `.release-test/reports/` into the committed evidence summary.
 * LOCAL ONLY: only `--write` calls this, so a clean checkout (no reports) still
 * renders from the committed summary alone.
 * @returns the summary, or null when there is nothing to distil.
 */
function collectEvidence() {
  const runs = listRuns()
  if (runs.length === 0) return null
  const latest = latestRun()
  // Newest evidence per version: status + timing + provenance.
  const targets = {}
  for (const target of matrix.targets) {
    const run = [...runs].reverse().find((r) => r.report?.targets?.some((x) => x.version === target.version))
    if (!run) continue
    const hit = run.report.targets.find((x) => x.version === target.version)
    targets[target.version] = {
      runId: run.runId,
      generatedAt: run.report.generatedAt,
      status: hit.status,
      provisionMode: hit.provisionMode ?? null,
      cliSource: hit.cliSource ?? null,
      readyMs: hit.timings?.readyMs ?? null,
      pluginVersion: run.report.plugin?.version ?? null,
      commit: run.report.git?.commit ? String(run.report.git.commit).slice(0, 8) : null,
      counts: hit.checksCounts ?? {},
    }
  }
  // "Latest complete test" means a run that covered every declared target; a
  // single-target debug run must not masquerade as the release evidence.
  const fullRun = [...runs].reverse().find((run) => run.report?.targets && declared.every((t) => run.report.targets.some((x) => x.version === t.version))) ?? null
  const verdictSource = fullRun ?? latest
  const loaded = verdictSource ? loadVerdict(verdictSource.dir) : { ok: false }
  const complete = Boolean(loaded.ok && loaded.verdict?.overall && loaded.verdict?.reviewer && loaded.verdict?.reviewedAt)
  const verdict = complete
    ? { state: 'complete', overall: loaded.verdict.overall, reviewer: loaded.verdict.reviewer, reviewedAt: loaded.verdict.reviewedAt }
    : loaded.ok
      ? { state: 'incomplete' } // verdict.json exists but the template is not filled in
      : { state: 'none' }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pluginVersion: pkg.version,
    // Stamped with the matrix this summary is VALID FOR (the current one), not
    // with the hash the local run happened to record: dropping an unsupported
    // target must not invalidate the evidence for the remaining, unchanged
    // targets. A NEW or CHANGED target has no entry here, so its row renders
    // "未验证" — the freshness guard that matters is kept.
    matrixHash: matrixHashValue,
    fullRun: fullRun
      ? { runId: fullRun.runId, generatedAt: fullRun.report?.generatedAt ?? null, status: fullRun.report?.status ?? null }
      : null,
    verdict,
    targets,
  }
}

/** Persist the summary, keeping the old timestamp when nothing but time changed. */
function writeEvidence(next) {
  const withoutStamp = (summary) => JSON.stringify({ ...summary, generatedAt: null })
  let previous = null
  try {
    previous = readJson(EVIDENCE_FILE)
  } catch {
    /* first write */
  }
  const stable = previous && withoutStamp(previous) === withoutStamp(next) ? previous.generatedAt : next.generatedAt
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ ...next, generatedAt: stable }, null, 2) + '\n')
}

function loadEvidence() {
  if (!fs.existsSync(EVIDENCE_FILE)) {
    console.error(
      `missing ${path.relative(REPO_ROOT, EVIDENCE_FILE)} — it is committed evidence; regenerate it from a completed\n` +
        'matrix run with: node release-test/support-matrix.mjs --write',
    )
    process.exit(1)
  }
  return readJson(EVIDENCE_FILE)
}

// Sync package.json BEFORE claims are read, so --write produces a document whose
// "known drift" section reflects the range it just wrote.
if (mode === 'write') {
  const refreshed = collectEvidence()
  if (refreshed) {
    writeEvidence(refreshed)
    console.log(`refreshed ${path.relative(REPO_ROOT, EVIDENCE_FILE)} from .release-test/reports/`)
  } else {
    console.warn('no .release-test/reports/ run found — keeping the committed evidence summary as is')
  }
}

const evidence = loadEvidence()
/** Newest evidence per version, from the committed summary. */
const evidenceFor = (version) => evidence.targets?.[version] ?? null

const fullRun = evidence.fullRun ?? null
const verdict = evidence.verdict ?? { state: 'none' }
const verdictText =
  verdict.state === 'complete'
    ? `${verdict.overall} — ${verdict.reviewer} @ ${verdict.reviewedAt}`
    : verdict.state === 'incomplete'
      ? '未完成 AI 判定（verdict.json 模板还没填完）'
      : '未做 AI 判定'

// A "line" is a major.minor.patch release line (0.1.5 / 0.1.6 / 0.2.1 …); the
// prerelease suffix is not part of the identity.
const versionLines = [...new Set(declared.map((t) => t.version.split('-')[0]))]
const lowestLine = versionLines[0]
const lowest = [...declared.map((t) => t.version)].sort(compareVersions)[0]
const highest = [...declared.map((t) => t.version)].sort(compareVersions).at(-1)
const evidenceList = declared.map((t) => evidenceFor(t.version)).filter(Boolean)
const latestDate = evidenceList.length ? evidenceList.map((e) => e.generatedAt.slice(0, 10)).sort().at(-1) : null
const allGreen = declared.every((t) => {
  const e = evidenceFor(t.version)
  return e && (e.status === 'pass' || e.status === 'warn')
})

const zhRange = `**DSH ${lowestLine} 起（${versionLines.join(' / ')} 共 ${versionLines.length} 条版本线，含预发布）** — ${declared.length} 个声明版本${allGreen ? '已实测通过' : '尚未全部通过'}${latestDate ? `（最近验证 ${latestDate}）` : ''}。`
const enRange = `**From DSH ${lowestLine} (lines ${versionLines.join(' / ')}, prereleases included)** — ${declared.length} declared versions ${allGreen ? 'verified' : 'not all verified yet'}${latestDate ? ` (last verified ${latestDate})` : ''}.`

const STATUS_ZH = { pass: '✅ 通过', warn: '⚠️ 通过（有告警）', fail: '❌ 失败', error: '💥 错误' }
const STATUS_EN = { pass: '✅ pass', warn: '⚠️ pass with notes', fail: '❌ fail', error: '💥 error' }
const UI_ZH = { legacy: '旧版', modern: '新版' }

const fmtReady = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`)
const fmtWhen = (e) => (e ? `${e.generatedAt.slice(0, 10)} · ${e.commit ?? '?'}` : '未验证')
const fmtProvision = (e, zh) => (e?.provisionMode === 'manual' ? (zh ? ' · 手工装配' : ' · manual') : '')

function detailTable(targets, lang) {
  const zh = lang === 'zh'
  const rows = [
    zh ? '| DSH 版本 | 界面 | 启动 | 硬检查 | 结论 | 最近验证 |' : '| DSH version | UI | Boot | Hard checks | Result | Last verified |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const target of targets) {
    const e = evidenceFor(target.version)
    const counts = e?.counts ?? {}
    const pass = counts.pass ?? '—'
    const status = e ? (zh ? STATUS_ZH : STATUS_EN)[e.status] ?? e.status : '—'
    const ui = zh ? UI_ZH[target.ui] ?? target.ui : target.ui
    rows.push(`| \`${target.version}\` | ${ui} | ${fmtReady(e?.readyMs)} | ${pass} | ${status}${fmtProvision(e, zh)} | ${fmtWhen(e)} |`)
  }
  return rows.join('\n')
}

const zhBlock = `${BEGIN}
## 支持的版本范围

${zhRange}

<details>
<summary>逐版本实测明细（点开查看）</summary>

${detailTable(declared, 'zh')}

</details>

完整证据、判定规则与已知偏差见 [doc/SUPPORT-MATRIX.md](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/SUPPORT-MATRIX.md)。
${END}`

const enBlock = `${BEGIN}
## Supported version range

${enRange}

<details>
<summary>Per-version verification details (expand)</summary>

${detailTable(declared, 'en')}

</details>

Full evidence, review rules and known drift live in [doc/SUPPORT-MATRIX.md](https://github.com/mr-mihu/dsh-dbhub-live/blob/dev/doc/SUPPORT-MATRIX.md).
${END}`

const doc = `# 支持的 DSH 版本（发布测试矩阵）

> **本文件由脚本生成，请勿手工编辑。**
> 数据源：\`release-test/matrix.json\`（声明）+ \`release-test/evidence-summary.json\`（最近验证证据摘要，随包提交）。
> \`.release-test/reports/\` 只被 \`--write\` 读取一次并蒸馏成上面这份摘要，渲染不依赖本机目录，所以干净检出也能复现。
> 重新生成：\`node release-test/support-matrix.mjs --write\`　校验结构：\`--check\`　校验证据是否过期（仅本机有报告时）：\`--check-evidence\`

- 插件版本：\`${pkg.version}\`
- 矩阵指纹：\`${matrixHashValue.slice(0, 12)}\`（证据摘要按当前矩阵盖章；增减 target 后必须重跑 \`--write\`）
- 最近一次完整测试：${fullRun ? `\`${fullRun.runId}\`（${fullRun.generatedAt ?? '?'}，${fullRun.status ?? '?'}）` : '尚无完整矩阵运行'}
- 最近一次 AI 判定：${verdictText}
- 声明范围：${lowest} 起至 ${highest}（${versionLines.join(' / ')}，含预发布）

## 声明支持（blocking：任一失败即禁止发版）

| DSH 版本 | 集成代际 | 界面 | 声明依据 | 最近验证 | 结果 |
| --- | --- | --- | --- | --- | --- |
${declared.map((t) => {
  const e = evidenceFor(t.version)
  return `| \`${t.version}\` | ${t.era} | ${t.ui} | ${t.why} | ${fmtWhen(e)}${fmtProvision(e, true)} | ${e ? (STATUS_ZH[e.status] ?? e.status) : '—'} |`
}).join('\n')}

## 观察项（advisory：只报告，不阻塞）

| DSH 版本 | 集成代际 | 界面 | 声明依据 | 最近验证 | 结果 |
| --- | --- | --- | --- | --- | --- |
${advisory.map((t) => {
  const e = evidenceFor(t.version)
  return `| \`${t.version}\` | ${t.era} | ${t.ui} | ${t.why} | ${fmtWhen(e)}${fmtProvision(e, true)} | ${e ? (STATUS_ZH[e.status] ?? e.status) : '—'} |`
}).join('\n')}

## 这些版本是怎么验证的

每个版本都跑一遍**真实 web 端**，不复用开发机的 profile：

1. **CLI 来源**（两种，同一套探针）：
   - **mise（推荐）**：\`mise -C release-test install\` 一次性预装全部声明版本（不激活、不占 PATH），测试时按版本临时调用 \`mise x npm:@deepseek-ai/dsh@<版本> -- dsh …\`；预装清单由本文件同源的脚本生成到 \`release-test/mise.toml\`。
   - **npm（回退）**：没有 mise 的机器自动回退为每版本一次性 \`npm install --ignore-scripts\` 到 \`.release-test/cache/tools/\`。
2. 在 \`.release-test/homes/dsh-<版本>/\` 建**隔离的 DSH_HOME**，跑 \`--profile web --dump-config\` 生成 web profile；
3. 把 \`npm pack\` 出来的**真实发布产物**装进该 profile（\`--provision cli\` 时走真实 \`dsh plugin add\`）；
4. 起 \`dsh web\`，抓 ready 行的 token，换 cookie 后探针：\`/api/dsh-dbhub-live/state\`（带/不带 cookie）、模块清单里的 client bundle、写 options、非法 op；
5. 断言启动日志里的 4 工具与通道、state 里的 \`pluginVersion\` / \`dshVersion\` 与矩阵一致，且 view 里**没有**版本门（门槛由 \`engines.dsh\` 在激活期强制，插件不再自己判）；
6. 证据落在 \`.release-test/reports/<run>/evidence/<版本>/\`；由 AI 复核后写 \`verdict.json\`；\`npm run release:preflight\` 校验「报告新鲜 + 矩阵未变 + 声明无偏差 + AI 判定通过 + 工作区干净」后才允许打 tag。

## 判定规则

- **declared** 的任一目标出现 \`fail\`：报告为 red，发版被阻断。
- **advisory** 目标失败：只进入「需要复核」清单，不阻塞。
- 手工装配（\`provision=manual\`）会标「（手工装配）」并进入复核清单：产物内容验证了，但真实安装路径没走。
- AI 判定必须逐版本给结论、逐条回答 open question，且报告哈希要对得上；判定不能把 fail 说成 pass（脚本会拒绝）。

## 如何增删一个版本

1. 改 \`release-test/matrix.json\` 的 \`targets\`（\`tier\` / \`era\` / \`ui\` / \`why\` / \`expect\`），\`ui\` 必须与最低支持版本门一致（>=0.2.1 为 modern，含预发布；低于 0.2.1 的 target 不允许出现在矩阵里）；
2. \`node release-test/run.mjs selftest\` 校验矩阵结构与 semver 规则；
3. \`node release-test/support-matrix.mjs --write\` 同步本文件、\`release-test/mise.toml\` 与两个 README 的版本段；
4. \`mise -C release-test install\`（或直接跑测试让它回退 npm）→ \`node release-test/run.mjs\` 全矩阵 → AI 判定；
5. \`package.json\` **不声明 DSH 版本范围**（只有 \`@deepseek-ai/cordis\` / \`@deepseek-ai/schemastery\` 两个库 peer）：范围无法同时表达「最低 0.2.1」与「未来的任意预发布」，写了反而会在新 DSH 发布当天把用户挡在门外。兼容性由**运行时特性探测**（桥接）+ 卡片里的过旧升级提示保证；\`dsh.compatibility.dshReleases\` 手工维护，须与矩阵 declared 一致，改完跑 \`node release-test/run.mjs matrix\` 确认「声明偏差」清零。

## 已知声明偏差

${claims.length ? claims.map((claim) => `- ⚠️ ${claim.detail}`).join('\n') : '无：矩阵与 `dsh.compatibility.dshReleases` 一致，且没有低于最低支持版本的 target。'}
`

const miseToml = `# Generated from release-test/matrix.json by \`node release-test/support-matrix.mjs --write\`.
# Do not edit by hand. Install everything once (versions coexist, nothing is
# activated globally):
#
#   mise -C release-test install
#
# Then the harness runs a specific version on demand:
#
#   mise x npm:@deepseek-ai/dsh@<version> -- dsh web ...
#
[tools]
"npm:@deepseek-ai/dsh" = [
${matrix.targets.map((t) => `  "${t.version}",`).join('\n')}
]
`

function replaceBlock(file, block, lang) {
  const text = fs.readFileSync(file, 'utf8')
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${path.relative(REPO_ROOT, file)}: missing ${BEGIN} / ${END} markers`)
  }
  return text.slice(0, begin) + block + text.slice(end + END.length)
}

// --- peer range, derived from the declared targets ---------------------------
// (defined above, before claims are read)

const artifacts = [
  { file: OUT_DOC, content: doc, label: 'doc/SUPPORT-MATRIX.md' },
  { file: OUT_MISE, content: miseToml, label: 'release-test/mise.toml' },
  { file: READMES[0].file, content: replaceBlock(READMES[0].file, zhBlock, 'zh'), label: 'README.md' },
  { file: READMES[1].file, content: replaceBlock(READMES[1].file, enBlock, 'en'), label: 'README.en.md' },
]

if (mode === 'write') {

  // Preserve the line endings the file already has: this generator writes LF, but
  // a Windows checkout (core.autocrlf) holds CRLF, so rewriting a file whose
  // CONTENT did not change used to leave it "modified" in `git status` with an
  // empty `git diff` — and a dirty tree blocks `release:preflight`.
  const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n')
  for (const artifact of artifacts) {
    const existing = fs.existsSync(artifact.file) ? fs.readFileSync(artifact.file, 'utf8') : ''
    const body = eolOf(existing) === '\r\n' ? artifact.content.replace(/\r?\n/g, '\r\n') : artifact.content
    fs.mkdirSync(path.dirname(artifact.file), { recursive: true })
    fs.writeFileSync(artifact.file, body)
    console.log(`wrote ${artifact.label}`)
  }
} else if (mode === 'check' || mode === 'check-evidence') {
  // Line endings are not content: the generator writes LF, a Windows checkout can
  // hold CRLF (see .gitattributes), and comparing raw text made `--check` red on
  // every Windows machine while `git diff` stayed empty.
  const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')

  if (mode === 'check-evidence') {
    // Evidence freshness is only answerable where the reports exist; a clean
    // checkout has none, so this step self-skips instead of failing the job.
    const refreshed = collectEvidence()
    if (!refreshed) {
      console.log('evidence check skipped: no local .release-test/reports/ (structural check still applies)')
    } else {
      const committed = loadEvidence()
      const withoutStamp = (summary) => JSON.stringify({ ...summary, generatedAt: null, pluginVersion: null })
      if (withoutStamp(committed) !== withoutStamp(refreshed)) {
        console.error(
          'release-test/evidence-summary.json is older than the local reports — the shipped evidence table no longer\n' +
            'matches what was tested here. Regenerate: node release-test/support-matrix.mjs --write',
        )
        process.exitCode = 1
      } else {
        console.log('evidence summary matches the local .release-test/reports/ runs')
      }
    }
  } else {
    const stale = []
    if (evidence.matrixHash && evidence.matrixHash !== matrixHashValue) {
      stale.push('release-test/evidence-summary.json was collected against a different matrix.json (rerun the matrix, then --write)')
    }
    for (const artifact of artifacts) {
      const current = fs.existsSync(artifact.file) ? fs.readFileSync(artifact.file, 'utf8') : ''
      if (!sameText(current, artifact.content)) stale.push(artifact.label)
    }
    if (!peerDepsUpToDate()) stale.push('package.json peerDependencies (framework peers only)')
    if (stale.length) {
      console.error(`out of date: ${stale.join(', ')} — run: node release-test/support-matrix.mjs --write`)
      process.exitCode = 1
    } else {
      console.log('support matrix, mise.toml and both READMEs are up to date (structure; evidence freshness: --check-evidence)')
    }
  }
} else {
  process.stdout.write(doc)
}
