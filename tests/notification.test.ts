import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app'
import { createToken } from '../src/utils/jwt'
import { notificationService, NotificationRow, UnreadCounts } from '../src/services/notification.service'

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy'

const mockNotification: NotificationRow = {
  id: 101,
  userId: 1,
  type: 'LEAVE_REQUESTED',
  title: 'New Leave Request',
  message: 'John Doe requested leave from 2026-10-10 to 2026-10-15',
  link: '/dashboard?view=leaves',
  relatedId: 55,
  isRead: false,
  createdAt: '2026-10-05T10:00:00.000Z',
  readAt: null,
}

const mockUnreadCounts: UnreadCounts = {
  total: 3,
  byType: {
    LEAVE_REQUESTED: 2,
    LEAVE_APPROVED: 1,
  },
}

describe('notification endpoints', () => {
  const app = createApp()
  const userToken = createToken({ id: 1, email: 'john@example.com', role: 'EMPLOYEE' })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('GET /api/notifications requires authentication', async () => {
    await request(app).get('/api/notifications').expect(401)
  })

  it('GET /api/notifications returns user notifications', async () => {
    vi.spyOn(notificationService, 'getUserNotifications').mockResolvedValueOnce({
      items: [mockNotification],
      total: 1,
      page: 1,
      limit: 20,
    })

    const res = await request(app)
      .get('/api/notifications?page=1&limit=20')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data.items).toHaveLength(1)
    expect(res.body.data.items[0].id).toBe(101)
    expect(res.body.data.total).toBe(1)
  })

  it('GET /api/notifications/unread-count returns counts', async () => {
    vi.spyOn(notificationService, 'getUnreadCounts').mockResolvedValueOnce(mockUnreadCounts)

    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.byType.LEAVE_REQUESTED).toBe(2)
  })

  it('PATCH /api/notifications/:id/read marks single notification as read', async () => {
    const markSpy = vi.spyOn(notificationService, 'markAsRead').mockResolvedValueOnce(true)

    const res = await request(app)
      .patch('/api/notifications/101/read')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(markSpy).toHaveBeenCalledWith(101, 1)
  })

  it('PATCH /api/notifications/:id/read returns 404 when notification belongs to another user', async () => {
    vi.spyOn(notificationService, 'markAsRead').mockResolvedValueOnce(false)

    const res = await request(app)
      .patch('/api/notifications/999/read')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(404)

    expect(res.body.success).toBe(false)
  })

  it('PATCH /api/notifications/read-all marks all notifications as read', async () => {
    const markAllSpy = vi.spyOn(notificationService, 'markAllAsRead').mockResolvedValueOnce()

    const res = await request(app)
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(markAllSpy).toHaveBeenCalledWith(1)
  })

  it('PATCH /api/notifications/read-by-type marks matching notifications as read', async () => {
    const markTypeSpy = vi.spyOn(notificationService, 'markByTypeAsRead').mockResolvedValueOnce()

    const res = await request(app)
      .patch('/api/notifications/read-by-type')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 'LEAVE' })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(markTypeSpy).toHaveBeenCalledWith(1, 'LEAVE')
  })
})
