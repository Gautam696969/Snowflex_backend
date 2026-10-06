import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const { executeQueryMock, executeInsertMock, executeUpdateMock, executeDeleteMock, withTransactionMock, approveBalanceMock, releaseBalanceMock, notifyRequestMock, notifyApplicantMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  executeInsertMock: vi.fn(),
  executeUpdateMock: vi.fn(),
  executeDeleteMock: vi.fn(),
  withTransactionMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  approveBalanceMock: vi.fn(),
  releaseBalanceMock: vi.fn(),
  notifyRequestMock: vi.fn(),
  notifyApplicantMock: vi.fn(),
}))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: executeQueryMock,
  executeInsert: executeInsertMock,
  executeUpdate: executeUpdateMock,
  executeDelete: executeDeleteMock,
  withTransaction: withTransactionMock,
}))

vi.mock('../src/services/leave-balance.service', () => ({
  leaveBalanceService: {
    approveLeave: approveBalanceMock,
    releasePending: releaseBalanceMock,
    reservePending: vi.fn(),
    getBalancesForEmployee: vi.fn(async () => []),
    getBalancesForUser: vi.fn(async () => []),
  },
}))

vi.mock('../src/services/notification.service', () => ({
  notificationService: {
    notifyLeaveReviewers: notifyRequestMock,
    createNotification: notifyApplicantMock,
  },
}))

import { leaveService } from '../src/services/leave.service'
import { assertNotLastActiveSuperAdmin } from '../src/utils/super-admin-safeguards'
import { leaveRouter } from '../src/routes/leave.routes'
import { leaveBalanceRouter } from '../src/routes/leave-balance.routes'
import { createAdminRouter } from '../src/routes/admin.routes'
import { errorHandler } from '../src/middleware/error.middleware'
import { createToken } from '../src/utils/jwt'
import type { AuthServiceContract } from '../src/services/auth.service'

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy'

let requestRow: Record<string, unknown>

function createLeaveApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/leaves', leaveRouter)
  app.use('/api/leave-balances', leaveBalanceRouter)
  app.use(errorHandler)
  return app
}

function createAdminApp() {
  const app = express()
  app.use(express.json())
  const fakeAuthService = {
    register: vi.fn(),
    login: vi.fn(),
    getUserById: vi.fn(),
    listUsers: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
  } as unknown as AuthServiceContract
  app.use('/api/admin', createAdminRouter(fakeAuthService))
  app.use(errorHandler)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  requestRow = {
    ID: 77,
    STATUS: 'PENDING',
    EMPLOYEE_ID: 300,
    LEAVE_TYPE_ID: 4,
    START_DATE: '2026-10-07',
    END_DATE: '2026-10-07',
    DAYS_COUNT: 1,
    LEAVE_TYPE_NAME: 'Annual leave',
    USER_ID: 30,
    APPLICANT_ROLE: 'EMPLOYEE',
  }
  executeQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM LEAVE_REQUESTS L') && sql.includes('WHERE L.ID = ?')) return [requestRow]
    if (sql.includes('SELECT FULL_NAME FROM USERS')) return [{ FULL_NAME: 'Casey Approver' }]
    if (sql.includes('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?')) return [{ ID: 300 }]
    if (sql.includes('SELECT ID, NAME, CODE, IS_PAID')) return [{ ID: 4, NAME: 'Annual leave', CODE: 'AL', IS_PAID: true, YEARLY_QUOTA: null, REQUIRES_DOCUMENT: false, IS_ACTIVE: true }]
    if (sql.includes('SELECT ID, START_DATE, END_DATE, STATUS')) return []
    if (sql.includes("UPPER(U.ROLE) = 'SUPER_ADMIN'")) return []
    if (sql.includes('ORDER BY CREATED_AT DESC, ID DESC LIMIT 1')) return [{ ID: 77 }]
    if (sql.includes('SELECT FULL_NAME FROM USERS WHERE ID = ?')) return [{ FULL_NAME: 'Casey Applicant' }]
    return []
  })
  executeInsertMock.mockResolvedValue(undefined)
  executeUpdateMock.mockResolvedValue(1)
  executeDeleteMock.mockResolvedValue(undefined)
  approveBalanceMock.mockResolvedValue(undefined)
  releaseBalanceMock.mockResolvedValue(undefined)
  notifyRequestMock.mockResolvedValue(undefined)
  notifyApplicantMock.mockResolvedValue(undefined)
  withTransactionMock.mockImplementation(async (fn: () => Promise<unknown>) => fn())
})

