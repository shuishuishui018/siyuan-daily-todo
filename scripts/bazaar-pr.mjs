// 第 2 步：同步 bazaar fork → 在 plugins.txt 追加一行 → 向 siyuan-note/bazaar 提 PR
// 用法：node scripts/bazaar-pr.mjs --check   （只查看状态，不写入）
//       node scripts/bazaar-pr.mjs           （执行同步、提交、提 PR）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECK_ONLY = process.argv.includes('--check')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const META = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'plugin.json'), 'utf8'))
const VERSION = META.version
const OWNER = 'shuishuishui018'
const PLUGIN_REPO = META.name
const UPSTREAM = 'siyuan-note/bazaar'
const FORK = `${OWNER}/bazaar`
const ENTRY = `${OWNER}/${PLUGIN_REPO}`
const BRANCH = 'main'

function gitEnv() {
  const env = { ...process.env }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    delete env[k]
  }
  return env
}

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: gitEnv(),
  })
  return out.split(/\r?\n/).find((l) => l.startsWith('password=')).slice('password='.length)
}

const T = token()

async function api(p, init = {}) {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${T}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'siyuan-daily-todo-publish',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text }
}

// ---------- 1. fork 状态 ----------
let fork = await api(`/repos/${FORK}`)
if (fork.status !== 200) {
  console.log('未找到 fork，正在创建…')
  const created = await api(`/repos/${UPSTREAM}/forks`, { method: 'POST', body: '{}' })
  if (created.status !== 202 && created.status !== 201) {
    console.error(`创建 fork 失败 ${created.status}: ${created.json?.message}`)
    process.exit(1)
  }
  // 等待 fork 就绪
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    fork = await api(`/repos/${FORK}`)
    if (fork.status === 200) break
  }
}
console.log(`fork: ${FORK} | 默认分支 ${fork.json?.default_branch}`)

// 与上游的差距
const cmp = await api(`/repos/${UPSTREAM}/compare/${BRANCH}...${OWNER}:${BRANCH}`)
if (cmp.status === 200) {
  console.log(
    `与上游差距: 落后 ${cmp.json.behind_by} 个提交，领先 ${cmp.json.ahead_by} 个提交`,
  )
}

// 是否已有同分支的开放 PR
const openPrs = await api(`/repos/${UPSTREAM}/pulls?state=open&head=${OWNER}:${BRANCH}`)
if (Array.isArray(openPrs.json) && openPrs.json.length > 0) {
  console.log('已存在开放的 PR:', openPrs.json.map((p) => `#${p.number} ${p.title}`).join(', '))
}

// ---------- 2. 读取 plugins.txt ----------
let file = await api(`/repos/${FORK}/contents/plugins.txt?ref=${BRANCH}`)
if (file.status !== 200) {
  console.error(`读取 fork 的 plugins.txt 失败: ${file.status}`)
  process.exit(1)
}
const raw = Buffer.from(file.json.content, 'base64').toString('utf8')
const lines = raw.split('\n')
const present = lines.map((l) => l.trim()).includes(ENTRY)
console.log(`plugins.txt 现有 ${lines.filter((l) => l.trim()).length} 行 | 已包含本插件: ${present}`)

if (CHECK_ONLY) {
  console.log('\n--check 模式，未做任何写入')
  process.exit(0)
}

// ---------- 3. 同步 fork（落后上游时用 merge-upstream）----------
if (cmp.status === 200 && cmp.json.behind_by > 0) {
  console.log(`同步 fork：落后 ${cmp.json.behind_by} 个提交，调用 merge-upstream…`)
  const merged = await api(`/repos/${FORK}/merge-upstream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: BRANCH }),
  })
  if (merged.status === 200) {
    console.log('  同步完成:', merged.json?.merge_type || 'ok')
    file = await api(`/repos/${FORK}/contents/plugins.txt?ref=${BRANCH}`)
  } else {
    console.log(`  同步返回 ${merged.status}: ${merged.json?.message || ''}（继续尝试后续步骤）`)
  }
}

// ---------- 4. 追加并提交 ----------
if (present) {
  console.log('plugins.txt 已包含该插件，跳过提交')
} else {
  const text = Buffer.from(file.json.content, 'base64').toString('utf8')
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const next = text.replace(/\s*$/, '') + nl + ENTRY + nl
  const put = await api(`/repos/${FORK}/contents/plugins.txt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Add ${ENTRY}`,
      content: Buffer.from(next, 'utf8').toString('base64'),
      sha: file.json.sha,
      branch: BRANCH,
    }),
  })
  if (put.status !== 200 && put.status !== 201) {
    console.error(`提交失败 ${put.status}: ${put.json?.message || put.text.slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`已提交: ${put.json.commit.sha.slice(0, 7)} — Add ${ENTRY}`)
}

// ---------- 5. 提 PR ----------
const existing = await api(`/repos/${UPSTREAM}/pulls?state=open&head=${OWNER}:${BRANCH}`)
if (Array.isArray(existing.json) && existing.json.length > 0) {
  const p = existing.json[0]
  console.log(`PR 已存在: #${p.number} ${p.html_url}`)
  process.exit(0)
}

const body = [
  '新增插件：**每日待办 / Daily Todo**',
  '',
  `- 仓库：https://github.com/${OWNER}/${PLUGIN_REPO}`,
  `- Release：https://github.com/${OWNER}/${PLUGIN_REPO}/releases/tag/v1.0.0`,
  '- `plugin.json` 与 `package.zip` 均在根目录，`frontends: ["all"]`（桌面端与手机端均可使用）',
  '',
  '### 功能简介',
  '把每日待办清单直接内嵌进思源文档正文：打开「每日待办」下的文档，清单出现在正文顶部，',
  '自动生成当天待办、未完成自动结转、可从工作日志提取 `- [ ]` 任务、打勾立即写回笔记，',
  '支持 `@+2d` / `@2026-12-01` 延后提醒。',
  '',
  '### 校验',
  '- `icon.png` 160×160 / 19.6 KB（< 64 KiB）',
  '- `preview.png` 1024×768 / 144 KB（< 512 KiB）',
  '- `package.zip` 10 个文件，`plugin.json` 位于压缩包根目录',
  `- 版本 ${VERSION}，与 Release tag v${VERSION} 一致`,
].join('\n')

const pr = await api(`/repos/${UPSTREAM}/pulls`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: `Add plugin: 每日待办 (${ENTRY})`,
    head: `${OWNER}:${BRANCH}`,
    base: BRANCH,
    body,
  }),
})
if (pr.status === 201) {
  console.log(`PR 已创建: #${pr.json.number} ${pr.json.html_url}`)
} else {
  console.error(`PR 创建失败 ${pr.status}: ${pr.json?.message || pr.text.slice(0, 400)}`)
  if (pr.json?.errors) console.error(JSON.stringify(pr.json.errors))
  process.exit(1)
}
