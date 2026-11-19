// DeepSeek Clone — 前端主程序（原生 ES 模块，无构建、无框架）
import { render as md } from './md.js'

/* ───────────── 小工具 ───────────── */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
  return res.status === 204 ? null : res.json()
}

/** 顶栏标题：统一入口，保证长标题末尾省略（而不是两端都被切） */
function setTitle(text) {
  const box = document.getElementById('top-title')
  if (!box) return
  box.innerHTML = ''
  const span = document.createElement('span')
  span.className = 't'
  span.textContent = text || '潮汐'
  box.append(span)
}
function setBrandTitle() {
  const box = document.getElementById('top-title')
  if (box) box.innerHTML = '<span class="mark-sm"></span><span class="brand">潮汐</span>'
}

/* ───────────── 状态 ───────────── */const state = {
  settings: {},
  providers: [],
  conversations: [],
  activeId: null,
  messages: [],
  streaming: false,
  controller: null,
  attachments: [],
  editTargetId: null,
  pendingReasoning: '',
  pendingContent: '',
  pendingSearch: null,
  lastMeta: null,
  renderQueued: false,
  lastRender: 0,
  installPrompt: null,
}

/* ───────────── 启动 ───────────── */
init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#e5484d;white-space:pre-wrap">启动失败：${e.message}\n\n检查服务是否在运行：node server/index.mjs</pre>`
})

async function init() {
  const boot = await api('/api/bootstrap')
  state.settings = boot.settings
  state.providers = boot.providers
  state.conversations = boot.conversations
  $('#drawer-version').textContent = `v${boot.version} · ${boot.settings.providerId}`
  applyTheme()
  applyFontSize()
  bindEvents()
  syncModeChip()
  renderConversations()
  syncComposer()
  const last = state.conversations[0]
  if (last) await openConversation(last.id)
  else renderThread()
  registerSW()
  // ?q=xxx：直接开问（方便做桌面快捷方式 / 分享链接）
  const preset = new URLSearchParams(location.search).get('q')
  if (preset) {
    history.replaceState(null, '', location.pathname)
    newChat()
    $('#input').value = preset
    autoGrow()
    syncComposer()
    setTimeout(() => onSendClick(), 120)
    return
  }
  $('#input').focus({ preventScroll: true })
  maybeShowOnboarding()
}

/* ───────────── 主题 / 字号 ───────────── */
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme || 'auto'
}
function applyFontSize() {
  document.documentElement.style.setProperty('--fs', `${state.settings.fontSize || 16}px`)
}

/* ───────────── 事件绑定 ───────────── */
function bindEvents() {
  $('#btn-drawer').onclick = () => toggleDrawer(true)
  $('#drawer-mask').onclick = () => toggleDrawer(false)
  $('#btn-new').onclick = newChat
  $('#btn-new-2').onclick = () => {
    newChat()
    toggleDrawer(false)
  }
  $('#btn-settings').onclick = () => {
    toggleDrawer(false)
    openSettings()
  }
  $('#sheet-close').onclick = closeSettings
  $('#conv-search').oninput = () => renderConversations($('#conv-search').value)
  $('#btn-send').onclick = onSendClick
  $('#chip-attach').onclick = () => $('#file-input').click()
  $('#file-input').onchange = onFilesPicked
  $('#btn-mic').onclick = onMic
  $$('.chip-toggle').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.toggle
      state.settings[key] = !state.settings[key]
      syncComposer()
      saveSettings({ [key]: state.settings[key] })
    }
  })
  const input = $('#input')
  input.addEventListener('input', () => {
    autoGrow()
    syncComposer()
  })
  input.addEventListener('focus', () => $('#composer').classList.add('focus'))
  input.addEventListener('blur', () => $('#composer').classList.remove('focus'))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && state.settings.sendOnEnter !== false) {
      e.preventDefault()
      onSendClick()
    }
    if (e.key === 'Escape' && state.streaming) stopStreaming()
  })

  const scroller = $('#scroller')
  scroller.addEventListener(
    'scroll',
    () => {
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140
      $('#scroll-bottom').classList.toggle('show', !nearBottom)
      $('#topbar').classList.toggle('scrolled', scroller.scrollTop > 4)
    },
    { passive: true },
  )
  $('#scroll-bottom').onclick = () => scrollToBottom(true)
  $('#thread').addEventListener('click', onThreadClick)

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    state.installPrompt = e
  })
  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1)
    if (id && id !== state.activeId) openConversation(id)
  })
  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', () => {
      if (document.activeElement === input) scrollToBottom(false)
    })
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      toggleDrawer(true)
      $('#conv-search').focus()
    }
  })
}

/* ───────────── 抽屉 ───────────── */
function toggleDrawer(open) {
  $('#drawer').classList.toggle('show', open)
  $('#drawer-mask').classList.toggle('show', open)
  if (open) renderConversations($('#conv-search').value)
}

function groupOf(ts) {
  const d = new Date(ts)
  const today = new Date()
  const diff = (today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff <= 7) return '7 天内'
  if (diff <= 30) return '30 天内'
  return '更早'
}

function renderConversations(filter = '') {
  const list = $('#conv-list')
  list.innerHTML = ''
  const q = String(filter || '').trim().toLowerCase()
  const items = state.conversations.filter((c) => !q || (c.title || '').toLowerCase().includes(q))
  if (!items.length) {
    list.append(el('div', 'conv-group', q ? '没有匹配的对话' : '还没有对话'))
    return
  }
  let curGroup = ''
  for (const c of items) {
    const g = c.pinned ? '置顶' : groupOf(c.updatedAt || c.createdAt)
    if (g !== curGroup) {
      curGroup = g
      list.append(el('div', 'conv-group', g))
    }
    const item = el('div', 'conv-item' + (c.id === state.activeId ? ' active' : ''))
    item.dataset.id = c.id
    item.append(el('div', 't', c.title || '新对话'))
    if (c.pinned) item.append(el('span', 'pin', '置顶'))
    const more = el('button', 'more')
    more.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>'
    more.onclick = (e) => {
      e.stopPropagation()
      convMenu(c)
    }
    item.append(more)
    item.onclick = () => {
      toggleDrawer(false)
      openConversation(c.id)
    }
    list.append(item)
  }
}

