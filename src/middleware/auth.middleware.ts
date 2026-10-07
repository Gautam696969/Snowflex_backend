import { NextFunction, Request, Response } from 'express'
import { AuthTokenPayload, verifyToken } from '../utils/jwt'
import { HttpError } from '../utils/http-error'
import { sendError } from '../utils/apiResponse'
import { normalizeRole } from '../utils/roles'
import { getUserStatus } from '../services/user-status.service'

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload
    }
  }
}

export async function requireAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
  const authorization = request.header('Authorization')
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  const tokenString = match ? match[1] : (typeof request.query.token === 'string' ? request.query.token : null)

  if (!tokenString) {
    sendError(response, 401, 'Unauthorized')
    return
  }

  try {
    const decoded = verifyToken(tokenString)
    request.user = decoded

    const status = await getUserStatus(decoded.id)
    if (status === 'TERMINATED') {
      sendError(response, 403, 'Your account has been deactivated. Please contact HR.')
      return
    }

    next()
  } catch {
    sendError(response, 401, 'Unauthorized')
  }
}

export function authorizeRoles(...roles: string[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.user) {
      next(new HttpError(401, 'Unauthorized'))
      return
    }
    if (!roles.map(normalizeRole).includes(normalizeRole(request.user.role))) {
      next(new HttpError(403, 'Forbidden'))
      return
    }
    next()
  }
}
