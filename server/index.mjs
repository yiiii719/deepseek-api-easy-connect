// TIDE（潮汐）· 零依赖后端
// 统一入口：静态站 + 私有 API + OpenAI 兼容网关 + SSE 直通
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ROOT, PORT, HOST, PROVIDER_PRESETS, DEFAULT_SETTINGS, VERSION, DATA_DIR } from './config.mjs'
import { db, uid, now } from './store.mjs'
import { buildRequest, SseDecoder, translate, demoStream } from './providers.mjs'
import { request, prewarm, fetchText, destroyAll } from './transport.mjs'
import { extractText, buildAttachmentContext } from './extract.mjs'
import { webSearch, searchContext } from './search.mjs'

const WEB_DIR = path.join(ROOT, 'web')
const startedAt = Date.now()

/* ─────────────────────────── 工具 ─────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(status, { 'content-length': buf.length, ...headers })
  res.end(buf)
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
}
function readBody(req, limit = 24 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
async function readJson(req) {
  const buf = await readBody(req)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('bad json')
  }
}

/** 到点就放弃，返回兜底值（用于搜索这类「有更好、没有也能答」的步骤） */
function withTimeout(promise, ms, fallback) {
  promise.catch(() => {})
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms)
      t.unref?.()
    }),
  ])
}

/* ─────────────────────────── 设置 / 服务商 ─────────────────────────── */

function settings() {
  const stored = db.getSettings()
  const merged = { ...DEFAULT_SETTINGS, ...stored }
  // providers: 预设 + 用户覆盖
  const overrides = new Map((merged.providers || []).map((p) => [p.id, p]))
  const providers = PROVIDER_PRESETS.map((p) => ({ ...p, ...(overrides.get(p.id) || {}) }))
  for (const [id, p] of overrides) if (!providers.some((x) => x.id === id)) providers.push({ dialect: 'openai', models: [], ...p })
  return { ...merged, providersList: providers }
}

function resolveProvider(settingsObj, providerId) {
  const id = providerId || settingsObj.providerId
  return settingsObj.providersList.find((p) => p.id === id) || settingsObj.providersList[0]
}

function pickModel(settingsObj, provider, model, thinking) {
  const m = model || settingsObj.model || provider.defaultModel || provider.models?.[0] || 'deepseek-chat'
  if (thinking && provider.thinkingModel && m === provider.defaultModel) return provider.thinkingModel
  return m
}

/* ─────────────────────────── 预热 ─────────────────────────── */

const warmState = new Map() // baseUrl -> 上次预热时间
async function warmAll({ force = false } = {}) {
  const s = settings()
  for (const p of s.providersList) {
    if (!p.baseUrl || !p.apiKey || p.dialect === 'demo') continue
    const last = warmState.get(p.baseUrl) || 0
    if (!force && Date.now() - last < 30_000) continue // 30s 内不重复
    warmState.set(p.baseUrl, Date.now())
    const ok = await prewarm(p.baseUrl)
    if (force) console.log(`[warm] ${p.name} ${ok ? 'ok' : 'fail'} ${p.baseUrl}`)
  }
}
// 保活节奏要短于上游/中间层的 idle timeout（常见 60–90s），否则每条消息都在重新握手
setInterval(() => warmAll().catch(() => {}), 75_000)

/* ─────────────────────────── 静态资源 ─────────────────────────── */

const gzipCache = new Map()

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath.split('?')[0])
  const full = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))
  if (!full.startsWith(WEB_DIR)) return send(res, 403, 'forbidden')
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 兜底
      const idx = path.join(WEB_DIR, 'index.html')
      return fs.readFile(idx, (e2, buf2) => (e2 ? send(res, 404, 'not found') : send(res, 200, buf2, { 'content-type': MIME['.html'] })))
    }
    const ext = path.extname(full).toLowerCase()
    const type = MIME[ext] || 'application/octet-stream'
    const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      return res.end()
    }
    const isText = /^(text|application\/(json|manifest\+json)|image\/svg)/.test(type)
    const cache = gzipCache.get(full + etag)
    if (cache) {
      res.writeHead(200, { 'content-type': type, etag, 'content-encoding': cache.enc, 'cache-control': 'no-cache', vary: 'accept-encoding', 'content-length': cache.buf.length })
      return res.end(cache.buf)
    }
    fs.readFile(full, (e, buf) => {
      if (e) return send(res, 500, 'read error')
      const acceptGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '')
      if (isText && acceptGzip && buf.length > 1024) {
        const gz = zlib.gzipSync(buf, { level: 6 })
        if (gzipCache.size > 60) gzipCache.clear()
        gzipCache.set(full + etag, { buf: gz, enc: 'gzip' })
        res.writeHead(200, { 'content-type': type, etag, 'content-encoding': 'gzip', 'cache-control': 'no-cache', vary: 'accept-encoding', 'content-length': gz.length })
        return res.end(gz)
      }
      res.writeHead(200, { 'content-type': type, etag, 'cache-control': 'no-cache', 'content-length': buf.length })
      res.end(buf)
    })
  })
}

