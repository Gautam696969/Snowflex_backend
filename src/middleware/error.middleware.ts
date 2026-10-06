import { ErrorRequestHandler } from 'express'
import { HttpError } from '../utils/http-error'
import { sendError } from '../utils/apiResponse'
import { logger } from '../utils/logger'

interface DiagnosticError extends Error {
  code?: unknown
  sqlState?: unknown
  sqlText?: unknown
  cause?: unknown
}

function redactSecrets(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return String(value)
    .replace(/\b(password|passwd|token|secret|authorization|private[_ -]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, (_match, key: string, separator: string, raw: string) => {
      const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : ''
      return `${key}${separator}${quote}[REDACTED]${quote}`
    })
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
}

function errorChain(error: unknown): DiagnosticError[] {
  const result: DiagnosticError[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const item = current as DiagnosticError
    result.push(item)
    current = item.cause
  }
  return result
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error?.type === 'entity.parse.failed') {
    sendError(response, 400, 'Invalid JSON request body')
    return
  }

  if (error?.type === 'entity.too.large') {
    sendError(response, 413, 'Request body is too large')
    return
  }

  if (error?.code === 'LIMIT_FILE_SIZE') {
    sendError(response, 413, 'Audio file is too large. Maximum size is 10 MB.')
    return
  }

  if (error instanceof HttpError && error.statusCode < 500) {
    const statusCode = error.statusCode === 422 ? 400 : error.statusCode
    sendError(response, statusCode, error.message, error.details)
    logger.warn(`${request.method} ${request.path} -> ${statusCode}: ${error.message}`)
    return
  }

  const errors = errorChain(error)
  const rootError = errors.at(-1)
  logger.error(`${request.method} ${request.path} failed`, {
    errors: errors.map((item) => ({
      name: redactSecrets(item.name),
      message: redactSecrets(item.message),
      stack: redactSecrets(item.stack),
      code: redactSecrets(item.code),
      sqlState: redactSecrets(item.sqlState),
      sqlText: redactSecrets(item.sqlText),
    })),
  })

  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : redactSecrets(rootError?.message) || redactSecrets(error) || 'Unknown server error'
  response.status(500).json({ success: false, message: 'Internal server error', error: process.env.NODE_ENV === 'production' ? null : message })
}
