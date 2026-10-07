import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { isAllowedOrigin } from '../src/config/cors'
import { createApp } from '../src/app'
import { AuthServiceContract } from '../src/services/auth.service'

const mockAuthService: AuthServiceContract = {
  register: vi.fn(),
  getUserById: vi.fn(),
  listUsers: vi.fn(),
  login: vi.fn(async () => ({
    token: 'mock-token',
    user: { id: 1, email: 'test@example.com', fullName: 'Test User', role: 'EMPLOYEE' as const },
  })),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
}

describe('CORS configuration', () => {
  it('allows production Render frontend domains', () => {
    expect(isAllowedOrigin('https://snowflex-frontend-2.onrender.com')).toBe(true)
    expect(isAllowedOrigin('https://snowflex-frontend-2.onrender.com/')).toBe(true)
    expect(isAllowedOrigin('https://snowflex-frontend.onrender.com')).toBe(true)
  })

  it('allows localhost and local dev origins', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true)
  })

  it('allows requests without origin header (server-to-server, curl)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true)
    expect(isAllowedOrigin('')).toBe(true)
  })

  it('returns CORS headers for OPTIONS preflight from snowflex-frontend-2.onrender.com', async () => {
    const app = createApp(mockAuthService)
    const response = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://snowflex-frontend-2.onrender.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('https://snowflex-frontend-2.onrender.com')
    expect(response.headers['access-control-allow-credentials']).toBe('true')
  })

  it('returns CORS headers for OPTIONS preflight on unprefixed /auth/login', async () => {
    const app = createApp(mockAuthService)
    const response = await request(app)
      .options('/auth/login')
      .set('Origin', 'https://snowflex-frontend-2.onrender.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('https://snowflex-frontend-2.onrender.com')
  })

  it('handles /auth/login route alias as well as /api/auth/login', async () => {
    const app = createApp(mockAuthService)
    const response = await request(app)
      .post('/auth/login')
      .set('Origin', 'https://snowflex-frontend-2.onrender.com')
      .set('Content-Type', 'application/json')
      .send({ email: 'test@example.com', password: 'Password@123' })

    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe('https://snowflex-frontend-2.onrender.com')
    expect(response.body.success).toBe(true)
  })
})
