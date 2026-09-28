import { NextFunction, Request, Response } from 'express'
import { AuthTokenPayload, verifyToken } from '../utils/jwt'
import { HttpError } from '../utils/http-error'

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload
    }
  }
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.header('Authorization')
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    response.status(401).json({ success: false, message: 'Unauthorized' })
    return
  }

  try {
    request.user = verifyToken(match[1])
    next()
  } catch {
    response.status(401).json({ success: false, message: 'Unauthorized' })
  }
}

export function authorizeRoles(...roles: string[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.user) {
      next(new HttpError(401, 'Unauthorized'))
      return
    }
    if (!roles.includes(request.user.role)) {
      next(new HttpError(403, 'Forbidden'))
      return
    }
    next()
  }
}
