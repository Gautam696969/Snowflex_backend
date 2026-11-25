import crypto from 'node:crypto'
import type { Server as SocketIOServer, Socket } from 'socket.io'
import { z } from 'zod'
import { callService } from '../services/call.service'
import { presenceManager } from './presence.manager'
import { logger } from '../utils/logger'
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from './socket.server'

const RING_TIMEOUT_MS = 30_000

interface ActiveCallSession {
  callId: string
  conversationId: number
  callerId: number
  receiverId: number
  status: 'RINGING' | 'CONNECTED'
  startedAt: number
  connectedAt: number | null
  ringTimer: ReturnType<typeof setTimeout> | null
}

const activeSessions = new Map<string, ActiveCallSession>()
const userToCallId = new Map<number, string>()

const callRequestSchema = z.object({
  targetUserId: z.number().int().positive(),
  conversationId: z.number().int().positive().optional(),
})

const callIdSchema = z.object({
  callId: z.string().trim().min(1).max(128),
})

const callRejectSchema = z.object({
  callId: z.string().trim().min(1).max(128),
  reason: z.string().trim().max(120).optional(),
})

const sdpSchema = z.object({
  callId: z.string().trim().min(1).max(128),
  targetUserId: z.number().int().positive(),
  sdp: z.object({
    type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
    sdp: z.string().optional(),
  }),
})

const iceCandidateSchema = z.object({
  callId: z.string().trim().min(1).max(128),
  targetUserId: z.number().int().positive(),
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional(),
  }),
})

type TypedIO = SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>

function cleanupSession(session: ActiveCallSession): void {
  if (session.ringTimer) {
    clearTimeout(session.ringTimer)
    session.ringTimer = null
  }
  activeSessions.delete(session.callId)
  if (userToCallId.get(session.callerId) === session.callId) {
    userToCallId.delete(session.callerId)
  }
  if (userToCallId.get(session.receiverId) === session.callId) {
    userToCallId.delete(session.receiverId)
  }
}

async function finalizeAndBroadcast(
  io: TypedIO,
  session: ActiveCallSession,
  finalStatus: 'COMPLETED' | 'REJECTED' | 'MISSED' | 'BUSY',
  endReason: 'ended' | 'rejected' | 'timeout' | 'busy' | 'disconnected'
): Promise<void> {
  cleanupSession(session)

  const durationSeconds =
    finalStatus === 'COMPLETED' && session.connectedAt
      ? Math.max(1, Math.round((Date.now() - session.connectedAt) / 1000))
      : 0

  try {
    const savedMsg = await callService.finalizeCallLogAndCreateChatMessage({
      callId: session.callId,
      conversationId: session.conversationId,
      callerId: session.callerId,
      receiverId: session.receiverId,
      status: finalStatus,
      durationSeconds,
    })

    io.to(`user:${session.callerId}`).emit('message:new', savedMsg)
    io.to(`user:${session.receiverId}`).emit('message:new', savedMsg)

    const convUpdate = { conversationId: session.conversationId, lastMessage: savedMsg }
    io.to(`user:${session.callerId}`).emit('conversation:updated', convUpdate)
    io.to(`user:${session.receiverId}`).emit('conversation:updated', convUpdate)
  } catch (err) {
    logger.warn('Failed to persist call log message:', err)
  }

  const endPayload = {
    callId: session.callId,
    conversationId: session.conversationId,
    reason: endReason,
    durationSeconds,
  }
  io.to(`user:${session.callerId}`).emit('call:ended', endPayload)
  io.to(`user:${session.receiverId}`).emit('call:ended', endPayload)
}

