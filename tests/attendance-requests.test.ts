import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createToken } from '../src/utils/jwt'

const {
  executeQueryMock,
  executeInsertMock,
  executeUpdateMock,
  withTransactionMock,
} = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  executeInsertMock: vi.fn(),
  executeUpdateMock: vi.fn(),
  withTransactionMock: vi.fn(async (cb: () => Promise<unknown>) => cb()),
}))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: executeQueryMock,
  executeInsert: executeInsertMock,
  executeUpdate: executeUpdateMock,
  executeDelete: vi.fn(),
  withTransaction: withTransactionMock,
  isSnowflakeConnected: () => true,
}))

// Mock socket broadcasting
vi.mock('../src/socket/socket.server', () => ({
  broadcastAttendanceRequestCreated: vi.fn(),
  broadcastAttendanceRequestDecided: vi.fn(),
  getSocketServer: () => null,
  initSocketServer: vi.fn(),
}))

vi.mock('../src/services/notification.service', () => ({
  notificationService: {
    createNotification: vi.fn().mockResolvedValue({}),
    notifyAdmins: vi.fn().mockResolvedValue(undefined),
    notifyLeaveReviewers: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../src/services/user-status.service', () => ({
  getUserStatus: vi.fn().mockResolvedValue('ACTIVE'),
  ensureTerminationTables: vi.fn().mockResolvedValue(undefined),
}))

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy-for-tokens'

let app: ReturnType<(typeof import('../src/app.js'))['createApp']>

beforeAll(async () => {
  const { createApp } = await import('../src/app.js')
  app = createApp()
})

beforeEach(() => {
  vi.clearAllMocks()
  executeQueryMock.mockReset()
  executeInsertMock.mockReset()
  executeUpdateMock.mockReset()
  withTransactionMock.mockReset()
  withTransactionMock.mockImplementation(async (cb: () => Promise<unknown>) => cb())
})

describe('Attendance Request & Approval API', () => {
  const employeeToken = createToken({ id: 10, email: 'emp@example.com', role: 'EMPLOYEE' })
  const adminToken = createToken({ id: 1, email: 'admin@example.com', role: 'ADMIN' })
  const hrToken = createToken({ id: 2, email: 'hr@example.com', role: 'HR' })
  const superAdminToken = createToken({ id: 3, email: 'super@example.com', role: 'SUPER_ADMIN' })

  describe('POST /api/attendance-requests (EMPLOYEE only)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await request(app)
        .post('/api/attendance-requests')
        .send({
          date: '2026-10-20',
          type: 'MISSED_PUNCH',
          reason: 'Forgot to swipe card at 9am',
        })
        .expect(401)
    })

    it('rejects ADMIN submission with 403 (EMPLOYEE only)', async () => {
      const res = await request(app)
        .post('/api/attendance-requests')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          date: '2026-10-20',
          type: 'MISSED_PUNCH',
          reason: 'Forgot to swipe card at 9am',
        })
        .expect(403)

      expect(res.body.message).toMatch(/forbidden/i)
    })

    it('validates input and blocks invalid date format', async () => {
      const res = await request(app)
        .post('/api/attendance-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          date: 'invalid-date',
          type: 'MISSED_PUNCH',
          reason: 'Valid reason here',
        })
        .expect(400)

      expect(res.body.message.toLowerCase()).toContain('validation failed')
    })

    it('blocks duplicate PENDING request for same employee + date with 409', async () => {
      // Mock employee lookup
      executeQueryMock
        .mockResolvedValueOnce([{ ID: 5 }]) // employee lookup for user
        .mockResolvedValueOnce([{ ID: 5, USER_ID: 10, EMPLOYEE_CODE: 'EMP-05' }]) // get employee
        .mockResolvedValueOnce([{ ID: 99 }]) // existing pending check: returns existing ID

      const res = await request(app)
        .post('/api/attendance-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          date: '2026-10-20',
          type: 'MISSED_PUNCH',
          reason: 'Duplicate check test',
        })
        .expect(409)

      expect(res.body.message).toContain('pending attendance request already exists')
    })

    it('successfully creates attendance request with status PENDING', async () => {
      // Mock employee lookup
      executeQueryMock
        .mockResolvedValueOnce([{ ID: 5 }]) // employee lookup
        .mockResolvedValueOnce([{ ID: 5, USER_ID: 10, EMPLOYEE_CODE: 'EMP-05' }]) // get employee
        .mockResolvedValueOnce([]) // existing pending: none
        .mockResolvedValueOnce([{
          ID: 101,
          EMPLOYEE_ID: 5,
          USER_ID: 10,
          ATTENDANCE_DATE: '2026-10-20',
          REQUEST_TYPE: 'MISSED_PUNCH',
          CHECK_IN_TIME: '09:00',
          CHECK_OUT_TIME: '18:00',
          REASON: 'Badge reader error',
          STATUS: 'PENDING',
          EMPLOYEE_NAME: 'John Doe',
          EMPLOYEE_EMAIL: 'emp@example.com',
          EMPLOYEE_CODE: 'EMP-05',
          DEPARTMENT_NAME: 'Engineering',
          CREATED_AT: '2026-10-19T10:00:00Z',
          UPDATED_AT: '2026-10-19T10:00:00Z',
        }]) // select newly inserted record

      const res = await request(app)
        .post('/api/attendance-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          date: '2026-10-20',
          type: 'MISSED_PUNCH',
          checkInTime: '09:00',
          checkOutTime: '18:00',
          reason: 'Badge reader error',
        })
        .expect(201)

      expect(res.body.success).toBe(true)
      expect(res.body.data.id).toBe(101)
      expect(res.body.data.status).toBe('PENDING')
      expect(res.body.data.employeeName).toBe('John Doe')
      expect(executeInsertMock).toHaveBeenCalled()
    })
  })

  describe('GET /api/attendance-requests', () => {
    it('allows ADMIN to see all requests', async () => {
      executeQueryMock.mockResolvedValueOnce([
        {
          ID: 101,
          EMPLOYEE_ID: 5,
          ATTENDANCE_DATE: '2026-10-20',
          REQUEST_TYPE: 'MISSED_PUNCH',
          STATUS: 'PENDING',
          EMPLOYEE_NAME: 'John Doe',
        },
        {
          ID: 102,
          EMPLOYEE_ID: 6,
          ATTENDANCE_DATE: '2026-10-21',
          REQUEST_TYPE: 'WORK_FROM_HOME',
          STATUS: 'APPROVED',
          EMPLOYEE_NAME: 'Jane Smith',
          DECIDED_BY_NAME: 'Admin User',
          DECIDED_BY_ROLE: 'ADMIN',
        },
      ])

      const res = await request(app)
        .get('/api/attendance-requests')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(res.body.data).toHaveLength(2)
      expect(res.body.data[0].employeeName).toBe('John Doe')
      expect(res.body.data[1].decidedByName).toBe('Admin User')
    })

    it('scopes list to own requests when accessed by EMPLOYEE', async () => {
      executeQueryMock
        .mockResolvedValueOnce([{ ID: 5 }]) // find employee for user id 10
        .mockResolvedValueOnce([
          {
            ID: 101,
            EMPLOYEE_ID: 5,
            ATTENDANCE_DATE: '2026-10-20',
            REQUEST_TYPE: 'MISSED_PUNCH',
            STATUS: 'PENDING',
            EMPLOYEE_NAME: 'John Doe',
          },
        ])

      const res = await request(app)
        .get('/api/attendance-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)

      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].employeeId).toBe(5)
      expect(executeQueryMock.mock.calls[1][0]).toContain('AR.EMPLOYEE_ID = ?')
      expect(executeQueryMock.mock.calls[1][1]).toContain(5)
    })
  })

  describe('PATCH /api/attendance-requests/:id/approve & reject (RACE CONDITION SAFETY)', () => {
    it('blocks EMPLOYEE from approving with 403', async () => {
      await request(app)
        .patch('/api/attendance-requests/101/approve')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403)
    })

    it('successfully approves a PENDING request and creates attendance entry', async () => {
      // 1. Initial lookup of target request
      executeQueryMock
        .mockResolvedValueOnce([
          {
            ID: 101,
            STATUS: 'PENDING',
            EMPLOYEE_ID: 5,
            ATTENDANCE_DATE: '2026-10-20',
            REQUEST_TYPE: 'MISSED_PUNCH',
            CHECK_IN_TIME: '09:00',
            CHECK_OUT_TIME: '18:00',
            EMPLOYEE_USER_ID: 10,
            EMPLOYEE_NAME: 'John Doe',
          },
        ])
        // 2. Lookup approver name
        .mockResolvedValueOnce([{ FULL_NAME: 'HR Manager' }])
        // 3. Inside transaction: check if attendance record already exists
        .mockResolvedValueOnce([]) // no existing attendance record
        // 4. Query updated record to return
        .mockResolvedValueOnce([
          {
            ID: 101,
            STATUS: 'APPROVED',
            EMPLOYEE_ID: 5,
            ATTENDANCE_DATE: '2026-10-20',
            REQUEST_TYPE: 'MISSED_PUNCH',
            CHECK_IN_TIME: '09:00',
            CHECK_OUT_TIME: '18:00',
            DECIDED_BY: 2,
            DECIDED_BY_NAME: 'HR Manager',
            DECIDED_BY_ROLE: 'HR',
            DECIDED_AT: '2026-10-19T10:30:00Z',
            EMPLOYEE_NAME: 'John Doe',
          },
        ])

      // Atomic update returns 1 affected row
      executeUpdateMock.mockResolvedValueOnce(1)

      const res = await request(app)
        .patch('/api/attendance-requests/101/approve')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.status).toBe('APPROVED')
      expect(res.body.data.decidedByName).toBe('HR Manager')
      expect(res.body.data.decidedByRole).toBe('HR')

      // Verify conditional update contained STATUS = 'PENDING'
      expect(executeUpdateMock.mock.calls[0][0]).toContain("STATUS = 'PENDING'")

      // Verify attendance insertion into ATTENDANCE table
      expect(executeInsertMock).toHaveBeenCalled()
      expect(executeInsertMock.mock.calls[0][0]).toMatch(/INSERT INTO .*ATTENDANCE/)
    })

    it('returns 409 Conflict with approver name if request was already handled', async () => {
      // Lookup returns already approved
      executeQueryMock.mockResolvedValueOnce([
        {
          ID: 101,
          STATUS: 'APPROVED',
          EMPLOYEE_ID: 5,
          DECIDED_BY_NAME: 'Super Admin Jane',
        },
      ])

      const res = await request(app)
        .patch('/api/attendance-requests/101/approve')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409)

      expect(res.body.message).toBe('Already handled by Super Admin Jane')
    })

    it('handles race condition when 2 approvers click simultaneously (0 rows updated)', async () => {
      // 1. Initial check finds it PENDING
      executeQueryMock
        .mockResolvedValueOnce([
          {
            ID: 101,
            STATUS: 'PENDING',
            EMPLOYEE_ID: 5,
            DECIDED_BY_NAME: null,
          },
        ])
        .mockResolvedValueOnce([{ FULL_NAME: 'Admin User' }])
        // When checking after 0 rows updated:
        .mockResolvedValueOnce([
          {
            DECIDED_BY_NAME: 'HR Sarah',
            DECIDED_BY_ROLE: 'HR',
            STATUS: 'APPROVED',
          },
        ])

      // Update fails because another approver committed first (0 rows affected)
      executeUpdateMock.mockResolvedValueOnce(0)

      const res = await request(app)
        .patch('/api/attendance-requests/101/approve')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409)

      expect(res.body.message).toBe('Already handled by HR Sarah')
    })

    it('successfully rejects request with optional reason', async () => {
      executeQueryMock
        .mockResolvedValueOnce([
          {
            ID: 101,
            STATUS: 'PENDING',
            EMPLOYEE_ID: 5,
            EMPLOYEE_USER_ID: 10,
            EMPLOYEE_NAME: 'John Doe',
          },
        ])
        .mockResolvedValueOnce([{ FULL_NAME: 'Super Admin' }])
        .mockResolvedValueOnce([
          {
            ID: 101,
            STATUS: 'REJECTED',
            DECIDED_BY_NAME: 'Super Admin',
            DECIDED_BY_ROLE: 'SUPER_ADMIN',
            REJECT_REASON: 'Insufficient proof provided',
          },
        ])

      executeUpdateMock.mockResolvedValueOnce(1)

      const res = await request(app)
        .patch('/api/attendance-requests/101/reject')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ reason: 'Insufficient proof provided' })
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.status).toBe('REJECTED')
      expect(res.body.data.rejectReason).toBe('Insufficient proof provided')
    })
  })
})
