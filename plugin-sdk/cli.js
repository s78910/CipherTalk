#!/usr/bin/env node
/**
 * CipherTalk 插件脚手架 CLI（零依赖，Node 18+）。
 *
 * 用法：
 *   node cli.js init <目录>     创建插件项目骨架
 *   node cli.js pack [目录]     校验 manifest 并打包为 <id>-<version>.ctp
 *
 * 发布到 npm 后即为：npx ciphertalk-plugin init/pack
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const KNOWN_PERMISSIONS = [
  'sessions:read', 'contacts:read', 'messages:read', 'clipboard:write',
  'media:read', 'stt:use', 'search:use', 'stats:read', 'export:use',
  'notify:send', 'window:create', 'sns:read', 'ai:use', 'network',
]
const API_VERSION = 1

function fail(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`)
  process.exit(1)
}

function ok(message) {
  console.log(`\x1b[32m✓ ${message}\x1b[0m`)
}

/** 与宿主 pluginManagerService.validateManifest 保持一致的校验规则 */
function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'manifest.json 不是对象'
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(m.id)) {
    return 'id 缺失或不合法（小写字母/数字/点/连字符，2-64 位，建议反域名式如 com.you.name）'
  }
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name 缺失'
  if (typeof m.version !== 'string' || !m.version.trim()) return 'version 缺失'
  if (m.apiVersion !== API_VERSION) return `apiVersion 必须为 ${API_VERSION}`

  const author = m.author
  if (!author || typeof author !== 'object' || typeof author.name !== 'string' || !author.name.trim()) {
    return 'author.name（开发者名称）必填'
  }
  if (author.name.trim().length > 64) return 'author.name 过长（最多 64 字符）'
  if (author.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(author.email))) {
    return 'author.email 格式不合法'
  }
  if (author.url !== undefined && !/^https?:\/\//.test(String(author.url))) {
    return 'author.url 须为 http(s) 地址'
  }

  const permissions = m.permissions ?? []
  if (!Array.isArray(permissions)) return 'permissions 必须是数组'
  const unknown = permissions.filter((p) => !KNOWN_PERMISSIONS.includes(p))
  if (unknown.length > 0) return `包含宿主不支持的权限：${unknown.join(', ')}`

  const views = (m.contributes && m.contributes.views) || {}
  for (const [key, view] of Object.entries(views)) {
    if (!view || typeof view.entry !== 'string') return `views.${key} 缺少 entry`
    const entry = view.entry.replace(/\\/g, '/')
    if (path.isAbsolute(entry) || entry.split('/').includes('..')) {
      return `views.${key}.entry 必须是插件目录内的相对路径`
    }
    return null // entry 存在性在 pack 时按文件检查
  }
  return null
}

// ===== 最小 ZIP 写入器（STORE/DEFLATE，无第三方依赖） =====

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeZip(outPath, files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const deflated = zlib.deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)               // version needed
    local.writeUInt16LE(0x0800, 6)           // UTF-8 flag
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10)               // dos time/date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(0, 12)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cen, nameBuf]))

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, end]))
}

// ===== pack =====

const DEFAULT_EXCLUDES = new Set(['node_modules', '.git', '.DS_Store', 'dist-pack'])

function collectFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DEFAULT_EXCLUDES.has(entry.name)) continue
    if (entry.name.endsWith('.ctp') || entry.name.endsWith('.map')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectFiles(full, base))
    else out.push({ name: path.relative(base, full).replace(/\\/g, '/'), data: fs.readFileSync(full) })
  }
  return out
}

function pack(dirArg) {
  const dir = path.resolve(dirArg || '.')
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) fail(`找不到 ${manifestPath}`)

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    fail(`manifest.json 解析失败:${e.message}`)
  }
  const error = validateManifest(manifest)
  if (error) fail(`manifest 校验失败:${error}`)

  // 视图 entry 文件必须存在
  const views = (manifest.contributes && manifest.contributes.views) || {}
  for (const [key, view] of Object.entries(views)) {
    if (!fs.existsSync(path.join(dir, view.entry))) {
      fail(`views.${key} 的入口文件不存在:${view.entry}`)
    }
  }

  const files = collectFiles(dir)
  if (!files.some((f) => f.name === 'manifest.json')) fail('打包内容缺少 manifest.json')

  const outName = `${manifest.id}-${manifest.version}.ctp`
  const outPath = path.join(path.dirname(dir), outName)
  writeZip(outPath, files)
  const size = (fs.statSync(outPath).size / 1024).toFixed(1)
  ok(`已打包 ${files.length} 个文件 → ${outPath}（${size} KB）`)
  console.log('  在 CipherTalk 中通过 设置 → 插件 → 安装插件 导入即可。')
}

