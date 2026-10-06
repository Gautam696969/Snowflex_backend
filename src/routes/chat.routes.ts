import { Router } from 'express'
import { z } from 'zod'
import { chatController } from '../controllers/chat.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const createConversationSchema = z.object({
  participantId: z.coerce.number().int().positive('participantId must be a positive integer'),
})

const conversationIdSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
})

export const chatRouter = Router()

chatRouter.use(requireAuth)

chatRouter.get('/contacts', chatController.getContacts)
chatRouter.get('/conversations', chatController.getConversations)
chatRouter.post('/conversations', validateBody(createConversationSchema), chatController.createConversation)
chatRouter.get('/conversations/:id/messages', validateParams(conversationIdSchema), chatController.getMessages)
chatRouter.post('/conversations/:id/read', validateParams(conversationIdSchema), chatController.markAsRead)
chatRouter.get('/unread-count', chatController.getUnreadCount)
