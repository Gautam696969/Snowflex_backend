import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
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
process.env.SNOWFLAKE_DATABASE = 'AUTH_PROJECT'
process.env.SNOWFLAKE_SCHEMA = 'PUBLIC'

let app: ReturnType<(typeof import('../src/app.js'))['createApp']>

beforeAll(async () => {
  const { createApp } = await import('../src/app.js')
  app = createApp()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('employee dashboard', () => {
  const token = createToken({ id: 1, email: 'employee@example.com', role: 'EMPLOYEE' })

  it('uses configured, qualified Snowflake table names', async () => {
    executeQueryMock
      .mockResolvedValueOnce([{ ID: 42 }])
      .mockResolvedValueOnce([{
        ATTENDANCE_THIS_MONTH: 0,
        LEAVE_BALANCE: 40,
        PENDING_LEAVES: 0,
        ASSIGNED_TASKS: 0,
        COMPLETED_TASKS: 0,
      }])

    await request(app)
      .get('/api/dashboard/employee')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(executeQueryMock.mock.calls[0][0]).toBe(
      'SELECT ID FROM "AUTH_PROJECT"."PUBLIC"."EMPLOYEES" WHERE USER_ID = ?',
    )
    expect(executeQueryMock.mock.calls[1][0]).toContain(
      'FROM "AUTH_PROJECT"."PUBLIC"."ATTENDANCE"',
    )
  })

  it('exposes database details in development diagnostics', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    executeQueryMock.mockRejectedValueOnce(new Error('private database detail'))

    await request(app)
      .get('/api/dashboard/employee')
      .set('Authorization', `Bearer ${token}`)
      .expect(500, { success: false, message: 'Internal server error', error: 'private database detail' })

    log.mockRestore()
  })
})

describe('Super Admin dashboard access', () => {
  it('allows a display-form Super Admin JWT to access the admin dashboard endpoint', async () => {
    const token = jwt.sign(
      { id: 12, email: 'super-admin@example.com', role: 'SUPER ADMIN' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    )
    executeQueryMock.mockResolvedValueOnce([{
      TOTAL_EMPLOYEES: 4,
      ACTIVE_EMPLOYEES: 4,
      PRESENT_TODAY: 3,
      ABSENT_TODAY: 1,
      LATE_TODAY: 0,
      PENDING_LEAVES: 0,
      PENDING_TASKS: 0,
    }])

    const response = await request(app)
      .get('/api/dashboard/admin')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(response.body.success).toBe(true)
    expect(executeQueryMock).toHaveBeenCalledOnce()
  })
})