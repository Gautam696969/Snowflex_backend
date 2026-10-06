import { Response } from 'express'
import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { normalizeRole } from '../utils/roles'

const notificationsTable = snowflakeTable('NOTIFICATIONS')
const usersTable = snowflakeTable('USERS')

export interface NotificationRow {
  id: number
  userId: number
  type: string
  title: string
  message: string
  link: string | null
  relatedId: number | null
  isRead: boolean
  createdAt: string
  readAt: string | null
}

export interface CreateNotificationInput {
  userId: number
  type: string
  title: string
  message: string
  link?: string | null
  relatedId?: number | null
}

export interface UnreadCounts {
  total: number
  byType: Record<string, number>
}

// In-memory active SSE streams mapped by userId
const activeClients = new Map<number, Set<Response>>()

function toNotification(row: Record<string, unknown>): NotificationRow {
  return {
    id: Number(row.ID),
    userId: Number(row.USER_ID),
    type: String(row.TYPE || ''),
    title: String(row.TITLE || ''),
    message: String(row.MESSAGE || ''),
    link: row.LINK ? String(row.LINK) : null,
    relatedId: row.RELATED_ID ? Number(row.RELATED_ID) : null,
    isRead: Boolean(row.IS_READ),
    createdAt: row.CREATED_AT ? new Date(String(row.CREATED_AT)).toISOString() : new Date().toISOString(),
    readAt: row.READ_AT ? new Date(String(row.READ_AT)).toISOString() : null,
  }
}

