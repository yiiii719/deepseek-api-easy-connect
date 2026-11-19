// 上游协议适配：OpenAI 兼容 / Anthropic 兼容 / 内置 demo（无 key 也能跑通 UI）
// 只做两件事：把统一消息体翻译成各家请求体；把各家 SSE 翻译成统一增量事件。

export const DIALECTS = ['openai', 'anthropic', 'demo']

/**
 * 统一事件：
 *  { type:'reasoning', text }   思考增量
 *  { type:'content', text }     正文增量
 *  { type:'usage', usage }      token 统计
 *  { type:'stop', reason }      结束原因
 *  { type:'meta', model }       上游回显的模型名
 */

export function buildRequest(provider, opts) {
  const { messages, model, system, temperature, maxTokens, topP, thinking, extra } = opts
  const base = String(provider.baseUrl || '').replace(/\/+$/, '')
  const key = provider.apiKey || ''
  const dialect = provider.dialect || 'openai'

  if (dialect === 'anthropic') {
    const sys = system ? [{ type: 'text', text: system }] : undefined
    const body = {
      model,
      max_tokens: maxTokens || 4096,
      stream: true,
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ...(sys ? { system: sys } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(topP != null ? { top_p: topP } : {}),
      ...(thinking ? { thinking: { type: 'enabled', budget_tokens: Math.max(1024, Math.floor((maxTokens || 4096) / 2)) } } : {}),
      ...(extra || {}),
    }
    return {
      url: `${base}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': provider.anthropicVersion || '2023-06-01',
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify(body),
    }
  }

  // openai 兼容（DeepSeek 官方、绝大多数中转、Ollama、vLLM 都走这套）
  const all = [...(system ? [{ role: 'system', content: system }] : []), ...messages]
  const body = {
    model,
    messages: all.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    stream_options: { include_usage: true },
    ...(temperature != null ? { temperature } : {}),
    ...(topP != null ? { top_p: topP } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(extra || {}),
  }
  return {
    url: `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
    },
    body: JSON.stringify(body),
  }
}

/** 增量 SSE 帧解析：吃字节，吐 data 载荷字符串 */
export class SseDecoder {
  constructor() {
    this.buf = ''
    this.decoder = new TextDecoder('utf-8')
  }
  push(chunk) {
    this.buf += this.decoder.decode(chunk, { stream: true })
    const out = []
    let idx
    // 兼容 \r\n\r\n 与 \n\n
    while ((idx = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const frame = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, '')
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('data:')) out.push(line.slice(5).trimStart())
      }
    }
    return out
  }
}

export function translate(dialect, payload) {
  const events = []
  if (payload === '[DONE]') {
    events.push({ type: 'stop', reason: 'done' })
    return events
  }
  let j
  try {
    j = JSON.parse(payload)
  } catch {
    return events
  }
  if (!j || typeof j !== 'object') return events
  if (j.error) {
    events.push({ type: 'error', message: j.error.message || String(j.error) })
    return events
  }

  if (dialect === 'anthropic') {
    if (j.type === 'content_block_delta') {
      const d = j.delta || {}
      if (d.type === 'thinking_delta' && d.thinking) events.push({ type: 'reasoning', text: d.thinking })
      if (d.type === 'text_delta' && d.text) events.push({ type: 'content', text: d.text })
    } else if (j.type === 'content_block_start') {
      const cb = j.content_block || {}
      if (cb.type === 'text' && cb.text) events.push({ type: 'content', text: cb.text })
      if (cb.type === 'thinking' && cb.thinking) events.push({ type: 'reasoning', text: cb.thinking })
    } else if (j.type === 'message_delta') {
      if (j.usage) events.push({ type: 'usage', usage: j.usage })
      if (j.delta?.stop_reason) events.push({ type: 'stop', reason: j.delta.stop_reason })
    } else if (j.type === 'message_stop') {
      events.push({ type: 'stop', reason: 'message_stop' })
    } else if (j.type === 'message_start' && j.message) {
      events.push({ type: 'meta', model: j.message.model })
      if (j.message.usage) events.push({ type: 'usage', usage: j.message.usage })
    }
    return events
  }

  // openai
  if (j.model) events.push({ type: 'meta', model: j.model })
  const choice = j.choices?.[0]
  if (choice) {
    const d = choice.delta || {}
    const reasoning = d.reasoning_content ?? d.reasoning ?? d.thinking
    if (typeof reasoning === 'string' && reasoning) events.push({ type: 'reasoning', text: reasoning })
    if (typeof d.content === 'string' && d.content) events.push({ type: 'content', text: d.content })
    if (choice.finish_reason) events.push({ type: 'stop', reason: choice.finish_reason })
  }
  if (j.usage) events.push({ type: 'usage', usage: j.usage })
  return events
}

/** 演示方言：不需要任何 key，用来验收链路与 UI（本地吐字，速度=本机极限） */
export function demoStream(messages, onEvent, signal) {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const q = (last?.content || '').slice(0, 200)
  const reply =
    `**演示模式**（未配置上游 Key）：链路是通的，这里是我本地生成的占位回复。\n\n` +
    `你刚才问的是：\n\n> ${q || '（空）'}\n\n` +
    `接上真 Key 的两种方式：\n\n` +
    `1. 打开右上角「设置 → 接口」，填 Base URL + API Key；\n` +
    `2. 或者用环境变量 \`DS_API_KEY\` 启动服务。\n\n` +
    `\`\`\`bash\n# 官方\nDS_API_BASE=https://api.deepseek.com/v1 DS_MODEL=deepseek-chat pnpm start\n\`\`\`\n\n` +
    `| 能力 | 状态 |\n|---|---|\n| 流式渲染 | ✅ |\n| 深度思考块 | ✅ |\n| 会话持久化 | ✅ |\n| 文件解析 | ✅ |\n`
  const reasoning = '用户在演示模式下测试。先确认链路可用，再给出去哪里填 Key 的说明。'
  let i = 0
  let j = 0
  const t = setInterval(() => {
    if (signal?.aborted) return clearInterval(t)
    if (i < reasoning.length) {
      const step = 4
      onEvent({ type: 'reasoning', text: reasoning.slice(i, i + step) })
      i += step
      return
    }
    if (j < reply.length) {
      const step = 6
      onEvent({ type: 'content', text: reply.slice(j, j + step) })
      j += step
      return
    }
    clearInterval(t)
    onEvent({ type: 'usage', usage: { prompt_tokens: 32, completion_tokens: Math.ceil(reply.length / 2) } })
    onEvent({ type: 'stop', reason: 'stop' })
  }, 16)
  return () => clearInterval(t)
}
