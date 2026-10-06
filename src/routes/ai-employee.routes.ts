import { Router } from 'express'
import { z } from 'zod'
import { aiEmployeeController } from '../controllers/ai-employee.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { validateBody } from '../middleware/validation.middleware'

import rateLimit from 'express-rate-limit'

const chatSchema = z.object({
  source: z.literal('ai-employee').optional(),
  conversationId: z.number().int().positive().optional(),
  message: z.string().trim().min(1).max(4000),
})

const widgetChatSchema = z.object({
  source: z.literal('widget'),
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(20).optional(),
})

const widgetConfirmSchema = z.object({
  confirmationToken: z.string().min(10, 'Confirmation token is required'),
})

const createConversationSchema = z.object({
  title: z.string().trim().max(120).optional(),
})

const widgetRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user?.id || 'anonymous'),
  validate: { keyGeneratorIpFallback: false },
  message: {
    success: false,
    message: 'Rate limit reached: you can send up to 20 messages per minute. Please wait a moment before trying again.',
    error: 'TOO_MANY_REQUESTS',
  },
  standardHeaders: true,
  legacyHeaders: false,
})

export const aiEmployeeRouter = Router()
aiEmployeeRouter.use(requireAuth)

aiEmployeeRouter.get('/conversations', aiEmployeeController.listConversations)
aiEmployeeRouter.post('/conversations', validateBody(createConversationSchema), aiEmployeeController.createConversation)
aiEmployeeRouter.get('/conversations/:conversationId/messages', aiEmployeeController.listMessages)
aiEmployeeRouter.post('/chat', validateBody(chatSchema), aiEmployeeController.chat)
aiEmployeeRouter.post('/widget/chat', widgetRateLimiter, validateBody(widgetChatSchema), aiEmployeeController.widgetChat)
aiEmployeeRouter.post('/widget/confirm', widgetRateLimiter, validateBody(widgetConfirmSchema), aiEmployeeController.widgetConfirm)
aiEmployeeRouter.delete('/conversations/:conversationId', aiEmployeeController.deleteConversation)