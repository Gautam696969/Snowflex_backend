import { NextFunction, Request, Response } from 'express'
import { aiEmployeeService } from '../services/ai-employee.service'
import { sendSuccess } from '../utils/apiResponse'

export const aiEmployeeController = {
  async listConversations(request: Request, response: Response, next: NextFunction) {
    try {
      const conversations = await aiEmployeeService.listConversations(request.user!.id)
      sendSuccess(response, 200, 'Conversations fetched successfully', conversations)
    } catch (error) { next(error) }
  },

  async createConversation(request: Request, response: Response, next: NextFunction) {
    try {
      const conversation = await aiEmployeeService.createConversation(request.user!.id, request.body?.title)
      sendSuccess(response, 201, 'Conversation created successfully', conversation)
    } catch (error) { next(error) }
  },

  async listMessages(request: Request, response: Response, next: NextFunction) {
    try {
      const conversationId = Number(request.params.conversationId)
      const messages = await aiEmployeeService.listMessages(conversationId, request.user!.id)
      sendSuccess(response, 200, 'Messages fetched successfully', messages)
    } catch (error) { next(error) }
  },

  async chat(request: Request, response: Response, next: NextFunction) {
    try {
      const result = await aiEmployeeService.chat(request.user!.id, request.user!.role, {
        conversationId: request.body?.conversationId ? Number(request.body.conversationId) : undefined,
        message: String(request.body?.message ?? ''),
      })
      sendSuccess(response, 200, 'Message sent successfully', result)
    } catch (error) { next(error) }
  },

  async widgetChat(request: Request, response: Response, next: NextFunction) {
    try {
      const result = await aiEmployeeService.widgetChat(request.user!.id, request.user!.role, {
        source: 'widget',
        message: String(request.body?.message ?? ''),
        history: request.body?.history,
      })
      sendSuccess(response, 200, 'Message sent successfully', result)
    } catch (error) { next(error) }
  },

  async deleteConversation(request: Request, response: Response, next: NextFunction) {
    try {
      const conversationId = Number(request.params.conversationId)
      await aiEmployeeService.deleteConversation(conversationId, request.user!.id)
      sendSuccess(response, 200, 'Conversation deleted successfully', null)
    } catch (error) { next(error) }
  },
}