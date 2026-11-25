import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken'
import { normalizeRole } from './roles'

export interface AuthenticatedUser {
  id: number
  fullName: string
  email: string
  role: string
  avatarUrl?: string | null
  status?: string
}

export interface AuthTokenPayload {
  id: number
  email: string
  role: string
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT configuration is incomplete')
  }
  return secret
}

function getRefreshSecret(): string {
  return (process.env.JWT_REFRESH_SECRET || `${getJwtSecret()}:refresh`).trim()
}

export function createToken(user: AuthTokenPayload): string {
  // Short-lived access token (15m default; configurable via JWT_ACCESS_EXPIRES_IN)
  const payload: AuthTokenPayload = { id: user.id, email: user.email, role: normalizeRole(user.role) }
  const expiresIn = (process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '15m') as SignOptions['expiresIn']
  return jwt.sign(payload, getJwtSecret(), { expiresIn })
}

export function createRefreshToken(user: AuthTokenPayload): string {
  const payload: AuthTokenPayload & { type: 'refresh' } = {
    id: user.id,
    email: user.email,
    role: normalizeRole(user.role),
    type: 'refresh',
  }
  const expiresIn = (process.env.JWT_REFRESH_EXPIRES_IN || '60d') as SignOptions['expiresIn']
  return jwt.sign(payload, getRefreshSecret(), { expiresIn })
}

export function verifyToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, getJwtSecret()) as JwtPayload & Partial<AuthTokenPayload>
  if (
    typeof payload.id !== 'number' ||
    typeof payload.email !== 'string' ||
    typeof payload.role !== 'string'
  ) {
    throw new Error('Invalid token payload')
  }
  return {
    id: payload.id,
    email: payload.email,
    role: normalizeRole(payload.role),
  }
}

export function verifyRefreshToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, getRefreshSecret()) as JwtPayload & Partial<AuthTokenPayload> & { type?: string }
  if (
    payload.type !== 'refresh' ||
    typeof payload.id !== 'number' ||
    typeof payload.email !== 'string' ||
    typeof payload.role !== 'string'
  ) {
    throw new Error('Invalid refresh token payload')
  }
  return {
    id: payload.id,
    email: payload.email,
    role: normalizeRole(payload.role),
  }
}
