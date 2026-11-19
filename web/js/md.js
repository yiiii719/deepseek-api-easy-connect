// 轻量 Markdown 渲染器（无依赖，专为流式增量渲染优化）
// 支持：标题/列表(嵌套)/引用/表格/分割线/围栏代码(带高亮+复制)/行内代码/粗斜删/链接/图片/公式/引用角标

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC_MAP[c])
const escAttr = (s) => esc(s).replace(/'/g, '&#39;')

/* ───────────────── 代码高亮 ───────────────── */

const KW = {
  js: 'await async break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of return set static super switch this throw try typeof var void while with yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self',
  sh: 'if then else elif fi for while do done case esac function return export local readonly declare source alias unset shift set trap in',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var val fun object when',
  sql: 'select from where insert into values update set delete create table drop alter add index on join left right inner outer group by order having limit offset as and or not null primary key distinct union all count sum avg min max case when then else end',
  json: 'true false null',
  css: 'important media supports keyframes import from to and not only',
  yaml: 'true false null yes no on off',
  toml: 'true false',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual override namespace template typename using new delete nullptr true false',
  php: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
  rb: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield attr_accessor require',
}
const lazy = (s) => s // 便于阅读

const TYPES = 'String Number Boolean Object Array Promise Map Set Date RegExp Error Function Symbol BigInt Buffer Response Request URL JSON Math console window document process globalThis require module exports React useState useEffect HTMLDivElement HTMLElement NodeList Intl i32 u32 f64 usize isize Vec Option Result Box Rc Arc HashMap'

function buildSpec(lang) {
  const kwSet = KW[lang] || KW.js
  const kwRe = `\\b(?:${kwSet.split(/\s+/).filter(Boolean).join('|')})\\b`
  const typeRe = `\\b(?:${TYPES.split(/\s+/).filter(Boolean).join('|')})\\b`
  const numRe = `\\b(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b`
  const fnRe = `\\b[A-Za-z_$][\\w$]*(?=\\s*\\()`
  const strJS = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + '`(?:\\\\.|[^`\\\\])*`'
  let commentRe
  let strRe = strJS
  switch (lang) {
    case 'py':
      commentRe = '#[^\\n]*'
      strRe = `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|` + strJS
      break
    case 'sh':
      commentRe = '(?:^|\\s)#[^\\n]*'
      strRe = strJS
      break
    case 'html':
    case 'xml':
      commentRe = '<!--[\\s\\S]*?-->'
      strRe = strJS
      break
    case 'css':
      commentRe = '\\/\\*[\\s\\S]*?\\*\\/'
      strRe = strJS
      break
    case 'sql':
      commentRe = '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'
      break
    case 'json':
      commentRe = '\\/\\/[^\\n]*'
      break
    default:
      commentRe = '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'
  }
  const parts = [
    ['c', commentRe],
    ['s', strRe],
    ['n', numRe],
    ['k', kwRe],
    ['t', typeRe],
    ['f', fnRe],
  ]
  return {
    // 每类都包一层捕获组（内部一律用 (?:...) 保证组号不串），这样才能判断命中类型
    re: new RegExp(parts.map(([, r]) => `(${r})`).join('|'), 'g'),
    count: parts.length,
    classes: parts.map(([c]) => c),
  }
}

const SPECS = new Map()
function specFor(lang) {
  const key = lang || 'js'
  if (!SPECS.has(key)) SPECS.set(key, buildSpec(key))
  return SPECS.get(key)
}

export function highlight(code, lang) {
  const normalized = String(lang || '').toLowerCase()
  const alias = {
    javascript: 'js',
    typescript: 'js',
    ts: 'js',
    jsx: 'js',
    tsx: 'js',
    node: 'js',
    mjs: 'js',
    python: 'py',
    py3: 'py',
    bash: 'sh',
    shell: 'sh',
    zsh: 'sh',
    console: 'sh',
    powershell: 'sh',
    ps1: 'sh',
    golang: 'go',
    rs: 'rust',
    kt: 'java',
    kotlin: 'java',
    csharp: 'java',
    cs: 'java',
    cpp: 'c',
    'c++': 'c',
    h: 'c',
    hpp: 'c',
    html: 'html',
    xml: 'html',
    vue: 'html',
    svelte: 'html',
    scss: 'css',
    less: 'css',
    yml: 'yaml',
    md: 'default',
    markdown: 'default',
    text: 'default',
    txt: 'default',
  }[normalized] || normalized

  if (alias === 'default' || !alias) return esc(code)
  const spec = specFor(alias)
  let out = ''
  let last = 0
  let m
  spec.re.lastIndex = 0
  while ((m = spec.re.exec(code))) {
    if (m.index > last) out += esc(code.slice(last, m.index))
    let cls = 'tok-f'
    for (let i = 1; i <= spec.count; i++) {
      if (m[i] !== undefined) {
        cls = `tok-${spec.classes[i - 1]}`
        break
      }
    }
    // 被替换组（非捕获）无法判定时按匹配到的字符猜一下
    const text = m[0]
    if (/^(\/\/|\/\*|#|--|<!--)/.test(text)) cls = 'tok-c'
    else if (/^["'`]/.test(text)) cls = 'tok-s'
    else if (/^\d|^0x/.test(text)) cls = 'tok-n'
    out += `<span class="${cls}">${esc(text)}</span>`
    last = m.index + text.length
    if (text.length === 0) {
      spec.re.lastIndex++
    }
  }
  out += esc(code.slice(last))
  return out
}

/* ───────────────── 行内 ───────────────── */

/** 轻量公式排版：^x / ^{xy} → 上标，_x / _{xy} → 下标 */
function formatMath(s) {
  return s
    .replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>')
    .replace(/\^([0-9A-Za-z])/g, '<sup>$1</sup>')
    .replace(/_\{([^}]*)\}/g, '<sub>$1</sub>')
    .replace(/_([0-9A-Za-z])/g, '<sub>$1</sub>')
    .replace(/\\([a-zA-Z]+)/g, '$1')
}

function inline(src) {
  const codes = []
  let s = String(src)
  // 行内代码先抽走，避免被后面的规则破坏
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c)
    return `\u0000C${codes.length - 1}\u0000`
  })
  s = esc(s)
  // 图片
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => `<img alt="${alt}" src="${url}" style="max-width:100%;border-radius:10px">`)
  // 链接
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, url) => {
    const safe = /^(https?:|mailto:|#|\/)/.test(url) ? url : '#'
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`
  })
  // 粗体 / 斜体 / 删除线
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  // 行内公式 $...$（把 ^ _ 转成上/下标，够用的轻量排版）
  s = s.replace(/\$([^$\n]{1,200})\$/g, (_, m) => `<span class="math">${formatMath(m)}</span>`)
  // 引用角标 [1]
  s = s.replace(/\[(\d{1,2})\](?!\()/g, '<span class="cite">[$1]</span>')
  // 裸链接
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"）)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
  // 还原行内代码
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code class="inline">${esc(codes[Number(i)])}</code>`)
  return s
}