function convMenu(c) {
  const action = window.prompt(`「${c.title}」\n\n输入：r 重命名 / p 置顶切换 / d 删除`, 'r')
  if (!action) return
  const a = action.trim().toLowerCase()
  if (a.startsWith('r')) {
    const title = window.prompt('新的标题', c.title)
    if (title) renameConv(c.id, title)
  } else if (a.startsWith('p')) {
    api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !c.pinned }) }).then(refreshConversations)
  } else if (a.startsWith('d')) {
    if (window.confirm(`删除「${c.title}」？此操作不可恢复`)) {
      api(`/api/conversations/${c.id}`, { method: 'DELETE' }).then(() => {
        if (state.activeId === c.id) newChat()
        refreshConversations()
      })
    }
  }
}

async function renameConv(id, title) {
  await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
  await refreshConversations()
  if (state.activeId === id) setTitle(title)
}

async function refreshConversations() {
  state.conversations = await api('/api/conversations')
  renderConversations($('#conv-search').value)
}

/* ───────────── 会话 ───────────── */
async function openConversation(id) {
  const conv = await api(`/api/conversations/${id}`)
  state.activeId = conv.id
  state.messages = conv.messages || []
  state.pendingReasoning = ''
  state.pendingContent = ''
  state.editTargetId = null
  history.replaceState(null, '', `#${conv.id}`)
  setTitle(conv.title || '潮汐')
  renderConversations($('#conv-search').value)
  renderThread()
  scrollToBottom(false)
}

function newChat() {
  if (state.streaming) stopStreaming()
  state.activeId = null
  state.messages = []
  state.attachments = []
  state.editTargetId = null
  state.pendingReasoning = ''
  state.pendingContent = ''
  history.replaceState(null, '', location.pathname)
  setBrandTitle()
  renderThread()
  renderAttachments()
  syncComposer()
  $('#input').focus({ preventScroll: true })
}

/* ───────────── 首次引导：没配 Key 就弹教程 ───────────── */

const OFFICIAL_BASE = 'https://api.deepseek.com/v1'

function currentProvider() {
  return state.providers.find((p) => p.id === state.settings.providerId) || state.providers[0] || null
}

/** 当前服务商有没有可用的 key（演示模式视为已就绪） */
function providerReady() {
  const pv = currentProvider()
  if (!pv) return false
  if (pv.id === 'demo') return true
  return !!pv.hasKey
}

function maybeShowOnboarding() {
  if (providerReady()) return
  if (localStorage.getItem('tide.onboard.seen') === '1') return
  openOnboarding(true)
}

/** 当前是不是演示模式 */
function isDemoMode() {
  const pv = currentProvider()
  return state.settings.providerId === 'demo' || (!!pv && pv.id === 'demo')
}

/** 顶栏那个常驻「演示」角标：点一下就回去填 Key */
function syncModeChip() {
  const chip = document.getElementById('mode-chip')
  if (!chip) return
  chip.hidden = !isDemoMode()
  chip.onclick = () => openOnboarding(false)
  chip.title = '当前是演示模式，点这里填 API Key'
}

/** 切到演示模式后的明确提示：给一条回填 Key 的路 */
function openDemoNotice() {
  if (document.getElementById('demo-notice')) return
  const mask = el('div', 'onboard')
  mask.id = 'demo-notice'
  const card = el('div', 'onboard-card')
  card.style.maxWidth = '360px'
  card.append(el('div', 'ob-kicker', 'DEMO · 演示模式'))
  card.append(el('h2', 'ob-title', '现在是演示模式'))
  card.append(
    el(
      'p',
      'ob-sub',
      '回复由 App 本地生成，不会调用真模型。想让 DeepSeek 真正回答，填上 API Key 就行，30 秒。',
    ),
  )
  const actions = el('div', 'ob-actions')
  const go = el('button', 'ob-primary')
  go.type = 'button'
  go.textContent = '去填 API Key'
  go.onclick = () => {
    mask.remove()
    openOnboarding(false)
  }
  const stay = el('button', 'ob-secondary', '继续体验演示')
  stay.type = 'button'
  stay.onclick = () => mask.remove()
  actions.append(go, stay)
  card.append(actions)
  mask.append(card)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove()
  })
  document.body.append(mask)
}

let onboardClose = null

