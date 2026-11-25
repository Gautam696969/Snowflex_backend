import type { Server as SocketIOServer, Socket } from 'socket.io'
import { z } from 'zod'
import { meetingService } from '../services/meeting.service'
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from './socket.server'

type TypedIO = SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>

// In-memory room coordination state (single presenter lock & raised hands)
const roomPresenters = new Map<string, { userId: number; fullName: string }>()
const roomRaisedHands = new Map<string, Set<number>>()
const userActiveMeeting = new Map<number, string>()

const meetingCodeSchema = z.object({
  meetingCode: z.string().trim().min(1).max(64),
})

const handRaiseSchema = z.object({
  meetingCode: z.string().trim().min(1).max(64),
  raised: z.boolean(),
})

const reactionSchema = z.object({
  meetingCode: z.string().trim().min(1).max(64),
  emoji: z.string().trim().min(1).max(16),
})

const hostTargetSchema = z.object({
  meetingCode: z.string().trim().min(1).max(64),
  targetUserId: z.number().int().positive(),
})

const screenPolicySchema = z.object({
  meetingCode: z.string().trim().min(1).max(64),
  allowScreenShare: z.boolean(),
})

export function registerMeetingSignalingHandlers(io: TypedIO, socket: TypedSocket): void {
  const userId = socket.data.user.id
  const fullName = socket.data.user.fullName || socket.data.user.email.split('@')[0]

  socket.on('meeting:join-room', async (payload: unknown, ack) => {
    const parsed = meetingCodeSchema.safeParse(payload)
    if (!parsed.success) {
      ack?.({ success: false, error: 'Invalid meetingCode' })
      return
    }
    const { meetingCode } = parsed.data
    try {
      const { meeting } = await meetingService.assertMeetingAccess(meetingCode, userId)
      const room = `meeting:${meetingCode}`
      await socket.join(room)
      userActiveMeeting.set(userId, meetingCode)

      const presenter = roomPresenters.get(meetingCode) || null
      const raised = Array.from(roomRaisedHands.get(meetingCode) || [])

      ack?.({
        success: true,
        presenter,
        allowScreenShare: meeting.allowScreenShare,
        raisedHands: raised,
      })
    } catch (err) {
      ack?.({ success: false, error: err instanceof Error ? err.message : 'Unable to join meeting room' })
    }
  })

  socket.on('meeting:leave-room', async (payload: unknown) => {
    const parsed = meetingCodeSchema.safeParse(payload)
    if (!parsed.success) return
    const { meetingCode } = parsed.data
    const room = `meeting:${meetingCode}`
    await socket.leave(room)

    if (userActiveMeeting.get(userId) === meetingCode) {
      userActiveMeeting.delete(userId)
    }

    const presenter = roomPresenters.get(meetingCode)
    if (presenter?.userId === userId) {
      roomPresenters.delete(meetingCode)
      io.to(room).emit('meeting:screen-share-stopped', { meetingCode, userId })
    }

    const hands = roomRaisedHands.get(meetingCode)
    if (hands?.has(userId)) {
      hands.delete(userId)
      io.to(room).emit('meeting:hand-raise', { meetingCode, userId, fullName, raised: false })
    }
  })

  socket.on('meeting:screen-share-start', async (payload: unknown, ack) => {
    const parsed = meetingCodeSchema.safeParse(payload)
    if (!parsed.success) {
      ack?.({ success: false, error: 'Invalid meetingCode' })
      return
    }
    const { meetingCode } = parsed.data

    try {
      const { meeting } = await meetingService.assertMeetingAccess(meetingCode, userId)
      if (!meeting.allowScreenShare && meeting.hostId !== userId) {
        ack?.({ success: false, error: 'Host has disabled screen sharing for participants' })
        return
      }

      const currentPresenter = roomPresenters.get(meetingCode)
      if (currentPresenter && currentPresenter.userId !== userId) {
        ack?.({ success: false, error: `${currentPresenter.fullName} is already presenting` })
        return
      }

      roomPresenters.set(meetingCode, { userId, fullName })
      io.to(`meeting:${meetingCode}`).emit('meeting:screen-share-started', {
        meetingCode,
        presenterUserId: userId,
        presenterName: fullName,
      })
      ack?.({ success: true })
    } catch (err) {
      ack?.({ success: false, error: err instanceof Error ? err.message : 'Cannot start screen share' })
    }
  })

  socket.on('meeting:screen-share-stop', (payload: unknown) => {
    const parsed = meetingCodeSchema.safeParse(payload)
    if (!parsed.success) return
    const { meetingCode } = parsed.data
    const currentPresenter = roomPresenters.get(meetingCode)
    if (currentPresenter?.userId === userId) {
      roomPresenters.delete(meetingCode)
      io.to(`meeting:${meetingCode}`).emit('meeting:screen-share-stopped', { meetingCode, userId })
    }
  })

  socket.on('meeting:hand-raise', (payload: unknown) => {
    const parsed = handRaiseSchema.safeParse(payload)
    if (!parsed.success) return
    const { meetingCode, raised } = parsed.data
    let hands = roomRaisedHands.get(meetingCode)
    if (!hands) {
      hands = new Set<number>()
      roomRaisedHands.set(meetingCode, hands)
    }
    if (raised) hands.add(userId)
    else hands.delete(userId)

    io.to(`meeting:${meetingCode}`).emit('meeting:hand-raise', {
      meetingCode,
      userId,
      fullName,
      raised,
    })
  })

  socket.on('meeting:reaction', (payload: unknown) => {
    const parsed = reactionSchema.safeParse(payload)
    if (!parsed.success) return
    const { meetingCode, emoji } = parsed.data
    io.to(`meeting:${meetingCode}`).emit('meeting:reaction', {
      meetingCode,
      userId,
      fullName,
      emoji,
    })
  })

  socket.on('meeting:host-mute', async (payload: unknown) => {
    const parsed = hostTargetSchema.safeParse(payload)
    if (!parsed.success) return
    const { meetingCode, targetUserId } = parsed.data
    try {
      const { meeting } = await meetingService.assertMeetingAccess(meetingCode, userId)
      if (meeting.hostId !== userId) return
      io.to(`user:${targetUserId}`).emit('meeting:muted-by-host', {
        meetingCode,
        hostName: fullName,
      })
    } catch {
      // ignore
    }
  })

  socket.on('meeting:host-remove', async (payload: unknown) => {
    const parsed = hostTargetSchema.safeParse(payload)
    if (!parsed.success) return
    const { meetingCode, targetUserId } = parsed.data
    try {
      await meetingService.removeParticipant(meetingCode, userId, targetUserId)
      io.to(`user:${targetUserId}`).emit('meeting:removed-by-host', {
        meetingCode,
        hostName: fullName,
      })
      const presenter = roomPresenters.get(meetingCode)
      if (presenter?.userId === targetUserId) {
        roomPresenters.delete(meetingCode)
        io.to(`meeting:${meetingCode}`).emit('meeting:screen-share-stopped', {
          meetingCode,
          userId: targetUserId,
        })
      }
    } catch {
      // ignore
    }
  })

  socket.on('meeting:host-screen-share-policy', async (payload: unknown) => {
    const parsed = screenPolicySchema.safeParse(payload)
    if (!parsed.success) return
    const { meetingCode, allowScreenShare } = parsed.data
    try {
      await meetingService.setScreenSharePolicy(meetingCode, userId, allowScreenShare)
      io.to(`meeting:${meetingCode}`).emit('meeting:screen-share-policy', {
        meetingCode,
        allowScreenShare,
      })
    } catch {
      // ignore
    }
  })
}

export function handleUserMeetingDisconnect(io: TypedIO, userId: number): void {
  const meetingCode = userActiveMeeting.get(userId)
  if (!meetingCode) return
  userActiveMeeting.delete(userId)

  const presenter = roomPresenters.get(meetingCode)
  if (presenter?.userId === userId) {
    roomPresenters.delete(meetingCode)
    io.to(`meeting:${meetingCode}`).emit('meeting:screen-share-stopped', { meetingCode, userId })
  }

  const hands = roomRaisedHands.get(meetingCode)
  if (hands?.has(userId)) {
    hands.delete(userId)
    io.to(`meeting:${meetingCode}`).emit('meeting:hand-raise', {
      meetingCode,
      userId,
      fullName: 'Participant',
      raised: false,
    })
  }
}

