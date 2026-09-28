import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app'
import { AuthServiceContract } from '../src/services/auth.service'
import { HttpError } from '../src/utils/http-error'
import { AuthenticatedUser, createToken } from '../src/utils/jwt'

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy'

const safeUser: AuthenticatedUser = {
  id: 1,
  fullName: 'John Doe',
  email: 'john@example.com',
  role: 'USER',
}

const service: AuthServiceContract = {
  register: vi.fn(),
  getUserById: vi.fn(async () => safeUser),
  listUsers: vi.fn(async () => [safeUser]),
  login: vi.fn(async (email: string, password: string) => {
    if (email !== safeUser.email || password !== 'Password123') {
      throw new HttpError(401, 'Invalid email or password')
    }
    return { token: createToken(safeUser), user: safeUser }
  }),
}

const app = createApp(service)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(service.register).mockResolvedValue(undefined)
  vi.mocked(service.getUserById).mockResolvedValue(safeUser)
  vi.mocked(service.listUsers).mockResolvedValue([safeUser])
  vi.mocked(service.login).mockImplementation(async (email, password) => {
    if (email !== safeUser.email || password !== 'Password123') {
      throw new HttpError(401, 'Invalid email or password')
    }
    return { token: createToken(safeUser), user: safeUser }
  })
})

describe('health check', () => {
  it('reports that the backend is running', async () => {
    await request(app)
      .get('/api/health')
      .expect(200, { success: true, message: 'Backend is running' })
  })

  it('allows loopback Vite fallback ports during development', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://127.0.0.1:5176')
      .expect(200)
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5176')
  })
})

describe('registration', () => {
  it('registers a valid user', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'John Doe', email: 'john@example.com', password: 'Password123' })
      .expect(201, { success: true, message: 'User registered successfully' })
    expect(service.register).toHaveBeenCalledWith('John Doe', 'john@example.com', 'Password123')
  })

  it('rejects duplicate email addresses', async () => {
    vi.mocked(service.register).mockRejectedValueOnce(new HttpError(409, 'Email already registered'))
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'John Doe', email: 'john@example.com', password: 'Password123' })
      .expect(409, { success: false, message: 'Email already registered' })
  })

  it('rejects invalid emails and short passwords', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'John Doe', email: 'not-an-email', password: 'Password123' })
      .expect(400, { success: false, message: 'Invalid request' })
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'John Doe', email: 'john@example.com', password: 'short' })
      .expect(400, { success: false, message: 'Invalid request' })
    expect(service.register).not.toHaveBeenCalled()
  })
})

describe('login and protected routes', () => {
  it('returns a JWT and safe user information on successful login', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@example.com', password: 'Password123' })
      .expect(200)
    expect(response.body).toMatchObject({ success: true, message: 'Login successful', user: safeUser })
    expect(response.body.token).toEqual(expect.any(String))
    expect(response.body).not.toHaveProperty('user.password')
    expect(response.body).not.toHaveProperty('user.passwordHash')
    const payload = jwt.decode(response.body.token) as jwt.JwtPayload
    expect(payload).toMatchObject({ id: safeUser.id, email: safeUser.email, role: safeUser.role })
    expect(payload).not.toHaveProperty('fullName')
    expect(payload.exp! - payload.iat!).toBe(86_400)
  })

  it.each([
    ['wrong password', 'john@example.com', 'WrongPassword'],
    ['unknown email', 'missing@example.com', 'Password123'],
  ])('rejects login with %s', async (_scenario, email, password) => {
    await request(app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(401, { success: false, message: 'Invalid email or password' })
  })

  it('rejects missing and invalid JWTs', async () => {
    await request(app).get('/api/auth/me').expect(401, { success: false, message: 'Unauthorized' })
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401, { success: false, message: 'Unauthorized' })

    const expiredToken = jwt.sign(
      { id: safeUser.id, email: safeUser.email, role: safeUser.role },
      process.env.JWT_SECRET!,
      { expiresIn: -1 },
    )
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401, { success: false, message: 'Unauthorized' })
  })

  it('returns the authenticated user and supports stateless logout', async () => {
    const token = createToken({ id: safeUser.id, email: safeUser.email, role: safeUser.role })
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { success: true, user: safeUser })
    expect(service.getUserById).toHaveBeenCalledWith(safeUser.id)
    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { success: true, message: 'Logout successful' })
  })
})

describe('admin users route', () => {
  it('requires a valid token and ADMIN role', async () => {
    await request(app).get('/api/admin/users').expect(401)

    const userToken = createToken({ id: safeUser.id, email: safeUser.email, role: 'USER' })
    await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403, { success: false, message: 'Forbidden' })
    expect(service.listUsers).not.toHaveBeenCalled()
  })

  it('returns only safe user fields to an ADMIN', async () => {
    const adminToken = createToken({ id: 99, email: 'admin@example.com', role: 'ADMIN' })
    const response = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
    expect(response.body).toEqual({ success: true, users: [safeUser] })
    expect(JSON.stringify(response.body)).not.toContain('PASSWORD_HASH')
  })
})

describe('database failures', () => {
  it('returns a generic server error when authentication storage is unavailable', async () => {
    vi.mocked(service.register).mockRejectedValueOnce(new Error('provider details must stay private'))
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'John Doe', email: 'john@example.com', password: 'Password123' })
      .expect(500, { success: false, message: 'Something went wrong' })
  })
})