/* ───────────────── 块级 ───────────────── */

function renderCodeBlock(code, lang) {
  const l = (lang || '').trim().toLowerCase() || 'text'
  return `<div class="code-block"><div class="code-head"><span>${esc(l)}</span><button data-copy-code type="button">复制</button></div><pre><code>${highlight(code, l)}</code></pre></div>`
}

function renderTable(head, aligns, body) {
  const cell = (c, idx, tag) => {
    const al = aligns[idx] || ''
    const style = al ? ` style="text-align:${al}"` : ''
    return `<${tag}${style}>${inline(String(c).trim())}</${tag}>`
  }
  const html = [`<table><thead><tr>${head.map((c, i) => cell(c, i, 'th')).join('')}</tr></thead><tbody>`]
  for (const r of body) html.push(`<tr>${r.map((c, i) => cell(c, i, 'td')).join('')}</tr>`)
  html.push('</tbody></table>')
  return html.join('')
}

const isTableSep = (l) => /^\s*\|?[\s:-]*-[\s|:-]*$/.test(l) && l.includes('-')
const splitRow = (l) =>
  l
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())

export function render(src, opts = {}) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const out = []
  let i = 0
  let para = []

  const flushPara = () => {
    if (!para.length) return
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`)
    para = []
  }

  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/)
    if (fence) {
      flushPara()
      const fenceChar = fence[1][0]
      const closeRe = new RegExp('^\\s*' + (fenceChar === '`' ? '```+' : '~~~+') + '\\s*$')
      const lang = fence[2]
      const buf = []
      i++
      while (i < lines.length && !closeRe.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏
      out.push(renderCodeBlock(buf.join('\n'), lang))
      continue
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushPara()
      const lvl = Math.min(4, h[1].length)
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`)
      i++
      continue
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara()
      out.push('<hr>')
      i++
      continue
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara()
      const head = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':')
        const right = c.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return ''
      })
      const rows = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]))
        i++
      }
      out.push(renderTable(head, aligns, rows))
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</blockquote>`)
      continue
    }

    // 列表
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      flushPara()
      const html = []
      const stack = [] // 每层的父节点（含 indent 与 children）
      while (i < lines.length) {
        const l = lines[i]
        const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (!m) {
          // 缩进续行：并到当前项的文本里
          if (/^\s{2,}\S/.test(l) && stack.length) {
            const top = stack[stack.length - 1]
            const lastItem = top.children[top.children.length - 1]
            if (lastItem) lastItem.text += '\n' + l.trim()
            i++
            continue
          }
          break
        }
        const indent = m[1].replace(/\t/g, '  ').length
        const item = { indent, ordered: /\d/.test(m[2]), text: m[3], children: [] }
        while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop()
        const parent = stack.length ? stack[stack.length - 1].children : html
        parent.push(item)
        stack.push(item)
        i++
      }
      const renderList = (items) => {
        if (!items.length) return ''
        const ordered = items[0].ordered
        const tag = ordered ? 'ol' : 'ul'
        return `<${tag}>${items
          .map((it) => {
            const task = it.text.match(/^\[( |x|X)\]\s+(.*)$/)
            const content = task
              ? `<label class="task"><input type="checkbox" disabled ${task[1].toLowerCase() === 'x' ? 'checked' : ''}> <span>${inline(task[2])}</span></label>`
              : inline(it.text).replace(/\n/g, '<br>')
            return `<li${task ? ' class="task-item"' : ''}>${content}${renderList(it.children)}</li>`
          })
          .join('')}</${tag}>`
      }
      out.push(renderList(html))
      continue
    }

    // 空行
    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    // HTML 透传（少量安全标签）
    para.push(line)
    i++
  }
  flushPara()
  return out.join('\n')
}

/** 纯文本化（用于复制/标题） */
export function toPlain(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#>*_~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