// ===== init =====

/** 一次性读完 stdin 的所有行；管道/交互都可靠（避免 readline 在管道下丢行） */
function readAllLines() {
  return new Promise((resolve) => {
    let buf = ''
    if (process.stdin.isTTY) {
      // 交互终端：逐行读，收到足够行即返回
      process.stdin.setEncoding('utf-8')
      process.stdin.on('data', (chunk) => { buf += chunk })
      process.stdin.on('end', () => resolve(buf.split(/\r?\n/)))
      // 交互下用户按 Ctrl-D 结束；实践中脚手架多用管道，这里兜底
    } else {
      process.stdin.setEncoding('utf-8')
      process.stdin.on('data', (chunk) => { buf += chunk })
      process.stdin.on('end', () => resolve(buf.split(/\r?\n/)))
    }
  })
}

async function init(dirArg) {
  const dir = path.resolve(dirArg || '.')
  if (fs.existsSync(path.join(dir, 'manifest.json'))) fail(`${dir} 已存在 manifest.json`)

  const defaultId = `com.example.${path.basename(dir).toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`
  console.log('请依次输入（每行一个，可用管道提供）：插件 id、插件名称、开发者名称（必填）、联系邮箱（可留空）')

  const lines = await readAllLines()
  const pick = (i, fallback) => (lines[i] !== undefined && lines[i].trim()) || fallback || ''
  const id = pick(0, defaultId)
  const name = pick(1, path.basename(dir))
  const authorName = pick(2, '')
  if (!authorName) fail('开发者名称必填')
  const authorEmail = pick(3, '')

  fs.mkdirSync(dir, { recursive: true })

  const manifest = {
    id,
    name,
    version: '1.0.0',
    description: '',
    apiVersion: API_VERSION,
    author: { name: authorName, ...(authorEmail ? { email: authorEmail } : {}) },
    permissions: ['sessions:read', 'messages:read'],
    contributes: {
      sidebarMenus: [{ id: 'main', label: name, icon: 'puzzle', view: 'index' }],
      views: { index: { entry: 'index.html' } },
    },
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${name}</title>
  <style>body { padding: 24px; }</style>
</head>
<body>
  <h2 class="ct-title">${name}</h2>
  <p class="ct-hint" id="status">连接中…</p>
  <script type="module" src="./main.js"></script>
</body>
</html>
`)
  fs.writeFileSync(path.join(dir, 'main.js'), `import { connect } from './ciphertalk-plugin-sdk.js'

const api = await connect()
const { sessions } = await api.data.sessions.list({ limit: 20 })
document.getElementById('status').textContent = \`已连接，读取到 \${sessions.length} 个会话\`
`)
  const sdkSrc = path.join(__dirname, 'ciphertalk-plugin-sdk.js')
  if (fs.existsSync(sdkSrc)) {
    fs.copyFileSync(sdkSrc, path.join(dir, 'ciphertalk-plugin-sdk.js'))
    const dtsSrc = path.join(__dirname, 'ciphertalk-plugin-sdk.d.ts')
    if (fs.existsSync(dtsSrc)) fs.copyFileSync(dtsSrc, path.join(dir, 'ciphertalk-plugin-sdk.d.ts'))
  } else {
    console.warn('! 未找到 SDK 文件，请手动复制 ciphertalk-plugin-sdk.js 到插件目录')
  }

  ok(`插件骨架已创建:${dir}`)
  console.log(`  开发：CipherTalk 设置 → 插件 → 开发者模式 → 加载本地插件目录
  打包：node ${path.relative(process.cwd(), __filename)} pack ${dirArg || '.'}`)
}

// ===== main =====

const [, , command, arg] = process.argv
if (command === 'pack') {
  pack(arg)
} else if (command === 'init') {
  init(arg).catch((e) => fail(String(e)))
} else {
  console.log(`CipherTalk 插件脚手架

用法：
  node cli.js init <目录>    创建插件项目骨架（交互式填写开发者信息）
  node cli.js pack [目录]    校验 manifest 并打包为 <id>-<version>.ctp`)
  process.exit(command ? 1 : 0)
}
