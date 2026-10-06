import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createToken } from '../src/utils/jwt'

const { executeQueryMock } = vi.hoisted(() => ({ executeQueryMock: vi.fn() }))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: executeQueryMock,
  executeInsert: vi.fn(),
  executeUpdate: vi.fn(),
  executeDelete: vi.fn(),
  isSnowflakeConnected: () => true,
}))

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy'

let app: ReturnType<(typeof import('../src/app.js'))['createApp']>

beforeAll(async () => {
  const { createApp } = await import('../src/app.js')
  app = createApp()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/attendance/me', () => {
  const token = createToken({ id: 29, email: 'employee@example.com', role: 'EMPLOYEE' })

  it('resolves the employee record and returns the user avatar with attendance', async () => {
    executeQueryMock
      .mockResolvedValueOnce([{ ID: 4 }])
      .mockResolvedValueOnce([{
        ID: 4,
        USER_ID: 29,
        FULL_NAME: 'Employee User',
        EMAIL: 'employee@example.com',
        AVATAR_URL: '/uploads/avatars/employee.webp',
      }])
      .mockResolvedValueOnce([{
        ID: 8,
        EMPLOYEE_ID: 4,
        FULL_NAME: 'Employee User',
        EMAIL: 'employee@example.com',
        AVATAR_URL: '/uploads/avatars/employee.webp',
        ATTENDANCE_DATE: '2026-09-29',
        STATUS: 'PRESENT',
      }])

    const response = await request(app)
      .get('/api/attendance/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0].avatarUrl).toBe('/uploads/avatars/employee.webp')
    expect(executeQueryMock).toHaveBeenCalledTimes(3)
    expect(executeQueryMock.mock.calls[0][0]).toContain('WHERE USER_ID = ?')
    expect(executeQueryMock.mock.calls[0][1]).toEqual([29])
    expect(executeQueryMock.mock.calls[2][0]).toContain('U.AVATAR_URL')
    expect(executeQueryMock.mock.calls[2][1]).toEqual([4])
  })

  it('exposes the underlying error outside production if the attendance query fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    executeQueryMock.mockRejectedValueOnce(new Error('private database detail'))

    await request(app)
      .get('/api/attendance/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(500, { success: false, message: 'Internal server error', error: 'private database detail' })

    log.mockRestore()
  })
})