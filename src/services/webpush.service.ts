import webpush from 'web-push'
import { executeQuery, executeInsert, executeUpdate } from '../config/snowflake'
import { DbRow } from '../utils/rows'

export interface PushPayload {
  title: string
  body: string
  url?: string
  icon?: string
  type?: string
  relatedId?: number
}

const vapidPublicKey =
  process.env.VAPID_PUBLIC_KEY ||
  'BBpmBvontkIJs9dmJsUMhbRiY_Nt82333p7Z56zhtxh6P-BGA4sG7dm3eLvFahX7Oi6rNInGdOj3LZcxmxxwti4'
const vapidPrivateKey =
  process.env.VAPID_PRIVATE_KEY || 'n09XekTGn3Qv7O_Ccgd8pyZxkKA29mz2YYqx0_SlyM0'
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:support@snowflex.com'

try {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
} catch (err) {
  console.warn('[WEBPUSH] Failed to set VAPID details:', err)
}

export const webpushService = {
  getPublicKey(): string {
    return vapidPublicKey
  },

  async saveSubscription(
    userId: number,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  ): Promise<void> {
    const { endpoint, keys } = subscription
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new Error('Invalid push subscription payload')
    }

    const existing = await executeQuery<DbRow>(
      'SELECT ID FROM PUSH_SUBSCRIPTIONS WHERE ENDPOINT = ?',
      [endpoint]
    )

    if (existing.length > 0) {
      await executeUpdate(
        'UPDATE PUSH_SUBSCRIPTIONS SET USER_ID = ?, P256DH = ?, AUTH = ? WHERE ENDPOINT = ?',
        [userId, keys.p256dh, keys.auth, endpoint]
      )
    } else {
      await executeInsert(
        'INSERT INTO PUSH_SUBSCRIPTIONS (USER_ID, ENDPOINT, P256DH, AUTH) VALUES (?, ?, ?, ?)',
        [userId, endpoint, keys.p256dh, keys.auth]
      )
    }
  },

  async deleteSubscription(endpoint: string): Promise<void> {
    await executeUpdate('DELETE FROM PUSH_SUBSCRIPTIONS WHERE ENDPOINT = ?', [endpoint])
  },

  async sendToUser(userId: number, payload: PushPayload): Promise<void> {
    const rows = await executeQuery<DbRow>(
      'SELECT ENDPOINT, P256DH, AUTH FROM PUSH_SUBSCRIPTIONS WHERE USER_ID = ?',
      [userId]
    )

    const messageString = JSON.stringify(payload)

    for (const row of rows) {
      const sub = {
        endpoint: String(row.ENDPOINT),
        keys: {
          p256dh: String(row.P256DH),
          auth: String(row.AUTH),
        },
      }

      try {
        await webpush.sendNotification(sub, messageString)
      } catch (err: unknown) {
        const error = err as { statusCode?: number }
        // 404 or 410 means subscription has expired or unsubscribed
        if (error.statusCode === 404 || error.statusCode === 410) {
          await this.deleteSubscription(sub.endpoint).catch(() => {})
        } else {
          console.warn(`[WEBPUSH] Error sending push to user ${userId}:`, err)
        }
      }
    }
  },

  async sendToAdmins(payload: PushPayload): Promise<void> {
    const adminRows = await executeQuery<DbRow>(
      `SELECT ID FROM USERS WHERE REGEXP_REPLACE(UPPER(TRIM(ROLE)), '[[:space:]-]+', '_') IN ('ADMIN', 'SUPER_ADMIN')`
    )

    for (const admin of adminRows) {
      const adminId = Number(admin.ID)
      if (adminId) {
        await this.sendToUser(adminId, payload).catch(() => {})
      }
    }
  },
}

