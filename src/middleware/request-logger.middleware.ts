import { RequestHandler } from 'express'
import { logger } from '../utils/logger'

export const requestLogger: RequestHandler = (request, response, next) => {
  const startedAt = Date.now()
  response.on('finish', () => {
    logger.request(request.method, request.originalUrl, response.statusCode, Date.now() - startedAt)
  })
  next()
}
