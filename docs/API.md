# 接口手册

两类接口：

- `/api/*` —— 前端自己用的私有接口（JSON + SSE）
- `/v1/*` —— **OpenAI 兼容网关**，给别的 App / CLI / SDK 用

默认地址 `http://127.0.0.1:8899`（手机本机跑就是 `http://127.0.0.1:8899`）。
服务没有内置鉴权；要暴露出去请设 `DS_GATEWAY_KEY` 并套一层反代。

---

## 一、私有接口

### `GET /api/health`

```json
{ "ok": true, "version": "1.0.0", "uptime": 132, "store": "sqlite", "node": "v24.22.1" }
```

### `GET /api/bootstrap`

一次拿齐首屏需要的东西：设置、服务商列表、历史会话。

```json
{
  "settings": { "providerId": "deepseek", "model": "", "temperature": 1, "maxTokens": 4096, "theme": "auto", ... },
  "providers": [{ "id": "deepseek", "name": "DeepSeek 官方 API", "dialect": "openai", "baseUrl": "https://api.deepseek.com/v1", "models": ["deepseek-chat","deepseek-reasoner"], "hasKey": false }],
  "conversations": [{ "id": "...", "title": "...", "updatedAt": 1794888509656, "pinned": false }],
  "version": "1.0.0"
}
```

### `POST /api/settings`

局部更新。`providers` 是**合并**语义（按 `id` 覆盖字段），不是替换整个数组。

```json
{ "providerId": "deepseek", "model": "deepseek-chat", "temperature": 0.7,
  "providers": [{ "id": "deepseek", "apiKey": "sk-..." }] }
```

### 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/conversations` | 列表（置顶优先、按更新时间倒序） |
| POST | `/api/conversations` | 新建 `{title}` |
| GET | `/api/conversations/:id` | 详情 + 全部消息 |
| PATCH | `/api/conversations/:id` | `{title?, pinned?}` |
| DELETE | `/api/conversations/:id` | 连带消息一起删 |
| DELETE | `/api/conversations/:id/messages/:mid` | 删单条 |

### `POST /api/chat` —— 核心，SSE

请求体：

```json
{
  "convId": "可选，不传就新建",
  "text": "用户这句话",
  "regenerate": false,
  "truncateFrom": "可选，从这个 messageId 起截断（编辑重发用）",
  "attachments": ["附件 id"],
  "thinking": true,
  "search": true,
  "model": "可选，覆盖设置",
  "temperature": 0.7,
  "maxTokens": 4096
}
```

响应是 `text/event-stream`，事件按顺序：

| event | data | 含义 |
|---|---|---|
| `meta` | `{convId, messageId, model, provider, title}` | 会话与消息 id，先给前端占位 |
| `search_start` | `{query}` | 开始搜索 |
| `search` | `{query, results:[{title,url,snippet}], citations:[{index,title,url}], ms, error?}` | 搜索结果（失败也可能有 error） |
| `reasoning` | `{t}` | 思考增量 |
| `content` | `{t}` | 正文增量 |
| `error` | `{message}` | 出错 |
| `done` | `{messageId, convId, content, reasoning, citations, stats:{ttft, ms, usage, stopReason, model}}` | 结束，带完整文本与统计 |

`curl` 看效果：

```bash
curl -N -X POST http://127.0.0.1:8899/api/chat \
  -H 'content-type: application/json' \
  -d '{"text":"用一句话解释 TCP 三次握手","thinking":false,"search":false}'
```

`stopReason` 出现 `length` 说明撞到 `max_tokens`；前端会提示「继续」。

### `POST /api/attachments`

```json
{ "name": "周报.docx", "mime": "", "data": "base64..." }
```

返回 `{id, name, size, chars, kind, preview}`，把 `id` 放进 `attachments` 就能进上下文。
支持 txt/md/csv/json/代码、docx、xlsx、pptx，pdf 尽力而为。上限 12MB。

### `POST /api/search`

```json
{ "q": "DeepSeek 上下文长度", "limit": 5, "pages": true, "provider": "bing" }
```

### `GET /api/models?provider=id`

向上游 `/models` 拉列表；拉不到就回预设列表。结果不落库，每次现拉（带 keep-alive）。

### `GET /api/bench?provider=id&model=xxx`

打一发 `max_tokens:1` 的请求，只测到首字节，返回 `{ttft, ms, model, provider}`。设置面板里「测试首字延迟」就是它。

### `GET /api/stats`

运行时长、存储类型、数据目录、内存占用。

---

## 二、OpenAI 兼容网关

Base URL：`http://127.0.0.1:8899/v1`
API Key：随便填（除非服务端设了 `DS_GATEWAY_KEY`，那就要填它）
模型名：填你设置里配过的模型（`/v1/models` 能列出来）

### `GET /v1/models`

```json
{ "object": "list", "data": [{ "id": "deepseek-chat", "object": "model", "owned_by": "deepseek" }] }
```

### `POST /v1/chat/completions`

标准 OpenAI 请求体，支持 `stream: true/false`。无论上游是 OpenAI 方言还是 Anthropic 方言，出去都是 OpenAI 形状。

```bash
curl -N http://127.0.0.1:8899/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

### 直接用 OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8899/v1", api_key="any")
for chunk in client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

### 接入现成客户端

| 客户端 | Base URL | Key | 模型 |
|---|---|---|---|
| ChatBox / NextChat / Lobe | `http://<host>:8899/v1` | 任意 | 从 `/v1/models` 选 |
| Cursor / Continue | 同上（OpenAI 兼容模式） | 任意 | 同上 |
| OpenAI CLI / 各类脚本 | `OPENAI_BASE_URL=http://<host>:8899/v1` | 任意 | 同上 |

手机本机跑的时候，同机任何 App 都能用 `http://127.0.0.1:8899/v1`，不经过外网。

---

## 三、错误约定

- 4xx/5xx 一律 `{"error": "..."}`（网关走 OpenAI 形状 `{"error":{"message":"..."}}`）
- 上游错误原样透出：`请求失败：上游 401：Authentication Fails...`
- 连接失败会在**没收到任何数据**时自动重试一次（只会重试零字节的情况，不会重复扣费）