export const notificationService = {
  // SSE subscription management
  addClient(userId: number, res: Response): void {
    let userStreams = activeClients.get(userId)
    if (!userStreams) {
      userStreams = new Set<Response>()
      activeClients.set(userId, userStreams)
    }
    userStreams.add(res)
  },

  removeClient(userId: number, res: Response): void {
    const userStreams = activeClients.get(userId)
    if (userStreams) {
      userStreams.delete(res)
      if (userStreams.size === 0) {
        activeClients.delete(userId)
      }
    }
  },

  broadcastToUser(userId: number, event: string, data: unknown): void {
    const userStreams = activeClients.get(userId)
    if (!userStreams || userStreams.size === 0) return

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of userStreams) {
      try {
        client.write(payload)
      } catch {
        userStreams.delete(client)
      }
    }
  },

  async createNotification(input: CreateNotificationInput): Promise<NotificationRow> {
    await executeInsert(
      `INSERT INTO ${notificationsTable} (
        USER_ID, TYPE, TITLE, MESSAGE, LINK, RELATED_ID, IS_READ, CREATED_AT
      ) VALUES (?, ?, ?, ?, ?, ?, FALSE, CURRENT_TIMESTAMP())`,
      [
        input.userId,
        input.type,
        input.title.slice(0, 200),
        input.message.slice(0, 1000),
        input.link ? input.link.slice(0, 300) : null,
        input.relatedId ?? null,
      ],
    )

    // Fetch the newly created notification to get its ID and timestamp
    const latest = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_ID, TYPE, TITLE, MESSAGE, LINK, RELATED_ID, IS_READ, CREATED_AT, READ_AT
       FROM ${notificationsTable}
       WHERE USER_ID = ?
       ORDER BY CREATED_AT DESC, ID DESC
       LIMIT 1`,
      [input.userId],
    )

    const notification = latest[0]
      ? toNotification(latest[0])
      : {
          id: Date.now(),
          userId: input.userId,
          type: input.type,
          title: input.title,
          message: input.message,
          link: input.link ?? null,
          relatedId: input.relatedId ?? null,
          isRead: false,
          createdAt: new Date().toISOString(),
          readAt: null,
        }

    // Push real-time event to user's SSE streams if connected
    try {
      const counts = await this.getUnreadCounts(input.userId)
      this.broadcastToUser(input.userId, 'notification', {
        notification,
        unreadCounts: counts,
      })
    } catch {
      // non-blocking
    }

    return notification
  },

  async notifyAdmins(input: Omit<CreateNotificationInput, 'userId'>): Promise<void> {
    const adminRows = await executeQuery<Record<string, unknown>>(
      `SELECT ID FROM ${usersTable} WHERE REGEXP_REPLACE(UPPER(TRIM(ROLE)), '[[:space:]-]+', '_') = 'ADMIN'`,
    )

    for (const admin of adminRows) {
      const adminId = Number(admin.ID)
      if (adminId) {
        await this.createNotification({
          userId: adminId,
          ...input,
        }).catch((err) => {
          console.error(`Failed to notify admin ${adminId}:`, err)
        })
      }
    }
  },

  async notifyLeaveReviewers(
    applicantRole: string,
    applicantUserId: number,
    input: Omit<CreateNotificationInput, 'userId'>,
  ): Promise<void> {
    const normalizedRole = normalizeRole(applicantRole)
    const targetRoles = normalizedRole === 'ADMIN'
      ? ['SUPER_ADMIN']
      : normalizedRole === 'SUPER_ADMIN'
        ? ['SUPER_ADMIN']
        : ['ADMIN', 'SUPER_ADMIN']
    const placeholders = targetRoles.map(() => '?').join(', ')
    const users = await executeQuery<Record<string, unknown>>(
      `SELECT U.ID FROM ${usersTable} U
       LEFT JOIN EMPLOYEES E ON E.USER_ID = U.ID
      WHERE REGEXP_REPLACE(UPPER(TRIM(U.ROLE)), '[[:space:]-]+', '_') IN (${placeholders}) AND U.ID <> ?
         AND COALESCE(E.STATUS, 'ACTIVE') = 'ACTIVE'`,
      [...targetRoles, applicantUserId],
    )

    for (const user of users) {
      const userId = Number(user.ID)
      if (!userId) continue
      await this.createNotification({ userId, ...input }).catch((error) => {
        console.error(`Failed to notify leave reviewer ${userId}:`, error)
      })
    }
  },

  async getUserNotifications(
    userId: number,
    options: { page?: number; limit?: number } = {},
  ): Promise<{ items: NotificationRow[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(options.page) || 1)
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 20))
    const offset = (page - 1) * limit

    const [rows, countRows] = await Promise.all([
      executeQuery<Record<string, unknown>>(
        `SELECT ID, USER_ID, TYPE, TITLE, MESSAGE, LINK, RELATED_ID, IS_READ, CREATED_AT, READ_AT
         FROM ${notificationsTable}
         WHERE USER_ID = ?
         ORDER BY CREATED_AT DESC, ID DESC
         LIMIT ? OFFSET ?`,
        [userId, limit, offset],
      ),
      executeQuery<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM ${notificationsTable} WHERE USER_ID = ?`,
        [userId],
      ),
    ])

    const total = Number(countRows[0]?.CNT || 0)
    const items = rows.map(toNotification)

    return { items, total, page, limit }
  },

  async getUnreadCounts(userId: number): Promise<UnreadCounts> {
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT TYPE, COUNT(*) AS CNT
       FROM ${notificationsTable}
       WHERE USER_ID = ? AND IS_READ = FALSE
       GROUP BY TYPE`,
      [userId],
    )

    let total = 0
    const byType: Record<string, number> = {}

    for (const row of rows) {
      const type = String(row.TYPE || '')
      const count = Number(row.CNT || 0)
      if (type) {
        byType[type] = count
        total += count
      }
    }

    return { total, byType }
  },

  async markAsRead(id: number, userId: number): Promise<boolean> {
    const existing = await executeQuery<{ ID: number }>(
      `SELECT ID FROM ${notificationsTable} WHERE ID = ? AND USER_ID = ?`,
      [id, userId],
    )
    if (!existing || existing.length === 0) {
      return false
    }

    await executeUpdate(
      `UPDATE ${notificationsTable}
       SET IS_READ = TRUE, READ_AT = CURRENT_TIMESTAMP()
       WHERE ID = ? AND USER_ID = ?`,
      [id, userId],
    )

    try {
      const counts = await this.getUnreadCounts(userId)
      this.broadcastToUser(userId, 'unread_counts', counts)
    } catch {
      // non-blocking
    }
    return true
  },

  async markAllAsRead(userId: number): Promise<void> {
    await executeUpdate(
      `UPDATE ${notificationsTable}
       SET IS_READ = TRUE, READ_AT = CURRENT_TIMESTAMP()
       WHERE USER_ID = ? AND IS_READ = FALSE`,
      [userId],
    )

    try {
      const counts = await this.getUnreadCounts(userId)
      this.broadcastToUser(userId, 'unread_counts', counts)
    } catch {
      // non-blocking
    }
  },

  async markByTypeAsRead(userId: number, typePrefixOrType: string): Promise<void> {
    const cleanPattern = typePrefixOrType.trim().toUpperCase()
    const pattern = cleanPattern.includes('%') ? cleanPattern : `${cleanPattern}%`

    await executeUpdate(
      `UPDATE ${notificationsTable}
       SET IS_READ = TRUE, READ_AT = CURRENT_TIMESTAMP()
       WHERE USER_ID = ? AND IS_READ = FALSE AND UPPER(TYPE) LIKE ?`,
      [userId, pattern],
    )

    try {
      const counts = await this.getUnreadCounts(userId)
      this.broadcastToUser(userId, 'unread_counts', counts)
    } catch {
      // non-blocking
    }
  },
}
