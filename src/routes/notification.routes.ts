import { Router } from 'express'
import { notificationController } from '../controllers/notification.controller'
import { requireAuth } from '../middleware/auth.middleware'

const router = Router()

// All notification routes require authentication
router.use(requireAuth)

// Real-time Server-Sent Events stream
router.get('/stream', notificationController.stream)

// Unread counts summary (total + by type)
router.get('/unread-count', notificationController.getUnreadCount)

// Paginated notification list
router.get('/', notificationController.getNotifications)

// Batch mark as read endpoints (Must precede parameterized /:id route)
router.patch('/read-all', notificationController.markAllAsRead)
router.patch('/read-by-type', notificationController.markByTypeAsRead)

// Single notification mark as read
router.patch('/:id/read', notificationController.markAsRead)

export const notificationRouter = router
