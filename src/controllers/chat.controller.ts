import { NextFunction, Request, Response } from 'express'
import { chatService } from '../services/chat.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'
import { getSocketServer } from '../socket/socket.server'

export const chatController = {
  getContacts: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const contacts = await chatService.getContacts(request.user.id, request.user.role)
      sendSuccess(response, 200, 'Contacts fetched successfully', contacts)
    } catch (error) {
      next(error)
    }
  },

  getConversations: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const conversations = await chatService.getConversations(request.user.id, request.user.role)
      sendSuccess(response, 200, 'Conversations fetched successfully', conversations)
    } catch (error) {
      next(error)
    }
  },

  createConversation: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const { participantId } = request.body as { participantId: number }
      if (!participantId || typeof participantId !== 'number') {
        throw new HttpError(400, 'participantId must be a valid number')
      }

      const conversation = await chatService.getOrCreateConversation(
        request.user.id,
        request.user.role,
        participantId
      )

      sendSuccess(response, 201, 'Conversation retrieved or created successfully', conversation)
    } catch (error) {
      next(error)
    }
  },

  getMessages: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const conversationId = Number(request.params.id)
      if (!conversationId || isNaN(conversationId)) {
        throw new HttpError(400, 'Invalid conversation ID')
      }

      const cursor = request.query.cursor ? Number(request.query.cursor) : undefined
      const limit = request.query.limit ? Number(request.query.limit) : 30

      const result = await chatService.getConversationMessages(
        request.user.id,
        conversationId,
        cursor,
        limit
      )

      sendSuccess(response, 200, 'Messages fetched successfully', result)
    } catch (error) {
      next(error)
    }
  },

  markAsRead: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const conversationId = Number(request.params.id)
      if (!conversationId || isNaN(conversationId)) {
        throw new HttpError(400, 'Invalid conversation ID')
      }

      const count = await chatService.markConversationAsRead(request.user.id, conversationId)

      // Emit read receipt via socket to other participants
      const io = getSocketServer()
      if (io) {
        const readAt = new Date().toISOString()
        io.to(`conv:${conversationId}`).emit('message:read', {
          conversationId,
          readerId: request.user.id,
          readAt,
        })
      }

      sendSuccess(response, 200, 'Messages marked as read', { readCount: count })
    } catch (error) {
      next(error)
    }
  },

  getUnreadCount: async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new HttpError(401, 'Unauthorized')
      const count = await chatService.getUnreadCount(request.user.id)
      sendSuccess(response, 200, 'Unread count fetched successfully', { count })
    } catch (error) {
      next(error)
    }
  },
}
