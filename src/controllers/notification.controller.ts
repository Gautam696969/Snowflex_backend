import { NextFunction, Request, Response } from 'express'
import { notificationService } from '../services/notification.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'

export const notificationController = {
  async getNotifications(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const page = Number(request.query.page) || 1
      const limit = Number(request.query.limit) || 20
      const result = await notificationService.getUserNotifications(request.user!.id, { page, limit })
      sendSuccess(response, 200, 'Notifications fetched successfully', result)
    } catch (error) {
      next(error)
    }
  },

  async getUnreadCount(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      response.setHeader('Pragma', 'no-cache')
      response.setHeader('Expires', '0')
      const counts = await notificationService.getUnreadCounts(request.user!.id)
      sendSuccess(response, 200, 'Unread notification counts fetched successfully', counts)
    } catch (error) {
      next(error)
    }
  },

  async markAsRead(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const id = Number(request.params.id)
      if (!id || isNaN(id)) {
        throw new HttpError(400, 'Invalid notification ID')
      }
      const found = await notificationService.markAsRead(id, request.user!.id)
      if (!found) {
        throw new HttpError(404, 'Notification not found')
      }
      sendSuccess(response, 200, 'Notification marked as read', { id, isRead: true })
    } catch (error) {
      next(error)
    }
  },

  async markAllAsRead(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      await notificationService.markAllAsRead(request.user!.id)
      sendSuccess(response, 200, 'All notifications marked as read', null)
    } catch (error) {
      next(error)
    }
  },

  async markByTypeAsRead(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const type = String(request.body.type || request.query.type || '').trim()
      if (!type) {
        throw new HttpError(400, 'Notification type or prefix is required')
      }
      await notificationService.markByTypeAsRead(request.user!.id, type)
      sendSuccess(response, 200, `Notifications of type '${type}' marked as read`, null)
    } catch (error) {
      next(error)
    }
  },

  // Server-Sent Events stream for instant real-time pushes
  stream(request: Request, response: Response): void {
    const userId = request.user!.id

    // SSE headers
    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()

    // Send initial connected event
    response.write(`event: connected\ndata: ${JSON.stringify({ userId, connectedAt: new Date().toISOString() })}\n\n`)

    // Register active client
    notificationService.addClient(userId, response)

    // Send current unread counts immediately on connect
    void notificationService.getUnreadCounts(userId).then((counts) => {
      response.write(`event: unread_counts\ndata: ${JSON.stringify(counts)}\n\n`)
    }).catch(() => {})

    // Keep-alive heartbeat ping every 25 seconds
    const pingInterval = setInterval(() => {
      try {
        response.write(':ping\n\n')
      } catch {
        clearInterval(pingInterval)
      }
    }, 25000)

    request.on('close', () => {
      clearInterval(pingInterval)
      notificationService.removeClient(userId, response)
    })
  },
}
