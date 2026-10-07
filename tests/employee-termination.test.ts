import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createToken } from '../src/utils/jwt'
import { setUserStatusCache, clearUserStatusCache } from '../src/services/user-status.service'

const { executeQueryMock, executeUpdateMock, executeInsertMock, executeDeleteMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  executeUpdateMock: vi.fn(),
  executeInsertMock: vi.fn(),
  executeDeleteMock: vi.fn(),
}))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: executeQueryMock,
  executeInsert: executeInsertMock,
  executeUpdate: executeUpdateMock,
  executeDelete: executeDeleteMock,
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
  clearUserStatusCache(10)
  clearUserStatusCache(20)
  clearUserStatusCache(30)
  clearUserStatusCache(40)
})

describe('Employee Termination & Reactivation Endpoints', () => {
  const superAdminToken = createToken({ id: 1, email: 'superadmin@example.com', role: 'SUPER_ADMIN' })
  const adminToken = createToken({ id: 2, email: 'admin@example.com', role: 'ADMIN' })
  const hrToken = createToken({ id: 3, email: 'hr@example.com', role: 'HR' })
  const employeeToken = createToken({ id: 4, email: 'emp@example.com', role: 'EMPLOYEE' })

  describe('GET /api/employees/stats', () => {
    it('returns active, terminated, and byRole counts', async () => {
      executeQueryMock.mockResolvedValueOnce([{
        ACTIVE_COUNT: 12,
        TERMINATED_COUNT: 3,
        ROLE_SUPER_ADMIN: 1,
        ROLE_ADMIN: 2,
        ROLE_HR: 2,
        ROLE_MANAGER: 3,
        ROLE_EMPLOYEE: 4,
      }])

      const res = await request(app)
        .get('/api/employees/stats')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.activeCount).toBe(12)
      expect(res.body.data.terminatedCount).toBe(3)
      expect(res.body.data.byRole.SUPER_ADMIN).toBe(1)
      expect(res.body.data.byRole.EMPLOYEE).toBe(4)
    })
  })

  describe('POST /api/employees/:id/terminate permissions and validation', () => {
    it('rejects regular employees with 403', async () => {
      await request(app)
        .post('/api/employees/10/terminate')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ reason: 'Valid reason here' })
        .expect(403)
    })

    it('rejects short reason (< 5 characters) with 400', async () => {
      await request(app)
        .post('/api/employees/10/terminate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'bad' })
        .expect(400)
    })

    it('rejects self-termination with 403', async () => {
      executeQueryMock.mockResolvedValueOnce([{
        EMPLOYEE_ID: 10,
        USER_ID: 2, // matches adminToken id
        STATUS: 'ACTIVE',
        ROLE: 'ADMIN',
      }])

      const res = await request(app)
        .post('/api/employees/10/terminate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Cannot terminate self' })
        .expect(403)

      expect(res.body.message).toContain('Nobody can terminate themselves')
    })

    it('blocks HR from terminating ADMIN with 403', async () => {
      executeQueryMock.mockResolvedValueOnce([{
        EMPLOYEE_ID: 10,
        USER_ID: 20,
        STATUS: 'ACTIVE',
        ROLE: 'ADMIN',
      }])

      const res = await request(app)
        .post('/api/employees/10/terminate')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ reason: 'HR trying admin termination' })
        .expect(403)

      expect(res.body.message).toContain('HR cannot terminate administrators')
    })

    it('blocks ADMIN from terminating SUPER_ADMIN with 403', async () => {
      executeQueryMock.mockResolvedValueOnce([{
        EMPLOYEE_ID: 10,
        USER_ID: 20,
        STATUS: 'ACTIVE',
        ROLE: 'SUPER_ADMIN',
      }])

      const res = await request(app)
        .post('/api/employees/10/terminate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Admin trying superadmin termination' })
        .expect(403)

      expect(res.body.message).toContain('Administrators cannot terminate Super Administrators')
    })

    it('allows HR to terminate normal EMPLOYEE', async () => {
      executeQueryMock
        // Target lookup
        .mockResolvedValueOnce([{
          EMPLOYEE_ID: 10,
          USER_ID: 30,
          STATUS: 'ACTIVE',
          ROLE: 'EMPLOYEE',
        }])
        // Updated employee lookup in get(id)
        .mockResolvedValueOnce([{
          ID: 10,
          USER_ID: 30,
          FULL_NAME: 'Target Employee',
          EMAIL: 'target@example.com',
          STATUS: 'TERMINATED',
          TERMINATION_REASON: 'Policy violation',
        }])

      const res = await request(app)
        .post('/api/employees/10/terminate')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ reason: 'Policy violation' })
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.message).toContain('Employee terminated successfully')
      expect(executeUpdateMock).toHaveBeenCalledTimes(2) // Users & Employees
      expect(executeInsertMock).toHaveBeenCalledTimes(1) // Audit log
    })

    it('returns 400 when attempting to terminate an already terminated employee', async () => {
      executeQueryMock.mockResolvedValueOnce([{
        EMPLOYEE_ID: 10,
        USER_ID: 30,
        STATUS: 'TERMINATED',
        ROLE: 'EMPLOYEE',
      }])

      const res = await request(app)
        .post('/api/employees/10/terminate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Already terminated employee' })
        .expect(400)

      expect(res.body.message).toContain('Employee is already terminated')
    })

    it('returns 404 when employee does not exist', async () => {
      executeQueryMock
        .mockResolvedValueOnce([]) // No employee
        .mockResolvedValueOnce([]) // No user

      await request(app)
        .post('/api/employees/999/terminate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Non-existent employee' })
        .expect(404)
    })
  })

  describe('POST /api/employees/:id/reactivate', () => {
    it('blocks HR from reactivating with 403', async () => {
      await request(app)
        .post('/api/employees/10/reactivate')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(403)
    })

    it('allows ADMIN to reactivate a terminated employee', async () => {
      executeQueryMock
        .mockResolvedValueOnce([{
          EMPLOYEE_ID: 10,
          USER_ID: 30,
          STATUS: 'TERMINATED',
          ROLE: 'EMPLOYEE',
        }])
        .mockResolvedValueOnce([{
          ID: 10,
          USER_ID: 30,
          FULL_NAME: 'Target Employee',
          EMAIL: 'target@example.com',
          STATUS: 'ACTIVE',
        }])

      const res = await request(app)
        .post('/api/employees/10/reactivate')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.message).toContain('Employee reactivated successfully')
    })

    it('returns 400 if employee is already active', async () => {
      executeQueryMock.mockResolvedValueOnce([{
        EMPLOYEE_ID: 10,
        USER_ID: 30,
        STATUS: 'ACTIVE',
        ROLE: 'EMPLOYEE',
      }])

      const res = await request(app)
        .post('/api/employees/10/reactivate')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(res.body.message).toContain('Employee is already active')
    })
  })

  describe('Immediate access revocation', () => {
    it('rejects authenticated requests when user status is cached as TERMINATED', async () => {
      const termUserToken = createToken({ id: 40, email: 'term@example.com', role: 'EMPLOYEE' })
      setUserStatusCache(40, 'TERMINATED')

      const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${termUserToken}`)
        .expect(403)

      expect(res.body.message).toBe('Your account has been deactivated. Please contact HR.')
    })
  })
})
