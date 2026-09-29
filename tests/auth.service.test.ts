import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: queryMock,
  executeInsert: queryMock,
  executeUpdate: queryMock,
  executeDelete: queryMock,
}))

import { authService } from '../src/services/auth.service'
import { hashPassword } from '../src/utils/password'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy'

describe('authService role migration', () => {
  beforeEach(() => queryMock.mockReset())

  it('normalizes legacy USER accounts to EMPLOYEE in profile and token', async () => {
    const passwordHash = await hashPassword('Password123')
    queryMock.mockResolvedValueOnce([{
      ID: 12,
      FULL_NAME: 'Legacy User',
      EMAIL: 'legacy@example.com',
      PASSWORD_HASH: passwordHash,
      ROLE: 'USER',
    }])
    queryMock.mockResolvedValueOnce(undefined)

    const result = await authService.login('legacy@example.com', 'Password123')
    expect(result.user.role).toBe('EMPLOYEE')
    const claims = jwt.decode(result.token) as jwt.JwtPayload
    expect(claims.role).toBe('EMPLOYEE')
  })
})