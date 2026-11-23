// 一键完成上架前配置：填 GitHub 信息 → 加打赏二维码 → 构建 → 打包
//
// 用法：
//   node scripts/setup-publish.mjs --owner <GitHub用户名>
//   node scripts/setup-publish.mjs --owner <GitHub用户名> --author "显示名"
//   node scripts/setup-publish.mjs --owner <GitHub用户名> --sponsor "D:\path\收款码.png"
//
// 幂等：重复执行只会覆盖同样的内容，不会重复插入打赏章节。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback
}

function fail(message) {
  console.error(`\n[错误] ${message}\n`)
  process.exit(1)
}

const owner = arg('owner')
const author = arg('author', owner)
const sponsor = arg('sponsor')

if (!owner) {
  fail(
    '缺少 --owner\n\n' +
      '  用法: node scripts/setup-publish.mjs --owner <你的GitHub用户名> [--sponsor "收款码图片路径"]\n\n' +
      '  示例: node scripts/setup-publish.mjs --owner octocat --sponsor "C:\\Users\\Admin\\Desktop\\微信收款码.png"',
  )
}

// GitHub 用户名：1-39 位，字母数字与连字符，不能以连字符开头结尾
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  fail(`GitHub 用户名不合法: "${owner}"（只能是字母、数字、单个连字符，且不以连字符开头结尾）`)
}

// ---------- 1. 更新 plugin.json ----------

const metaPath = path.join(root, 'plugin.json')
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))

meta.author = author
meta.url = `https://github.com/${owner}/${meta.name}`
meta.funding = meta.funding || { custom: [] }

fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
console.log(`[1/5] plugin.json  ->  author="${meta.author}"  url="${meta.url}"`)

// ---------- 2. 打赏二维码 ----------

const SPONSOR_IMG = 'assets/sponsor-wechat.png'
const SPONSOR_IMG_ABS = path.join(root, SPONSOR_IMG)
const START = '<!-- sponsor:start -->'
const END = '<!-- sponsor:end -->'

if (sponsor) {
  if (!fs.existsSync(sponsor)) fail(`找不到收款码图片: ${sponsor}`)
  const ext = path.extname(sponsor).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    fail(`不支持的图片格式 ${ext}，请使用 png / jpg / webp`)
  }

  fs.mkdirSync(path.dirname(SPONSOR_IMG_ABS), { recursive: true })

  if (ext === '.png') {
    fs.copyFileSync(sponsor, SPONSOR_IMG_ABS)
  } else {
    // 集市要求 png/jpeg/webp，非 png 就重命名并同步改引用
    const target = path.join(root, `assets/sponsor-wechat${ext}`)
    fs.copyFileSync(sponsor, target)
    if (fs.existsSync(SPONSOR_IMG_ABS)) fs.unlinkSync(SPONSOR_IMG_ABS)
  }

  const imgRef = fs.existsSync(SPONSOR_IMG_ABS)
    ? SPONSOR_IMG
    : `assets/sponsor-wechat${ext}`

  const blocks = {
    'README.zh-CN.md': [
      START,
      '## 支持作者',
      '',
      '如果这个插件帮你省了点事，可以请我喝杯咖啡。你的支持是它继续维护下去的动力。',
      '',
      '<p align="center">',
      `  <img src="${imgRef}" alt="微信赞赏码" width="260" />`,
      '</p>',
      '',
      '也欢迎在集市给个好评，或者提 issue 告诉我哪里不好用。',
      END,
      '',
    ].join('\n'),
    'README.md': [
      START,
      '## Support',
      '',
      'If this plugin saves you some time, you can buy me a coffee. Your support keeps it maintained.',
      '',
      '<p align="center">',
      `  <img src="${imgRef}" alt="WeChat tip code" width="260" />`,
      '</p>',
      '',
      'A rating in the marketplace or an issue report is just as welcome.',
      END,
      '',
    ].join('\n'),
  }

  const anchors = { 'README.zh-CN.md': '## 许可证', 'README.md': '## License' }

  for (const [file, block] of Object.entries(blocks)) {
    const filePath = path.join(root, file)
    if (!fs.existsSync(filePath)) {
      console.warn(`[警告] 缺少 ${file}，跳过打赏章节`)
      continue
    }
    let text = fs.readFileSync(filePath, 'utf8')

    const existing = new RegExp(`${START}[\\s\\S]*?${END}\\n?`, 'm')
    if (existing.test(text)) {
      text = text.replace(existing, `${block}\n`)
    } else {
      const anchor = anchors[file]
      const at = text.indexOf(anchor)
      if (at === -1) text = `${text.trimEnd()}\n\n${block}\n`
      else text = `${text.slice(0, at)}${block}\n${text.slice(at)}`
    }

    fs.writeFileSync(filePath, text, 'utf8')
    console.log(`[2/5] ${file}     ->  已插入打赏章节`)
  }

  // funding 指向二维码承载页（README），集市里显示为赞助入口
  meta.funding.custom = [`https://github.com/${owner}/${meta.name}#support`]
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  console.log(`[2/5] funding.custom -> ${meta.funding.custom[0]}`)
} else {
  console.log('[2/5] 未提供 --sponsor，跳过打赏章节（之后可单独补）')
}

// ---------- 3 & 4. 构建 + 打包 ----------

console.log('[3/5] 构建中…')
execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'inherit' })

console.log('[4/5] 打包中…')
execFileSync(process.execPath, [path.join(root, 'scripts', 'pack.mjs')], { cwd: root, stdio: 'inherit' })

// ---------- 5. git 身份 + 首次提交 ----------

console.log('[5/5] 准备 git…')
try {
  execFileSync('git', ['config', 'user.name', author], { cwd: root })
  execFileSync('git', ['config', 'user.email', `${owner}@users.noreply.github.com`], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })

  let hasCommit = true
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'ignore' })
  } catch {
    hasCommit = false
  }

  const message = `feat: daily todo plugin v${meta.version}`
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: root, stdio: 'pipe' })
  console.log(`      git commit ok (${hasCommit ? '追加提交' : '首次提交'}): ${message}`)
} catch (err) {
  console.warn(`[警告] git 步骤失败: ${err.message.split('\n')[0]}`)
}

console.log(`
============================================================
 完成。下面三条命令把仓库推上 GitHub（在 GitHub 新建空仓库
 ${meta.name} 之后执行，不要勾选初始化 README）：
============================================================
  git remote add origin https://github.com/${owner}/${meta.name}.git
  git push -u origin main
  # 然后到 Releases 新建 v${meta.version}，上传 package.zip
============================================================
 接着 fork github.com/siyuan-note/bazaar，在 plugins.txt 末尾加一行：
  ${owner}/${meta.name}
 再提 PR 即可。详细步骤见 RELEASE.md。
`)
