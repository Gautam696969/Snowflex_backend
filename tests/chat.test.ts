import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app'
import { createToken } from '../src/utils/jwt'
import { chatRateLimiter } from '../src/socket/chatRateLimiter'
import { chatService } from '../src/services/chat.service'
import { HttpError } from '../src/utils/http-error'

describe('Live Chat API & Permission enforcement', () => {
  const app = createApp()

  const employeeToken = createToken({ id: 10, email: 'emp@snowflex.com', role: 'EMPLOYEE' })
  const adminToken = createToken({ id: 20, email: 'admin@snowflex.com', role: 'ADMIN' })
  const managerToken = createToken({ id: 30, email: 'mgr@snowflex.com', role: 'MANAGER' })
  const hrToken = createToken({ id: 40, email: 'hr@snowflex.com', role: 'HR' })
  const superAdminToken = createToken({ id: 50, email: 'super@snowflex.com', role: 'SUPER_ADMIN' })
  const outsiderToken = createToken({ id: 99, email: 'outsider@snowflex.com', role: 'EMPLOYEE' })

  beforeEach(() => {
    vi.restoreAllMocks()
    chatRateLimiter.reset()
  })

  describe('Authentication requirement', () => {
    it('rejects unauthenticated requests to chat endpoints with 401', async () => {
      await request(app).get('/api/chat/contacts').expect(401)
      await request(app).get('/api/chat/conversations').expect(401)
      await request(app).post('/api/chat/conversations').send({ participantId: 20 }).expect(401)
      await request(app).get('/api/chat/unread-count').expect(401)
    })
  })

  describe('Role-restricted contacts & conversations', () => {
    it('EMPLOYEE contacts only includes ADMINs', async () => {
      vi.spyOn(chatService, 'getContacts').mockImplementation(async (userId, role) => {
        expect(userId).toBe(10)
        expect(role).toBe('EMPLOYEE')
        return [
          {
            id: 20,
            fullName: 'Admin User',
            email: 'admin@snowflex.com',
            role: 'ADMIN',
            avatarUrl: null,
            status: 'ACTIVE',
            isOnline: true,
            lastSeen: null,
          },
        ]
      })

      const res = await request(app)
        .get('/api/chat/contacts')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].role).toBe('ADMIN')
    })

    it('rejects self-chat attempts with 400', async () => {
      const res = await request(app)
        .post('/api/chat/conversations')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ participantId: 10 })
        .expect(400)

      expect(res.body.success).toBe(false)
      expect(res.body.message).toContain('yourself')
    })

    it('blocks EMPLOYEE from starting a chat with a MANAGER with 403', async () => {
      vi.spyOn(chatService, 'getUserInfo').mockImplementation(async (id) => {
        if (id === 10) return { id: 10, fullName: 'Emp', email: 'e@s.com', role: 'EMPLOYEE', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        if (id === 30) return { id: 30, fullName: 'Mgr', email: 'm@s.com', role: 'MANAGER', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        throw new Error('Not found')
      })

      const res = await request(app)
        .post('/api/chat/conversations')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ participantId: 30 })
        .expect(403)

      expect(res.body.success).toBe(false)
      expect(res.body.message).toContain('not permitted to chat')
    })

    it('blocks EMPLOYEE from starting a chat with HR with 403', async () => {
      vi.spyOn(chatService, 'getUserInfo').mockImplementation(async (id) => {
        if (id === 10) return { id: 10, fullName: 'Emp', email: 'e@s.com', role: 'EMPLOYEE', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        if (id === 40) return { id: 40, fullName: 'HR', email: 'h@s.com', role: 'HR', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        throw new Error('Not found')
      })

      const res = await request(app)
        .post('/api/chat/conversations')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ participantId: 40 })
        .expect(403)

      expect(res.body.success).toBe(false)
      expect(res.body.message).toContain('not permitted to chat')
    })

    it('blocks EMPLOYEE from starting a chat with SUPER_ADMIN with 403', async () => {
      vi.spyOn(chatService, 'getUserInfo').mockImplementation(async (id) => {
        if (id === 10) return { id: 10, fullName: 'Emp', email: 'e@s.com', role: 'EMPLOYEE', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        if (id === 50) return { id: 50, fullName: 'Super', email: 's@s.com', role: 'SUPER_ADMIN', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        throw new Error('Not found')
      })

      const res = await request(app)
        .post('/api/chat/conversations')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ participantId: 50 })
        .expect(403)

      expect(res.body.success).toBe(false)
    })

    it('allows ADMIN to start chat with EMPLOYEE', async () => {
      vi.spyOn(chatService, 'getUserInfo').mockImplementation(async (id) => {
        if (id === 20) return { id: 20, fullName: 'Admin', email: 'a@s.com', role: 'ADMIN', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        if (id === 10) return { id: 10, fullName: 'Emp', email: 'e@s.com', role: 'EMPLOYEE', avatarUrl: null, status: 'ACTIVE', expiresAt: Date.now() + 10000 }
        throw new Error('Not found')
      })

      vi.spyOn(chatService, 'getOrCreateConversation').mockResolvedValue({
        id: 1,
        userAId: 10,
        userBId: 20,
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        otherUser: {
          id: 10,
          fullName: 'Emp',
          email: 'e@s.com',
          role: 'EMPLOYEE',
          avatarUrl: null,
          status: 'ACTIVE',
          isOnline: false,
          lastSeen: null,
        },
        lastMessage: null,
        unreadCount: 0,
        isReadOnly: false,
      })

      const res = await request(app)
        .post('/api/chat/conversations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ participantId: 10 })
        .expect(201)

      expect(res.body.success).toBe(true)
      expect(res.body.data.id).toBe(1)
    })
  })

  describe('Conversation security & isolation', () => {
    it('blocks outsider from reading conversation messages with 403', async () => {
      vi.spyOn(chatService, 'getConversationMessages').mockRejectedValue(
        new HttpError(403, 'Forbidden: you are not a participant in this conversation')
      )

      const res = await request(app)
        .get('/api/chat/conversations/1/messages')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403)

      expect(res.body.success).toBe(false)
      expect(res.body.message).toContain('not a participant')
    })
  })

  describe('Rate limiting and sanitization', () => {
    it('enforces rate limits on rapid message spam', () => {
      const userId = 777
      for (let i = 0; i < 20; i++) {
        const check = chatRateLimiter.checkRateLimit(userId, 20, 10000)
        expect(check.allowed).toBe(true)
      }
      const overLimitCheck = chatRateLimiter.checkRateLimit(userId, 20, 10000)
      expect(overLimitCheck.allowed).toBe(false)
      expect(overLimitCheck.retryAfterMs).toBeGreaterThan(0)
    })
  })
})
