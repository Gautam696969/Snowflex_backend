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

  it('registers the user and creates a linked employee profile', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{
        ID: 29,
        FULL_NAME: 'New User',
        EMAIL: 'new@example.com',
        PASSWORD_HASH: 'stored-hash',
        ROLE: 'EMPLOYEE',
      }])
      .mockResolvedValueOnce(undefined)

    await authService.register('New User', 'new@example.com', 'Password123')

    expect(queryMock.mock.calls[0][0]).toBe(
      'SELECT ID, FULL_NAME, EMAIL, PASSWORD_HASH, ROLE FROM "AUTH_PROJECT"."PUBLIC"."USERS" WHERE EMAIL = ?',
    )
    expect(queryMock.mock.calls[1][0]).toContain(
      'INSERT INTO "AUTH_PROJECT"."PUBLIC"."USERS"',
    )
    expect(queryMock.mock.calls[2][0]).toContain(
      'SELECT ID, FULL_NAME, EMAIL, PASSWORD_HASH, ROLE FROM "AUTH_PROJECT"."PUBLIC"."USERS"',
    )
    expect(queryMock.mock.calls[3][0]).toContain(
      'INSERT INTO "AUTH_PROJECT"."PUBLIC"."EMPLOYEES"',
    )
  })

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
    expect(queryMock.mock.calls[0][0]).toContain('FROM "AUTH_PROJECT"."PUBLIC"."USERS"')
    expect(queryMock.mock.calls[1][0]).toContain('UPDATE "AUTH_PROJECT"."PUBLIC"."USERS"')
    const claims = jwt.decode(result.token) as jwt.JwtPayload
    expect(claims.role).toBe('EMPLOYEE')
  })

  it('loads the authenticated profile from uppercase USERS columns', async () => {
    queryMock.mockResolvedValueOnce([{
      ID: 23,
      FULL_NAME: 'Profile User',
      EMAIL: 'profile@example.com',
      ROLE: 'EMPLOYEE',
    }])

    await expect(authService.getUserById(23)).resolves.toEqual({
      id: 23,
      fullName: 'Profile User',
      email: 'profile@example.com',
      role: 'EMPLOYEE',
    })
    expect(queryMock.mock.calls[0][0]).toBe(
      'SELECT ID, FULL_NAME, EMAIL, ROLE FROM "AUTH_PROJECT"."PUBLIC"."USERS" WHERE ID = ?',
    )
  })
})