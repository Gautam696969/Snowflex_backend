import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createToken } from '../src/utils/jwt'
import { clearHolidayCache } from '../src/services/holiday.service'

const { executeQueryMock, executeInsertMock, executeUpdateMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  executeInsertMock: vi.fn(),
  executeUpdateMock: vi.fn(),
}))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: executeQueryMock,
  executeInsert: executeInsertMock,
  executeUpdate: executeUpdateMock,
  isSnowflakeConnected: () => true,
}))

vi.mock('../src/socket/socket.server', () => ({
  getSocketServer: () => ({
    emit: vi.fn(),
  }),
}))

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy'

let app: ReturnType<(typeof import('../src/app.js'))['createApp']>

beforeAll(async () => {
  const { createApp } = await import('../src/app.js')
  app = createApp()
})

beforeEach(() => {
  vi.clearAllMocks()
  clearHolidayCache()
})

describe('Holiday API & Permission Enforcement', () => {
  const employeeToken = createToken({ id: 101, email: 'emp@example.com', role: 'EMPLOYEE' })
  const managerToken = createToken({ id: 102, email: 'mgr@example.com', role: 'MANAGER' })
  const hrToken = createToken({ id: 103, email: 'hr@example.com', role: 'HR' })
  const adminToken = createToken({ id: 104, email: 'admin@example.com', role: 'ADMIN' })
  const superAdminToken = createToken({ id: 105, email: 'super@example.com', role: 'SUPER_ADMIN' })

  describe('Authentication & Public/Employee Access', () => {
    it('rejects unauthenticated requests to GET /api/holidays with 401', async () => {
      await request(app).get('/api/holidays').expect(401)
    })

    it('allows EMPLOYEE to list holidays with 200', async () => {
      executeQueryMock.mockResolvedValueOnce([
        {
          ID: 1,
          NAME: 'Diwali',
          DESCRIPTION: 'Festival of Lights',
          HOLIDAY_DATE: '2026-10-20',
          END_DATE: '2026-10-21',
          TYPE: 'PUBLIC',
          COLOR: '#ed6b4f',
          IS_RECURRING: false,
          STATUS: 'ACTIVE',
          CREATED_BY_NAME: 'HR Lead',
        },
      ])

      const response = await request(app)
        .get('/api/holidays?year=2026')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0].name).toBe('Diwali')
      expect(response.body.data[0].holidayDate).toBe('2026-10-20')
      expect(response.body.data[0].createdByName).toBe('HR Lead')
    })

    it('returns recurring holiday mapped to the requested year', async () => {
      executeQueryMock.mockResolvedValueOnce([
        {
          ID: 2,
          NAME: 'New Year',
          DESCRIPTION: 'Annual celebration',
          HOLIDAY_DATE: '2020-01-01',
          END_DATE: '2020-01-01',
          TYPE: 'PUBLIC',
          COLOR: '#10b981',
          IS_RECURRING: true,
          STATUS: 'ACTIVE',
          CREATED_BY_NAME: 'Admin User',
        },
      ])

      const response = await request(app)
        .get('/api/holidays?year=2027')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)

      expect(response.body.data).toHaveLength(1)
      expect(response.body.data[0].name).toBe('New Year')
      expect(response.body.data[0].holidayDate).toBe('2027-01-01')
      expect(response.body.data[0].isRecurring).toBe(true)
    })

    it('allows EMPLOYEE to fetch upcoming holidays', async () => {
      executeQueryMock
        .mockResolvedValueOnce([
          {
            ID: 3,
            NAME: 'Gandhi Jayanti',
            HOLIDAY_DATE: '2026-10-02',
            END_DATE: '2026-10-02',
            TYPE: 'PUBLIC',
            STATUS: 'ACTIVE',
          },
        ])
        .mockResolvedValueOnce([])

      const response = await request(app)
        .get('/api/holidays/upcoming?limit=3')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(Array.isArray(response.body.data)).toBe(true)
    })

    it('returns 404 when single holiday is not found', async () => {
      executeQueryMock.mockResolvedValueOnce([])

      const response = await request(app)
        .get('/api/holidays/999')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(404)

      expect(response.body.success).toBe(false)
      expect(response.body.message).toContain('Holiday not found')
    })
  })

  describe('Role-Based Permissions for Create, Update, Delete', () => {
    it('blocks EMPLOYEE from POST /api/holidays with 403', async () => {
      await request(app)
        .post('/api/holidays')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          name: 'Unauthorized Holiday',
          holidayDate: '2026-11-01',
        })
        .expect(403)
    })

    it('blocks MANAGER from POST /api/holidays with 403', async () => {
      await request(app)
        .post('/api/holidays')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          name: 'Manager Holiday',
          holidayDate: '2026-11-01',
        })
        .expect(403)
    })

    it('blocks EMPLOYEE from PUT /api/holidays/:id with 403', async () => {
      await request(app)
        .put('/api/holidays/1')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ name: 'Hacked Holiday' })
        .expect(403)
    })

    it('blocks EMPLOYEE from DELETE /api/holidays/:id with 403', async () => {
      await request(app)
        .delete('/api/holidays/1')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403)
    })
  })

  describe('Validation & Duplicate Rules', () => {
    it('rejects POST /api/holidays if name is less than 2 characters with 400', async () => {
      await request(app)
        .post('/api/holidays')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'X',
          holidayDate: '2026-10-25',
        })
        .expect(400)
    })

    it('rejects POST /api/holidays if endDate is earlier than holidayDate with 400', async () => {
      await request(app)
        .post('/api/holidays')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'Invalid Multi-day Holiday',
          holidayDate: '2026-10-25',
          endDate: '2026-10-20',
        })
        .expect(400)
    })

    it('returns 409 Conflict if duplicate holiday exists on the same date with same name', async () => {
      // Mock existing duplicate check to return an existing record
      executeQueryMock.mockResolvedValueOnce([{ ID: 50 }])

      const response = await request(app)
        .post('/api/holidays')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'Independence Day',
          holidayDate: '2026-08-15',
          type: 'PUBLIC',
        })
        .expect(409)

      expect(response.body.success).toBe(false)
      expect(response.body.message).toContain('already exists')
    })
  })

  describe('Authorized Operations (HR, ADMIN, SUPER_ADMIN)', () => {
    it('allows HR to create a valid holiday with 201', async () => {
      // Mock duplicate check: none found
      executeQueryMock
        .mockResolvedValueOnce([])
        // Mock created row query
        .mockResolvedValueOnce([
          {
            ID: 10,
            NAME: 'Diwali Break',
            DESCRIPTION: 'Festival break',
            HOLIDAY_DATE: '2026-11-01',
            END_DATE: '2026-11-03',
            TYPE: 'COMPANY',
            COLOR: '#ed6b4f',
            IS_RECURRING: false,
            STATUS: 'ACTIVE',
            CREATED_BY_NAME: 'HR Person',
          },
        ])

      executeInsertMock.mockResolvedValueOnce(undefined)

      const response = await request(app)
        .post('/api/holidays')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          name: 'Diwali Break',
          description: 'Festival break',
          holidayDate: '2026-11-01',
          endDate: '2026-11-03',
          type: 'COMPANY',
          color: '#ed6b4f',
          isRecurring: false,
        })
        .expect(201)

      expect(response.body.success).toBe(true)
      expect(response.body.data.id).toBe(10)
      expect(response.body.data.name).toBe('Diwali Break')
      expect(response.body.data.daysCount).toBe(3)
      expect(executeInsertMock).toHaveBeenCalled()
    })

    it('allows ADMIN to update a holiday with 200', async () => {
      // Mock existing check
      executeQueryMock
        .mockResolvedValueOnce([
          {
            ID: 10,
            NAME: 'Diwali Break',
            HOLIDAY_DATE: '2026-11-01',
            END_DATE: '2026-11-03',
            TYPE: 'COMPANY',
            COLOR: '#ed6b4f',
            IS_RECURRING: false,
            STATUS: 'ACTIVE',
          },
        ])
        // Duplicate check (none found)
        .mockResolvedValueOnce([])
        // getById after update
        .mockResolvedValueOnce([
          {
            ID: 10,
            NAME: 'Diwali Extended Break',
            HOLIDAY_DATE: '2026-11-01',
            END_DATE: '2026-11-04',
            TYPE: 'COMPANY',
            COLOR: '#ed6b4f',
            IS_RECURRING: false,
            STATUS: 'ACTIVE',
            CREATED_BY_NAME: 'Admin User',
          },
        ])

      executeUpdateMock.mockResolvedValueOnce(1)

      const response = await request(app)
        .put('/api/holidays/10')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Diwali Extended Break',
          endDate: '2026-11-04',
        })
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data.name).toBe('Diwali Extended Break')
      expect(executeUpdateMock).toHaveBeenCalled()
    })

    it('allows HR to soft-cancel a holiday with 200', async () => {
      // Mock existing check
      executeQueryMock.mockResolvedValueOnce([
        { ID: 10, NAME: 'Diwali Extended Break' },
      ])
      executeUpdateMock.mockResolvedValueOnce(1)

      const response = await request(app)
        .delete('/api/holidays/10')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data.status).toBe('CANCELLED')
      expect(executeUpdateMock).toHaveBeenCalled()
    })

    it('allows SUPER_ADMIN to hard delete a holiday with ?hard=true', async () => {
      // Mock existing check
      executeQueryMock.mockResolvedValueOnce([
        { ID: 10, NAME: 'Diwali Extended Break' },
      ])
      executeUpdateMock.mockResolvedValueOnce(1)

      const response = await request(app)
        .delete('/api/holidays/10?hard=true')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data.status).toBe('DELETED')
      expect(executeUpdateMock).toHaveBeenCalled()
    })
  })
})
