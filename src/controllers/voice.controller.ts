import { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import { getGroqConfigOrThrow } from '../config/groq'
import { logger } from '../utils/logger'

export interface VoiceTranscribeRequest extends Request {
  body: { language?: string }
}

class GroqProviderError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Groq transcription failed with status ${status}`)
  }
}

function getAudioExtension(cleanMime: string): string {
  if (cleanMime.includes('wav')) return 'wav'
  if (cleanMime.includes('mp4') || cleanMime.includes('m4a')) return 'mp4'
  if (cleanMime.includes('ogg')) return 'ogg'
  if (cleanMime.includes('mpeg') || cleanMime.includes('mp3')) return 'mp3'
  return 'webm'
}

async function transcribeWithGroq(
  audioBuffer: Buffer | ArrayBuffer,
  mimeType: string,
  language?: string,
  originalFilename?: string,
): Promise<string> {
  const config = getGroqConfigOrThrow()

  // Strip ;codecs=... before creating the blob for Groq
  const rawMime = mimeType || 'audio/wav'
  const cleanMime = rawMime.split(';')[0].trim().toLowerCase()
  const extension = getAudioExtension(cleanMime)
  const filename = originalFilename && originalFilename.includes('.')
    ? originalFilename
    : `speech.${extension}`

  const arrayBuffer = audioBuffer instanceof ArrayBuffer
    ? audioBuffer
    : (audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer)
  const form = new FormData()
  const blob = new Blob([arrayBuffer], { type: cleanMime })
  form.append('file', blob, filename)
  form.append('model', config.whisperModel)
  form.append('response_format', 'json')
  if (language) form.append('language', language)

  console.log(`[voice] transcribeWithGroq - bufferBytes: ${arrayBuffer.byteLength}, cleanMime: ${cleanMime}, filename: ${filename}, model: ${config.whisperModel}`)
  logger.info('[voice] transcribeWithGroq sending to Groq', {
    bufferBytes: arrayBuffer.byteLength,
    cleanMime,
    filename,
    model: config.whisperModel,
  })

  const response = await fetch(`${config.apiBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(`[voice] Groq API error (${response.status}):`, text.slice(0, 1000))
    logger.error(`[voice] Groq API error (${response.status})`, { body: text.slice(0, 1000) })
    throw new GroqProviderError(response.status, text.slice(0, 1000))
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
        console.warn('[voice] Transcribe request missing file')
        response.status(400).json({ success: false, message: 'Audio file is required', data: null })
        return
      }

      const rawMime = file.mimetype || ''
      const cleanMime = rawMime.split(';')[0].trim().toLowerCase()
      const fileSize = file.size ?? file.buffer?.length ?? 0

      // Requirement 1 & 5: Log originalname, mimetype and size on the server
      console.log(`[voice] Server /transcribe received file - originalname: ${file.originalname}, mimetype: ${file.mimetype}, size: ${fileSize} bytes`)
      logger.info('[voice] Server /transcribe received file', {
        originalname: file.originalname,
        mimetype: file.mimetype,
        cleanMime,
        size: fileSize,
      })

      // Requirement 5: Temporary debug write of the received file
      try {
        const debugDir = path.join(process.cwd(), 'debug_audio')
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true })
        }
        const safeOriginalName = (file.originalname || 'speech.wav').replace(/[^a-zA-Z0-9._-]/g, '_')
        const debugFilePath = path.join(debugDir, `debug_${Date.now()}_${safeOriginalName}`)
        fs.writeFileSync(debugFilePath, file.buffer)
        console.log(`[voice] Temporary debug audio written to: ${debugFilePath}`)
      } catch (writeErr) {
        console.warn('[voice] Failed to write temporary debug audio file:', writeErr)
      }

      if (fileSize === 0) {
        response.status(400).json({ success: false, message: 'Audio file is empty', data: null })
        return
      }

      if (fileSize < 100) {
        response.status(400).json({ success: false, message: 'Audio file is too small or corrupted', data: null })
        return
      }

      const text = await transcribeWithGroq(file.buffer, cleanMime, request.body?.language, file.originalname)
      console.log(`[voice] Transcription completed (${text.length} chars): "${text}"`)
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
        logger.error(`[voice] Groq whisper transcription failed (${error.status})`, { body: error.body })
        console.error(`[voice] Groq whisper transcription failed (${error.status}):`, error.body)

        let groqDetail = ''
        try {
          const parsed = JSON.parse(error.body) as { error?: { message?: string } }
          if (parsed?.error?.message) {
            groqDetail = parsed.error.message
          }
        } catch {}

        let message = ''
        let statusCode = error.status

        if (error.status === 413) {
          message = 'Audio file exceeds transcription size limit (25MB).'
          statusCode = 413
        } else if (error.status === 400) {
          message = groqDetail ? `Audio transcription failed: ${groqDetail}` : 'Audio invalid or unsupported format'
          statusCode = 400
        } else if (error.status === 401) {
          message = 'Invalid Groq API key configuration.'
          statusCode = 401
        } else if (error.status === 429) {
          message = 'Rate limit reached, try again shortly.'
          statusCode = 429
        } else {
          message = groqDetail ? `Transcription error: ${groqDetail}` : 'Speech transcription service is unavailable.'
          statusCode = 502
        }

        response.status(statusCode).json({
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
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB limit (requirement 4)
    fileFilter: (_req: Request, file: { mimetype: string }, cb: (err: Error | null, accept: boolean) => void) => {
      // Strip ";codecs=..." before mime validation (requirement 4)
      const rawMime = file.mimetype || ''
      const cleanMime = rawMime.split(';')[0].trim().toLowerCase()
      // Accept webm, mp4, mpeg, wav, ogg
      const allowed = [
        'audio/webm',
        'audio/mp4',
        'audio/mpeg',
        'audio/mp3',
        'audio/wav',
        'audio/x-wav',
        'audio/wave',
        'audio/ogg',
        'audio/x-m4a',
        'audio/m4a',
        'audio/aac',
      ]
      if (allowed.includes(cleanMime) || cleanMime.startsWith('audio/')) {
        cb(null, true)
      } else {
        cb(new Error(`Unsupported audio format: ${rawMime}. Allowed formats: webm, mp4, mpeg, wav, ogg.`), false)
      }
    },
  })
}