function openOnboarding(firstRun) {
  if (document.getElementById('onboard')) return
  const pv = currentProvider() || {}
  const isDemo = pv.id === 'demo'

  const mask = el('div', 'onboard')
  mask.id = 'onboard'
  const card = el('div', 'onboard-card')

  card.append(el('div', 'ob-kicker', 'TIDE · 30 秒上手'))
  card.append(el('h2', 'ob-title', firstRun ? '先把 API Key 接上' : '接口配置'))
  card.append(
    el(
      'p',
      'ob-sub',
      '这个 App 不卖额度、也不经我们的服务器：它直接调用你填的接口。一次配置，之后随便聊。',
    ),
  )

  const steps = el('ol', 'ob-steps')
  steps.innerHTML = `
    <li><span>去 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener"><b>platform.deepseek.com</b></a> 注册 → 「API keys」→ 创建，复制 <code>sk-...</code></span></li>
    <li><span>粘到下面。接口地址已经预填官方 <code>${OFFICIAL_BASE}</code></span></li>
    <li><span>点「保存并测试」，看到绿色的首字延迟就成功了</span></li>`
  card.append(steps)

  // 接口地址
  const baseField = el('div', 'ob-field')
  baseField.append(el('label', null, '接口地址（Base URL）'))
  const baseInput = el('input')
  baseInput.type = 'text'
  baseInput.value = pv.baseUrl || OFFICIAL_BASE
  baseInput.placeholder = OFFICIAL_BASE
  baseField.append(baseInput)
  card.append(baseField)

  // API Key
  const keyField = el('div', 'ob-field')
  keyField.append(el('label', null, 'API Key'))
  const keyRow = el('div', 'ob-key-row')
  const keyInput = el('input')
  keyInput.type = 'password'
  keyInput.placeholder = 'sk-...'
  keyInput.autocomplete = 'off'
  keyInput.spellcheck = false
  const showBtn = el('button', null, '显示')
  showBtn.type = 'button'
  showBtn.onclick = () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password'
    showBtn.textContent = keyInput.type === 'password' ? '显示' : '隐藏'
  }
  keyRow.append(keyInput, showBtn)
  keyField.append(keyRow)
  card.append(keyField)

  const msg = el('div', 'ob-msg', isDemo ? '当前是演示模式，填 Key 后就能接真模型' : '')
  card.append(msg)

  const actions = el('div', 'ob-actions')

  const primary = el('button', 'ob-primary')
  primary.type = 'button'
  primary.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg><span>保存并测试</span>'
  actions.append(primary)

  const demoBtn = el('button', 'ob-secondary', '先用演示模式看看（不需要 Key）')
  demoBtn.type = 'button'
  actions.append(demoBtn)

  const skip = el('button', 'ob-skip', '以后再说')
  skip.type = 'button'
  actions.append(skip)
  card.append(actions)

  card.append(
    el(
      'div',
      'ob-note',
      'Key 只存在这台设备上（APK 在应用私有目录，网页版在服务端数据库），不会经过任何第三方。' +
        '官方 API 按量计费，以官网价格为准；也可以填任何 OpenAI 兼容的中转地址。',
    ),
  )

  mask.append(card)
  document.body.append(mask)
  onboardClose = () => {
    mask.remove()
    onboardClose = null
  }

  skip.onclick = () => {
    localStorage.setItem('tide.onboard.seen', '1')
    onboardClose?.()
  }

  demoBtn.onclick = async () => {
    demoBtn.disabled = true
    demoBtn.textContent = '切换中…'
    try {
      await saveSettings({ providerId: 'demo', model: 'demo' })
      const boot = await api('/api/bootstrap')
      state.providers = boot.providers
      state.settings = boot.settings
      localStorage.setItem('tide.onboard.seen', '1')
      onboardClose?.()
      newChat()
      syncModeChip()
      openDemoNotice()
    } catch (e) {
      demoBtn.disabled = false
      demoBtn.textContent = '先用演示模式看看（不需要 Key）'
      msg.className = 'ob-msg err'
      msg.textContent = `切换失败：${e.message}`
    }
  }

  primary.onclick = async () => {
    const key = keyInput.value.trim()
    const baseUrl = baseInput.value.trim() || OFFICIAL_BASE
    if (!key) {
      msg.className = 'ob-msg err'
      msg.textContent = '先填 API Key；没有的话去 platform.deepseek.com 创建一个'
      keyInput.classList.add('bad')
      keyInput.focus()
      setTimeout(() => keyInput.classList.remove('bad'), 1500)
      return
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      msg.className = 'ob-msg err'
      msg.textContent = '接口地址要以 http:// 或 https:// 开头'
      return
    }
    primary.disabled = true
    primary.querySelector('span').textContent = '保存中…'
    msg.className = 'ob-msg'
    msg.textContent = '正在保存配置…'
    try {
      // 模型不暴露给用户，交给服务端用默认（deepseek-flash，开深度思考自动换 pro）
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          providerId: 'deepseek',
          model: '',
          providers: [{ id: 'deepseek', baseUrl, apiKey: key }],
        }),
      })
      const boot = await api('/api/bootstrap')
      state.providers = boot.providers
      state.settings = boot.settings
      msg.textContent = '配置已存，正在测试连接…'
      primary.querySelector('span').textContent = '测试中…'

      let result
      try {
        result = await api('/api/bench?provider=deepseek')
      } catch (e) {
        result = { ttft: -1, error: e.message }
      }
      const ok = result && typeof result.ttft === 'number' && result.ttft > 0
      if (ok) {
        msg.className = 'ob-msg ok'
        msg.textContent = `连接正常 · 首字 ${result.ttft}ms`
        localStorage.setItem('tide.onboard.seen', '1')
        primary.querySelector('span').textContent = '搞定'
        setTimeout(() => {
          onboardClose?.()
          newChat()
          syncModeChip()
          toast('配置完成，开始聊吧')
        }, 900)
      } else {
        msg.className = 'ob-msg err'
        msg.textContent =
          (result && (result.error || (result.ttft === -1 ? '上游没响应，检查 Key 或地址' : ''))) ||
          '测试失败：检查 Key 是否有效、地址是否可达'
        primary.disabled = false
        primary.querySelector('span').textContent = '再试一次'
      }
    } catch (e) {
      msg.className = 'ob-msg err'
      msg.textContent = `保存失败：${e.message}`
      primary.disabled = false
      primary.querySelector('span').textContent = '保存并测试'
    }
  }

  setTimeout(() => keyInput.focus(), 120)
}

/* ───────────── 空态 ───────────── */
const SUGGESTS = [
  { t: '写点代码', s: '读 CSV、算缺失率、出图', q: '写一个 Python 脚本：读取 CSV 文件，统计每列缺失率，并用 matplotlib 画出柱状图', i: 'code' },
  { t: '讲清一个概念', s: '用生活比喻说明三次握手', q: '用生活里的例子解释 TCP 三次握手，并说明为什么需要三次而不是两次', i: 'book' },
  { t: '翻译 / 润色', s: '中文自我介绍改成地道英文', q: '把我这段中文自我介绍翻译成地道英文，并说明改动的理由：\n\n我是…', i: 'lang' },
  { t: '做取舍分析', s: 'SSE 与 WebSocket 怎么选', q: '对比 SSE 与 WebSocket 在移动端聊天场景下的取舍，给出结论和理由', i: 'scale' },
]

const ICONS = {
  code: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2 2 0 0 1 6 4h5v16H6a2 2 0 0 1-2-2z"/><path d="M20 5.5A2 2 0 0 0 18 4h-5v16h5a2 2 0 0 0 2-2z"/></svg>',
  lang: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M8.5 6c0 6-2 9-4.5 11"/><path d="M12 20l4-10 4 10M13.4 17h5.2"/></svg>',
  scale: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M6 8h12M4 14l2-6 2 6a2.6 2.6 0 0 1-4 0zM16 14l2-6 2 6a2.6 2.6 0 0 1-4 0z"/></svg>',
}

