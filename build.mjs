import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(process.argv[2] || path.join(here, 'dist'))

fs.mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [path.join(here, 'src', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  external: ['siyuan'],
  outfile: path.join(outDir, 'index.js'),
  loader: { '.css': 'text' },
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})

const statics = ['plugin.json', 'README.md', 'README.zh-CN.md', 'icon.png', 'preview.png', 'LICENSE']
for (const file of statics) {
  const from = path.join(here, file)
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, file))
}

// README 里引用的图片（打赏二维码等）必须随包分发，否则离线集市会断图
const assetsDir = path.join(here, 'assets')
if (fs.existsSync(assetsDir)) {
  const images = fs
    .readdirSync(assetsDir)
    .filter((file) => /\.(png|jpe?g|webp|avif)$/i.test(file))
  if (images.length) {
    const target = path.join(outDir, 'assets')
    fs.mkdirSync(target, { recursive: true })
    for (const file of images) {
      fs.copyFileSync(path.join(assetsDir, file), path.join(target, file))
    }
  }
}

const i18nDir = path.join(here, 'src', 'i18n')
if (fs.existsSync(i18nDir)) {
  const target = path.join(outDir, 'i18n')
  fs.mkdirSync(target, { recursive: true })
  for (const file of fs.readdirSync(i18nDir)) {
    const from = path.join(i18nDir, file)
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(target, file))
  }
}

console.log(`built -> ${outDir}`)
