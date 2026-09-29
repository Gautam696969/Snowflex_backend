import { ErrorRequestHandler } from 'express'
import { HttpError } from '../utils/http-error'
import { sendError } from '../utils/apiResponse'

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof HttpError) {
    sendError(response, error.statusCode, error.message)
    return
  }

  sendError(response, 500, 'Internal server error')
}
