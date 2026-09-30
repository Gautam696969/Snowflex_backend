import { logger } from '../utils/logger'

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface AiChatResult {
  reply: string
  model: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

function getApiKey(): string {
  const key = process.env.AI_API_KEY?.trim()
  if (!key) throw new Error('AI_API_KEY is not configured.')
  return key
}

function getBaseUrl(): string {
  return (process.env.AI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '')
}

function getModel(): string {
  return process.env.AI_MODEL ?? 'gpt-4o-mini'
}

export const aiClient = {
  async chat(messages: AiChatMessage[], options: AiChatOptions = {}): Promise<AiChatResult> {
    const apiKey = getApiKey()
    const baseUrl = getBaseUrl()
    const model = options.model ?? getModel()
    const temperature = options.temperature ?? 0.4
    const maxTokens = options.maxTokens ?? 1024

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.error(`AI chat request failed with status ${response.status}`, { body: text.slice(0, 500) })
      throw new Error(`AI provider error (${response.status})`)
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const reply = body.choices?.[0]?.message?.content?.trim() ?? ''
    if (!reply) throw new Error('AI provider returned an empty response.')

    return {
      reply,
      model: body.model ?? model,
      usage: {
        promptTokens: body.usage?.prompt_tokens,
        completionTokens: body.usage?.completion_tokens,
      },
    }
  },
}