/* ─────────────────────────── SSE 输出 ─────────────────────────── */

function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'content-encoding': 'identity',
  })
  res.flushHeaders?.()
  res.socket?.setNoDelay?.(true)
  res.write(': open\n\n') // 立刻把响应头 + 首包推给客户端
}

function sse(res, event, data) {
  if (res.writableEnded) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/* ─────────────────────────── 会话 ─────────────────────────── */

function titleFrom(text) {  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[#>*`]/g, '')
    .trim()
  return t.slice(0, 28) || '新对话'
}

function historyFor(convId, { regenerate = false } = {}) {
  const rows = db.listMessages(convId)
  if (regenerate) {
    const lastAssistant = [...rows].reverse().find((m) => m.role === 'assistant')
    if (lastAssistant) {
      db.deleteMessage(lastAssistant.id)
      return rows.filter((m) => m.id !== lastAssistant.id)
    }
  }
  return rows
}

function toUpstreamMessages(rows, { contextBlock = '', budgetChars = 24000 } = {}) {
  const all = rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => (m.content || '').trim().length > 0 || (m.role === 'assistant' && m.reasoning))
    .map((m) => ({ role: m.role, content: m.content || '' }))

  // 上下文预算：从最新往回拿，超预算就从最老的开始丢。
  // 不砍历史的后果是 prefill 越来越慢——聊到 20 轮以后首字能翻倍。
  let used = 0
  const kept = []
  for (let i = all.length - 1; i >= 0; i--) {
    const len = all[i].content.length
    if (kept.length && used + len > budgetChars) break
    used += len
    kept.push(all[i])
  }
  const msgs = kept.reverse()
  if (msgs.length !== all.length) {
    msgs.unshift({ role: 'system', content: `（更早的 ${all.length - msgs.length} 条消息已按上下文预算省略，必要时请向用户确认。）` })
  }

  if (contextBlock) {
    // 塞进最后一条 user 消息比放 system 更管用：多数模型对「用户提供的资料」采信度更高
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (lastUser) lastUser.content = `${lastUser.content}\n\n${contextBlock}`
    else msgs.push({ role: 'user', content: contextBlock })
  }
  return msgs
}

/* ─────────────────────────── 核心：流式对话 ─────────────────────────── */

async function handleChat(req, res) {
  const body = await readJson(req)
  const s = settings()
  const provider = resolveProvider(s, body.providerId)
  const thinking = body.thinking ?? s.thinking
  const model = pickModel(s, provider, body.model, thinking)
  let maxTokens = body.maxTokens ?? s.maxTokens
  // 思考模型的 CoT 通常也计入 max_tokens，预算给小了会「只想不答」
  if (thinking) maxTokens = Math.max(maxTokens, 8192)
  const temperature = body.temperature ?? s.temperature
  const system = [s.system, body.system].filter(Boolean).join('\n\n')

  // 会话
  let conv = body.convId ? db.getConversation(body.convId) : null
  const userText = String(body.text || '').trim()
  const regenerate = !!body.regenerate

  if (!conv) {
    conv = db.createConversation({ title: titleFrom(userText), model, provider: provider.id })
  }
  let rows
  if (regenerate) {
    rows = historyFor(conv.id, { regenerate: true })
  } else {
    if (!userText) return sendJson(res, 400, { error: 'empty message' })
    // 编辑重发：从指定消息起整段截断
    if (body.truncateFrom) {
      const all = db.listMessages(conv.id)
      const idx = all.findIndex((m) => m.id === body.truncateFrom)
      if (idx >= 0) for (const m of all.slice(idx)) db.deleteMessage(m.id)
    }
    const meta = { attachments: body.attachments || [], provider: provider.id, model }
    db.addMessage(conv.id, { role: 'user', content: userText, meta })
    rows = db.listMessages(conv.id)
  }

  // 附件
  let attachmentContext = ''
  if (body.attachments?.length) {
    const atts = body.attachments.map((id) => db.getAttachment(id)).filter(Boolean)
    attachmentContext = buildAttachmentContext(atts)
  }

  openSse(res)
  const t0 = performance.now()
  const msgId = uid()
  sse(res, 'meta', { convId: conv.id, messageId: msgId, model, provider: provider.name, title: conv.title })

  // 联网搜索（在模型开始前完成，先给 UI 看资料；整体封顶，别把首字拖死）
  let searchText = ''
  let citations = []
  if (body.search ?? s.search) {
    const q = regenerate ? [...rows].reverse().find((m) => m.role === 'user')?.content || userText : userText
    sse(res, 'search_start', { query: q })
    const r = await withTimeout(webSearch(q, { provider: s.searchProvider, limit: 5 }), 6500, {
      query: q,
      results: [],
      error: 'search timeout',
      ms: 6500,
    })
    const ctx = searchContext(r)
    searchText = ctx.text
    citations = ctx.citations
    sse(res, 'search', { query: q, results: (r.results || []).map(({ title, url, snippet }) => ({ title, url, snippet })), citations, ms: r.ms, error: r.error })
  }

  // 把「附件正文 + 搜索结果」拼成一段随最后一条 user 消息下发的上下文
  const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  const parts = []
  if (attachmentContext) parts.push(attachmentContext)
  if (searchText) {
    parts.push(
      `【联网搜索结果 · 抓取时间 ${nowStr}】\n${searchText}\n\n` +
        `【硬性要求】以上网页是刚刚实时抓到的，请直接据此回答；不要声称"我无法联网"或"知识有截止日期"；` +
        `引用某条资料时在该句末尾标注 [编号]。若资料确实覆盖不到问题，再说明缺什么。`,
    )
  }
  const contextBlock = parts.join('\n\n')

  const messages = toUpstreamMessages(rows, { contextBlock, budgetChars: s.contextChars || 24000 })
  if (process.env.DS_DEBUG_UPSTREAM === '1') {
    console.log(
      '[upstream]',
      JSON.stringify({ system: system.slice(0, 40), ctxChars: contextBlock.length, msgs: messages.map((m) => `${m.role}:${m.content.length}`) }),
    )
  }

  let content = ''
  let reasoning = ''
  let usage = null
  let stopReason = null
  let modelEcho = model
  let firstTokenAt = null
  let closed = false
  let upstreamReq = null
  let demoStop = null
  const timing = {}

  const finish = (extra = {}) => {
    if (closed) return
    closed = true
    const ms = Math.round(performance.now() - t0)
    const ttft = firstTokenAt ? Math.round(firstTokenAt - t0) : null
    const meta = { model: modelEcho, provider: provider.id, ttft, ms, usage, stopReason, timing, ...extra }
    try {
      if (content || reasoning) {
        db.addMessage(conv.id, { id: msgId, role: 'assistant', content, reasoning, meta })
      }
      if (conv.title === '新对话' || !conv.title) db.updateConversation(conv.id, { title: titleFrom(rows.find((r2) => r2.role === 'user')?.content || userText) })
    } catch (e) {
      console.error('[persist]', e.message)
    }
    sse(res, 'done', { messageId: msgId, convId: conv.id, content, reasoning, citations, stats: { ttft, ms, usage, stopReason, model: modelEcho, timing } })
    res.end()
  }

  res.on('close', () => {
    if (closed) return
    upstreamReq?.destroy()
    demoStop?.()
    finish({ aborted: true })
  })

  const onEvent = (ev) => {
    if (closed) return
    if (ev.type === 'meta' && ev.model) modelEcho = ev.model
    else if (ev.type === 'reasoning') {
      if (firstTokenAt === null) firstTokenAt = performance.now()
      reasoning += ev.text
      sse(res, 'reasoning', { t: ev.text })
    } else if (ev.type === 'content') {
      if (firstTokenAt === null) firstTokenAt = performance.now()
      content += ev.text
      sse(res, 'content', { t: ev.text })
    } else if (ev.type === 'usage') usage = ev.usage
    else if (ev.type === 'stop') stopReason = ev.reason
    else if (ev.type === 'error') {
      sse(res, 'error', { message: ev.message })
      finish({ error: ev.message })
    }
  }

  if (provider.dialect !== 'demo' && !provider.apiKey) {
    sse(res, 'error', { message: '还没填 API Key：去「设置 → 接口」填上，或先用「演示模式」体验' })
    return finish({ error: 'no-key' })
  }

  if (provider.dialect === 'demo' || !provider.baseUrl) {
    demoStop = demoStream(messages, onEvent, { aborted: false })
    sse(res, 'demo', { on: true })
    const iv = setInterval(() => {
      if (closed) {
        clearInterval(iv)
        return
      }
      if (stopReason) {
        clearInterval(iv)
        finish()
      }
    }, 100)
    return
  }

  let reqSpec
  try {
    // 官方 API 的 effort 档位：关思考走 low（首字最快），开思考走 high
    const extra = { ...(provider.extra || {}) }
    if (provider.effort) extra.effort = thinking ? provider.effort.thinking : provider.effort.fast
    reqSpec = buildRequest(provider, { messages, model, system, temperature, maxTokens, topP: s.topP, thinking, extra })
  } catch (e) {
    sse(res, 'error', { message: `请求构造失败：${e.message}` })
    return finish({ error: e.message })
  }

  const decoder = new SseDecoder()
  let gotAny = false
  let retried = false

  const fire = () => {
    upstreamReq = request(reqSpec.url, {
      method: 'POST',
      headers: reqSpec.headers,
      body: reqSpec.body,
      onTiming: (t) => Object.assign(timing, t),
      onResponse: (r) => {
        if (r.statusCode >= 400) {
          let eb = ''
          r.on('data', (c) => (eb += c.toString('utf8')))
          r.on('end', () => {
            let msg = `上游 ${r.statusCode}`
            try {
              const j = JSON.parse(eb)
              msg += `：${j.error?.message || j.message || eb.slice(0, 300)}`
            } catch {
              if (eb) msg += `：${eb.slice(0, 300)}`
            }
            sse(res, 'error', { message: msg })
            finish({ error: msg })
          })
          return
        }
        if (!/text\/event-stream/.test(r.headers['content-type'] || '')) {
          // 有的中转不认 stream:true，直接回整包 JSON
          let all = ''
          r.on('data', (c) => (all += c.toString('utf8')))
          r.on('end', () => {
            try {
              const j = JSON.parse(all)
              const c = j.choices?.[0]?.message?.content || ''
              const rsn = j.choices?.[0]?.message?.reasoning_content || ''
              if (rsn) onEvent({ type: 'reasoning', text: rsn })
              if (c) onEvent({ type: 'content', text: c })
              if (j.usage) onEvent({ type: 'usage', usage: j.usage })
              onEvent({ type: 'stop', reason: j.choices?.[0]?.finish_reason || 'stop' })
            } catch (e) {
              sse(res, 'error', { message: `上游返回不可解析：${all.slice(0, 200)}` })
            }
            finish()
          })
          return
        }
        r.on('data', (chunk) => {
          gotAny = true
          for (const payload of decoder.push(chunk)) {
            for (const ev of translate(provider.dialect, payload)) {
              if (ev.type === 'stop' && ev.reason === 'done') continue
              onEvent(ev)
            }
          }
        })
        r.on('end', () => finish())
      },
      onError: (e) => {
        if (!gotAny && !retried) {
          retried = true
          console.warn('[retry]', e.message)
          return fire()
        }
        sse(res, 'error', { message: `连接上游失败：${e.message}` })
        finish({ error: e.message })
      },
    })
  }
  fire()
}

/* ─────────────────────────── OpenAI 兼容网关 ─────────────────────────── */

async function handleGateway(req, res) {
  const key = process.env.DS_GATEWAY_KEY
  if (key) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (got !== key) return sendJson(res, 401, { error: { message: 'invalid gateway key' } })
  }
  const body = await readJson(req)
  const s = settings()
  const provider = resolveProvider(s, body.provider_id)
  const model = body.model || provider.defaultModel
  const stream = body.stream !== false
  const spec = buildRequest(provider, {
    messages: body.messages || [],
    model,
    system: body.system,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    topP: body.top_p,
    thinking: /reason/i.test(model),
    extra: provider.extra,
  })

  if (!stream) {
    let acc = ''
    let rsn = ''
    const r = request(spec.url, {
      method: 'POST',
      headers: { ...spec.headers, accept: 'application/json' },
      body: spec.body.replace('"stream":true', '"stream":false'),
      onResponse: (up) => {
        if (up.statusCode >= 400) return sendJson(res, up.statusCode, { error: { message: 'upstream error' } })
      },
      onData: (c) => (acc += c.toString('utf8')),
      onEnd: () => {
        try {
          const j = JSON.parse(acc)
          return sendJson(res, 200, { ...j, model })
        } catch {
          return sendJson(res, 502, { error: { message: 'upstream parse error', raw: acc.slice(0, 500) } })
        }
      },
      onError: (e) => sendJson(res, 502, { error: { message: e.message } }),
    })
    r.on('error', () => {})
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  })
  res.flushHeaders?.()
  const dec = new SseDecoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${uid().slice(0, 8)}`
  const emit = (delta, finish = null) => {
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    )
  }
  request(spec.url, {
    method: 'POST',
    headers: spec.headers,
    body: spec.body,
    onResponse: (up) => {
      if (up.statusCode >= 400) {
        emit({ content: `upstream ${up.statusCode}` }, 'error')
        res.end('data: [DONE]\n\n')
      }
    },
    onData: (chunk) => {
      for (const payload of dec.push(chunk)) {
        for (const ev of translate(provider.dialect, payload)) {
          if (ev.type === 'reasoning') emit({ reasoning_content: ev.text })
          else if (ev.type === 'content') emit({ content: ev.text })
        }
      }
    },
    onEnd: () => {
      emit({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    },
    onError: () => {
      emit({}, 'error')
      res.end('data: [DONE]\n\n')
    },
  }).on('error', () => {})
  res.on('close', () => {})
}

/* ─────────────────────────── 路由 ─────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type, authorization')
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  try {
    /* ---- 网关（给别的 App/CLI 用） ---- */
    if (p === '/v1/chat/completions' && req.method === 'POST') return await handleGateway(req, res)
    if (p === '/v1/models') {
      const s = settings()
      const data = s.providersList.flatMap((pv) => (pv.models || []).map((m) => ({ id: m, object: 'model', owned_by: pv.id })))
      return sendJson(res, 200, { object: 'list', data })
    }

    /* ---- 私有 API ---- */
    if (p === '/api/health') {
      return sendJson(res, 200, { ok: true, version: VERSION, uptime: Math.round((Date.now() - startedAt) / 1000), store: db.kind, node: process.version })
    }

    if (p === '/api/bootstrap') {
      const s = settings()
      return sendJson(res, 200, {
        settings: { ...s, providersList: undefined },
        providers: s.providersList.map((pv) => ({ id: pv.id, name: pv.name, dialect: pv.dialect, baseUrl: pv.baseUrl, models: pv.models, defaultModel: pv.defaultModel, thinkingModel: pv.thinkingModel, hasKey: !!pv.apiKey })),
        conversations: db.listConversations(),
        version: VERSION,
      })
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const patch = await readJson(req)
      if (patch.providers) {
        const cur = db.getSettings()
        patch.providers = mergeProviders(cur.providers || [], patch.providers)
      }
      db.saveSettings(patch)
      warmState.clear()
      warmAll({ force: true }).catch(() => {})
      return sendJson(res, 200, { ok: true, settings: settings() })
    }

    if (p === '/api/conversations' && req.method === 'GET') return sendJson(res, 200, db.listConversations())
    if (p === '/api/conversations' && req.method === 'POST') {
      const b = await readJson(req)
      return sendJson(res, 200, db.createConversation({ title: b.title || '新对话' }))
    }
    if (p.startsWith('/api/conversations/')) {
      const parts = p.split('/')
      const id = parts[3]
      // /api/conversations/:id/messages/:mid
      if (parts[4] === 'messages' && parts[5] && req.method === 'DELETE') {
        db.deleteMessage(parts[5])
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'GET') {
        const conv = db.getConversation(id)
        if (!conv) return sendJson(res, 404, { error: 'not found' })
        return sendJson(res, 200, { ...conv, messages: db.listMessages(id) })
      }
      if (req.method === 'PATCH') {
        const b = await readJson(req)
        return sendJson(res, 200, db.updateConversation(id, b))
      }
      if (req.method === 'DELETE') {
        db.deleteConversation(id)
        return sendJson(res, 200, { ok: true })
      }
    }

    if (p === '/api/chat' && req.method === 'POST') return await handleChat(req, res)

    if (p === '/api/attachments' && req.method === 'POST') {
      const b = await readJson(req)
      const buf = Buffer.from(String(b.data || ''), 'base64')
      const r = extractText(b.name, b.mime, buf)
      if (!r.text) return sendJson(res, 400, { error: r.error || '无法解析该文件' })
      const saved = db.saveAttachment({ name: b.name, mime: b.mime, size: buf.length, text: r.text })
      return sendJson(res, 200, { ...saved, kind: r.kind, preview: r.text.slice(0, 300) })
    }

    if (p === '/api/search' && req.method === 'POST') {
      const b = await readJson(req)
      const s = settings()
      const r = await webSearch(b.q, { provider: b.provider || s.searchProvider, limit: b.limit || 5, fetchPages: !!b.pages })
      return sendJson(res, 200, r)
    }

    if (p === '/api/models') {
      const s = settings()
      const pv = resolveProvider(s, url.searchParams.get('provider'))
      if (!pv.baseUrl || !pv.apiKey || pv.dialect === 'demo') return sendJson(res, 200, { models: pv.models || [] })
      try {
        const txt = await fetchText(`${pv.baseUrl.replace(/\/+$/, '')}/models`, {
          headers: pv.dialect === 'anthropic' ? { 'x-api-key': pv.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${pv.apiKey}` },
          timeout: 6000,
        })
        const j = JSON.parse(txt)
        const models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)
        return sendJson(res, 200, { models: models.length ? models : pv.models || [] })
      } catch (e) {
        return sendJson(res, 200, { models: pv.models || [], error: e.message })
      }
    }

    // 速度体检：打一发 1 token 的请求，量 TTFB
    if (p === '/api/bench') {
      const s = settings()
      const pv = resolveProvider(s, url.searchParams.get('provider'))
      const model = url.searchParams.get('model') || pickModel(s, pv, '', false)
      if (pv.dialect === 'demo') return sendJson(res, 200, { mode: 'demo', ttft: 1, ms: 1 })
      if (!pv.apiKey) return sendJson(res, 200, { error: '还没配置 API Key', provider: pv.id })
      const spec = buildRequest(pv, {
        messages: [{ role: 'user', content: 'hi' }],
        model,
        maxTokens: 1,
        temperature: 0,
        thinking: false,
      })
      const t0 = performance.now()
      let ttft = null
      let failed = null
      const dec = new SseDecoder()
      const req2 = request(spec.url, {
        method: 'POST',
        headers: spec.headers,
        body: spec.body,
        onResponse: (r) => {
          if (r.statusCode >= 400) {
            failed = `上游 ${r.statusCode}`
            let eb = ''
            r.on('data', (c) => (eb += c.toString('utf8')))
            r.on('end', () => {
              try {
                const j = JSON.parse(eb)
                failed = `上游 ${r.statusCode}：${j.error?.message || j.message || ''}`.slice(0, 200)
              } catch {
                /* ignore */
              }
              if (!res.writableEnded) sendJson(res, 200, { error: failed, ms: Math.round(performance.now() - t0), model, provider: pv.id })
            })
          }
        },
        onData: (c) => {
          if (failed) return
          if (ttft === null) ttft = Math.round(performance.now() - t0)
          dec.push(c)
          req2.destroy()
        },
        onEnd: () => {
          if (failed) return
          sendJson(res, 200, { ttft, ms: Math.round(performance.now() - t0), model, provider: pv.id })
        },
        onError: () => {
          if (failed) return
          sendJson(res, 200, { ttft, ms: Math.round(performance.now() - t0), model, provider: pv.id, note: 'closed early' })
        },
      })
      req2.setTimeout(15_000, () => {
        req2.destroy()
        if (!res.writableEnded) sendJson(res, 200, { ttft, ms: Math.round(performance.now() - t0), timeout: true })
      })
      return
    }

    if (p === '/api/stats') {
      return sendJson(res, 200, { uptime: Math.round((Date.now() - startedAt) / 1000), store: db.kind, dataDir: DATA_DIR, memory: process.memoryUsage().rss })
    }

    /* ---- 静态 ---- */
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p)
    return sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    console.error('[err]', req.method, p, e.message)
    if (!res.headersSent) sendJson(res, 500, { error: e.message })
    else res.end()
  }
})

function mergeProviders(current, incoming) {
  const map = new Map(current.map((p) => [p.id, p]))
  for (const p of incoming) {
    if (!p?.id) continue
    map.set(p.id, { ...(map.get(p.id) || {}), ...p })
  }
  return [...map.values()]
}

server.listen(PORT, HOST, () => {
  const s = settings()
  console.log(`\n  DeepSeek Clone v${VERSION}  ·  ${db.kind} store`)
  console.log(`  http://127.0.0.1:${PORT}   (LAN: http://<本机IP>:${PORT})`)
  console.log(`  OpenAI 兼容网关: http://127.0.0.1:${PORT}/v1  ·  默认服务商: ${resolveProvider(s).name}\n`)
  warmAll({ force: true }).catch(() => {})
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    destroyAll()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500)
  })
}
