import { ErrorRequestHandler } from 'express'
import { HttpError } from '../utils/http-error'
import { sendError } from '../utils/apiResponse'
import { logger } from '../utils/logger'

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error?.code === 'LIMIT_FILE_SIZE') {
    sendError(response, 413, 'Audio file is too large. Maximum size is 10 MB.')
    return
  }

  if (error instanceof HttpError) {
    sendError(response, error.statusCode, error.message)
    logger.warn(`${request.method} ${request.path} -> ${error.statusCode}: ${error.message}`)
    return
  }

  logger.error(`${request.method} ${request.path} failed`, {
    error: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
  })
  sendError(response, 500, 'Internal server error')
}
