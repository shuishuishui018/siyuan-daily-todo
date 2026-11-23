// 核对 PR 的改动范围与 CI 校验结果
import { execFileSync } from 'node:child_process'

const OWNER = 'shuishuishui018'
const PR = process.argv[2] || '2565'

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
async function api(p) {
  const res = await fetch(`https://api.github.com${p}`, {
    headers: {
      Authorization: `Bearer ${T}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'siyuan-daily-todo-publish',
    },
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, text }
  }
}

const pr = await api(`/repos/siyuan-note/bazaar/pulls/${PR}`)
if (pr.status !== 200) {
  console.log('读取 PR 失败:', pr.status, pr.json?.message)
  process.exit(1)
}
console.log(`PR #${pr.json.number} [${pr.json.state}] ${pr.json.title}`)
console.log(`  改动: +${pr.json.additions} / -${pr.json.deletions} ，${pr.json.changed_files} 个文件`)
console.log(`  可合并: ${pr.json.mergeable === null ? '计算中' : pr.json.mergeable}`)
console.log(`  地址: ${pr.json.html_url}`)

const files = await api(`/repos/siyuan-note/bazaar/pulls/${PR}/files`)
if (Array.isArray(files.json)) {
  for (const f of files.json) {
    console.log(`  文件 ${f.filename}: +${f.additions} -${f.deletions}`)
    if (f.patch) console.log(f.patch.split('\n').slice(0, 12).map((l) => '    ' + l).join('\n'))
  }
}

// 合并状态（含 CI）
const st = await api(`/repos/siyuan-note/bazaar/commits/${pr.json.head.sha}/status`)
console.log(`\n综合状态: ${st.json?.state || '无'}（共 ${st.json?.statuses?.length ?? 0} 项）`)
for (const s of st.json?.statuses || []) {
  console.log(`  - ${s.context}: ${s.state} ${s.description || ''}`)
}
const checks = await api(`/repos/siyuan-note/bazaar/commits/${pr.json.head.sha}/check-runs`)
if (Array.isArray(checks.json?.check_runs)) {
  for (const c of checks.json.check_runs) {
    console.log(`  - [check] ${c.name}: ${c.status}/${c.conclusion || '-'}`)
  }
}
