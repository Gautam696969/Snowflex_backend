import { Request, Response, NextFunction } from 'express'
import { getGroqConfigOrThrow } from '../config/groq'
import { logger } from '../utils/logger'

interface MulterFile {
  fieldname: string
  originalname: string
  encoding: string
  mimetype: string
  size: number
  buffer: Buffer
  destination?: string
  filename?: string
  path?: string
}

export interface VoiceTranscribeRequest extends Request {
  file?: MulterFile
  body: { language?: string }
}

class GroqProviderError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Groq transcription failed with status ${status}`)
  }
}

async function transcribeWithGroq(audioBuffer: ArrayBuffer, mimeType: string, language?: string): Promise<string> {
  const config = getGroqConfigOrThrow()

  const form = new FormData()
  const blob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' })
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
  form.append('file', blob, `audio.${extension}`)
  form.append('model', config.whisperModel)
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  const response = await fetch(`${config.apiBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new GroqProviderError(response.status, text.slice(0, 500))
  }

  const body = (await response.json()) as { text?: string }
  const text = body.text?.trim() ?? ''
  if (!text) throw new Error('Transcription provider returned an empty response.')
  return text
}

export const voiceController = {
  async transcribe(request: VoiceTranscribeRequest, response: Response, next: NextFunction) {
    try {
      const file = request.file
      if (!file) {
        response.status(400).json({ success: false, message: 'Audio file is required', data: null })
        return
      }

      const audioBuffer = file.buffer.buffer.slice(
        file.buffer.byteOffset,
        file.buffer.byteOffset + file.buffer.byteLength,
      ) as ArrayBuffer
      const text = await transcribeWithGroq(audioBuffer, file.mimetype, request.body?.language)
      response.json({ success: true, message: 'Transcription completed', text, data: { text } })
    } catch (error) {
      if (error instanceof Error && error.message === 'GROQ_API_KEY is missing or invalid.') {
        response.status(503).json({
          success: false,
          message: 'Voice transcription is disabled because GROQ_API_KEY is missing or invalid in Back/.env.',
          data: null,
        })
        return
      }
      if (error instanceof GroqProviderError) {
        logger.error(`Groq whisper transcription failed (${error.status})`, { body: error.body })
        const message = error.status === 401
          ? 'Invalid Groq API key'
          : error.status === 429
            ? 'Rate limit reached, try again shortly'
            : error.status === 400 || error.status === 413
              ? 'Audio invalid or too large'
              : 'Speech transcription service is unavailable.'
        response.status(error.status === 400 || error.status === 413 ? error.status : error.status === 401 || error.status === 429 ? error.status : 502).json({
          success: false,
          message,
          data: null,
        })
        return
      }
      next(error)
    }
  },
}

export function createVoiceUpload() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const multer = require('multer') as {
    (options: {
      storage: unknown
      limits: { fileSize: number }
      fileFilter: (req: Request, file: { mimetype: string }, cb: (err: Error | null, accept: boolean) => void) => void
    }): { single(field: string): (req: Request, res: Response, next: NextFunction) => void }
    memoryStorage(): unknown
  }
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req: Request, file: { mimetype: string }, cb: (err: Error | null, accept: boolean) => void) => {
      const allowed = ['audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a']
      if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) cb(null, true)
      else cb(new Error('Only audio files are allowed'), false)
    },
  })
}