function greetingByHour() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function renderSuggestions() {
  const wrap = el('section', 'empty')
  if (!providerReady()) {
    const banner = el('button', 'banner')
    banner.type = 'button'
    banner.innerHTML = '<b>还没填 API Key</b><span>点这里，30 秒配好</span><span class="chev">›</span>'
    banner.onclick = () => openOnboarding(false)
    wrap.append(banner)
  } else if (isDemoMode()) {
    const banner = el('button', 'banner demo')
    banner.type = 'button'
    banner.innerHTML = '<b>演示模式</b><span>回复是本地生成的 · 点这里填 API Key 接真模型</span><span class="chev">›</span>'
    banner.onclick = () => openOnboarding(false)
    wrap.append(banner)
  }
  wrap.append(el('div', 'empty-kicker', 'TIDE · 本地推理'))
  wrap.append(el('h1', null, `${greetingByHour()}，想聊点什么？`))
  wrap.append(el('p', null, '接你自己的 API Key，对话只存在这台设备上'))
  const list = el('div', 'suggests')
  for (const s of SUGGESTS) {
    const row = el('button', 'suggest')
    row.dataset.q = s.q
    const ico = el('span', 'ico')
    ico.innerHTML = ICONS[s.i] || ICONS.code
    row.append(ico)
    const txt = el('span')
    txt.append(el('b', null, s.t))
    txt.append(el('span', null, s.s))
    row.append(txt)
    row.append(el('span', 'arrow', '›'))
    list.append(row)
  }
  wrap.append(list)
  $('#thread').append(wrap)
  $('#thread').classList.add('is-empty')
}

/* ───────────── 渲染消息 ───────────── */
function renderThread() {
  const thread = $('#thread')
  thread.innerHTML = ''
  thread.classList.toggle('is-empty', state.messages.length === 0)
  if (!state.messages.length) {
    renderSuggestions()
    return
  }
  for (const m of state.messages) thread.append(messageNode(m))
}

function messageNode(m) {
  const node = el('div', `msg ${m.role}`)
  node.dataset.id = m.id
  if (m.role === 'user') {
    const bubble = el('div', 'bubble')
    bubble.textContent = m.content
    node.append(bubble)
    const atts = m.meta?.attachments || []
    if (atts.length) {
      const row = el('div', 'attach-row')
      for (const a of atts) {
        const chip = el('div', 'attach-chip')
        chip.append(el('span', null, `📄 ${a.name || '文件'}`))
        row.append(chip)
      }
      node.append(row)
    }
    const acts = el('div', 'actions')
    acts.append(actionBtn('复制', () => copy(m.content)), actionBtn('编辑', () => editMessage(m)))
    node.append(acts)
  } else {
    const avatar = el('div', 'avatar', '潮')
    node.append(avatar)
    const body = el('div', 'body-wrap')
    body.append(assistantHead(m))
    if (m.reasoning) body.append(reasoningNode(m.reasoning, m.meta?.reasoningMs))
    if (m.meta?.citations?.length) body.append(searchNode(m.meta.citations, m.meta.searchQuery))
    const mdBody = el('div', 'msg-body md')
    mdBody.innerHTML = md(m.content || '')
    body.append(mdBody)
    if (m.meta?.stopReason === 'length') {
      const note = el('div', 'inline-note')
      note.textContent = m.content ? '输出达到上限，点「继续」接着写。' : '这次只产出了思考过程就撞到上限，点「继续」或加大最大输出 token。'
      body.append(note)
    }
    body.append(assistantActions(m))
    node.append(body)
  }
  return node
}

