import { NextFunction, Request, RequestHandler, Response } from 'express'
import { ZodType } from 'zod'
import { sendError } from '../utils/apiResponse'

export function validateBody(schema: ZodType): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      sendError(response, 400, 'Request validation failed')
      return
    }
    request.body = parsed.data
    next()
  }
}

export function validateParams(schema: ZodType): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const parsed = schema.safeParse(request.params)
    if (!parsed.success) {
      sendError(response, 400, 'Request validation failed')
      return
    }
    request.params = parsed.data as Request['params']
    next()
  }
}