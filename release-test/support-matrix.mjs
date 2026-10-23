#!/usr/bin/env node
// Generate / verify everything derived from the support matrix:
//   doc/SUPPORT-MATRIX.md          — the evidence table (Chinese, detailed)
//   release-test/mise.toml         — pre-install list for mise (no activation)
//   README.md / README.en.md       — the "supported version range" section,
//                                    collapsed detail under a one-line range
//
// One source of truth (release-test/matrix.json + the newest evidence), three
// renderings, so a claim cannot drift from what was tested.
//
//   node release-test/support-matrix.mjs --write   # regenerate all three
//   node release-test/support-matrix.mjs --check   # fail if any is stale (CI)
//   node release-test/support-matrix.mjs           # print the document
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './lib/util.mjs'
import { loadMatrix, matrixClaimWarnings, matrixHash } from './lib/matrix.mjs'
import { packageMeta } from './lib/artifact.mjs'
import { latestRun, listRuns } from './lib/runs.mjs'
import { loadVerdict } from './lib/verdict.mjs'
import { compareVersions } from './lib/semver.mjs'

const OUT_DOC = path.join(REPO_ROOT, 'doc', 'SUPPORT-MATRIX.md')
const OUT_MISE = path.join(REPO_ROOT, 'release-test', 'mise.toml')
const READMES = [
  { file: path.join(REPO_ROOT, 'README.md'), lang: 'zh' },
  { file: path.join(REPO_ROOT, 'README.en.md'), lang: 'en' },
]
const BEGIN = '<!-- release-test:versions:begin -->'
const END = '<!-- release-test:versions:end -->'

const argv = process.argv.slice(2)
const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : 'print'

const pkg = packageMeta()
const matrix = loadMatrix()
const matrixHashValue = matrixHash(matrix)
const runs = listRuns()
const latest = latestRun()
const declared = matrix.targets.filter((t) => t.tier === 'declared')
const advisory = matrix.targets.filter((t) => t.tier === 'advisory')

// --- peer range, derived from the declared targets ---------------------------
// node-semver only admits a prerelease when some comparator carries a prerelease
// on the SAME major.minor.patch tuple, so "all prereleases from 0.1.5 on" cannot
// be one comparator set: it needs one branch per release line. Deriving it from
// the matrix keeps the installable range and the tested range the same thing.
const PEER_NAMES = ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-settings']

function peerRangeFor(targets) {
  const tuples = [...new Set(targets.filter((t) => t.tier === 'declared').map((t) => t.version.split('-')[0]))]
    .sort(compareVersions)
  return tuples.map((tuple, index) => {
    const next = tuples[index + 1]
    const upper = next ? `<${next}-0` : '<0.3.0-0'
    return `>=${tuple}-0 ${upper}`
  }).join(' || ')
}

const peerRange = peerRangeFor(declared)

function peerRangeUpToDate() {
  const current = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).peerDependencies ?? {}
  return PEER_NAMES.every((name) => current[name] === peerRange)
}

function applyPeerRange() {
  const file = path.join(REPO_ROOT, 'package.json')
  let text = fs.readFileSync(file, 'utf8')
  for (const name of PEER_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`("${escaped}":\\s*)"[^"]*"`)
    if (!pattern.test(text)) throw new Error(`package.json has no peerDependencies entry for ${name}`)
    text = text.replace(pattern, `$1${JSON.stringify(peerRange)}`)
  }
  fs.writeFileSync(file, text)
}

// Sync package.json BEFORE claims are read, so --write produces a document whose
// "known drift" section reflects the range it just wrote.
if (mode === 'write') applyPeerRange()

const claims = matrixClaimWarnings(matrix)

/** Newest evidence per version: runId + status + timing + provenance. */
function evidenceFor(version) {
  for (const run of [...runs].reverse()) {
    const target = run.report?.targets?.find((t) => t.version === version)
    if (target) {
      return {
        runId: run.runId,
        generatedAt: run.report.generatedAt,
        status: target.status,
        provisionMode: target.provisionMode ?? null,
        cliSource: target.cliSource ?? null,
        readyMs: target.timings?.readyMs ?? null,
        pluginVersion: run.report.plugin?.version ?? null,
        commit: run.report.git?.commit?.slice(0, 8) ?? null,
        counts: target.checksCounts ?? {},
      }
    }
  }
  return null
}

// "Latest complete test" means a run that covered every declared target; a
// single-target debug run must not masquerade as the release evidence.
const fullRun = [...runs].reverse().find((run) => run.report?.targets && declared.every((t) => run.report.targets.some((x) => x.version === t.version))) ?? null
const verdictSource = fullRun ?? latest
const verdict = verdictSource ? loadVerdict(verdictSource.dir) : { ok: false }
const verdictComplete = verdict.ok && verdict.verdict?.overall && verdict.verdict?.reviewer && verdict.verdict?.reviewedAt
const verdictText = verdictComplete
  ? `${verdict.verdict.overall} — ${verdict.verdict.reviewer} @ ${verdict.verdict.reviewedAt}`
  : verdict.ok
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

