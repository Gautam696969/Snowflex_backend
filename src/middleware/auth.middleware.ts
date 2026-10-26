import { NextFunction, Request, Response } from 'express'
import { AuthTokenPayload, verifyToken } from '../utils/jwt'
import { HttpError } from '../utils/http-error'
import { sendError } from '../utils/apiResponse'
import { normalizeRole } from '../utils/roles'
import { getLiveUserRole, getUserStatus } from '../services/user-status.service'
import { logger } from '../utils/logger'

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
      logger.warn(`[DEBUG_AUTH] requireAuth rejected: userId=${decoded.id} has TERMINATED status`)
      sendError(response, 403, 'Your account has been deactivated. Please contact HR.')
      return
    }

    try {
      if (typeof getLiveUserRole === 'function') {
        const liveRole = await getLiveUserRole(decoded.id)
        if (liveRole) {
          request.user.role = normalizeRole(liveRole)
        }
      }
    } catch {
      // Fall back to decoded role
    }

    next()
  } catch (authError) {
    logger.warn(`[DEBUG_AUTH] requireAuth token verification failed for path=${request.originalUrl}:`, (authError as Error)?.message)
    sendError(response, 401, 'Unauthorized')
  }
}

export function authorizeRoles(...roles: string[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.user) {
      next(new HttpError(401, 'Unauthorized'))
      return
    }
    const userRole = normalizeRole(request.user.role)
    const normalizedAllowed = roles.map(normalizeRole)
    if (!normalizedAllowed.includes(userRole)) {
      logger.warn(`[DEBUG_AUTH] Access forbidden: path=${request.originalUrl}, userId=${request.user.id}, userRole="${request.user.role}" (normalized: "${userRole}"), allowedRoles=[${normalizedAllowed.join(', ')}]`)
      next(new HttpError(403, 'Forbidden'))
      return
    }
    next()
  }
}
