import { Request, Response, NextFunction } from 'express'
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
}

function getGroqApiKey(): string {
  const key = process.env.GROQ_API_KEY?.trim()
  if (!key) throw new Error('GROQ_API_KEY is not configured.')
  return key
}

function getGroqModel(): string {
  return process.env.GROQ_WHISPER_MODEL ?? 'whisper-large-v3'
}

async function transcribeWithGroq(audioBuffer: ArrayBuffer, mimeType: string): Promise<string> {
  const apiKey = getGroqApiKey()
  const model = getGroqModel()

  const form = new FormData()
  const blob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' })
  form.append('file', blob, 'audio.webm')
  form.append('model', model)
  form.append('response_format', 'json')

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error(`Groq whisper transcription failed (${response.status})`, { body: text.slice(0, 300) })
    throw new Error(`Transcription provider error (${response.status})`)
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
        response.status(422).json({ success: false, message: 'Audio file is required', data: null })
        return
      }

      const text = await transcribeWithGroq(file.buffer.buffer.slice(0, file.buffer.byteLength) as ArrayBuffer, file.mimetype)
      response.json({ success: true, message: 'Transcription completed', data: { text } })
    } catch (error) {
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
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req: Request, file: { mimetype: string }, cb: (err: Error | null, accept: boolean) => void) => {
      const allowed = ['audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a']
      if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) cb(null, true)
      else cb(new Error('Only audio files are allowed'), false)
    },
  })
}