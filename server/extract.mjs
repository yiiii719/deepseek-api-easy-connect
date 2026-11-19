// 附件正文抽取：txt/md/csv/json/代码 · docx · xlsx · pptx · pdf
import zlib from 'node:zlib'
import { docxText, xlsxText, pptxText } from './zip.mjs'

const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|csv|tsv|log|ini|conf|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|kt|go|rs|c|h|cpp|hpp|cs|php|rb|sh|bash|ps1|sql|toml|env)$/i

export function extractText(name, mime, buf) {
  const lower = (name || '').toLowerCase()
  const size = buf.length
  try {
    if (lower.endsWith('.pdf') || mime === 'application/pdf') return { text: pdfText(buf), kind: 'pdf' }
    if (lower.endsWith('.docx')) return { text: docxText(buf), kind: 'docx' }
    if (lower.endsWith('.xlsx')) return { text: xlsxText(buf), kind: 'xlsx' }
    if (lower.endsWith('.pptx')) return { text: pptxText(buf), kind: 'pptx' }
    if (TEXT_EXT.test(lower) || mime?.startsWith('text/') || mime === 'application/json') {
      return { text: buf.toString('utf8').replace(/\u0000/g, ''), kind: 'text' }
    }
    // 未知类型：能当文本读就试一下，NUL 太多就放弃
    const guess = buf.toString('utf8')
    const nul = (guess.match(/\u0000/g) || []).length
    if (size < 2_000_000 && nul / Math.max(1, guess.length) < 0.01) return { text: guess, kind: 'guess' }
    return { text: '', kind: 'binary', error: '二进制格式（如 .doc/.xls/图片）暂不支持解析，请另存为 docx/xlsx/pdf/txt' }
  } catch (e) {
    return { text: '', kind: 'error', error: `解析失败：${e.message}` }
  }
}

/** 朴素 PDF 抽取：解 FlateDecode 流 → 抓 Tj/TJ 文本。对中文 CID 字体无能为力，属已知取舍。 */
export function pdfText(buf) {
  const raw = buf.toString('latin1')
  const out = []
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    const slice = Buffer.from(raw.slice(start, end), 'latin1')
    let data = null
    try {
      data = zlib.inflateSync(slice)
    } catch {
      try {
        data = zlib.inflateRawSync(slice)
      } catch {
        continue
      }
    }
    const s = data.toString('latin1')
    if (!/(Tj|TJ)/.test(s)) continue
    for (const seg of s.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\][]|\\.)*\]\s*TJ/g)) {
      const chunk = seg[0]
      const parts = [...chunk.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((p) => unescapePdf(p[0].slice(1, -1)))
      if (parts.length) out.push(parts.join(''))
    }
    if (out.length > 4000) break
  }
  return out.join(' ').replace(/\s{2,}/g, ' ').trim()
}

function unescapePdf(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' })[c])
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
}

/** 附件拼进 prompt：限制总量，避免把上下文塞爆 */
export function buildAttachmentContext(atts, maxChars = 24_000) {
  if (!atts?.length) return ''
  let budget = maxChars
  const blocks = []
  for (const a of atts) {
    if (budget <= 0) break
    const t = String(a.text || '').slice(0, budget)
    budget -= t.length
    blocks.push(`<file name="${a.name}">\n${t}\n</file>`)
  }
  return blocks.length ? `以下是用户上传的文件内容，请以此为事实依据回答：\n\n${blocks.join('\n\n')}` : ''
}