export function registerCallSignalingHandlers(io: TypedIO, socket: TypedSocket): void {
  const userId = socket.data.user.id

  // 1. Caller initiates a 1-to-1 video call
  socket.on('call:request', async (payload: unknown, ack) => {
    try {
      const parsed = callRequestSchema.safeParse(payload)
      if (!parsed.success) {
        ack?.({ success: false, error: 'Invalid call request payload' })
        return
      }

      const { targetUserId, conversationId: reqConvId } = parsed.data

      if (userToCallId.has(userId)) {
        ack?.({ success: false, status: 'busy', error: 'You are already on another call' })
        return
      }

      const { conversationId, caller } = await callService.validateCallEligibility(
        userId,
        targetUserId,
        reqConvId
      )

      const callId = crypto.randomUUID()

      // Check receiver online status
      if (!presenceManager.isOnline(targetUserId)) {
        await callService.createCallLog({
          callId,
          conversationId,
          callerId: userId,
          receiverId: targetUserId,
          status: 'MISSED',
        })
        const savedMsg = await callService.finalizeCallLogAndCreateChatMessage({
          callId,
          conversationId,
          callerId: userId,
          receiverId: targetUserId,
          status: 'MISSED',
          durationSeconds: 0,
        })
        io.to(`user:${userId}`).emit('message:new', savedMsg)
        io.to(`user:${userId}`).emit('conversation:updated', { conversationId, lastMessage: savedMsg })

        ack?.({ success: false, status: 'offline', error: 'User is currently offline' })
        return
      }

      // Check if receiver is busy on another call
      if (userToCallId.has(targetUserId)) {
        await callService.createCallLog({
          callId,
          conversationId,
          callerId: userId,
          receiverId: targetUserId,
          status: 'BUSY',
        })
        const savedMsg = await callService.finalizeCallLogAndCreateChatMessage({
          callId,
          conversationId,
          callerId: userId,
          receiverId: targetUserId,
          status: 'BUSY',
          durationSeconds: 0,
        })
        io.to(`user:${userId}`).emit('message:new', savedMsg)
        io.to(`user:${targetUserId}`).emit('message:new', savedMsg)
        io.to(`user:${userId}`).emit('conversation:updated', { conversationId, lastMessage: savedMsg })
        io.to(`user:${targetUserId}`).emit('conversation:updated', { conversationId, lastMessage: savedMsg })

        ack?.({ success: false, status: 'busy', error: 'Employee is currently on another call' })
        return
      }

      const session: ActiveCallSession = {
        callId,
        conversationId,
        callerId: userId,
        receiverId: targetUserId,
        status: 'RINGING',
        startedAt: Date.now(),
        connectedAt: null,
        ringTimer: null,
      }

      session.ringTimer = setTimeout(() => {
        const current = activeSessions.get(callId)
        if (current && current.status === 'RINGING') {
          void finalizeAndBroadcast(io, current, 'MISSED', 'timeout')
        }
      }, RING_TIMEOUT_MS)

      activeSessions.set(callId, session)
      userToCallId.set(userId, callId)
      userToCallId.set(targetUserId, callId)

      await callService.createCallLog({
        callId,
        conversationId,
        callerId: userId,
        receiverId: targetUserId,
        status: 'RINGING',
      })

      // Notify receiver across all connected tabs/devices
      io.to(`user:${targetUserId}`).emit('call:incoming', {
        callId,
        conversationId,
        caller: {
          id: caller.id,
          fullName: caller.fullName,
          role: caller.role,
          avatarUrl: caller.avatarUrl,
        },
      })

      ack?.({ success: true, callId, conversationId, status: 'ringing' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start video call'
      ack?.({ success: false, error: message })
    }
  })

  // 2. Receiver accepts incoming call
  socket.on('call:accept', async (payload: unknown, ack) => {
    const parsed = callIdSchema.safeParse(payload)
    if (!parsed.success) {
      ack?.({ success: false, error: 'Invalid callId' })
      return
    }

    const session = activeSessions.get(parsed.data.callId)
    if (!session || session.receiverId !== userId || session.status !== 'RINGING') {
      ack?.({ success: false, error: 'Call is no longer available' })
      return
    }

    if (session.ringTimer) {
      clearTimeout(session.ringTimer)
      session.ringTimer = null
    }

    session.status = 'CONNECTED'
    session.connectedAt = Date.now()
    await callService.markCallConnected(session.callId).catch(() => {})

    io.to(`user:${session.callerId}`).emit('call:accepted', {
      callId: session.callId,
      conversationId: session.conversationId,
      acceptedByUserId: userId,
    })

    // Also notify receiver's other tabs so ringing stops everywhere
    io.to(`user:${session.receiverId}`).emit('call:accepted', {
      callId: session.callId,
      conversationId: session.conversationId,
      acceptedByUserId: userId,
    })

    ack?.({ success: true })
  })

  // 3. Receiver rejects incoming call
  socket.on('call:reject', async (payload: unknown) => {
    const parsed = callRejectSchema.safeParse(payload)
    if (!parsed.success) return

    const session = activeSessions.get(parsed.data.callId)
    if (!session) return
    if (session.receiverId !== userId && session.callerId !== userId) return

    io.to(`user:${session.callerId}`).emit('call:rejected', {
      callId: session.callId,
      reason: parsed.data.reason || 'rejected',
    })

    await finalizeAndBroadcast(io, session, 'REJECTED', 'rejected')
  })

  // 4. WebRTC Offer relay
  socket.on('call:offer', (payload: unknown) => {
    const parsed = sdpSchema.safeParse(payload)
    if (!parsed.success) return

    const session = activeSessions.get(parsed.data.callId)
    if (!session) return
    const { targetUserId, sdp, callId } = parsed.data
    if (
      (session.callerId !== userId && session.receiverId !== userId) ||
      (session.callerId !== targetUserId && session.receiverId !== targetUserId)
    ) {
      return
    }

    io.to(`user:${targetUserId}`).emit('call:offer', {
      callId,
      fromUserId: userId,
      sdp,
    })
  })

  // 5. WebRTC Answer relay
  socket.on('call:answer', (payload: unknown) => {
    const parsed = sdpSchema.safeParse(payload)
    if (!parsed.success) return

    const session = activeSessions.get(parsed.data.callId)
    if (!session) return
    const { targetUserId, sdp, callId } = parsed.data
    if (
      (session.callerId !== userId && session.receiverId !== userId) ||
      (session.callerId !== targetUserId && session.receiverId !== targetUserId)
    ) {
      return
    }

    io.to(`user:${targetUserId}`).emit('call:answer', {
      callId,
      fromUserId: userId,
      sdp,
    })
  })

  // 6. WebRTC ICE candidate relay
  socket.on('call:ice-candidate', (payload: unknown) => {
    const parsed = iceCandidateSchema.safeParse(payload)
    if (!parsed.success) return

    const session = activeSessions.get(parsed.data.callId)
    if (!session) return
    const { targetUserId, candidate, callId } = parsed.data
    if (
      (session.callerId !== userId && session.receiverId !== userId) ||
      (session.callerId !== targetUserId && session.receiverId !== targetUserId)
    ) {
      return
    }

    io.to(`user:${targetUserId}`).emit('call:ice-candidate', {
      callId,
      fromUserId: userId,
      candidate,
    })
  })

  // 7. End or cancel call
  socket.on('call:end', async (payload: unknown) => {
    const parsed = callIdSchema.safeParse(payload)
    if (!parsed.success) return

    const session = activeSessions.get(parsed.data.callId)
    if (!session) return
    if (session.callerId !== userId && session.receiverId !== userId) return

    const finalStatus = session.status === 'CONNECTED' ? 'COMPLETED' : 'MISSED'
    await finalizeAndBroadcast(io, session, finalStatus, 'ended')
  })
}

export async function handleUserCallDisconnect(io: TypedIO, userId: number): Promise<void> {
  const callId = userToCallId.get(userId)
  if (!callId) return

  const session = activeSessions.get(callId)
  if (!session) {
    userToCallId.delete(userId)
    return
  }

  const finalStatus = session.status === 'CONNECTED' ? 'COMPLETED' : 'MISSED'
  await finalizeAndBroadcast(io, session, finalStatus, 'disconnected')
}