function timeLabel(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function assistantHead(m) {
  const head = el('div', 'msg-head')
  head.append(el('span', 'model', m.meta?.model || state.settings.model || '模型'))
  const t = timeLabel(m.createdAt)
  if (t) {
    head.append(el('span', 'sep'))
    head.append(el('span', null, t))
  }
  return head
}

function reasoningNode(reasonText, ms) {
  const d = el('details', 'reason')
  const sum = el('summary')
  sum.append(el('span', 'dot-static'))
  sum.append(el('span', 'tag', '思考'))
  const chars = reasonText.length
  sum.append(el('span', null, ms ? `用时 ${(ms / 1000).toFixed(1)}s · ${chars} 字` : `${chars} 字`))
  d.append(sum)
  d.append(el('div', 'reason-text', reasonText))
  if (reasonText.length < 260) d.open = true
  return d
}

function searchNode(citations, query) {
  const d = el('details', 'search-block')
  const sum = el('summary')
  sum.append(el('span', 'tag', '联网'))
  sum.append(el('span', null, query ? `「${query}」· ${citations.length} 条来源` : `${citations.length} 条来源`))
  d.append(sum)
  const ol = el('ol')
  for (const c of citations) {
    const li = el('li')
    const a = el('a', null, c.title || c.url)
    a.href = c.url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    li.append(a)
    if (c.snippet) li.append(el('div', 'src-title', c.snippet.slice(0, 160)))
    ol.append(li)
  }
  d.append(ol)
  d.open = citations.length <= 3
  return d
}

function assistantActions(m) {
  const acts = el('div', 'actions')
  acts.append(
    actionBtn('复制', () => copy(m.content)),
    actionBtn('重新生成', () => regenerate(m)),
    actionBtn('继续', () => continueAnswer()),
    actionBtn('删除', () => deleteMessage(m)),
  )
  acts.append(el('span', 'stats', statsText(m.meta)))
  return acts
}

function statsText(meta) {
  if (!meta || state.settings.showStats === false) return ''
  const parts = []
  if (meta.ttft) parts.push(`首字 ${meta.ttft}ms`)
  if (meta.timing && meta.timing.reused === false && meta.timing.tlsMs) parts.push(`新建连接 ${meta.timing.tlsMs}ms`)
  if (meta.usage?.completion_tokens && meta.ms) parts.push(`${(meta.usage.completion_tokens / (meta.ms / 1000)).toFixed(0)} tok/s`)
  if (meta.ms) parts.push(`${(meta.ms / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

function actionBtn(label, fn) {
  const b = el('button', null, label)
  b.type = 'button'
  b.onclick = (e) => {
    e.stopPropagation()
    fn()
  }
  return b
}

/* ───────────── 流式节点 ───────────── */
function streamingNode() {
  const node = el('div', 'msg assistant streaming')
  node.id = 'msg-streaming'
  node.append(el('div', 'avatar', '潮'))
  const wrap = el('div', 'body-wrap')
  wrap.append(assistantHead({ meta: { model: state.lastMeta?.model }, createdAt: Date.now() }))
  const search = el('div')
  search.id = 'stream-search'
  wrap.append(search)
  const reason = el('details', 'reason')
  reason.id = 'stream-reason'
  reason.open = true
  reason.hidden = true
  const sum = el('summary')
  sum.append(el('span', 'spin'))
  sum.append(el('span', 'tag', '思考'))
  sum.append(el('span', null, '进行中…'))
  reason.append(sum)
  const rtext = el('div', 'reason-text')
  rtext.id = 'stream-reason-text'
  reason.append(rtext)
  wrap.append(reason)
  const body = el('div', 'msg-body md')
  body.id = 'stream-body'
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'
  wrap.append(body)
  node.append(wrap)
  return node
}

function scheduleStreamRender() {
  if (state.renderQueued) return
  state.renderQueued = true
  requestAnimationFrame(() => {
    state.renderQueued = false
    const now = performance.now()
    if (now - state.lastRender < 60) {
      setTimeout(scheduleStreamRender, 60)
      return
    }
    state.lastRender = now
    paintStream()
  })
}

function paintStream() {
  const body = $('#stream-body')
  if (!body) return
  const text = state.pendingContent
  if (text) {
    if (text.length > 20000) {
      body.textContent = text
      body.classList.remove('md')
    } else {
      body.classList.add('md')
      body.innerHTML = md(text) + '<span class="cursor"></span>'
    }
  }
  const reason = $('#stream-reason')
  if (reason && state.pendingReasoning) {
    reason.hidden = false
    $('#stream-reason-text').textContent = state.pendingReasoning
  }
  if (autoScrollEnabled()) scrollToBottom(false)
}

/* ───────────── 发送 ───────────── */
function onSendClick() {
  if (state.streaming) return stopStreaming()
  const text = $('#input').value.trim()
  if (!text && !state.attachments.length) return
  send(text)
}

async function send(text, { regenerate = false } = {}) {
  const atts = state.attachments.map((a) => a.id)
  const attachMeta = state.attachments.map((a) => ({ name: a.name, chars: a.chars }))

  if (!regenerate) {
    state.messages.push({ id: `tmp-${Date.now()}`, role: 'user', content: text, meta: { attachments: attachMeta } })
    $('#input').value = ''
    autoGrow()
    state.attachments = []
    renderAttachments()
    $('#thread').innerHTML = ''
    for (const m of state.messages) $('#thread').append(messageNode(m))
  } else {
    const lastA = [...state.messages].reverse().find((m) => m.role === 'assistant')
    if (lastA) state.messages = state.messages.filter((m) => m.id !== lastA.id)
    $('#thread').innerHTML = ''
    for (const m of state.messages) $('#thread').append(messageNode(m))
  }

  state.streaming = true
  state.controller = new AbortController()
  state.pendingReasoning = ''
  state.pendingContent = ''
  state.lastMeta = null
  syncComposer()
  $('#thread').append(streamingNode())
  scrollToBottom(true)

  const t0 = performance.now()

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: state.controller.signal,
      body: JSON.stringify({
        convId: state.activeId,
        text: regenerate ? '' : text,
        regenerate,
        truncateFrom: regenerate ? undefined : state.editTargetId || undefined,
        attachments: atts,
        thinking: state.settings.thinking,
        search: state.settings.search,
      }),
    })
    if (!res.ok || !res.body) throw new Error(await res.text())

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let doneInfo = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let evName = 'message'
        let data = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        let payload
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }
        switch (evName) {
          case 'meta': {
            state.lastMeta = payload
            if (!state.activeId) {
              state.activeId = payload.convId
              history.replaceState(null, '', `#${payload.convId}`)
            }
            if (payload.title) setTitle(payload.title)
            break
          }
          case 'search_start': {
            const host = $('#stream-search')
            if (host) host.innerHTML = `<div class="search-block"><summary style="color:var(--text-3);font-size:13px">正在搜索「${escapeHtml(payload.query)}」…</summary></div>`
            break
          }
          case 'search': {
            const host = $('#stream-search')
            if (host && (payload.citations || payload.results)) {
              host.innerHTML = ''
              host.append(searchNode(payload.citations || payload.results, payload.query))
            }
            state.pendingSearch = payload
            break
          }
          case 'reasoning': {
            state.pendingReasoning += payload.t
            const r = $('#stream-reason')
            if (r && r.hidden) r.hidden = false
            scheduleStreamRender()
            break
          }
          case 'content': {
            state.pendingContent += payload.t
            const sb = $('#stream-body')
            if (sb && sb.querySelector('.typing')) sb.innerHTML = ''
            scheduleStreamRender()
            break
          }
          case 'demo':
            toast('演示模式：去「设置 → 接口」填上 API Key 就能接真模型')
            break
          case 'error':
            doneInfo = { error: payload.message }
            break
          case 'done':
            // 保留之前的错误：服务端会先发 error 再发 done，别把错误覆盖掉
            doneInfo = { ...payload, error: (doneInfo && doneInfo.error) || payload.error }
            break
        }
      }
    }

    const stats = doneInfo?.stats || {}
    const finalContent = doneInfo?.content ?? state.pendingContent
    const finalReasoning = doneInfo?.reasoning ?? state.pendingReasoning
    $('#msg-streaming')?.remove()
    if (doneInfo?.error) {
      const errNode = el('div', 'msg assistant')
      errNode.append(el('div', 'avatar', '潮'))
      const wrap = el('div', 'body-wrap')
      wrap.append(assistantHead({ meta: { model: stats.model }, createdAt: Date.now() }))
      const b = el('div', 'msg-body')
      b.innerHTML = `<p style="color:var(--danger);margin:0 0 6px">请求失败：${escapeHtml(doneInfo.error)}</p>`
      wrap.append(b)
      if (!providerReady()) {
        const go = el('button', 'ob-secondary', '去填 API Key')
        go.style.maxWidth = '180px'
        go.onclick = () => openOnboarding(false)
        wrap.append(go)
      }
      errNode.append(wrap)
      $('#thread').append(errNode)
    } else if (finalContent || finalReasoning) {
      const msg = {
        id: doneInfo?.messageId || `a-${Date.now()}`,
        role: 'assistant',
        content: finalContent,
        reasoning: finalReasoning,
        meta: {
          ...stats,
          citations: doneInfo?.citations || state.pendingSearch?.citations,
          searchQuery: state.pendingSearch?.query,
          ttft: stats.ttft ?? Math.round(performance.now() - t0),
        },
      }
      state.messages.push(msg)
      $('#thread').append(messageNode(msg))
    }
    state.pendingContent = ''
    state.pendingReasoning = ''
    state.pendingSearch = null
    scrollToBottom(true)
    refreshConversations().catch(() => {})
  } catch (e) {
    $('#msg-streaming')?.remove()
    if (e.name === 'AbortError') {
      if (state.pendingContent || state.pendingReasoning) {
        const msg = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: state.pendingContent,
          reasoning: state.pendingReasoning,
          meta: { stopReason: 'aborted', ms: Math.round(performance.now() - t0) },
        }
        state.messages.push(msg)
        $('#thread').append(messageNode(msg))
      }
      state.pendingContent = ''
      state.pendingReasoning = ''
      toast('已停止生成')
      refreshConversations().catch(() => {})
    } else {
      toast(`出错了：${e.message}`)
    }
  } finally {
    state.streaming = false
    state.controller = null
    state.editTargetId = null
    syncComposer()
  }
}

