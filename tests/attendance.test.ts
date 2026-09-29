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

  it('queries attendance by the authenticated USERS ID without looking up EMPLOYEES', async () => {
    executeQueryMock.mockResolvedValueOnce([{
      ID: 4,
      EMPLOYEE_ID: 29,
      ATTENDANCE_DATE: '2026-09-29',
      STATUS: 'PRESENT',
    }])

    const response = await request(app)
      .get('/api/attendance/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(response.body.data).toHaveLength(1)
    expect(executeQueryMock).toHaveBeenCalledTimes(1)
    expect(executeQueryMock.mock.calls[0][0]).toContain('FROM ATTENDANCE WHERE EMPLOYEE_ID = ?')
    expect(executeQueryMock.mock.calls[0][1]).toEqual([29])
    expect(String(executeQueryMock.mock.calls[0][0])).not.toContain('EMPLOYEES')
  })

  it('keeps the generic error response if the attendance query fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    executeQueryMock.mockRejectedValueOnce(new Error('private database detail'))

    await request(app)
      .get('/api/attendance/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(500, { success: false, message: 'Internal server error', error: null })

    log.mockRestore()
  })
})