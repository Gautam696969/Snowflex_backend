import { logger } from '../utils/logger'
import { getGroqConfigOrThrow } from './groq'

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
  return getGroqConfigOrThrow().apiKey
}

function getBaseUrl(): string {
  return getGroqConfigOrThrow().apiBaseUrl
}

function getModel(): string {
  return getGroqConfigOrThrow().chatModel
}

function extractReply(body: {
  choices?: {
    message?: {
      content?: unknown
      reasoning_content?: unknown
    }
  }[]
}): string {
  const message = body.choices?.[0]?.message
  const content = message?.content ?? message?.reasoning_content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) return String(part.text ?? '')
        return ''
      })
      .join('')
      .trim()
  }
  return ''
}

function prepareMessages(messages: AiChatMessage[]): AiChatMessage[] {
  const validMessages = messages.filter((message) => message.content.trim().length > 0)
  const systemMessage = validMessages.find((message) => message.role === 'system')
  const conversation = validMessages.filter((message) => message.role !== 'system').slice(-20)
  return systemMessage ? [systemMessage, ...conversation] : conversation
}

export const aiClient = {
  async chat(messages: AiChatMessage[], options: AiChatOptions = {}): Promise<AiChatResult> {
    const apiKey = getApiKey()
    const baseUrl = getBaseUrl()
    const model = options.model ?? getModel()
    const fallbackModel = 'qwen/qwen3.8-27b'
    const temperature = options.temperature ?? 0.4
    const maxTokens = options.maxTokens ?? 1024
    const requestMessages = prepareMessages(messages)

    let requestModel = model
    let response: Response
    while (true) {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: requestModel,
          messages: requestMessages,
          temperature,
          max_tokens: maxTokens,
        }),
      })
      if (response.ok || response.status !== 404 || requestModel === fallbackModel) break
      const text = await response.text().catch(() => '')
      logger.warn(`Groq chat model ${requestModel} is unavailable; retrying with ${fallbackModel}`, { body: text.slice(0, 300) })
      requestModel = fallbackModel
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.error(`AI chat request failed with status ${response.status}`, { body: text.slice(0, 500) })
      throw new Error(`AI provider error (${response.status})`)
    }

    let body = (await response.json()) as {
      choices?: {
        message?: { content?: unknown; reasoning_content?: unknown }
        finish_reason?: string
      }[]
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number }  
    }

    let reply = extractReply(body)
    if (!reply) {
      const latestUserMessage = [...requestMessages].reverse().find((message) => message.role === 'user')
      const systemMessage = requestMessages.find((message) => message.role === 'system')
      if (latestUserMessage) {
        logger.warn('Groq returned empty content; retrying with fresh conversation context')
        const recoveryResponse = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: fallbackModel,
            messages: systemMessage ? [systemMessage, latestUserMessage] : [latestUserMessage],
            temperature: 0.2,
            max_tokens: maxTokens,
          }),
        })
        if (recoveryResponse.ok) {
          body = (await recoveryResponse.json()) as typeof body
          reply = extractReply(body)
          requestModel = fallbackModel
        } else {
          const recoveryError = await recoveryResponse.text().catch(() => '')
          logger.error(`AI recovery request failed with status ${recoveryResponse.status}`, { body: recoveryError.slice(0, 500) })
        }
      }
    }
    if (!reply) {
      logger.error('AI provider returned no usable message content', {
        model: body.model ?? requestModel,
        choices: body.choices?.length ?? 0,
        finishReason: body.choices?.[0]?.finish_reason,
        messageKeys: body.choices?.[0]?.message ? Object.keys(body.choices[0].message) : [],
      })
      throw new Error('AI provider returned an empty response.')
    }

    return {
      reply,
      model: body.model ?? requestModel,
      usage: {
        promptTokens: body.usage?.prompt_tokens,
        completionTokens: body.usage?.completion_tokens,
      },
    }
  },
}