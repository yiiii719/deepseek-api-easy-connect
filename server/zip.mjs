// 最小 ZIP 读取（docx/xlsx/pptx 都是 zip）：只解析中央目录 + inflateRaw，不引入依赖
import zlib from 'node:zlib'

export function readZip(buf) {
  // 找 EOCD
  let eocd = -1
  const minPos = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method, compSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name)
      if (!e) return null
      const lp = e.localOffset
      if (buf.readUInt32LE(lp) !== 0x04034b50) return null
      const nameLen = buf.readUInt16LE(lp + 26)
      const extraLen = buf.readUInt16LE(lp + 28)
      const start = lp + 30 + nameLen + extraLen
      const raw = buf.subarray(start, start + e.compSize)
      if (e.method === 0) return raw
      if (e.method === 8) return zlib.inflateRawSync(raw)
      return null
    },
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[g] ?? m
  })
}

/** WordprocessingML → 纯文本（保留段落/表格分隔） */
export function docxText(buf) {
  const zip = readZip(buf)
  const xml = zip.read('word/document.xml')
  if (!xml) throw new Error('docx 里没有 word/document.xml')
  const s = xml.toString('utf8')
  return decodeEntities(
    s
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** xlsx → 逐表 TSV */
export function xlsxText(buf) {
  const zip = readZip(buf)
  const sharedXml = zip.read('xl/sharedStrings.xml')?.toString('utf8') || ''
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, '')),
  )
  const out = []
  for (const name of zip.names()) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue
    const xml = zip.read(name)?.toString('utf8') || ''
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)]
    out.push(`### ${name.replace('xl/worksheets/', '').replace('.xml', '')}`)
    for (const r of rows) {
      const cells = [...r[1].matchAll(/<c[^>]*?(?:\st="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)].map((c) => {
        const t = c[1]
        const vTag = c[2].match(/<v>([\s\S]*?)<\/v>/)
        if (!vTag) {
          const isTag = c[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)
          return isTag ? decodeEntities(isTag[1]) : ''
        }
        const v = vTag[1]
        return t === 's' ? shared[Number(v)] ?? '' : v
      })
      if (cells.some((c) => c !== '')) out.push(cells.join('\t'))
    }
    out.push('')
  }
  return out.join('\n').trim()
}

/** pptx → 每页文本 */
export function pptxText(buf) {
  const zip = readZip(buf)
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const out = []
  for (const s of slides) {
    const xml = zip.read(s)?.toString('utf8') || ''
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeEntities(m[1]))
    out.push(`## 第 ${Number(s.match(/\d+/)[0])} 页\n` + texts.join('\n'))
  }
  return out.join('\n\n').trim()
}
