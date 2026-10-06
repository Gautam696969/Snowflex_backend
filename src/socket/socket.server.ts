import type { Server as HttpServer } from 'node:http'
import { Server as SocketIOServer, Socket } from 'socket.io'
import { z } from 'zod'
import { verifyToken, AuthTokenPayload } from '../utils/jwt'
import { chatService } from '../services/chat.service'
import { presenceManager } from './presence.manager'
import { chatRateLimiter } from './chatRateLimiter'
import { logger } from '../utils/logger'

import { ChatMessageItem } from '../services/chat.service'

export interface ServerToClientEvents {
  'message:new': (message: ChatMessageItem) => void
  'message:delivered': (data: { messageId: number; conversationId: number; deliveredAt: string }) => void
  'message:read': (data: { conversationId: number; readerId: number; readAt: string }) => void
  'typing:start': (data: { conversationId: number; userId: number; userName: string }) => void
  'typing:stop': (data: { conversationId: number; userId: number }) => void
  'presence:update': (data: { userId: number; isOnline: boolean; lastSeen?: string }) => void
  'conversation:updated': (data: { conversationId: number; lastMessage: ChatMessageItem }) => void
}

export interface ClientToServerEvents {
  'message:send': (payload: unknown, ack?: (response: { success: boolean; message?: ChatMessageItem; error?: string }) => void) => void
  'message:delivered': (payload: { messageId: number; conversationId: number; senderId: number }) => void
  'message:read': (payload: { conversationId: number; recipientId: number }) => void
  'typing:start': (payload: { conversationId: number; recipientId: number }) => void
  'typing:stop': (payload: { conversationId: number; recipientId: number }) => void
}

export interface InterServerEvents {}

export interface SocketData {
  user: AuthTokenPayload & { fullName?: string }
}

let ioInstance: SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> | null = null

export function getSocketServer(): SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> | null {
  return ioInstance
}

function parseAllowedOrigins(): string[] {
  const envOrigins = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (process.env.NODE_ENV !== 'production') {
    if (!envOrigins.includes('http://localhost:5173')) {
      envOrigins.push('http://localhost:5173')
    }
  }

  return envOrigins
}

const messageSendSchema = z.object({
  conversationId: z.number().int().positive('conversationId is required'),
  recipientId: z.number().int().positive('recipientId is required'),
  body: z.string().trim().min(1, 'Message cannot be empty').max(2000, 'Message cannot exceed 2000 characters'),
  clientMessageId: z.string().trim().min(1).max(128).optional(),
})

