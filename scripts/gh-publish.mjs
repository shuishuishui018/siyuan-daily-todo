// 第 1 步：创建 GitHub 仓库 → 推送 main → 创建 Release 并上传 package.zip
// 幂等：仓库已存在则跳过创建；Release 已存在则只补传附件
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const OWNER = 'shuishuishui018'
const REPO = 'siyuan-daily-todo'
const FULL = `${OWNER}/${REPO}`

const meta = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'))
const VERSION = meta.version
const TAG = `v${VERSION}`
const ZIP = path.join(root, 'package.zip')

// 本机 HTTP(S)_PROXY 对 github.com 的 CONNECT 隧道会返回 502，
// git 走代理必然失败；调用 git 时统一剔除代理环境变量
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

async function api(p, init = {}, raw = false) {
  const res = await fetch(raw ? p : `https://api.github.com${p}`, {
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

// ---------- 1. 仓库 ----------
let r = await api(`/repos/${FULL}`)
if (r.status === 200) {
  console.log(`[1/3] 仓库已存在: ${r.json.html_url}`)
} else {
  r = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO,
      description: meta.description['zh-CN'],
      homepage: `https://github.com/${FULL}`,
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  if (r.status !== 201) {
    console.error(`[1/3] 创建失败 ${r.status}: ${r.json?.message || r.text.slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`[1/3] 仓库已创建: ${r.json.html_url}`)
}

// ---------- 2. 推送 ----------
const remoteUrl = `https://github.com/${FULL}.git`
const remotes = execFileSync('git', ['remote'], { cwd: root, encoding: 'utf8', env: gitEnv() }).split(/\r?\n/)
if (!remotes.includes('origin')) {
  execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: root, env: gitEnv() })
} else {
  execFileSync('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: root, env: gitEnv() })
}

try {
  const out = execFileSync('git', ['push', '-u', 'origin', 'main'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: gitEnv(),
  })
  console.log('[2/3] 推送成功')
  if (out.trim()) console.log('     ' + out.trim().split('\n').slice(-1)[0])
} catch (err) {
  const detail = (err.stderr || err.message || '').toString()
  // 已是最新时不视为失败
  if (/Everything up-to-date|up to date/i.test(detail)) {
    console.log('[2/3] 远端已是最新')
  } else {
    console.error('[2/3] 推送失败:')
    console.error(detail.slice(0, 800))
    process.exit(1)
  }
}

// ---------- 3. Release ----------
let rel = await api(`/repos/${FULL}/releases/tags/${TAG}`)
if (rel.status === 200) {
  console.log(`[3/3] Release ${TAG} 已存在`)
} else {
  const body = [
    '## 每日待办 v' + VERSION,
    '',
    '把每日待办清单直接内嵌进思源文档：打开「每日待办」下的文档，清单出现在正文顶部。',
    '',
    '### 功能',
    '- 自动生成当天清单，未完成项自动结转到次日',
    '- 从工作日志提取 `- [ ]` 任务',
    '- 打勾立即写回笔记，保留历史归档',
    '- 支持延后提醒（`@+2d`、`@2026-12-01`）',
    '- 面板注入文档正文，**桌面端与手机端共用同一套渲染**',
    '',
    '### 安装',
    '集市搜索「每日待办」，或从本 Release 下载 `package.zip` 解压到工作空间 `data/plugins/siyuan-daily-todo/`。',
    '',
    '完整说明见 [README](https://github.com/' + FULL + '#使用)。',
  ].join('\n')

  rel = await api(`/repos/${FULL}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      target_commitish: 'main',
      name: `v${VERSION}`,
      body,
      draft: false,
      prerelease: false,
    }),
  })
  if (rel.status !== 201) {
    console.error(`[3/3] 创建 Release 失败 ${rel.status}: ${rel.json?.message || rel.text.slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`[3/3] Release 已创建: ${rel.json.html_url}`)
}

const assets = await api(`/repos/${FULL}/releases/${rel.json.id}/assets`)
const already = Array.isArray(assets.json) && assets.json.some((a) => a.name === 'package.zip')
if (already) {
  console.log('      package.zip 附件已存在，跳过上传')
} else {
  const buf = fs.readFileSync(ZIP)
  const up = await api(
    `https://uploads.github.com/repos/${FULL}/releases/${rel.json.id}/assets?name=package.zip`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) },
      body: buf,
    },
    true,
  )
  if (up.status === 201) {
    console.log(`      package.zip 已上传: ${Math.round(up.json.size / 1024)} KB`)
  } else {
    console.error(`      上传失败 ${up.status}: ${up.json?.message || up.text.slice(0, 300)}`)
    process.exit(1)
  }
}

console.log(`\n完成: https://github.com/${FULL}/releases/tag/${TAG}`)
