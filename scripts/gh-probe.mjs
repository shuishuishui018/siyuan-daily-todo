// 探测本机 git 凭据的 GitHub 身份与权限，以及 bazaar 仓库结构
// 只打印非敏感信息，绝不输出 token 本身
import { execFileSync } from 'node:child_process'

function readToken() {
  // 通过 git credential 协议向凭据管理器索取，不落盘、不打印
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split(/\r?\n/).find((l) => l.startsWith('password='))
  if (!line) throw new Error('凭据中没有 password 字段')
  return line.slice('password='.length)
}

async function api(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
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
    /* 非 JSON 响应 */
  }
  return { status: res.status, headers: res.headers, json, text }
}

const token = readToken()
console.log('token 读取成功，长度:', token.length, '前缀:', token.slice(0, 4) + '***')

const me = await api('/user', token)
if (me.status !== 200) {
  console.log('身份校验失败:', me.status, me.json?.message || me.text.slice(0, 200))
  process.exit(1)
}
console.log('登录身份:', me.json.login, '| 名称:', me.json.name || '(未设置)')
console.log('授权范围:', me.headers.get('x-oauth-scopes') || '(未声明)')

const repo = await api('/repos/shuishuishui018/siyuan-daily-todo', token)
console.log('目标仓库是否已存在:', repo.status === 200 ? '是' : `否 (${repo.status})`)

const bazaar = await api('/repos/siyuan-note/bazaar', token)
console.log('bazaar 默认分支:', bazaar.json?.default_branch, '| 状态:', bazaar.status)

const contents = await api('/repos/siyuan-note/bazaar/contents/', token)
if (Array.isArray(contents.json)) {
  console.log('bazaar 根目录 txt 文件:')
  for (const f of contents.json.filter((x) => x.name.endsWith('.txt'))) {
    console.log('  ', f.name, f.size, 'bytes')
  }
} else {
  console.log('读取根目录失败:', contents.status)
}

const pluginsTxt = await api('/repos/siyuan-note/bazaar/contents/plugins.txt', token)
if (pluginsTxt.status === 200) {
  const raw = Buffer.from(pluginsTxt.json.content, 'base64').toString('utf8')
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  console.log(`plugins.txt 共 ${lines.length} 行，末 3 行:`)
  console.log(lines.slice(-3).map((l) => '  ' + l).join('\n'))
  console.log('已包含本插件:', lines.some((l) => l.includes('siyuan-daily-todo')))
} else {
  console.log('plugins.txt 读取失败:', pluginsTxt.status)
}

const fork = await api('/repos/shuishuishui018/bazaar', token)
console.log('是否已有 bazaar fork:', fork.status === 200 ? '是' : `否 (${fork.status})`)
