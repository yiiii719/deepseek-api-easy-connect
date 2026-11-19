// 默认配置 + 环境变量覆盖。所有值都能在 App 的「设置」里改，改完落 SQLite。
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..')

export const DATA_DIR = process.env.DS_DATA_DIR || path.join(ROOT, 'data')

export const PORT = Number(process.env.DS_PORT || 8899)
export const HOST = process.env.DS_HOST || '0.0.0.0'

/** 预置服务商：都可以在设置里改；key 一律从界面或环境变量来，代码里不留任何真实凭据 */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek 官方 API（推荐）',
    dialect: 'openai',
    baseUrl: process.env.DS_API_BASE || 'https://api.deepseek.com/v1',
    apiKey: process.env.DS_API_KEY || '',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-flash',
    thinkingModel: 'deepseek-v4-pro',
    // 官方 API 支持 effort 档位：关思考走 low（最快），开思考走 high
    effort: { fast: 'low', thinking: 'high' },
  },
  {
    id: 'anthropic',
    name: 'Anthropic 兼容',
    dialect: 'anthropic',
    baseUrl: process.env.DS_ANTHROPIC_BASE || 'https://api.anthropic.com/v1',
    apiKey: '',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1'],
    defaultModel: 'claude-sonnet-4-5',
    thinkingModel: 'claude-sonnet-4-5',
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    dialect: 'openai',
    baseUrl: '',
    apiKey: '',
    models: [],
    defaultModel: '',
    thinkingModel: '',
  },
  {
    id: 'demo',
    name: '演示模式（无需 Key）',
    dialect: 'demo',
    baseUrl: '',
    apiKey: '',
    models: ['demo'],
    defaultModel: 'demo',
    thinkingModel: 'demo',
  },
]

export const DEFAULT_SETTINGS = {
  providerId: 'deepseek',
  model: process.env.DS_MODEL || '',
  thinking: false,
  search: false,
  temperature: 1,
  maxTokens: 4096,
  topP: 1,
  contextChars: 24000, // 历史消息预算：超了从头砍，prefill 才不会越聊越慢
  system: '',
  theme: 'auto',
  fontSize: 16,
  streamRender: true,
  sendOnEnter: true,
  providers: [], // 用户在设置里改过的覆盖项（按 id 合并）
  searchProvider: 'bing', // bing | ddg | serper | tavily | brave | off
  showStats: true,
}

export const VERSION = '1.0.0'
export const HOSTNAME = os.hostname()
