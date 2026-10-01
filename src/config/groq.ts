import { logger } from '../utils/logger'

const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1'
const DEFAULT_WHISPER_MODEL = 'whisper-large-v3-turbo'
const DEFAULT_CHAT_MODEL = 'qwen/qwen3.8-27b'

export interface GroqConfig {
  apiKey: string
  apiBaseUrl: string
  whisperModel: string
  chatModel: string
}

export function getGroqConfig(): GroqConfig | null {
  const apiKey = process.env.GROQ_API_KEY?.trim()
  if (!apiKey || !apiKey.startsWith('gsk_')) return null
  const configuredChatModel = process.env.GROQ_CHAT_MODEL?.trim()
  const retiredChatModel = configuredChatModel === 'llama-3.3-70b-versatile'
    || configuredChatModel === 'llama-3.1-8b-instant'
  const chatModel = retiredChatModel
    ? DEFAULT_CHAT_MODEL
    : configuredChatModel || DEFAULT_CHAT_MODEL

  return {
    apiKey,
    apiBaseUrl: GROQ_API_BASE_URL,
    whisperModel: process.env.GROQ_WHISPER_MODEL?.trim() || DEFAULT_WHISPER_MODEL,
    chatModel,
  }
}

export function validateGroqConfig(): boolean {
  const rawKey = process.env.GROQ_API_KEY?.trim()
  if (!rawKey) {
    logger.warn('GROQ_API_KEY missing in Back/.env. Voice transcription and Groq chat disabled')
    return false
  }
  if (!rawKey.startsWith('gsk_')) {
    logger.warn('GROQ_API_KEY is invalid in Back/.env. Expected a key beginning with gsk_. Voice transcription and Groq chat disabled')
    return false
  }

  logger.info('Groq API key loaded successfully')
  return true
}

export function getGroqConfigOrThrow(): GroqConfig {
  const config = getGroqConfig()
  if (!config) throw new Error('GROQ_API_KEY is missing or invalid.')
  return config
}
