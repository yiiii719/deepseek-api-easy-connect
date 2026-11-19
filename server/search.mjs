// 联网搜索：默认走 DuckDuckGo 轻量版（不要 key），可选 Brave / Serper / Tavily
// 返回结构统一：{ query, provider, ms, results:[{ title, url, snippet, content }] }
import { fetchText } from './transport.mjs'

const UA =
  'Mozilla/5.0 (Linux; Android 13; M2012K11AC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'

/**
 * 把用户原话压成一条像样的搜索词。
 * 直接拿整句去搜，中文搜索引擎会把「给三条」「一句话回答」也当关键词，结果全是噪声。
 */
export function distillQuery(text) {
  let q = String(text || '').replace(/\s+/g, ' ').trim()
  q = q.split(/[。？！?!\n]/)[0] // 只要第一句
  q = q.replace(/^(请问一下|请问|麻烦你?|帮我|帮忙|我想知道|我想问|你好|嗨|哈喽)[\s,，]*/g, '')
  q = q.replace(/^(今天|今日|现在|当前|最近|近来|这几天)[\s,，]*/g, '')
  q = q.replace(/(有什么|有哪些|是什么|是多少|是啥|怎么样|如何|多少钱)/g, ' ')
  q = q.replace(/[，,；;].*$/, '') // 逗号后的补充说明丢掉
  q = q.replace(/[“”"'《》`（）()【】\[\]]/g, ' ')
  q = q.replace(/\s+/g, ' ').trim()
  if (!q) q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 48)
  return q.slice(0, 64)
}

export async function webSearch(query, { provider = 'bing', limit = 5, fetchPages = true, timeout = 9000, distill = true } = {}) {
  const t0 = Date.now()
  const q = distill ? distillQuery(query) : query
  let results = []
  const chain =
    provider === 'serper' && process.env.SERPER_KEY
      ? [serper]
      : provider === 'tavily' && process.env.TAVILY_KEY
        ? [tavily]
        : provider === 'brave' && process.env.BRAVE_KEY
          ? [brave]
          : provider === 'ddg'
            ? [ddg, bing]
            : [bing, ddg]
  let lastErr
  for (const fn of chain) {
    try {
      results = await fn(q, limit)
      if (results.length) break
    } catch (e) {
      lastErr = e
    }
  }
  if (!results.length) return { query, distilled: q, provider, ms: Date.now() - t0, results: [], error: lastErr?.message || 'no results' }
  results = results.slice(0, limit)
  if (fetchPages && results.length) {
    const pages = await Promise.allSettled(results.slice(0, 3).map((r) => readPage(r.url, timeout)))
    pages.forEach((p, i) => {
      if (p.status === 'fulfilled' && p.value) results[i].content = p.value.slice(0, 4000)
    })
  }
  return { query, distilled: q, provider, ms: Date.now() - t0, results }
}

const decodeXml = (s) =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim()

/** Bing 的 RSS 出口：免 key、结构化、比抓 HTML 稳得多 */
async function bing(q, limit) {
  const headers = { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' }
  const path = `/search?q=${encodeURIComponent(q)}&format=rss&mkt=zh-CN&setlang=zh-Hans`
  let xml = await fetchText(`https://cn.bing.com${path}`, { headers, timeout: 9000 })
  // 个别边缘节点会回一个 "Object moved" 的 HTML 跳转页，跟着走一次
  if (!/<item>/.test(xml)) {
    const m = xml.match(/href="([^"]+)"/)
    if (m) xml = await fetchText(m[1].replace(/&amp;/g, '&'), { headers, timeout: 9000 })
  }
  const out = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= limit) break
    const block = m[1]
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
    const link = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '')
    const desc = decodeXml(block.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '')
    if (!/^https?:/.test(link)) continue
    out.push({ title: title || link, url: link, snippet: desc })
  }
  return out
}

async function ddg(q, limit) {
  const html = await fetchText('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
      referer: 'https://lite.duckduckgo.com/',
      accept: 'text/html',
    },
    body: new URLSearchParams({ q, kl: 'cn-zh' }).toString(),
    timeout: 9000,
  })
  const out = []
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<td[^>]+class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripHtml(m[1]))
  let i = 0
  let m
  while ((m = linkRe.exec(html)) && out.length < limit) {
    const url = decodeURIComponent(m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&rut=')[0])
    if (!/^https?:/.test(url)) {
      i++
      continue
    }
    out.push({ title: stripHtml(m[2]).trim() || url, url, snippet: snippets[i] || '' })
    i++
  }
  if (!out.length) {
    // 兜底：直接抓普通结果链接
    for (const m2 of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{2,120}?)<\/a>/g)) {
      if (out.length >= limit) break
      if (/duckduckgo\.com/.test(m2[1])) continue
      out.push({ title: stripHtml(m2[2]).trim(), url: m2[1], snippet: '' })
    }
  }
  return out
}

async function serper(q, limit) {
  const r = await fetchText('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': process.env.SERPER_KEY },
    body: JSON.stringify({ q, gl: 'cn', hl: 'zh-cn', num: limit }),
    timeout: 9000,
  })
  const j = JSON.parse(r)
  return (j.organic || []).map((o) => ({ title: o.title, url: o.link, snippet: o.snippet || '' }))
}

async function tavily(q, limit) {
  const r = await fetchText('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_KEY, query: q, max_results: limit, search_depth: 'basic' }),
    timeout: 12000,
  })
  const j = JSON.parse(r)
  return (j.results || []).map((o) => ({ title: o.title, url: o.url, snippet: o.content || '' }))
}

async function brave(q, limit) {
  const r = await fetchText(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_KEY, accept: 'application/json' },
    timeout: 9000,
  })
  const j = JSON.parse(r)
  return (j.web?.results || []).map((o) => ({ title: o.title, url: o.url, snippet: o.description || '' }))
}

async function readPage(url, timeout) {
  const html = await fetchText(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    timeout,
    maxBytes: 3 << 20,
  })
  return stripHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' '),
  )
}

export function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 把搜索结果压成注入 system 的上下文 */
export function searchContext(res) {
  if (!res?.results?.length) return { text: '', citations: [] }
  const lines = res.results.map((r, i) => {
    const body = (r.content || r.snippet || '').slice(0, 1800)
    return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${body}`
  })
  return {
    text: `下面是刚才联网搜到的资料，回答时如果引用了某条，请在该句末尾标 [编号]。不要编造资料里没有的事实。\n\n${lines.join('\n\n')}`,
    citations: res.results.map((r, i) => ({ index: i + 1, title: r.title, url: r.url })),
  }
}
