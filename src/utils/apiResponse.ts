import { Response } from 'express'

export function sendSuccess<T>(
  response: Response,
  statusCode: number,
  message: string,
  data: T,
): void {
  response.status(statusCode).json({ success: true, message, data })
}

export function sendError(response: Response, statusCode: number, message: string, details?: Record<string, unknown>): void {
  response.status(statusCode).json({ success: false, message, error: null, ...(details || {}) })
}