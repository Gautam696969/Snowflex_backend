import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app'
import { createToken } from '../src/utils/jwt'
import { authService } from '../src/services/auth.service'
import { themeService } from '../src/services/theme.service'

describe('Role-based Theme Customization API & Permissions', { timeout: 25000 }, () => {
  const app = createApp()

  const superAdminToken = createToken({ id: 1, email: 'super@snowflex.com', role: 'SUPER_ADMIN' })
  const adminToken = createToken({ id: 2, email: 'admin@snowflex.com', role: 'ADMIN' })
  const otherAdminToken = createToken({ id: 3, email: 'otheradmin@snowflex.com', role: 'ADMIN' })
  const managerToken = createToken({ id: 4, email: 'manager@snowflex.com', role: 'MANAGER' })
  const hrToken = createToken({ id: 5, email: 'hr@snowflex.com', role: 'HR' })
  const employeeToken = createToken({ id: 6, email: 'employee@snowflex.com', role: 'EMPLOYEE' })

  const validTheme = {
    bgColor: '#1a231e',
    primaryColor: '#2563eb',
    accentColor: '#d9ed74',
    sidebarColor: '#121815',
    cardColor: '#202c24',
    textColor: '#f1f5f2',
  }

  const usersMock = [
    { id: 1, fullName: 'Super Admin', email: 'super@snowflex.com', role: 'SUPER_ADMIN', avatarUrl: null, status: 'ACTIVE' },
    { id: 2, fullName: 'Admin User', email: 'admin@snowflex.com', role: 'ADMIN', avatarUrl: null, status: 'ACTIVE' },
    { id: 3, fullName: 'Other Admin', email: 'otheradmin@snowflex.com', role: 'ADMIN', avatarUrl: null, status: 'ACTIVE' },
    { id: 4, fullName: 'Manager User', email: 'manager@snowflex.com', role: 'MANAGER', avatarUrl: null, status: 'ACTIVE' },
    { id: 5, fullName: 'HR User', email: 'hr@snowflex.com', role: 'HR', avatarUrl: null, status: 'ACTIVE' },
    { id: 6, fullName: 'Employee User', email: 'employee@snowflex.com', role: 'EMPLOYEE', avatarUrl: null, status: 'ACTIVE' },
  ]

  beforeEach(() => {
    vi.restoreAllMocks()
    themeService._clearMemory()

    // Mock getUserById
    vi.spyOn(authService, 'getUserById').mockImplementation(async (id: number) => {
      const u = usersMock.find((x) => x.id === id)
      if (!u) throw new Error('User not found')
      return u as any
    })

    // Mock listUsers
    vi.spyOn(authService, 'listUsers').mockImplementation(async () => {
      return usersMock as any
    })
  })

  describe('Authentication requirements', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await request(app).get('/api/themes/me').expect(401)
      await request(app).get('/api/themes/2').expect(401)
      await request(app).put('/api/themes/2').send(validTheme).expect(401)
      await request(app).delete('/api/themes/2').expect(401)
      await request(app).put('/api/themes/role/HR').send(validTheme).expect(401)
    })
  })

  describe('Color validation', () => {
    it('rejects non-hex and invalid colors with 400', async () => {
      const badColors = [
        { ...validTheme, bgColor: 'red' },
        { ...validTheme, primaryColor: '#12345' },
        { ...validTheme, accentColor: 'rgb(0,0,0)' },
        { ...validTheme, bgColor: '#gggggg' },
      ]

      for (const payload of badColors) {
        await request(app)
          .put('/api/themes/6')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send(payload)
          .expect(400)
      }
    })

    it('accepts valid 3-digit and 6-digit hex colors with 200', async () => {
      const payload3Digit = {
        bgColor: '#111',
        primaryColor: '#222',
        accentColor: '#333',
      }

      const res = await request(app)
        .put('/api/themes/6')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(payload3Digit)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.bgColor).toBe('#111')
    })
  })

  describe('Super Admin permissions', () => {
    it('Super Admin can change theme of ANY user (Admin, Manager, HR, Employee, Self)', async () => {
      for (const targetId of [1, 2, 4, 5, 6]) {
        const res = await request(app)
          .put(`/api/themes/${targetId}`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send(validTheme)
          .expect(200)

        expect(res.body.success).toBe(true)
        expect(res.body.data.userId).toBe(targetId)
        expect(res.body.data.updatedBy).toBe(1)
      }
    })

    it('Super Admin can bulk apply to any role', async () => {
      const res = await request(app)
        .put('/api/themes/role/HR')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(validTheme)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.affectedCount).toBe(1)
      expect(res.body.data.userIds).toContain(5)
    })

    it('Super Admin can reset theme for any user', async () => {
      await request(app)
        .delete('/api/themes/6')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200)
    })
  })

  describe('Admin permissions', () => {
    it('Admin can change theme of Manager, HR, Employee and Self', async () => {
      for (const targetId of [2, 4, 5, 6]) {
        const res = await request(app)
          .put(`/api/themes/${targetId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send(validTheme)
          .expect(200)

        expect(res.body.success).toBe(true)
        expect(res.body.data.userId).toBe(targetId)
      }
    })

    it('Admin CANNOT change theme of Super Admin (blocked with 403)', async () => {
      const res = await request(app)
        .put('/api/themes/1')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validTheme)
        .expect(403)

      expect(res.body.success).toBe(false)
      expect(res.body.message).toContain('Super Admin')
    })

    it('Admin CANNOT change theme of another Admin (blocked with 403)', async () => {
      const res = await request(app)
        .put('/api/themes/3')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validTheme)
        .expect(403)

      expect(res.body.success).toBe(false)
    })

    it('Admin can bulk apply to Manager, HR, Employee', async () => {
      const res = await request(app)
        .put('/api/themes/role/EMPLOYEE')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validTheme)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.userIds).toContain(6)
    })

    it('Admin CANNOT bulk apply to Super Admin or Admin role (blocked with 403)', async () => {
      await request(app)
        .put('/api/themes/role/SUPER_ADMIN')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validTheme)
        .expect(403)

      await request(app)
        .put('/api/themes/role/ADMIN')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validTheme)
        .expect(403)
    })

    it('Admin CANNOT reset theme of Super Admin (blocked with 403)', async () => {
      await request(app)
        .delete('/api/themes/1')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403)
    })
  })

  describe('Manager, HR and Employee restrictions', () => {
    it('Manager, HR and Employee CANNOT change theme for other users (403)', async () => {
      for (const token of [managerToken, hrToken, employeeToken]) {
        await request(app)
          .put('/api/themes/6')
          .set('Authorization', `Bearer ${token}`)
          .send(validTheme)
          .expect(403)
      }
    })

    it('Manager, HR and Employee CANNOT change custom colors even for themselves (403)', async () => {
      await request(app)
        .put('/api/themes/4')
        .set('Authorization', `Bearer ${managerToken}`)
        .send(validTheme)
        .expect(403)

      await request(app)
        .put('/api/themes/5')
        .set('Authorization', `Bearer ${hrToken}`)
        .send(validTheme)
        .expect(403)

      await request(app)
        .put('/api/themes/6')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send(validTheme)
        .expect(403)
    })

    it('Manager, HR and Employee CANNOT bulk apply themes (403)', async () => {
      await request(app)
        .put('/api/themes/role/EMPLOYEE')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send(validTheme)
        .expect(403)
    })
  })

  describe('Get theme endpoints', () => {
    it('GET /api/themes/me returns current user theme', async () => {
      // First set theme for user 6 via Super Admin
      await request(app)
        .put('/api/themes/6')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(validTheme)
        .expect(200)

      // User 6 fetches own theme
      const res = await request(app)
        .get('/api/themes/me')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.bgColor).toBe(validTheme.bgColor)
      expect(res.body.data.primaryColor).toBe(validTheme.primaryColor)
    })

    it('GET /api/themes/me returns null when no custom theme set', async () => {
      await request(app)
        .delete('/api/themes/6')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200)

      const res = await request(app)
        .get('/api/themes/me')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data).toBeNull()
    })
  })

  describe('Dark Mode and Light Mode controls by Role', () => {
    it('Super Admin can change mode to dark/light for Admin, Manager, HR, and Employee', async () => {
      // Super Admin sets dark mode for Admin (id 2)
      const resAdmin = await request(app)
        .put('/api/themes/2')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ ...validTheme, mode: 'dark' })
        .expect(200)
      expect(resAdmin.body.data.mode).toBe('dark')

      // Super Admin sets light mode for Employee (id 6)
      const resEmp = await request(app)
        .put('/api/themes/6')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ ...validTheme, mode: 'light' })
        .expect(200)
      expect(resEmp.body.data.mode).toBe('light')

      // Verify Employee fetching own theme gets mode: 'light'
      const empTheme = await request(app)
        .get('/api/themes/me')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)
      expect(empTheme.body.data.mode).toBe('light')
    })

    it('Admin can change dark/light mode for Manager, HR, Employee, and Self', async () => {
      // Admin sets dark mode for Manager (id 4)
      const resMgr = await request(app)
        .put('/api/themes/4')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validTheme, mode: 'dark' })
        .expect(200)
      expect(resMgr.body.data.mode).toBe('dark')

      // Admin sets light mode for HR (id 5)
      const resHr = await request(app)
        .put('/api/themes/5')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validTheme, mode: 'light' })
        .expect(200)
      expect(resHr.body.data.mode).toBe('light')

      // Admin sets dark mode for Self (id 2)
      const resSelf = await request(app)
        .put('/api/themes/2')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validTheme, mode: 'dark' })
        .expect(200)
      expect(resSelf.body.data.mode).toBe('dark')
    })

    it('Admin is strictly BLOCKED from changing dark/light mode for Super Admin (403)', async () => {
      const res = await request(app)
        .put('/api/themes/1')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validTheme, mode: 'dark' })
        .expect(403)

      expect(res.body.success).toBe(false)
      expect(res.body.message).toContain('Forbidden: Administrators cannot modify themes for Super Admins')
    })

    it('Any user (Employee, HR, Manager, Admin, Super Admin) can toggle their own mode via /me/mode', async () => {
      // Employee sets mode to dark
      const empRes = await request(app)
        .put('/api/themes/me/mode')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ mode: 'dark' })
        .expect(200)
      expect(empRes.body.data.mode).toBe('dark')

      // Employee sets mode back to light
      const empLight = await request(app)
        .put('/api/themes/me/mode')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ mode: 'light' })
        .expect(200)
      expect(empLight.body.data.mode).toBe('light')

      // Super Admin sets own mode to dark
      const saRes = await request(app)
        .put('/api/themes/me/mode')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ mode: 'dark' })
        .expect(200)
      expect(saRes.body.data.mode).toBe('dark')
    })
  })
})