export function initSocketServer(httpServer: HttpServer): SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> {
  const allowedOrigins = parseAllowedOrigins()

  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      cors: {
        origin(origin, callback) {
          if (
            !origin ||
            allowedOrigins.includes(origin) ||
            (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):517\d$/.test(origin))
          ) {
            callback(null, true)
          } else {
            callback(new Error('Origin not allowed by Socket.IO CORS'))
          }
        },
        credentials: true,
      },
      pingTimeout: 20000,
      pingInterval: 25000,
    }
  )

  // Handshake authentication
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        (typeof socket.handshake.headers.authorization === 'string'
          ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, '')
          : undefined) ||
        socket.handshake.query?.token

      if (!token || typeof token !== 'string') {
        return next(new Error('Authentication token required'))
      }

      const decoded = verifyToken(token)
      // Derive userId and role ONLY from verified token
      socket.data.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
      }
      next()
    } catch {
      return next(new Error('Invalid or expired authentication token'))
    }
  })

  io.on('connection', async (socket) => {
    const user = socket.data.user
    const userId = user.id
    const userRoom = `user:${userId}`

    // Populate full name for typing indicator
    try {
      const profile = await chatService.getUserInfo(userId)
      user.fullName = profile.fullName
    } catch {
      user.fullName = user.email.split('@')[0]
    }

    // Join personal user room for multi-device/multi-tab synchronization
    await socket.join(userRoom)

    // Update presence
    const { wasOffline } = presenceManager.addConnection(userId, socket.id)
    if (wasOffline) {
      io.emit('presence:update', { userId, isOnline: true })
    }

    // Client event: message:send
    socket.on('message:send', async (payload: unknown, ack?: (response: { success: boolean; message?: ChatMessageItem; error?: string }) => void) => {
      try {
        const parsed = messageSendSchema.safeParse(payload)
        if (!parsed.success) {
          const firstErr = parsed.error.issues[0]?.message || 'Invalid message payload'
          if (ack) ack({ success: false, error: firstErr })
          return
        }

        const { conversationId, recipientId, body, clientMessageId } = parsed.data

        // Enforce per-user sliding window rate limiting
        const rateCheck = chatRateLimiter.checkRateLimit(userId)
        if (!rateCheck.allowed) {
          const msg = `Rate limit reached. Please wait ${Math.ceil((rateCheck.retryAfterMs || 1000) / 1000)}s.`
          if (ack) ack({ success: false, error: msg })
          return
        }

        // Persist message with fresh backend role check & membership validation
        const savedMessage = await chatService.saveMessage({
          conversationId,
          senderId: userId,
          recipientId,
          body,
          clientMessageId,
        })

        const recipientRoom = `user:${recipientId}`

        // Real-time broadcast to recipient and sender rooms
        io.to(recipientRoom).emit('message:new', savedMessage)
        io.to(userRoom).emit('message:new', savedMessage)

        // Notify both sides of conversation update
        const convUpdate = { conversationId, lastMessage: savedMessage }
        io.to(recipientRoom).emit('conversation:updated', convUpdate)
        io.to(userRoom).emit('conversation:updated', convUpdate)

        if (ack) {
          ack({ success: true, message: savedMessage })
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to send message'
        if (ack) ack({ success: false, error: message })
      }
    })

    // Client event: message:delivered
    socket.on('message:delivered', (payload: unknown) => {
      const data = payload as { messageId: number; conversationId: number; senderId: number }
      if (data && data.senderId) {
        io.to(`user:${data.senderId}`).emit('message:delivered', {
          messageId: data.messageId,
          conversationId: data.conversationId,
          deliveredAt: new Date().toISOString(),
        })
      }
    })

    // Client event: message:read
    socket.on('message:read', async (payload: unknown) => {
      const data = payload as { conversationId: number; recipientId: number }
      if (data && data.conversationId) {
        try {
          await chatService.markConversationAsRead(userId, data.conversationId)
          if (data.recipientId) {
            io.to(`user:${data.recipientId}`).emit('message:read', {
              conversationId: data.conversationId,
              readerId: userId,
              readAt: new Date().toISOString(),
            })
          }
        } catch {
          // ignore error in background read sync
        }
      }
    })

    // Client event: typing:start
    socket.on('typing:start', (payload: unknown) => {
      const data = payload as { conversationId: number; recipientId: number }
      if (data && data.recipientId && data.conversationId) {
        io.to(`user:${data.recipientId}`).emit('typing:start', {
          conversationId: data.conversationId,
          userId,
          userName: user.fullName || 'Someone',
        })
      }
    })

    // Client event: typing:stop
    socket.on('typing:stop', (payload: unknown) => {
      const data = payload as { conversationId: number; recipientId: number }
      if (data && data.recipientId && data.conversationId) {
        io.to(`user:${data.recipientId}`).emit('typing:stop', {
          conversationId: data.conversationId,
          userId,
        })
      }
    })

    // Disconnect handler
    socket.on('disconnect', () => {
      const { isNowOffline, lastSeen } = presenceManager.removeConnection(userId, socket.id)
      if (isNowOffline) {
        io.emit('presence:update', {
          userId,
          isOnline: false,
          lastSeen: lastSeen.toISOString(),
        })
      }
    })
  })

  ioInstance = io
  return io
}
