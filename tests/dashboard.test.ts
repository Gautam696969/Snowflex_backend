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
      'SELECT ID FROM "EMPLOYEES" WHERE USER_ID = ?',
    )
    expect(executeQueryMock.mock.calls[1][0]).toContain(
      'FROM "ATTENDANCE"',
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

describe('Role-based Employee Dashboard Access & ID Routing', () => {
  const superAdminToken = createToken({ id: 100, email: 'superadmin@example.com', role: 'SUPER_ADMIN' })
  const adminToken = createToken({ id: 101, email: 'admin@example.com', role: 'ADMIN' })
  const hrToken = createToken({ id: 102, email: 'hr@example.com', role: 'HR' })
  const managerToken = createToken({ id: 103, email: 'manager@example.com', role: 'MANAGER' })
  const employeeToken = createToken({ id: 104, email: 'employee@example.com', role: 'EMPLOYEE' })

  it('returns 403 with clear message when SUPER_ADMIN calls /api/dashboard/employee without an ID and has no employee profile', async () => {
    executeQueryMock.mockResolvedValueOnce([])

    const res = await request(app)
      .get('/api/dashboard/employee')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(403)

    expect(res.body).toEqual({
      success: false,
      message: 'Employee profile not linked to this user',
      error: null,
    })
  })

  it('allows SUPER_ADMIN, ADMIN and HR to access /api/dashboard/employee/:id for any employee', async () => {
    for (const token of [superAdminToken, adminToken, hrToken]) {
      executeQueryMock
        .mockResolvedValueOnce([{ ID: 55, USER_ID: 200, MANAGER_ID: 10 }])
        .mockResolvedValueOnce([{
          ATTENDANCE_THIS_MONTH: 5,
          LEAVE_BALANCE: 20,
          PENDING_LEAVES: 1,
          ASSIGNED_TASKS: 3,
          COMPLETED_TASKS: 2,
        }])

      const res = await request(app)
        .get('/api/dashboard/employee/55')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.LEAVE_BALANCE).toBe(20)
    }
  })

  it('allows a normal employee to access only their own dashboard data via /api/dashboard/employee/:id', async () => {
    executeQueryMock
      .mockResolvedValueOnce([{ ID: 55, USER_ID: 104, MANAGER_ID: 10 }])
      .mockResolvedValueOnce([{
        ATTENDANCE_THIS_MONTH: 12,
        LEAVE_BALANCE: 15,
        PENDING_LEAVES: 0,
        ASSIGNED_TASKS: 2,
        COMPLETED_TASKS: 8,
      }])

    const ownRes = await request(app)
      .get('/api/dashboard/employee/55')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200)

    expect(ownRes.body.success).toBe(true)
    expect(ownRes.body.data.LEAVE_BALANCE).toBe(15)

    executeQueryMock
      .mockResolvedValueOnce([{ ID: 88, USER_ID: 999, MANAGER_ID: 10 }])

    const otherRes = await request(app)
      .get('/api/dashboard/employee/88')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403)

    expect(otherRes.body).toEqual({
      success: false,
      message: 'Role not allowed: you can only view your own dashboard data',
      error: null,
    })
  })

  it('allows MANAGER to view their team member, but blocks non-team member with 403', async () => {
    executeQueryMock
      .mockResolvedValueOnce([{ ID: 70, USER_ID: 301, MANAGER_ID: 50 }])
      .mockResolvedValueOnce([{ ID: 50 }])
      .mockResolvedValueOnce([{ ID: 70 }])
      .mockResolvedValueOnce([{
        ATTENDANCE_THIS_MONTH: 8,
        LEAVE_BALANCE: 10,
        PENDING_LEAVES: 1,
        ASSIGNED_TASKS: 1,
        COMPLETED_TASKS: 1,
      }])

    const teamRes = await request(app)
      .get('/api/dashboard/employee/70')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200)

    expect(teamRes.body.success).toBe(true)

    executeQueryMock
      .mockResolvedValueOnce([{ ID: 90, USER_ID: 302, MANAGER_ID: 99 }])
      .mockResolvedValueOnce([{ ID: 50 }])
      .mockResolvedValueOnce([])

    const nonTeamRes = await request(app)
      .get('/api/dashboard/employee/90')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403)

    expect(nonTeamRes.body).toEqual({
      success: false,
      message: "Role not allowed: you do not have permission to access this employee's dashboard",
      error: null,
    })
  })

  it('returns 404 when employee is not found', async () => {
    executeQueryMock.mockResolvedValueOnce([])

    const res = await request(app)
      .get('/api/dashboard/employee/99999')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(404)

    expect(res.body.message).toBe('Employee not found')
  })

  it('supports related calls (stats, upcoming, badge-count)', async () => {
    executeQueryMock
      .mockResolvedValueOnce([{ ID: 1, NAME: 'New Year', HOLIDAY_DATE: '2026-01-01', END_DATE: '2026-01-01', STATUS: 'ACTIVE' }])
      .mockResolvedValueOnce([])
    const upcomingRes = await request(app)
      .get('/api/dashboard/upcoming')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(200)
    expect(upcomingRes.body.success).toBe(true)

    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('LEAVE_REQUESTS')) return [{ CNT: 3 }]
      if (sql.includes('NOTIFICATIONS')) return [{ CNT: 0 }]
      if (sql.includes('ATTENDANCE_REQUESTS')) return [{ CNT: 2 }]
      return []
    })
    const badgeRes = await request(app)
      .get('/api/dashboard/badge-count')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(200)
    expect(badgeRes.body.success).toBe(true)
    expect(badgeRes.body.data.leaveBadgeCount).toBe(3)
    expect(badgeRes.body.data.attendanceBadgeCount).toBe(2)
    expect(badgeRes.body.data.total).toBe(5)
  })
})