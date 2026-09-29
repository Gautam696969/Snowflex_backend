import { ErrorRequestHandler } from 'express'
import { HttpError } from '../utils/http-error'
import { sendError } from '../utils/apiResponse'

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error instanceof HttpError) {
    sendError(response, error.statusCode, error.message)
    return
  }

  console.error(`[api] ${request.method} ${request.path} failed`, {
    error: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
  })
  sendError(response, 500, 'Internal server error')
}
