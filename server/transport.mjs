// 上游传输层：keep-alive 池 + TLS 会话复用 + 预热 + 直通流
// 设计目标：把「首字延迟」里跟模型无关的部分全部干掉（DNS / TCP / TLS / 冷连接）
import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'

const agents = new Map()

function keyOf(u) {
  return `${u.protocol}//${u.host}`
}

/** 拿到（或建一个）该 host 的 keep-alive agent。参数按 host 缓存，第一次生效。 */
export function agentFor(u) {
  const k = keyOf(u)
  let a = agents.get(k)
  if (a) return a
  const isTls = u.protocol === 'https:'
  const opts = {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 64,
    maxFreeSockets: 24,
    timeout: 120_000,
    scheduling: 'lifo',
  }
  if (isTls) {
    opts.maxCachedSessions = 128 // TLS session ticket 复用，重连省掉一次完整握手
    opts.rejectUnauthorized = process.env.DS_INSECURE_TLS !== '1'
  }
  a = isTls ? new https.Agent(opts) : new http.Agent(opts)
  agents.set(k, a)
  return a
}

/** 预热：提前建好 TCP+TLS，让第一条消息不用付握手成本。不携带鉴权、不产生计费。 */
export function prewarm(baseUrl) {
  let u
  try {
    u = new URL(baseUrl)
  } catch {
    return Promise.resolve(false)
  }
  const mod = u.protocol === 'https:' ? https : http
  return new Promise((resolve) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname.replace(/\/+$/, '') + '/',
        method: 'GET',
        agent: agentFor(u),
        headers: { accept: '*/*', 'user-agent': 'deepseek-clone/1.0 (prewarm)' },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(true))
      },
    )
    req.setTimeout(6000, () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * 发起上游请求，把响应体逐块交给 onData（不做任何缓冲 → 首字立刻往下游走）。
 * onTiming 会给出连接各阶段耗时，用来证明时间到底花在哪。
 * 返回 { status, headers, abort }。
 */
export function request(target, { method = 'POST', headers = {}, body, onData, onEnd, onError, onResponse, onTiming }) {
  const u = new URL(target)
  const mod = u.protocol === 'https:' ? https : http
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const h = { ...headers }
  if (payload) h['content-length'] = String(payload.length)
  const t0 = performance.now()
  const timing = {}

  const req = mod.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      agent: agentFor(u),
      headers: h,
    },
    (res) => {
      timing.firstByteMs = Math.round(performance.now() - t0)
      res.socket?.setNoDelay?.(true)
      onTiming?.(timing)
      onResponse?.(res)
      res.on('data', (chunk) => onData?.(chunk))
      res.on('end', () => onEnd?.())
      res.on('error', (e) => onError?.(e))
    },
  )
  req.on('socket', (s) => {
    if (!s.connecting) {
      timing.reused = true
      return
    }
    timing.reused = false
    s.once('connect', () => {
      timing.connectMs = Math.round(performance.now() - t0)
      if (u.protocol !== 'https:') onTiming?.(timing)
    })
    s.once('secureConnect', () => {
      timing.tlsMs = Math.round(performance.now() - t0)
      onTiming?.(timing)
    })
  })
  req.setTimeout(180_000, () => req.destroy(new Error('upstream timeout')))
  req.on('error', (e) => onError?.(e))
  if (payload) req.end(payload)
  else req.end()
  return req
}

/** 一次性 JSON 请求（用于 /models、搜索、取网页），带 keep-alive，复用连接；自动跟 3xx */
export function fetchJson(target, { method = 'GET', headers = {}, body, timeout = 15_000, maxBytes = 8 << 20, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      fn(v)
    }
    const follow = (res) => {
      const loc = res.headers.location
      if (!loc) return false
      const next = new URL(loc, target).toString()
      res.resume()
      if (redirects <= 0) {
        done(reject, new Error('too many redirects'))
        return true
      }
      fetchJson(next, { method: 'GET', headers, timeout, maxBytes, redirects: redirects - 1 }).then(
        (v) => done(resolve, v),
        (e) => done(reject, e),
      )
      return true
    }
    const req = request(target, {
      method,
      headers: { 'accept-encoding': 'identity', ...headers },
      body,
      onResponse: (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res)
          return
        }
        if (res.statusCode >= 400) {
          res.resume()
          done(reject, Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }))
          return
        }
      },
      onData: (c) => {
        size += c.length
        if (size > maxBytes) {
          req?.destroy()
          done(reject, new Error('response too large'))
          return
        }
        chunks.push(c)
      },
      onEnd: () => done(resolve, Buffer.concat(chunks)),
      onError: (e) => done(reject, e),
    })
    req.setTimeout(timeout, () => {
      req.destroy(new Error('timeout'))
      done(reject, new Error('timeout'))
    })
  })
}

export async function fetchText(target, opts = {}) {
  const buf = await fetchJson(target, opts)
  return buf.toString('utf8')
}

export function destroyAll() {
  for (const a of agents.values()) a.destroy()
  agents.clear()
}
