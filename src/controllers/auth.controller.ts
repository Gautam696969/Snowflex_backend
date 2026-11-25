import { NextFunction, Request, Response } from 'express'
import { AuthServiceContract, authService } from '../services/auth.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'

const REFRESH_COOKIE_NAME = 'snowflex_refresh_token'
const REFRESH_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!cookieHeader) return out
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(val)
  }
  return out
}

function setRefreshCookie(response: Response, refreshToken?: string): void {
  if (!refreshToken) return
  const isProd = process.env.NODE_ENV === 'production'
  response.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: REFRESH_MAX_AGE_MS,
    path: '/',
  })
}

function clearRefreshCookie(response: Response): void {
  const isProd = process.env.NODE_ENV === 'production'
  response.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  })
}

export function createAuthController(service: AuthServiceContract = authService) {
  return {
    register: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const { fullName, email, password } = request.body as {
          fullName: string
          email: string
          password: string
        }
        await service.register(fullName, email, password)
        sendSuccess(response, 201, 'User registered successfully', null)
      } catch (error) {
        next(error)
      }
    },

    login: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const { email, password } = request.body as { email: string; password: string }
        const cleanEmail = (email || '').trim().toLowerCase()
        const result = await service.login(cleanEmail, password)
        setRefreshCookie(response, result.refreshToken)
        sendSuccess(response, 200, 'Login successful', result)
      } catch (error) {
        next(error)
      }
    },

    refresh: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const cookies = parseCookies(request.headers.cookie)
        const refreshToken =
          cookies[REFRESH_COOKIE_NAME] ||
          (typeof request.body?.refreshToken === 'string' ? request.body.refreshToken : '')
        if (!refreshToken || !service.refreshSession) {
          throw new HttpError(401, 'Refresh token missing or expired')
        }
        const result = await service.refreshSession(refreshToken)
        setRefreshCookie(response, result.refreshToken)
        sendSuccess(response, 200, 'Session refreshed', result)
      } catch (error) {
        clearRefreshCookie(response)
        next(error)
      }
    },

    me: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const user = await service.getUserById(request.user!.id)
        sendSuccess(response, 200, 'Profile fetched successfully', user)
      } catch (error) {
        next(error)
      }
    },

    logout: async (request: Request, response: Response) => {
      const cookies = parseCookies(request.headers.cookie)
      const refreshToken =
        cookies[REFRESH_COOKIE_NAME] ||
        (typeof request.body?.refreshToken === 'string' ? request.body.refreshToken : '')
      if (refreshToken && service.revokeRefreshToken) {
        await service.revokeRefreshToken(refreshToken).catch(() => {})
      }
      clearRefreshCookie(response)
      sendSuccess(response, 200, 'Logout successful', null)
    },

    forgotPassword: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const { email } = request.body as { email: string }
        const origin = request.get('origin') || request.get('referer')
        await service.forgotPassword(email, origin)
        sendSuccess(response, 200, 'If this email exists, a reset link has been sent', null)
      } catch (error) {
        next(error)
      }
    },

    resetPassword: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const { token, password } = request.body as { token: string; password: string }
        await service.resetPassword(token, password)
        sendSuccess(response, 200, 'Password reset successful', null)
      } catch (error) {
        next(error)
      }
    },
  }
}
