// 延迟体检：直连上游 vs 走本复刻代理
// 口径统一为「第一个真正的内容/思考 token」，不是首字节（官方会先发一个 role-only 的 delta）
// 用法：PROVIDER=deepseek node bench/latency.mjs deepseek-flash 5
import https from 'node:https'
import http from 'node:http'
import { PROVIDER_PRESETS } from '../server/config.mjs'
import { buildRequest, SseDecoder, translate } from '../server/providers.mjs'
import { request, prewarm } from '../server/transport.mjs'

const MODEL = process.argv[2] || 'deepseek-flash'
const ROUNDS = Number(process.argv[3] || 5)
const PROXY = new URL(process.env.PROXY || 'http://127.0.0.1:8899')
const pv = PROVIDER_PRESETS.find((p) => p.id === (process.env.PROVIDER || 'deepseek'))

const PROMPT = '数一下：1 2 3，只回数字，不要解释。'
const reqOpts = { messages: [{ role: 'user', content: PROMPT }], model: MODEL, maxTokens: 16, temperature: 0 }

/** 直连：同时记录首字节 / 首个 token */
function onceDirect() {
  return new Promise((resolve) => {
    const spec = buildRequest(pv, reqOpts)
    const dec = new SseDecoder()
    const t0 = performance.now()
    let firstByte = null
    let firstToken = null
    const finish = () => resolve({ firstByte, firstToken })
    const req = request(spec.url, {
      method: 'POST',
      headers: spec.headers,
      body: spec.body,
      onData: (c) => {
        if (firstByte === null) firstByte = performance.now() - t0
        for (const payload of dec.push(c)) {
          for (const ev of translate(pv.dialect || 'openai', payload)) {
            if (!firstToken && (ev.type === 'content' || ev.type === 'reasoning')) {
              firstToken = performance.now() - t0
              req.destroy()
              finish()
            }
          }
        }
      },
      onEnd: finish,
      onError: finish,
    })
    req.setTimeout(30_000, () => {
      req.destroy()
      finish()
    })
  })
}

/** 冷连接：agent:false，每次重做 TCP+TLS；口径同上 */
function onceCold() {
  return new Promise((resolve) => {
    const spec = buildRequest(pv, reqOpts)
    const u = new URL(spec.url)
    const dec = new SseDecoder()
    const t0 = performance.now()
    let firstToken = null
    const req = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', headers: spec.headers, agent: false },
      (res) => {
        res.on('data', (c) => {
          for (const payload of dec.push(c)) {
            for (const ev of translate(pv.dialect || 'openai', payload)) {
              if (!firstToken && (ev.type === 'content' || ev.type === 'reasoning')) {
                firstToken = performance.now() - t0
                req.destroy()
                resolve(firstToken)
              }
            }
          }
        })
        res.on('end', () => resolve(firstToken))
      },
    )
    req.on('error', () => resolve(firstToken))
    req.end(spec.body)
  })
}

/** 走代理：裸 http.request，避免 fetch 自身引入缓冲 */
function onceProxy() {
  return new Promise((resolve) => {
    const payload = Buffer.from(
      JSON.stringify({ text: PROMPT, thinking: false, search: false, model: MODEL, temperature: 0, maxTokens: 16 }),
    )
    const t0 = performance.now()
    let firstByte = null
    let firstToken = null
    let serverTtft = null
    let buf = ''
    const req = http.request(
      {
        hostname: PROXY.hostname,
        port: PROXY.port,
        path: '/api/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length, accept: 'text/event-stream' },
      },
      (res) => {
        res.on('data', (c) => {
          if (firstByte === null) firstByte = performance.now() - t0
          buf += c.toString('utf8')
          if (firstToken === null && /event: (content|reasoning)/.test(buf)) firstToken = performance.now() - t0
          const m = buf.match(/"ttft":(\d+)/)
          if (m) serverTtft = Number(m[1])
        })
        res.on('end', () => resolve({ firstByte, firstToken, serverTtft }))
      },
    )
    req.on('error', () => resolve({ firstByte, firstToken, serverTtft }))
    req.end(payload)
  })
}

const med = (a) => {
  const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
const min = (a) => {
  const s = a.filter((x) => typeof x === 'number')
  return s.length ? Math.min(...s) : null
}
const f = (n) => (n == null ? '   -  ' : `${Math.round(n)}ms`)

await prewarm(pv.baseUrl)
console.log(`上游 ${pv.baseUrl}  模型 ${MODEL}  轮数 ${ROUNDS}  口径=首个内容 token\n`)

const cold = []
const direct = []
const proxyClient = []
const proxyServer = []
for (let i = 0; i < ROUNDS; i++) {
  cold.push(await onceCold())
  const d = await onceDirect()
  direct.push(d.firstToken)
  const r = await onceProxy()
  proxyClient.push(r.firstToken)
  proxyServer.push(r.serverTtft)
  console.log(
    `#${i + 1}  冷连接 ${f(cold.at(-1))}  直连(首字节 ${f(d.firstByte)} / 首token ${f(d.firstToken)})  ` +
      `代理(服务端 ${f(r.serverTtft)} / 客户端 ${f(r.firstToken)})  HTTP头 ${f(r.firstByte)}`,
  )
}

console.log('\n—— 结论 ——')
console.log(`冷连接（TLS 全握手）    p50 ${f(med(cold))}`)
console.log(`直连上游热连接          p50 ${f(med(direct))}   最小 ${f(min(direct))}`)
console.log(`代理内测到的上游首 token p50 ${f(med(proxyServer))}   最小 ${f(min(proxyServer))}`)
console.log(`代理 + 客户端感知        p50 ${f(med(proxyClient))}   最小 ${f(min(proxyClient))}`)
console.log(`代理自身开销（p50 差）  ${Math.round(med(proxyServer) - med(direct))}ms`)
console.log(`代理到浏览器的传输      ${Math.round(med(proxyClient) - med(proxyServer))}ms`)
console.log(`冷连接 vs 预热后        省 ${Math.round(med(cold) - med(proxyClient))}ms`)