describe('leave approval hierarchy', () => {
  it('lets an Admin decide an employee request and notifies the applicant', async () => {
    await leaveService.decide(77, 20, 'ADMIN', 'APPROVED')

    expect(executeUpdateMock).toHaveBeenCalledWith(
      expect.stringContaining("WHERE ID = ? AND STATUS = 'PENDING'"),
      ['APPROVED', 20, null, null, 77],
    )
    expect(approveBalanceMock).toHaveBeenCalledOnce()
    expect(notifyApplicantMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 30,
      type: 'LEAVE_APPROVED',
      message: expect.stringContaining('approved by Casey Approver'),
    }))
  })

  it('allows only a Super Admin to decide an Admin request, including direct API calls', async () => {
    requestRow = { ...requestRow, APPLICANT_ROLE: 'ADMIN' }
    const token = createToken({ id: 20, email: 'admin@example.com', role: 'ADMIN' })

    const response = await request(createLeaveApp())
      .patch('/api/leaves/77/approve')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)

    expect(response.body.message).toBe('Only a Super Admin can decide an Admin leave request')
    expect(executeUpdateMock).not.toHaveBeenCalled()
    expect(approveBalanceMock).not.toHaveBeenCalled()
  })

  it('allows a Super Admin to decide an Admin request', async () => {
    requestRow = { ...requestRow, APPLICANT_ROLE: 'ADMIN' }
    await leaveService.decide(77, 21, 'SUPER_ADMIN', 'APPROVED')
    expect(executeUpdateMock).toHaveBeenCalledOnce()
    expect(approveBalanceMock).toHaveBeenCalledOnce()
  })

  it('does not let an Admin request the privileged approval list', async () => {
    const token = createToken({ id: 20, email: 'admin@example.com', role: 'ADMIN' })
    const response = await request(createLeaveApp())
      .get('/api/leaves?scope=admin')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
    expect(response.body.message).toBe('Only a Super Admin can view Admin leave requests')
  })

  it('separates employee and privileged requests in approver list queries', async () => {
    await leaveService.listAll(20, 'ADMIN', 'team')
    const adminTeamQuery = String(executeQueryMock.mock.calls.at(-1)?.[0])
    expect(adminTeamQuery).toContain('E.USER_ID <> ?')
    expect(adminTeamQuery).toContain("REGEXP_REPLACE(UPPER(TRIM(U.ROLE)), '[[:space:]-]+', '_') NOT IN ('ADMIN', 'SUPER_ADMIN')")
    expect(executeQueryMock.mock.calls.at(-1)?.[1]).toEqual([20])

    await leaveService.listAll(21, 'SUPER_ADMIN', 'admin')
    const superAdminQuery = String(executeQueryMock.mock.calls.at(-1)?.[0])
    expect(superAdminQuery).toContain("REGEXP_REPLACE(UPPER(TRIM(U.ROLE)), '[[:space:]-]+', '_') IN ('ADMIN', 'SUPER_ADMIN')")
    expect(executeQueryMock.mock.calls.at(-1)?.[1]).toEqual([21])

    await leaveService.listAll(21, 'SUPER ADMIN', 'admin')
    expect(executeQueryMock.mock.calls.at(-1)?.[1]).toEqual([21])
  })

  it.each([
    ['EMPLOYEE', 'team', 403],
    ['EMPLOYEE', 'admin', 403],
    ['ADMIN', 'team', 200],
    ['ADMIN', 'admin', 403],
    ['SUPER_ADMIN', 'team', 200],
    ['SUPER_ADMIN', 'admin', 200],
  ] as const)('GET /leaves as %s with scope=%s returns %i', async (role, scope, status) => {
    const token = createToken({ id: 20, email: `${role.toLowerCase()}@example.com`, role })
    const response = await request(createLeaveApp())
      .get(`/api/leaves?scope=${scope}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(status)

    if (status === 200) expect(response.body.data).toEqual([])
  })

  it.each([
    ['EMPLOYEE', 403],
    ['ADMIN', 200],
    ['SUPER_ADMIN', 200],
  ] as const)('GET /leaves with default scope as %s returns %i', async (role, status) => {
    const token = createToken({ id: 20, email: `${role.toLowerCase()}@example.com`, role })
    const response = await request(createLeaveApp())
      .get('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .expect(status)

    if (status === 200) expect(response.body.data).toEqual([])
  })

  it.each(['EMPLOYEE', 'ADMIN', 'SUPER_ADMIN'] as const)('GET /leaves/me returns the signed-in user list for %s', async (role) => {
    const token = createToken({ id: 20, email: `${role.toLowerCase()}@example.com`, role })
    const response = await request(createLeaveApp())
      .get('/api/leaves/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(response.body.data).toEqual([])
  })

  it.each(['EMPLOYEE', 'ADMIN', 'SUPER_ADMIN'] as const)('GET /leave-balances/me returns the signed-in user balance list for %s', async (role) => {
    const token = createToken({ id: 20, email: `${role.toLowerCase()}@example.com`, role })
    const response = await request(createLeaveApp())
      .get('/api/leave-balances/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(response.body.data).toEqual([])
  })

  it('returns 401 for /leaves/me without a valid token', async () => {
    await request(createLeaveApp())
      .get('/api/leaves/me')
      .expect(401, { success: false, message: 'Unauthorized', error: null })
  })

  it('returns 400 for an unsupported leave scope', async () => {
    const token = createToken({ id: 21, email: 'super-admin@example.com', role: 'SUPER_ADMIN' })
    const response = await request(createLeaveApp())
      .get('/api/leaves?scope=department')
      .set('Authorization', `Bearer ${token}`)
      .expect(400)

    expect(response.body.message).toBe('scope must be either team or admin')
  })

  it('accepts a rejection without a reason', async () => {
    const token = createToken({ id: 20, email: 'admin@example.com', role: 'ADMIN' })
    await request(createLeaveApp())
      .patch('/api/leaves/77/reject')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'SUPER_ADMIN' })
      .expect(200)
    expect(executeUpdateMock).toHaveBeenCalledWith(
      expect.stringContaining("WHERE ID = ? AND STATUS = 'PENDING'"),
      ['REJECTED', 20, null, null, 77],
    )
  })

  it('blocks employees from reaching approver APIs', async () => {
    const token = createToken({ id: 30, email: 'employee@example.com', role: 'EMPLOYEE' })
    await request(createLeaveApp())
      .patch('/api/leaves/77/approve')
      .set('Authorization', `Bearer ${token}`)
      .expect(403, { success: false, message: 'Forbidden', error: null })
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it('blocks a user from deciding their own request', async () => {
    await expect(leaveService.decide(77, 30, 'SUPER_ADMIN', 'REJECTED', 'Not available'))
      .rejects.toMatchObject({ statusCode: 403, message: 'You cannot approve your own leave' })
    expect(executeUpdateMock).not.toHaveBeenCalled()
  })

  it('auto-approves a Super Admin request when no other active Super Admin exists', async () => {
    const result = await leaveService.create(20, {
      leaveTypeId: 4,
      startDate: '2026-10-07',
      endDate: '2026-10-07',
      reason: 'Personal appointment',
    }, 'SUPER_ADMIN')

    expect(result).toEqual({ id: 77, daysCount: 1 })
    expect(executeInsertMock).toHaveBeenCalledWith(
      expect.stringContaining('DECIDED_AT, DECISION_NOTE, AUTO_APPROVED'),
      expect.arrayContaining(['APPROVED', true, 'Auto-approved (no approver available)']),
    )
    expect(approveBalanceMock).toHaveBeenCalledOnce()
    expect(notifyRequestMock).not.toHaveBeenCalled()
  })

  it('processes only one decision when simultaneous updates race', async () => {
    executeUpdateMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

    await leaveService.decide(77, 20, 'ADMIN', 'APPROVED')
    await expect(leaveService.decide(77, 21, 'SUPER_ADMIN', 'REJECTED'))
      .rejects.toMatchObject({ statusCode: 409, message: 'Leave request has already been decided' })

    expect(approveBalanceMock).toHaveBeenCalledOnce()
    expect(releaseBalanceMock).not.toHaveBeenCalled()
    expect(notifyApplicantMock).toHaveBeenCalledOnce()
  })

  it('single approve via API returns 200, updates status once, and returns updated record', async () => {
    const token = createToken({ id: 21, email: 'super-admin@example.com', role: 'SUPER_ADMIN' })
    const response = await request(createLeaveApp())
      .patch('/api/leaves/77/approve')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(response.body.success).toBe(true)
    expect(response.body.message).toBe('Leave request approved')
    expect(response.body.data).toBeDefined()
    expect(executeUpdateMock).toHaveBeenCalledWith(
      expect.stringContaining("WHERE ID = ? AND STATUS = 'PENDING'"),
      ['APPROVED', 21, null, null, 77],
    )
    expect(approveBalanceMock).toHaveBeenCalledOnce()
  })

  it('two concurrent approves on the same request produce exactly one 200 and one 409', async () => {
    const token = createToken({ id: 21, email: 'super-admin@example.com', role: 'SUPER_ADMIN' })
    executeUpdateMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

    const [res1, res2] = await Promise.all([
      request(createLeaveApp())
        .patch('/api/leaves/77/approve')
        .set('Authorization', `Bearer ${token}`),
      request(createLeaveApp())
        .patch('/api/leaves/77/approve')
        .set('Authorization', `Bearer ${token}`),
    ])

    const statuses = [res1.status, res2.status].sort()
    expect(statuses).toEqual([200, 409])

    const conflictRes = res1.status === 409 ? res1 : res2
    expect(conflictRes.body.success).toBe(false)
    expect(conflictRes.body.message).toBe('Leave request has already been decided')
    expect(conflictRes.body.currentStatus).toBeDefined()
  })

  it('failure in notification step within transaction rolls back and throws error without half-done state', async () => {
    notifyApplicantMock.mockRejectedValueOnce(new Error('Notification DB failure'))
    let rolledBack = false
    withTransactionMock.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      try {
        return await fn()
      } catch (err) {
        rolledBack = true
        throw err
      }
    })

    await expect(leaveService.decide(77, 21, 'SUPER_ADMIN', 'APPROVED'))
      .rejects.toThrow('Notification DB failure')

    expect(rolledBack).toBe(true)
  })

  it('rejects demoting the last active Super Admin', async () => {
    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE U.ID = ?')) return [{ ROLE: 'SUPER_ADMIN', EMPLOYEE_STATUS: 'ACTIVE' }]
      if (sql.includes("WHERE UPPER(U.ROLE) = 'SUPER_ADMIN'")) return [{ CNT: 1 }]
      return []
    })

    await expect(assertNotLastActiveSuperAdmin(20, 'demote'))
      .rejects.toMatchObject({ statusCode: 409, message: 'Cannot demote the last active SUPER_ADMIN.' })
  })

  it('blocks last-Super-Admin demotion through the role-management API', async () => {
    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE U.ID = ?')) return [{ ROLE: 'SUPER_ADMIN', EMPLOYEE_STATUS: 'ACTIVE' }]
      if (sql.includes("WHERE UPPER(U.ROLE) = 'SUPER_ADMIN'")) return [{ CNT: 1 }]
      return []
    })
    const token = createToken({ id: 10, email: 'admin@example.com', role: 'ADMIN' })

    const response = await request(createAdminApp())
      .patch('/api/admin/users/20/role')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'EMPLOYEE' })
      .expect(409)

    expect(response.body.message).toBe('Cannot demote the last active SUPER_ADMIN.')
    expect(executeQueryMock).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE'))
  })

  it('normalizes the Super Admin display label before role validation', async () => {
    const token = createToken({ id: 10, email: 'super-admin@example.com', role: 'SUPER_ADMIN' })
    await request(createAdminApp())
      .patch('/api/admin/users/20/role')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ' super admin ' })
      .expect(200)

    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE'),
      ['SUPER_ADMIN', 20],
    )
  })

  it.each(['deactivate', 'remove'] as const)('blocks %s of the last active Super Admin', async (action) => {
    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE U.ID = ?')) return [{ ROLE: 'SUPER_ADMIN', EMPLOYEE_STATUS: 'ACTIVE' }]
      if (sql.includes("WHERE UPPER(U.ROLE) = 'SUPER_ADMIN'")) return [{ CNT: 1 }]
      return []
    })
    await expect(assertNotLastActiveSuperAdmin(20, action))
      .rejects.toMatchObject({ statusCode: 409, message: `Cannot ${action} the last active SUPER_ADMIN.` })
  })

  it('keeps legacy decision history fields available for existing requests', async () => {
    executeQueryMock.mockResolvedValueOnce([{
      ID: 8,
      EMPLOYEE_ID: 300,
      REQUESTER_USER_ID: 30,
      STATUS: 'APPROVED',
      APPROVER_NAME: 'Legacy Approver',
      DECIDED_AT: '2025-04-03T10:00:00.000Z',
      AUTO_APPROVED: null,
    }])

    const rows = await leaveService.listForUser(30)
    expect(rows[0]).toMatchObject({ status: 'APPROVED', approverName: 'Legacy Approver', decidedAt: '2025-04-03T10:00:00.000Z' })
  })
})