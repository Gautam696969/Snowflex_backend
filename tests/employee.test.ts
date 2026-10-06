import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
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

beforeEach(() => vi.clearAllMocks())

describe('GET /api/employees', () => {
  it('returns avatarUrl from the linked USERS row', async () => {
    executeQueryMock.mockResolvedValueOnce([{
      ID: 44,
      USER_ID: 29,
      FULL_NAME: 'Employee User',
      EMAIL: 'employee@example.com',
      AVATAR_URL: '/uploads/avatars/employee.webp',
    }])
    const token = createToken({ id: 29, email: 'admin@example.com', role: 'ADMIN' })

    const response = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(response.body.data[0].avatarUrl).toBe('/uploads/avatars/employee.webp')
    expect(executeQueryMock.mock.calls[0][0]).toContain('U.AVATAR_URL')
  })
})

describe('public avatar files', () => {
  it('serves uploads without authentication and allows cross-origin images', async () => {
    const filename = `avatar-test-${randomUUID()}.svg`
    const filePath = path.resolve(process.cwd(), 'uploads', 'avatars', filename)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')

    try {
      const response = await request(app).get(`/uploads/avatars/${filename}`).expect(200)
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin')
      expect(response.headers['content-type']).toContain('image/svg+xml')
    } finally {
      await fs.unlink(filePath).catch(() => {})
    }
  })
})