function stopStreaming() {
  state.controller?.abort()
}

function regenerate(m) {
  if (state.streaming) return
  const idx = state.messages.findIndex((x) => x.id === m.id)
  state.messages = state.messages.slice(0, Math.max(0, idx))
  $('#thread').innerHTML = ''
  for (const x of state.messages) $('#thread').append(messageNode(x))
  send('', { regenerate: true })
}

function continueAnswer() {
  $('#input').value = '继续'
  onSendClick()
}

async function deleteMessage(m) {
  if (!window.confirm('删除这条消息？')) return
  if (state.activeId && m.id && !m.id.startsWith('tmp-')) {
    await api(`/api/conversations/${state.activeId}/messages/${m.id}`, { method: 'DELETE' }).catch(() => {})
  }
  state.messages = state.messages.filter((x) => x.id !== m.id)
  renderThread()
}

function editMessage(m) {
  state.editTargetId = m.id
  $('#input').value = m.content
  autoGrow()
  syncComposer()
  $('#input').focus()
  toast('改完直接发送：这条之后的消息会被替换')
}

/* ───────────── 附件 ───────────── */
async function onFilesPicked(e) {
  const files = [...(e.target.files || [])]
  e.target.value = ''
  for (const f of files) {
    if (f.size > 12 * 1024 * 1024) {
      toast(`${f.name} 太大了（>12MB）`)
      continue
    }
    toast(`解析 ${f.name}…`)
    try {
      const data = await fileToBase64(f)
      const r = await api('/api/attachments', { method: 'POST', body: JSON.stringify({ name: f.name, mime: f.type, data }) })
      state.attachments.push({ id: r.id, name: r.name, chars: r.chars })
      renderAttachments()
      syncComposer()
      toast(`已加入上下文：${f.name}（${r.chars} 字）`)
    } catch (err) {
      toast(`解析失败：${err.message}`)
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '')
    fr.onerror = () => reject(new Error('读取失败'))
    fr.readAsDataURL(file)
  })
}

function renderAttachments() {
  const row = $('#attach-row')
  row.innerHTML = ''
  for (const a of state.attachments) {
    const chip = el('div', 'attach-chip')
    chip.append(el('span', null, `📄 ${a.name} · ${a.chars}字`))
    const x = el('button', null, '×')
    x.onclick = () => {
      state.attachments = state.attachments.filter((z) => z.id !== a.id)
      renderAttachments()
      syncComposer()
    }
    chip.append(x)
    row.append(chip)
  }
}

