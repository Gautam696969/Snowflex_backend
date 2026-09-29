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

  it('keeps database details out of the generic error response', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    executeQueryMock.mockRejectedValueOnce(new Error('private database detail'))

    await request(app)
      .get('/api/dashboard/employee')
      .set('Authorization', `Bearer ${token}`)
      .expect(500, { success: false, message: 'Internal server error', error: null })

    log.mockRestore()
  })
})