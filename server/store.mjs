// 存储层：优先 node:sqlite（Node 22.5+ 内置，零依赖），不可用时退回 JSON 文件
// 聊天主路径只写内存 + 异步落库，绝不阻塞 SSE。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from './config.mjs'

fs.mkdirSync(DATA_DIR, { recursive: true })

const uid = () => crypto.randomUUID()
const now = () => Date.now()

class SqliteStore {
  constructor(db) {
    this.db = db
    this.kind = 'sqlite'
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER,
        pinned INTEGER DEFAULT 0, model TEXT, provider TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conv_id TEXT, role TEXT, content TEXT, reasoning TEXT,
        created_at INTEGER, seq INTEGER, meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, seq);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, text TEXT, created_at INTEGER
      );
    `)
    this.q = {
      listConv: db.prepare(`SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC LIMIT 500`),
      getConv: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
      insConv: db.prepare(`INSERT INTO conversations (id,title,created_at,updated_at,pinned,model,provider) VALUES (?,?,?,?,?,?,?)`),
      touchConv: db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`),
      renameConv: db.prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`),
      pinConv: db.prepare(`UPDATE conversations SET pinned = ? WHERE id = ?`),
      setConvModel: db.prepare(`UPDATE conversations SET model = ?, provider = ? WHERE id = ?`),
      delConv: db.prepare(`DELETE FROM conversations WHERE id = ?`),
      delConvMsgs: db.prepare(`DELETE FROM messages WHERE conv_id = ?`),
      listMsgs: db.prepare(`SELECT * FROM messages WHERE conv_id = ? ORDER BY seq ASC`),
      insMsg: db.prepare(`INSERT INTO messages (id,conv_id,role,content,reasoning,created_at,seq,meta) VALUES (?,?,?,?,?,?,?,?)`),
      updMsg: db.prepare(`UPDATE messages SET content = ?, reasoning = ?, meta = ? WHERE id = ?`),
      delMsg: db.prepare(`DELETE FROM messages WHERE id = ?`),
      delMsgsFrom: db.prepare(`DELETE FROM messages WHERE conv_id = ? AND seq >= ?`),
      lastSeq: db.prepare(`SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE conv_id = ?`),
      getSetting: db.prepare(`SELECT v FROM settings WHERE k = ?`),
      putSetting: db.prepare(`INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`),
      allSettings: db.prepare(`SELECT k,v FROM settings`),
      insAtt: db.prepare(`INSERT INTO attachments (id,name,mime,size,text,created_at) VALUES (?,?,?,?,?,?)`),
      getAtt: db.prepare(`SELECT * FROM attachments WHERE id = ?`),
    }
  }

  listConversations() {
    return this.q.listConv.all().map(rowConv)
  }
  getConversation(id) {
    const r = this.q.getConv.get(id)
    return r ? rowConv(r) : null
  }
  createConversation({ title = '新对话', model = '', provider = '' } = {}) {
    const id = uid()
    const t = now()
    this.q.insConv.run(id, title, t, t, 0, model, provider)
    return this.getConversation(id)
  }
  updateConversation(id, patch) {
    const c = this.getConversation(id)
    if (!c) return null
    if (patch.title != null) this.q.renameConv.run(String(patch.title).slice(0, 200), now(), id)
    if (patch.pinned != null) this.q.pinConv.run(patch.pinned ? 1 : 0, id)
    if (patch.model != null || patch.provider != null) this.q.setConvModel.run(patch.model ?? c.model, patch.provider ?? c.provider, id)
    this.q.touchConv.run(now(), id)
    return this.getConversation(id)
  }
  deleteConversation(id) {
    this.q.delConvMsgs.run(id)
    this.q.delConv.run(id)
    return true
  }
  listMessages(convId) {
    return this.q.listMsgs.all(convId).map(rowMsg)
  }
  addMessage(convId, m) {
    const seq = (this.q.lastSeq.get(convId)?.s || 0) + 1
    const id = m.id || uid()
    this.q.insMsg.run(id, convId, m.role, m.content || '', m.reasoning || '', m.createdAt || now(), seq, JSON.stringify(m.meta || {}))
    this.q.touchConv.run(now(), convId)
    return { ...m, id, seq, convId }
  }
  updateMessage(id, patch) {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id)
    if (!row) return null
    this.q.updMsg.run(patch.content ?? row.content, patch.reasoning ?? row.reasoning, patch.meta ? JSON.stringify(patch.meta) : row.meta, id)
    return { ...rowMsg(row), ...patch }
  }
  deleteMessage(id) {
    this.q.delMsg.run(id)
    return true
  }
  truncateFrom(convId, seq) {
    this.q.delMsgsFrom.run(convId, seq)
    return true
  }
  getSettings() {
    const out = {}
    for (const r of this.q.allSettings.all()) {
      try {
        out[r.k] = JSON.parse(r.v)
      } catch {
        /* ignore */
      }
    }
    return out
  }
  saveSettings(patch) {
    for (const [k, v] of Object.entries(patch)) this.q.putSetting.run(k, JSON.stringify(v))
    return this.getSettings()
  }
  saveAttachment(a) {
    const id = uid()
    this.q.insAtt.run(id, a.name, a.mime, a.size, a.text, now())
    return { id, name: a.name, mime: a.mime, size: a.size, chars: a.text.length }
  }
  getAttachment(id) {
    const r = this.q.getAtt.get(id)
    return r ? { id: r.id, name: r.name, text: r.text } : null
  }
}

/** 无 node:sqlite 时的降级实现（单文件 JSON，够用） */
class JsonStore {
  constructor(file) {
    this.file = file
    this.kind = 'json'
    this.data = { conversations: [], messages: [], settings: {}, attachments: {} }
    if (fs.existsSync(file)) {
      try {
        Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch {
        /* ignore */
      }
    }
    this.timer = null
  }
  flush() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      fs.writeFileSync(this.file, JSON.stringify(this.data))
    }, 300)
  }
  listConversations() {
    return [...this.data.conversations].sort((a, b) => b.pinned - a.pinned || b.updated_at - a.updated_at)
  }
  getConversation(id) {
    return this.data.conversations.find((c) => c.id === id) || null
  }
  createConversation({ title = '新对话', model = '', provider = '' } = {}) {
    const c = { id: uid(), title, created_at: now(), updated_at: now(), pinned: 0, model, provider }
    this.data.conversations.push(c)
    this.flush()
    return c
  }
  updateConversation(id, patch) {
    const c = this.getConversation(id)
    if (!c) return null
    Object.assign(c, patch.title != null ? { title: String(patch.title).slice(0, 200) } : {}, patch.pinned != null ? { pinned: patch.pinned ? 1 : 0 } : {}, { updated_at: now() })
    this.flush()
    return c
  }
  deleteConversation(id) {
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id)
    this.data.messages = this.data.messages.filter((m) => m.conv_id !== id)
    this.flush()
    return true
  }
  listMessages(convId) {
    return this.data.messages.filter((m) => m.conv_id === convId).sort((a, b) => a.seq - b.seq)
  }
  addMessage(convId, m) {
    const seq = this.listMessages(convId).length + 1
    const row = { id: m.id || uid(), conv_id: convId, role: m.role, content: m.content || '', reasoning: m.reasoning || '', created_at: now(), seq, meta: JSON.stringify(m.meta || {}) }
    this.data.messages.push(row)
    this.updateConversation(convId, {})
    this.flush()
    return rowMsg(row)
  }
  updateMessage(id, patch) {
    const row = this.data.messages.find((m) => m.id === id)
    if (!row) return null
    if (patch.content != null) row.content = patch.content
    if (patch.reasoning != null) row.reasoning = patch.reasoning
    if (patch.meta) row.meta = JSON.stringify(patch.meta)
    this.flush()
    return rowMsg(row)
  }
  deleteMessage(id) {
    this.data.messages = this.data.messages.filter((m) => m.id !== id)
    this.flush()
    return true
  }
  truncateFrom(convId, seq) {
    this.data.messages = this.data.messages.filter((m) => !(m.conv_id === convId && m.seq >= seq))
    this.flush()
    return true
  }
  getSettings() {
    return { ...this.data.settings }
  }
  saveSettings(patch) {
    Object.assign(this.data.settings, patch)
    this.flush()
    return this.getSettings()
  }
  saveAttachment(a) {
    const id = uid()
    this.data.attachments[id] = { name: a.name, text: a.text, mime: a.mime, size: a.size }
    this.flush()
    return { id, name: a.name, mime: a.mime, size: a.size, chars: a.text.length }
  }
  getAttachment(id) {
    const a = this.data.attachments[id]
    return a ? { id, name: a.name, text: a.text } : null
  }
}

function rowConv(r) {
  return { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, pinned: !!r.pinned, model: r.model, provider: r.provider }
}
function rowMsg(r) {
  let meta = {}
  try {
    meta = JSON.parse(r.meta || '{}')
  } catch {
    /* ignore */
  }
  return { id: r.id, convId: r.conv_id, role: r.role, content: r.content, reasoning: r.reasoning, createdAt: r.created_at, seq: r.seq, meta }
}

let store
try {
  const { DatabaseSync } = await import('node:sqlite')
  store = new SqliteStore(new DatabaseSync(path.join(DATA_DIR, 'deepseek.db')))
  console.log(`[store] sqlite -> ${path.join(DATA_DIR, 'deepseek.db')}`)
} catch (e) {
  store = new JsonStore(path.join(DATA_DIR, 'deepseek.json'))
  console.log(`[store] json fallback (${e.message}) -> ${path.join(DATA_DIR, 'deepseek.json')}`)
}
export const db = store
export { uid, now }