完整证据、判定规则与已知偏差见 [doc/SUPPORT-MATRIX.md](doc/SUPPORT-MATRIX.md)。
${END}`

const enBlock = `${BEGIN}
## Supported version range

${enRange}

<details>
<summary>Per-version verification details (expand)</summary>

${detailTable(declared, 'en')}

</details>

Full evidence, review rules and known drift live in [doc/SUPPORT-MATRIX.md](doc/SUPPORT-MATRIX.md).
${END}`

const doc = `# 支持的 DSH 版本（发布测试矩阵）

> **本文件由脚本生成，请勿手工编辑。**
> 数据源：\`release-test/matrix.json\`（声明）+ \`.release-test/reports/\`（最近验证证据）。
> 重新生成：\`node release-test/support-matrix.mjs --write\`　校验是否同步：\`node release-test/support-matrix.mjs --check\`

- 插件版本：\`${pkg.version}\`
- 矩阵指纹：\`${matrixHashValue.slice(0, 12)}\`（矩阵变了，旧报告就不再被采信）
- 最近一次完整测试：${fullRun ? `\`${fullRun.runId}\`（${fullRun.report?.generatedAt ?? '?'}，${fullRun.report?.status ?? '?'}）` : '尚无完整矩阵运行'}
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
5. 断言启动日志里的 4 工具与通道、state 里的 \`pluginVersion\` / \`dshVersion\` / \`dshModern\` 与矩阵一致；
6. 证据落在 \`.release-test/reports/<run>/evidence/<版本>/\`；由 AI 复核后写 \`verdict.json\`；\`npm run release:preflight\` 校验「报告新鲜 + 矩阵未变 + 声明无偏差 + AI 判定通过 + 工作区干净」后才允许打 tag。

## 判定规则

- **declared** 的任一目标出现 \`fail\`：报告为 red，发版被阻断。
- **advisory** 目标失败：只进入「需要复核」清单，不阻塞。
- 手工装配（\`provision=manual\`）会标「（手工装配）」并进入复核清单：产物内容验证了，但真实安装路径没走。
- AI 判定必须逐版本给结论、逐条回答 open question，且报告哈希要对得上；判定不能把 fail 说成 pass（脚本会拒绝）。

## 如何增删一个版本

1. 改 \`release-test/matrix.json\` 的 \`targets\`（\`tier\` / \`era\` / \`ui\` / \`why\` / \`expect\`），\`ui\` 必须与插件自己的 \`dshModern\`（>=0.2.1）一致；
2. \`node release-test/run.mjs selftest\` 校验矩阵结构与 semver 规则；
3. \`node release-test/support-matrix.mjs --write\` 同步本文件、\`release-test/mise.toml\` 与两个 README 的版本段；
4. \`mise -C release-test install\`（或直接跑测试让它回退 npm）→ \`node release-test/run.mjs\` 全矩阵 → AI 判定；
5. \`package.json\` 的 \`peerDependencies\`（两个 \`@deepseek-ai/dsh-*\`）**由矩阵生成**：本脚本按声明版本推导「每个 patch 元组一段」的范围（node-semver 的预发布规则要求同元组比较器），不要手改；\`dsh.compatibility.dshReleases\` 仍手工维护，须与矩阵 declared 一致，改完跑 \`node release-test/run.mjs matrix\` 确认「声明偏差」清零。

## 已知声明偏差

${claims.length ? claims.map((claim) => `- ⚠️ ${claim.detail}`).join('\n') : '无：矩阵里每个声明版本都能被当前 `peerDependencies` 匹配。'}
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
  console.log(`peer range: ${peerRange}`)
  for (const artifact of artifacts) {
    fs.mkdirSync(path.dirname(artifact.file), { recursive: true })
    fs.writeFileSync(artifact.file, artifact.content)
    console.log(`wrote ${artifact.label}`)
  }
} else if (mode === 'check') {
  const stale = []
  for (const artifact of artifacts) {
    const current = fs.existsSync(artifact.file) ? fs.readFileSync(artifact.file, 'utf8') : ''
    if (current !== artifact.content) stale.push(artifact.label)
  }
  if (!peerRangeUpToDate()) stale.push('package.json peerDependencies (run --write to sync)')
  if (stale.length) {
    console.error(`out of date: ${stale.join(', ')} — run: node release-test/support-matrix.mjs --write`)
    process.exitCode = 1
  } else {
    console.log('support matrix, mise.toml and both READMEs are up to date')
  }
} else {
  process.stdout.write(doc)
}