/* ───────────── 输入区状态 ───────────── */
function autoGrow() {
  const ta = $('#input')
  ta.style.height = 'auto'
  ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`
}

function syncComposer() {
  const hasText = $('#input').value.trim().length > 0 || state.attachments.length > 0
  const send = $('#btn-send')
  send.disabled = !state.streaming && !hasText
  send.classList.toggle('stop', state.streaming)
  send.innerHTML = state.streaming
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
  for (const b of $$('.chip-toggle')) b.classList.toggle('on', !!state.settings[b.dataset.toggle])
}

/* ───────────── 滚动 ───────────── */
function autoScrollEnabled() {
  const s = $('#scroller')
  return s.scrollHeight - s.scrollTop - s.clientHeight < 160
}
function scrollToBottom(force) {
  const s = $('#scroller')
  if (!force && !autoScrollEnabled()) return
  requestAnimationFrame(() => {
    s.scrollTop = s.scrollHeight
  })
}

/* ───────────── 点击委托 ───────────── */
function onThreadClick(e) {
  const copyBtn = e.target.closest('[data-copy-code]')
  if (copyBtn) {
    const code = copyBtn.closest('.code-block')?.querySelector('code')?.textContent || ''
    copy(code)
    copyBtn.textContent = '已复制'
    setTimeout(() => (copyBtn.textContent = '复制'), 1200)
    return
  }
  const sugg = e.target.closest('.suggest')
  if (sugg) {
    $('#input').value = sugg.dataset.q
    autoGrow()
    syncComposer()
    onSendClick()
  }
}

/* ───────────── 设置面板 ───────────── */
function openSettings() {
  const body = $('#sheet-body')
  const s = state.settings
  const pv = state.providers.find((p) => p.id === s.providerId) || state.providers[0]
  body.innerHTML = ''

  const provSection = section('接口（API 接入）')
  provSection.append(
    rowButtons([
      [
        '配置向导 / 使用说明',
        () => {
          closeSettings()
          openOnboarding(false)
        },
      ],
    ]),
  )
  provSection.append(
    field('服务商', selectNode(state.providers.map((p) => ({ v: p.id, t: p.name })), s.providerId, onProviderChange)),
    field('Base URL', inputNode(pv.baseUrl || '', (v) => saveProvider({ baseUrl: v }), { placeholder: 'https://api.deepseek.com/v1' })),
    field('API Key', passwordNode('', (v) => saveProvider({ apiKey: v })), 'key 只存在本机（APK 在应用私有目录，Node 版在 SQLite），不会外发；留空表示不修改'),
    (() => {
      // 模型交给服务端默认（deepseek-flash；开深度思考自动换 pro），普通用户不用管
      const adv = el('details', 'adv')
      adv.append(el('summary', null, '高级：模型设置'))
      const body = el('div', 'adv-body')
      body.append(
        field(
          '模型（留空 = 默认）',
          inputNode(s.model || '', (v) => saveSettings({ model: v }), { placeholder: pv.defaultModel || 'deepseek-flash' }),
          '默认 deepseek-flash；只有想指定别的模型时才填',
        ),
        field('深度思考用的模型', inputNode(pv.thinkingModel || '', (v) => saveProvider({ thinkingModel: v }), { placeholder: 'deepseek-v4-pro' })),
      )
      adv.append(body)
      return adv
    })(),    rowButtons([
      [
        '测试首字延迟',
        async (btn) => {
          const cur = currentProvider()
          if (!cur) return toast('先选一个服务商')
          if (cur.id === 'demo') {
            toast('演示模式是本地生成的，不用测延迟；填了 Key 再测真上游')
            return
          }
          if (!cur.hasKey) {
            toast('还没填 API Key：先在上面 Key 输入框填一下，再点测试')
            const keyBox = document.querySelector('.field input[type="password"]')
            if (keyBox) {
              keyBox.focus()
              keyBox.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
            return
          }
          btn.textContent = '测试中…'
          try {
            const r = await api(`/api/bench?provider=${encodeURIComponent(s.providerId)}&model=${encodeURIComponent(s.model || pv.defaultModel || '')}`)
            if (r.error) {
              btn.textContent = '失败'
              toast(`测试失败：${r.error}`)
              return
            }
            btn.textContent = r.ttft ? `首字 ${r.ttft}ms` : '无响应'
            toast(r.ttft ? `上游首字延迟 ${r.ttft}ms（含连接复用）` : '上游没回内容，检查 Key 或地址')
          } catch (e) {
            btn.textContent = '失败'
            toast(`测试失败：${e.message}`)
          }
        },
      ],
      [
        '拉模型列表',
        async (btn) => {
          btn.textContent = '拉取中…'
          try {
            const r = await api(`/api/models?provider=${encodeURIComponent(s.providerId)}`)
            btn.textContent = `共 ${r.models.length} 个`
            toast(r.models.slice(0, 10).join(' / '))
          } catch (e) {
            btn.textContent = '失败'
            toast(e.message)
          }
        },
      ],
    ]),
  )
  body.append(provSection)

  const genSection = section('生成参数')
  genSection.append(
    sliderField('温度', s.temperature ?? 1, 0, 2, 0.1, (v) => saveSettings({ temperature: v })),
    sliderField('最大输出 token', s.maxTokens ?? 4096, 256, 32768, 256, (v) => saveSettings({ maxTokens: v })),
    sliderField('历史上下文预算（字）', s.contextChars ?? 24000, 4000, 120000, 1000, (v) => saveSettings({ contextChars: v })),
    textareaField('系统提示词（人设）', s.system || '', (v) => saveSettings({ system: v }), '例如：你是一位耐心的中文技术顾问，回答尽量给可执行步骤。'),
  )
  body.append(genSection)

  const uiSection = section('界面')
  uiSection.append(
    field(
      '主题',
      selectNode(
        [
          { v: 'auto', t: '跟随系统' },
          { v: 'light', t: '浅色' },
          { v: 'dark', t: '深色' },
        ],
        s.theme || 'auto',
        (v) => {
          saveSettings({ theme: v })
          applyTheme()
        },
      ),
    ),
    sliderField('正文字号', s.fontSize || 16, 13, 20, 1, (v) => {
      saveSettings({ fontSize: v })
      applyFontSize()
    }),
    toggleRow('显示每条回答的速度统计', s.showStats !== false, (on) => saveSettings({ showStats: on })),
    toggleRow('回车发送（关闭后回车换行）', s.sendOnEnter !== false, (on) => saveSettings({ sendOnEnter: on })),
  )
  body.append(uiSection)

  const searchSection = section('联网搜索')
  searchSection.append(
    field(
      '搜索源',
      selectNode(
        [
          { v: 'bing', t: 'Bing RSS（免 Key，最快）' },
          { v: 'ddg', t: 'DuckDuckGo（免 Key，可能被墙）' },
          { v: 'off', t: '关闭' },
        ],
        s.searchProvider || 'bing',
        (v) => saveSettings({ searchProvider: v }),
      ),
      null,
      '要更稳的结果：服务端配 SERPER_KEY / TAVILY_KEY / BRAVE_KEY 之一即可',
    ),
  )
  body.append(searchSection)

  const dataSection = section('数据与网关')
  const origin = location.origin
  dataSection.append(
    field(
      'OpenAI 兼容网关（给其他 App / CLI 用）',
      null,
      null,
      `Base URL：<span class="mono">${origin}/v1</span><br>API Key：任意（服务端设了 DS_GATEWAY_KEY 则填那个）<br>模型名：填上面配的模型`,
    ),
    rowButtons([
      [
        '导出全部对话',
        async () => {
          const all = []
          for (const c of state.conversations) all.push(await api(`/api/conversations/${c.id}`))
          downloadJson(all, `tide-chats-${Date.now()}.json`)
        },
      ],
      [
        '清空全部对话',
        async () => {
          if (!window.confirm('清空所有对话？不可恢复')) return
          for (const c of state.conversations) await api(`/api/conversations/${c.id}`, { method: 'DELETE' })
          state.conversations = []
          newChat()
          renderConversations()
          toast('已清空')
        },
      ],
      [
        '安装到桌面',
        async (btn) => {
          if (state.installPrompt) {
            state.installPrompt.prompt()
            state.installPrompt = null
          } else {
            btn.textContent = '用浏览器菜单安装'
            setTimeout(() => (btn.textContent = '安装到桌面'), 2000)
          }
        },
      ],
    ]),
    el('div', 'hint', `后端 ${location.host}`),
  )
  body.append(dataSection)

  $('#sheet').classList.add('show')
  $('#sheet').setAttribute('aria-hidden', 'false')
}

function closeSettings() {
  $('#sheet').classList.remove('show')
  $('#sheet').setAttribute('aria-hidden', 'true')
}

function section(title) {
  const g = el('div', 'group')
  g.append(el('h3', null, title))
  return g
}
function field(label, control, hint) {
  const f = el('div', 'field')
  if (label) f.append(el('label', null, label))
  if (control) f.append(control)
  if (hint) {
    const h = el('small')
    h.innerHTML = hint
    f.append(h)
  }
  return f
}
function inputNode(value, onChange, opts = {}) {
  const i = el('input')
  i.type = opts.type || 'text'
  i.value = value ?? ''
  if (opts.placeholder) i.placeholder = opts.placeholder
  i.onchange = () => onChange(i.value.trim())
  return i
}
function passwordNode(value, onChange) {
  const wrap = el('div', 'row')
  const i = el('input')
  i.type = 'password'
  i.placeholder = 'sk-... （已配置则留空）'
  i.value = value || ''
  i.onchange = () => onChange(i.value.trim())
  const toggle = el('button', 'btn', '显示')
  toggle.type = 'button'
  toggle.onclick = () => {
    i.type = i.type === 'password' ? 'text' : 'password'
    toggle.textContent = i.type === 'password' ? '显示' : '隐藏'
  }
  wrap.append(i, toggle)
  return wrap
}
function selectNode(options, value, onChange) {
  const sel = el('select')
  for (const o of options) {
    const opt = el('option', null, o.t)
    opt.value = o.v
    sel.append(opt)
  }
  sel.value = value
  sel.onchange = () => onChange(sel.value)
  return sel
}
function sliderField(label, value, min, max, step, onChange) {
  const f = el('div', 'field')
  const l = el('label', null, `${label}：${value}`)
  const r = el('input')
  r.type = 'range'
  r.min = min
  r.max = max
  r.step = step
  r.value = value
  r.oninput = () => {
    l.textContent = `${label}：${r.value}`
  }
  r.onchange = () => onChange(Number(r.value))
  f.append(l, r)
  return f
}
function textareaField(label, value, onChange, placeholder) {
  const f = el('div', 'field')
  f.append(el('label', null, label))
  const t = el('textarea')
  t.rows = 3
  t.value = value || ''
  t.placeholder = placeholder || ''
  t.onchange = () => onChange(t.value)
  f.append(t)
  return f
}
function toggleRow(label, on, onChange) {
  const row = el('div', 'inline-row')
  row.append(el('span', null, label))
  const sw = el('button', 'switch' + (on ? ' on' : ''))
  sw.type = 'button'
  sw.onclick = () => {
    const next = !sw.classList.contains('on')
    sw.classList.toggle('on', next)
    onChange(next)
  }
  row.append(sw)
  return row
}
function rowButtons(list) {
  const wrap = el('div', 'field')
  wrap.style.border = '0'
  wrap.style.background = 'transparent'
  wrap.style.padding = '0'
  const row = el('div', 'row')
  row.style.flexWrap = 'wrap'
  for (const [label, fn] of list) {
    const b = el('button', 'btn', label)
    b.type = 'button'
    b.onclick = () => fn(b)
    row.append(b)
  }
  wrap.append(row)
  return wrap
}

function onProviderChange(id) {
  saveSettings({ providerId: id, model: '' }).then(() => {
    const pv = state.providers.find((p) => p.id === id)
    closeSettings()
    syncModeChip()
    if (id === 'demo') {
      renderThread()
      setTimeout(openDemoNotice, 200)
    } else {
      setTimeout(openSettings, 60)
    }
    toast(`已切到 ${pv?.name || id}`)
  })
}

async function saveSettings(patch) {
  Object.assign(state.settings, patch)
  syncComposer()
  syncModeChip()
  try {
    const r = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) })
    if (r.settings) state.settings = { ...state.settings, ...stripProviders(r.settings) }
    syncModeChip()
  } catch (e) {
    toast(`保存失败：${e.message}`)
  }
}
function stripProviders(s) {
  const { providersList, ...rest } = s
  return rest
}

async function saveProvider(patch) {
  const id = state.settings.providerId
  if ('apiKey' in patch && !String(patch.apiKey || '').trim()) delete patch.apiKey
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ providers: [{ id, ...patch }] }) })
  const boot = await api('/api/bootstrap')
  state.providers = boot.providers
  state.settings = boot.settings
  toast('已保存接口配置')
}

/* ───────────── 语音 ───────────── */
function onMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return toast('这个浏览器没有语音识别，装 Chrome 或直接用输入法语音')
  const rec = new SR()
  rec.lang = 'zh-CN'
  rec.interimResults = true
  rec.continuous = false
  const base = $('#input').value
  toast('说话…')
  rec.onresult = (e) => {
    let text = ''
    for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript
    $('#input').value = (base ? base + ' ' : '') + text
    autoGrow()
    syncComposer()
  }
  rec.onerror = () => toast('语音识别失败')
  rec.onend = () => $('#input').focus()
  rec.start()
}

/* ───────────── 杂项 ───────────── */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text || '')
    toast('已复制')
  } catch {
    const ta = el('textarea')
    ta.value = text || ''
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    toast('已复制')
  }
}
let toastTimer = null
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200)
}
function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const a = el('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
