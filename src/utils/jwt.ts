import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken'

export interface AuthenticatedUser {
  id: number
  fullName: string
  email: string
  role: string
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

export function createToken(user: AuthTokenPayload): string {
  // Keep profile details out of the token; /me loads them from Snowflake.
  const payload: AuthTokenPayload = { id: user.id, email: user.email, role: user.role }
  const options: SignOptions = { expiresIn: '1d' }
  return jwt.sign(payload, getJwtSecret(), options)
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
    role: payload.role,
  }
}
