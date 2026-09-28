import { ErrorRequestHandler } from 'express'
import { HttpError } from '../utils/http-error'

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof HttpError) {
    response.status(error.statusCode).json({ success: false, message: error.message })
    return
  }

  response.status(500).json({ success: false, message: 'Something went wrong' })
}
