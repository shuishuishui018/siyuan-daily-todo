// 把 dist/ 打成 package.zip，zip 根目录直接是插件文件（不能多一层父目录）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const distDir = path.join(root, 'dist')
const outFile = path.resolve(process.argv[2] || path.join(root, 'package.zip'))

if (!fs.existsSync(distDir)) {
  console.error('dist/ 不存在，先运行 npm run build')
  process.exit(1)
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 收集 dist 下所有文件，返回 { name, data }，name 用正斜杠相对路径 */
function walk(dir, prefix = '') {
  const entries = []
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, item.name)
    const name = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) entries.push(...walk(full, name))
    else if (item.isFile()) entries.push({ name, data: fs.readFileSync(full) })
  }
  return entries
}

const files = walk(distDir)
if (!files.some((f) => f.name === 'plugin.json')) {
  console.error('dist/plugin.json 缺失，包结构不正确')
  process.exit(1)
}

// 固定时间戳，保证同样输入产出同样字节
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

const localParts = []
const centralParts = []
let offset = 0

for (const file of files) {
  const raw = file.data
  const deflated = zlib.deflateRawSync(raw, { level: 9 })
  const useDeflate = deflated.length < raw.length
  const body = useDeflate ? deflated : raw
  const method = useDeflate ? 8 : 0
  const crc = crc32(raw)
  const nameBuf = Buffer.from(file.name, 'utf8')

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(DOS_TIME, 10)
  local.writeUInt16LE(DOS_DATE, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)

  localParts.push(local, nameBuf, body)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(DOS_TIME, 12)
  central.writeUInt16LE(DOS_DATE, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)

  centralParts.push(central, nameBuf)
  offset += local.length + nameBuf.length + body.length
}

const centralBuf = Buffer.concat(centralParts)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(files.length, 8)
eocd.writeUInt16LE(files.length, 10)
eocd.writeUInt32LE(centralBuf.length, 12)
eocd.writeUInt32LE(offset, 16)
eocd.writeUInt16LE(0, 20)

fs.writeFileSync(outFile, Buffer.concat([...localParts, centralBuf, eocd]))

const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(1)
console.log(`packed ${files.length} files -> ${outFile} (${sizeKb} KB)`)
for (const file of files) console.log(`  ${file.name}`)
