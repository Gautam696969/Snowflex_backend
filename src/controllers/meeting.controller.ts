import { NextFunction, Request, Response } from 'express'
import { meetingService } from '../services/meeting.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'
import { getSocketServer } from '../socket/socket.server'
import { notificationService } from '../services/notification.service'

export const meetingController = {
  createMeeting: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const { title, description, chatId, invitedUserIds, scheduledAt } = request.body as {
        title: string
        description?: string
        chatId?: number | null
        invitedUserIds?: number[]
        scheduledAt?: string | null
      }

      const result = await meetingService.createMeeting({
        hostId: request.user.id,
        title,
        description,
        chatId,
        invitedUserIds,
        scheduledAt,
      })

      const io = getSocketServer()
      const allParticipants = Array.from(new Set([request.user.id, ...result.recipientUserIds]))

      if (io) {
        if (result.cardMessage && result.meeting.chatId) {
          for (const uid of allParticipants) {
            io.to(`user:${uid}`).emit('message:new', result.cardMessage)
            io.to(`user:${uid}`).emit('conversation:updated', {
              conversationId: result.meeting.chatId,
              lastMessage: result.cardMessage,
            })
          }
        }
        if (result.statusMessage && result.meeting.chatId) {
          for (const uid of allParticipants) {
            io.to(`user:${uid}`).emit('message:new', result.statusMessage)
            io.to(`user:${uid}`).emit('conversation:updated', {
              conversationId: result.meeting.chatId,
              lastMessage: result.statusMessage,
            })
          }
        }

        // Notify all invited chat members in real time when an instant meeting starts
        if (result.meeting.status === 'LIVE') {
          for (const uid of result.recipientUserIds) {
            io.to(`user:${uid}`).emit('meeting:started', {
              meeting: result.meeting,
            })
          }
        }
      }

      // Also persist in-app notification for all invited members
      if (result.meeting.status === 'LIVE') {
        for (const uid of result.recipientUserIds) {
          void notificationService
            .createNotification({
              userId: uid,
              type: 'MEETING_STARTED',
              title: `${result.meeting.hostName} started a meeting`,
              message: `${result.meeting.title} is live now. Tap to join.`,
              link: result.meeting.joinLink,
              relatedId: result.meeting.id,
            })
            .catch(() => {})
        }
      }

      sendSuccess(response, 201, 'Meeting created successfully', result.meeting)
    } catch (error) {
      next(error)
    }
  },

  listMeetings: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const rawFilter = String(request.query.filter || 'all')
      const filter = rawFilter === 'upcoming' || rawFilter === 'past' ? rawFilter : 'all'
      const meetings = await meetingService.listMeetingsForUser(request.user.id, filter)
      sendSuccess(response, 200, 'Meetings fetched successfully', meetings)
    } catch (error) {
      next(error)
    }
  },

  getMeeting: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const code = String(request.params.code || '').trim()
      if (!code) throw new HttpError(400, 'Meeting code is required')
      const result = await meetingService.getMeeting(code, request.user.id)
      sendSuccess(response, 200, 'Meeting fetched successfully', result)
    } catch (error) {
      next(error)
    }
  },

  joinMeeting: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const code = String(request.params.code || '').trim()
      if (!code) throw new HttpError(400, 'Meeting code is required')
      const result = await meetingService.joinMeeting(code, request.user.id)
      sendSuccess(response, 200, 'Joined meeting successfully', result)
    } catch (error) {
      next(error)
    }
  },

  leaveMeeting: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const code = String(request.params.code || '').trim()
      if (!code) throw new HttpError(400, 'Meeting code is required')
      const result = await meetingService.leaveMeeting(code, request.user.id)

      const io = getSocketServer()
      if (io && result.transferredHostToUserId) {
        io.to(`meeting:${code}`).emit('meeting:host-changed', {
          meetingCode: code,
          newHostId: result.transferredHostToUserId,
        })
      }

      sendSuccess(response, 200, 'Left meeting successfully', result)
    } catch (error) {
      next(error)
    }
  },

  endMeeting: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const code = String(request.params.code || '').trim()
      if (!code) throw new HttpError(400, 'Meeting code is required')
      const result = await meetingService.endMeeting(code, request.user.id)

      const io = getSocketServer()
      if (io) {
        io.to(`meeting:${code}`).emit('meeting:ended', {
          meetingCode: code,
          endedByUserId: request.user.id,
          durationMinutes: result.durationMinutes,
        })
        if (result.endedMessage && result.meeting.chatId) {
          const allParticipants = Array.from(
            new Set([result.meeting.hostId, ...result.meeting.invitedUserIds])
          )
          for (const uid of allParticipants) {
            io.to(`user:${uid}`).emit('message:new', result.endedMessage)
            io.to(`user:${uid}`).emit('conversation:updated', {
              conversationId: result.meeting.chatId,
              lastMessage: result.endedMessage,
            })
          }
        }
      }

      sendSuccess(response, 200, 'Meeting ended successfully', result.meeting)
    } catch (error) {
      next(error)
    }
  },
}

