import { executeQuery, executeUpdate } from '../config/snowflake'
import { canChat, isAllowAdminToAdminChat } from '../config/chatPermissions'
import { HttpError } from '../utils/http-error'
import { normalizeRole } from '../utils/roles'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { presenceManager } from '../socket/presence.manager'

const usersTable = snowflakeTable('USERS')
const employeesTable = snowflakeTable('EMPLOYEES')
const chatConversationsTable = snowflakeTable('CHAT_CONVERSATIONS')
const chatMessagesTable = snowflakeTable('CHAT_MESSAGES')

export interface ChatContact {
  id: number
  fullName: string
  email: string
  role: string
  avatarUrl: string | null
  status: string
  isOnline: boolean
  lastSeen: string | null
}

export interface ChatMessageItem {
  id: number
  conversationId: number
  senderId: number
  body: string
  createdAt: string
  deliveredAt: string | null
  readAt: string | null
  clientMessageId: string | null
  isDeleted: boolean
}

export interface ChatConversationItem {
  id: number
  userAId: number
  userBId: number
  createdAt: string
  lastMessageAt: string
  otherUser: {
    id: number
    fullName: string
    email: string
    role: string
    avatarUrl: string | null
    status: string
    isOnline: boolean
    lastSeen: string | null
  }
  lastMessage: ChatMessageItem | null
  unreadCount: number
  isReadOnly: boolean
}

export interface UserCachedInfo {
  id: number
  fullName: string
  email: string
  role: string
  avatarUrl: string | null
  status: string
  expiresAt: number
}

// In-memory cache for user role and active status (TTL 20 seconds) to reduce Snowflake reads
const userCache = new Map<number, UserCachedInfo>()
const CACHE_TTL_MS = 20_000

function toIsoString(val: unknown): string {
  if (!val) return new Date().toISOString()
  if (val instanceof Date) return val.toISOString()
  const parsed = new Date(String(val))
  return isNaN(parsed.getTime()) ? String(val) : parsed.toISOString()
}

function toNullableIsoString(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  const parsed = new Date(String(val))
  return isNaN(parsed.getTime()) ? String(val) : parsed.toISOString()
}

export const chatService = {
  /**
   * Ensures that live chat tables exist in Snowflake.
   */
  async ensureTables(): Promise<void> {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${chatConversationsTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          USER_A_ID INTEGER NOT NULL,
          USER_B_ID INTEGER NOT NULL,
          CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          LAST_MESSAGE_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          CONSTRAINT UQ_CHAT_CONVERSATION_PAIR UNIQUE (USER_A_ID, USER_B_ID)
        )
      `)
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${chatMessagesTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          CONVERSATION_ID INTEGER NOT NULL,
          SENDER_ID INTEGER NOT NULL,
          BODY VARCHAR(4000) NOT NULL,
          CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          DELIVERED_AT TIMESTAMP_NTZ,
          READ_AT TIMESTAMP_NTZ,
          CLIENT_MESSAGE_ID VARCHAR(128),
          IS_DELETED BOOLEAN DEFAULT FALSE
        )
      `)
    } catch {
      // In tests or if already created, safely ignore
    }
  },

  /**
   * Retrieves user role, profile, and active status with a short in-memory cache.
   */
  async getUserInfo(userId: number, bypassCache = false): Promise<UserCachedInfo> {
    const cached = userCache.get(userId)
    const now = Date.now()
    if (!bypassCache && cached && cached.expiresAt > now) {
      return cached
    }

    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT U.ID, U.FULL_NAME, U.EMAIL, U.ROLE, U.AVATAR_URL,
              COALESCE(E.STATUS, 'ACTIVE') AS STATUS
       FROM ${usersTable} U
       LEFT JOIN ${employeesTable} E ON E.USER_ID = U.ID
       WHERE U.ID = ?`,
      [userId]
    )

    if (!rows[0]) {
      throw new HttpError(404, 'User not found')
    }

    const row = rows[0]
    const info: UserCachedInfo = {
      id: Number(row.ID),
      fullName: String(row.FULL_NAME || ''),
      email: String(row.EMAIL || ''),
      role: normalizeRole(String(row.ROLE || 'EMPLOYEE')),
      avatarUrl: row.AVATAR_URL ? String(row.AVATAR_URL) : null,
      status: String(row.STATUS || 'ACTIVE').toUpperCase(),
      expiresAt: now + CACHE_TTL_MS,
    }

    userCache.set(userId, info)
    return info
  },

  /**
   * Invalidates cached info for a user (e.g. on role change).
   */
  invalidateUserCache(userId: number): void {
    userCache.delete(userId)
  },

  /**
   * Returns contacts that the current user's role is permitted to chat with symmetrically.
   * Only active users are included.
   */
  async getContacts(userId: number, userRole: string): Promise<ChatContact[]> {
    const normalizedCurrentUserRole = normalizeRole(userRole)

    // Fetch all active users except the current user
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT U.ID, U.FULL_NAME, U.EMAIL, U.ROLE, U.AVATAR_URL,
              COALESCE(E.STATUS, 'ACTIVE') AS STATUS
       FROM ${usersTable} U
       LEFT JOIN ${employeesTable} E ON E.USER_ID = U.ID
       WHERE U.ID <> ? AND COALESCE(E.STATUS, 'ACTIVE') = 'ACTIVE'
       ORDER BY U.FULL_NAME ASC`,
      [userId]
    )

    const contacts: ChatContact[] = []

    for (const row of rows) {
      const targetRole = normalizeRole(String(row.ROLE || 'EMPLOYEE'))
      const targetStatus = String(row.STATUS || 'ACTIVE').toUpperCase()

      // Enforce symmetric backend permission matrix
      if (targetStatus === 'ACTIVE' && canChat(normalizedCurrentUserRole, targetRole)) {
        const contactId = Number(row.ID)
        contacts.push({
          id: contactId,
          fullName: String(row.FULL_NAME || ''),
          email: String(row.EMAIL || ''),
          role: targetRole,
          avatarUrl: row.AVATAR_URL ? String(row.AVATAR_URL) : null,
          status: targetStatus,
          isOnline: presenceManager.isOnline(contactId),
          lastSeen: presenceManager.getLastSeen(contactId),
        })
      }
    }

    return contacts
  },

  /**
   * Fetches all conversations for the user with latest message preview and unread counts.
   * Single aggregated query to prevent N+1 overhead on Snowflake.
   */
  async getConversations(userId: number, userRole: string): Promise<ChatConversationItem[]> {
    const normalizedCurrentUserRole = normalizeRole(userRole)

    const sql = `
      SELECT 
        C.ID AS CONVERSATION_ID,
        C.USER_A_ID,
        C.USER_B_ID,
        C.CREATED_AT AS CONV_CREATED_AT,
        C.LAST_MESSAGE_AT,
        CASE WHEN C.USER_A_ID = ? THEN U_B.ID ELSE U_A.ID END AS OTHER_USER_ID,
        CASE WHEN C.USER_A_ID = ? THEN U_B.FULL_NAME ELSE U_A.FULL_NAME END AS OTHER_FULL_NAME,
        CASE WHEN C.USER_A_ID = ? THEN U_B.EMAIL ELSE U_A.EMAIL END AS OTHER_EMAIL,
        CASE WHEN C.USER_A_ID = ? THEN U_B.ROLE ELSE U_A.ROLE END AS OTHER_ROLE,
        CASE WHEN C.USER_A_ID = ? THEN U_B.AVATAR_URL ELSE U_A.AVATAR_URL END AS OTHER_AVATAR_URL,
        CASE WHEN C.USER_A_ID = ? THEN COALESCE(E_B.STATUS, 'ACTIVE') ELSE COALESCE(E_A.STATUS, 'ACTIVE') END AS OTHER_STATUS,
        LM.ID AS LAST_MSG_ID,
        LM.SENDER_ID AS LAST_MSG_SENDER_ID,
        LM.BODY AS LAST_MSG_BODY,
        LM.CREATED_AT AS LAST_MSG_CREATED_AT,
        LM.READ_AT AS LAST_MSG_READ_AT,
        LM.DELIVERED_AT AS LAST_MSG_DELIVERED_AT,
        LM.CLIENT_MESSAGE_ID AS LAST_MSG_CLIENT_ID,
        COALESCE(UNREAD.CNT, 0) AS UNREAD_COUNT
      FROM ${chatConversationsTable} C
      JOIN ${usersTable} U_A ON U_A.ID = C.USER_A_ID
      JOIN ${usersTable} U_B ON U_B.ID = C.USER_B_ID
      LEFT JOIN ${employeesTable} E_A ON E_A.USER_ID = U_A.ID
      LEFT JOIN ${employeesTable} E_B ON E_B.USER_ID = U_B.ID
      LEFT JOIN (
        SELECT CONVERSATION_ID, COUNT(*) AS CNT
        FROM ${chatMessagesTable}
        WHERE SENDER_ID <> ? AND READ_AT IS NULL AND IS_DELETED = FALSE
        GROUP BY CONVERSATION_ID
      ) UNREAD ON UNREAD.CONVERSATION_ID = C.ID
      LEFT JOIN (
        SELECT M.*
        FROM ${chatMessagesTable} M
        JOIN (
          SELECT CONVERSATION_ID, MAX(ID) AS MAX_ID
          FROM ${chatMessagesTable}
          WHERE IS_DELETED = FALSE
          GROUP BY CONVERSATION_ID
        ) LATEST ON M.ID = LATEST.MAX_ID
      ) LM ON LM.CONVERSATION_ID = C.ID
      WHERE (C.USER_A_ID = ? OR C.USER_B_ID = ?)
      ORDER BY C.LAST_MESSAGE_AT DESC
    `

    const rows = await executeQuery<Record<string, unknown>>(sql, [
      userId, userId, userId, userId, userId, userId,
      userId,
      userId, userId
    ])

    return rows.map((r) => {
      const otherUserId = Number(r.OTHER_USER_ID)
      const otherRole = normalizeRole(String(r.OTHER_ROLE || 'EMPLOYEE'))
      const otherStatus = String(r.OTHER_STATUS || 'ACTIVE').toUpperCase()
      const isAllowed = canChat(normalizedCurrentUserRole, otherRole) && otherStatus === 'ACTIVE'

      let lastMessage: ChatMessageItem | null = null
      if (r.LAST_MSG_ID) {
        lastMessage = {
          id: Number(r.LAST_MSG_ID),
          conversationId: Number(r.CONVERSATION_ID),
          senderId: Number(r.LAST_MSG_SENDER_ID),
          body: String(r.LAST_MSG_BODY || ''),
          createdAt: toIsoString(r.LAST_MSG_CREATED_AT),
          readAt: toNullableIsoString(r.LAST_MSG_READ_AT),
          deliveredAt: toNullableIsoString(r.LAST_MSG_DELIVERED_AT),
          clientMessageId: r.LAST_MSG_CLIENT_ID ? String(r.LAST_MSG_CLIENT_ID) : null,
          isDeleted: false,
        }
      }

      return {
        id: Number(r.CONVERSATION_ID),
        userAId: Number(r.USER_A_ID),
        userBId: Number(r.USER_B_ID),
        createdAt: toIsoString(r.CONV_CREATED_AT),
        lastMessageAt: toIsoString(r.LAST_MESSAGE_AT),
        otherUser: {
          id: otherUserId,
          fullName: String(r.OTHER_FULL_NAME || ''),
          email: String(r.OTHER_EMAIL || ''),
          role: otherRole,
          avatarUrl: r.OTHER_AVATAR_URL ? String(r.OTHER_AVATAR_URL) : null,
          status: otherStatus,
          isOnline: presenceManager.isOnline(otherUserId),
          lastSeen: presenceManager.getLastSeen(otherUserId),
        },
        lastMessage,
        unreadCount: Number(r.UNREAD_COUNT || 0),
        isReadOnly: !isAllowed,
      }
    })
  },

  /**
   * Creates a new conversation or retrieves an existing one between two users.
   * Enforces backend role permission check and non-self-chat rule.
   */
  async getOrCreateConversation(
    userId: number,
    userRole: string,
    participantId: number
  ): Promise<ChatConversationItem> {
    if (userId === participantId) {
      throw new HttpError(400, 'Cannot start a conversation with yourself')
    }

    // Verify recipient exists and is active
    const recipient = await this.getUserInfo(participantId)
    if (recipient.status !== 'ACTIVE') {
      throw new HttpError(400, 'User account is deactivated')
    }

    // Verify sender is active
    const sender = await this.getUserInfo(userId)
    if (sender.status !== 'ACTIVE') {
      throw new HttpError(403, 'Your account is deactivated')
    }

    // Enforce backend permission matrix
    const normalizedSenderRole = normalizeRole(sender.role || userRole)
    if (!canChat(normalizedSenderRole, recipient.role)) {
      throw new HttpError(403, `Role ${normalizedSenderRole} is not permitted to chat with role ${recipient.role}`)
    }

    // Normalized pair
    const userA = Math.min(userId, participantId)
    const userB = Math.max(userId, participantId)

    // Check existing
    const existing = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_A_ID, USER_B_ID, CREATED_AT, LAST_MESSAGE_AT
       FROM ${chatConversationsTable}
       WHERE USER_A_ID = ? AND USER_B_ID = ?`,
      [userA, userB]
    )

    let convId: number
    let createdAt: string
    let lastMessageAt: string

    if (existing[0]) {
      convId = Number(existing[0].ID)
      createdAt = toIsoString(existing[0].CREATED_AT)
      lastMessageAt = toIsoString(existing[0].LAST_MESSAGE_AT)
    } else {
      await executeQuery(
        `INSERT INTO ${chatConversationsTable} (USER_A_ID, USER_B_ID, CREATED_AT, LAST_MESSAGE_AT)
         VALUES (?, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [userA, userB]
      )

      const created = await executeQuery<Record<string, unknown>>(
        `SELECT ID, USER_A_ID, USER_B_ID, CREATED_AT, LAST_MESSAGE_AT
         FROM ${chatConversationsTable}
         WHERE USER_A_ID = ? AND USER_B_ID = ?`,
        [userA, userB]
      )

      if (!created[0]) {
        throw new HttpError(500, 'Failed to create conversation')
      }

      convId = Number(created[0].ID)
      createdAt = toIsoString(created[0].CREATED_AT)
      lastMessageAt = toIsoString(created[0].LAST_MESSAGE_AT)
    }

    return {
      id: convId,
      userAId: userA,
      userBId: userB,
      createdAt,
      lastMessageAt,
      otherUser: {
        id: recipient.id,
        fullName: recipient.fullName,
        email: recipient.email,
        role: recipient.role,
        avatarUrl: recipient.avatarUrl,
        status: recipient.status,
        isOnline: presenceManager.isOnline(recipient.id),
        lastSeen: presenceManager.getLastSeen(recipient.id),
      },
      lastMessage: null,
      unreadCount: 0,
      isReadOnly: false,
    }
  },

  /**
   * Fetches paginated messages for a conversation (cursor pagination).
   * Verifies membership in the conversation.
   */
  async getConversationMessages(
    userId: number,
    conversationId: number,
    cursor?: number,
    limit = 30
  ): Promise<{ messages: ChatMessageItem[]; nextCursor: number | null; hasMore: boolean }> {
    // Verify membership
    const convRows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_A_ID, USER_B_ID FROM ${chatConversationsTable} WHERE ID = ?`,
      [conversationId]
    )

    if (!convRows[0]) {
      throw new HttpError(404, 'Conversation not found')
    }

    const userA = Number(convRows[0].USER_A_ID)
    const userB = Number(convRows[0].USER_B_ID)

    if (userId !== userA && userId !== userB) {
      throw new HttpError(403, 'Forbidden: you are not a participant in this conversation')
    }

    const pageSize = Math.min(Math.max(Number(limit) || 30, 1), 100)
    const fetchLimit = pageSize + 1

    let query: string
    let binds: (number | string)[]

    if (cursor && cursor > 0) {
      query = `
        SELECT ID, CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, READ_AT, CLIENT_MESSAGE_ID, IS_DELETED
        FROM ${chatMessagesTable}
        WHERE CONVERSATION_ID = ? AND ID < ? AND IS_DELETED = FALSE
        ORDER BY ID DESC
        LIMIT ?
      `
      binds = [conversationId, cursor, fetchLimit]
    } else {
      query = `
        SELECT ID, CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, READ_AT, CLIENT_MESSAGE_ID, IS_DELETED
        FROM ${chatMessagesTable}
        WHERE CONVERSATION_ID = ? AND IS_DELETED = FALSE
        ORDER BY ID DESC
        LIMIT ?
      `
      binds = [conversationId, fetchLimit]
    }

    const rows = await executeQuery<Record<string, unknown>>(query, binds)

    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows

    // nextCursor is the oldest message ID in this page (for loading earlier messages)
    const nextCursor = hasMore && pageRows.length > 0 ? Number(pageRows[pageRows.length - 1].ID) : null

    // Reverse to chronological order (oldest to newest)
    const chronological = pageRows.reverse()

    const messages: ChatMessageItem[] = chronological.map((r) => ({
      id: Number(r.ID),
      conversationId: Number(r.CONVERSATION_ID),
      senderId: Number(r.SENDER_ID),
      body: String(r.BODY || ''),
      createdAt: toIsoString(r.CREATED_AT),
      deliveredAt: toNullableIsoString(r.DELIVERED_AT),
      readAt: toNullableIsoString(r.READ_AT),
      clientMessageId: r.CLIENT_MESSAGE_ID ? String(r.CLIENT_MESSAGE_ID) : null,
      isDeleted: Boolean(r.IS_DELETED),
    }))

    // Background mark undelivered incoming messages as delivered
    void executeQuery(
      `UPDATE ${chatMessagesTable}
       SET DELIVERED_AT = CURRENT_TIMESTAMP()
       WHERE CONVERSATION_ID = ? AND SENDER_ID <> ? AND DELIVERED_AT IS NULL`,
      [conversationId, userId]
    ).catch(() => {})

    return { messages, nextCursor, hasMore }
  },

  /**
   * Persists a newly sent message.
   * Enforces backend membership, role permissions, active user status, deduplication, and sanitization.
   */
  async saveMessage(input: {
    conversationId: number
    senderId: number
    recipientId: number
    body: string
    clientMessageId?: string
  }): Promise<ChatMessageItem> {
    const { conversationId, senderId, recipientId, body, clientMessageId } = input

    if (senderId === recipientId) {
      throw new HttpError(400, 'Cannot send message to yourself')
    }

    // Verify conversation membership
    const convRows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_A_ID, USER_B_ID FROM ${chatConversationsTable} WHERE ID = ?`,
      [conversationId]
    )

    if (!convRows[0]) {
      throw new HttpError(404, 'Conversation not found')
    }

    const userA = Number(convRows[0].USER_A_ID)
    const userB = Number(convRows[0].USER_B_ID)

    const isMember = (senderId === userA && recipientId === userB) || (senderId === userB && recipientId === userA)
    if (!isMember) {
      throw new HttpError(403, 'Forbidden: you are not a participant in this conversation')
    }

    // Check fresh sender & recipient status and roles
    const sender = await this.getUserInfo(senderId)
    const recipient = await this.getUserInfo(recipientId)

    if (sender.status !== 'ACTIVE') {
      throw new HttpError(403, 'Your account is deactivated')
    }
    if (recipient.status !== 'ACTIVE') {
      throw new HttpError(403, 'Recipient account is deactivated')
    }

    // Enforce role permission matrix
    if (!canChat(sender.role, recipient.role)) {
      throw new HttpError(403, `Messaging is not allowed between ${sender.role} and ${recipient.role}`)
    }

    // Deduplication check via clientMessageId
    if (clientMessageId) {
      const existing = await executeQuery<Record<string, unknown>>(
        `SELECT ID, CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, READ_AT, CLIENT_MESSAGE_ID, IS_DELETED
         FROM ${chatMessagesTable}
         WHERE CONVERSATION_ID = ? AND CLIENT_MESSAGE_ID = ?`,
        [conversationId, clientMessageId]
      )

      if (existing[0]) {
        return {
          id: Number(existing[0].ID),
          conversationId: Number(existing[0].CONVERSATION_ID),
          senderId: Number(existing[0].SENDER_ID),
          body: String(existing[0].BODY || ''),
          createdAt: toIsoString(existing[0].CREATED_AT),
          deliveredAt: toNullableIsoString(existing[0].DELIVERED_AT),
          readAt: toNullableIsoString(existing[0].READ_AT),
          clientMessageId: existing[0].CLIENT_MESSAGE_ID ? String(existing[0].CLIENT_MESSAGE_ID) : null,
          isDeleted: Boolean(existing[0].IS_DELETED),
        }
      }
    }

    // Plain text sanitization (trim, limit 2000 chars)
    const cleanBody = body.trim().slice(0, 2000)
    if (!cleanBody) {
      throw new HttpError(400, 'Message body cannot be empty')
    }

    const isRecipientOnline = presenceManager.isOnline(recipientId)
    const cleanClientId = clientMessageId ? clientMessageId.trim().slice(0, 128) : null

    if (isRecipientOnline) {
      await executeQuery(
        `INSERT INTO ${chatMessagesTable} (CONVERSATION_ID, SENDER_ID, BODY, CLIENT_MESSAGE_ID, CREATED_AT, DELIVERED_AT)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [conversationId, senderId, cleanBody, cleanClientId]
      )
    } else {
      await executeQuery(
        `INSERT INTO ${chatMessagesTable} (CONVERSATION_ID, SENDER_ID, BODY, CLIENT_MESSAGE_ID, CREATED_AT)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP())`,
        [conversationId, senderId, cleanBody, cleanClientId]
      )
    }

    // Update conversation last_message_at
    await executeQuery(
      `UPDATE ${chatConversationsTable} SET LAST_MESSAGE_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [conversationId]
    )

    // Retrieve saved message
    let savedRow: Record<string, unknown> | undefined
    if (cleanClientId) {
      const rows = await executeQuery<Record<string, unknown>>(
        `SELECT ID, CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, READ_AT, CLIENT_MESSAGE_ID, IS_DELETED
         FROM ${chatMessagesTable}
         WHERE CONVERSATION_ID = ? AND CLIENT_MESSAGE_ID = ?`,
        [conversationId, cleanClientId]
      )
      savedRow = rows[0]
    }

    if (!savedRow) {
      const rows = await executeQuery<Record<string, unknown>>(
        `SELECT ID, CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, READ_AT, CLIENT_MESSAGE_ID, IS_DELETED
         FROM ${chatMessagesTable}
         WHERE CONVERSATION_ID = ? AND SENDER_ID = ?
         ORDER BY ID DESC LIMIT 1`,
        [conversationId, senderId]
      )
      savedRow = rows[0]
    }

    if (!savedRow) {
      throw new HttpError(500, 'Failed to save message')
    }

    return {
      id: Number(savedRow.ID),
      conversationId: Number(savedRow.CONVERSATION_ID),
      senderId: Number(savedRow.SENDER_ID),
      body: String(savedRow.BODY || ''),
      createdAt: toIsoString(savedRow.CREATED_AT),
      deliveredAt: toNullableIsoString(savedRow.DELIVERED_AT),
      readAt: toNullableIsoString(savedRow.READ_AT),
      clientMessageId: savedRow.CLIENT_MESSAGE_ID ? String(savedRow.CLIENT_MESSAGE_ID) : null,
      isDeleted: false,
    }
  },

  /**
   * Marks unread messages in a conversation as read by the participant.
   */
  async markConversationAsRead(userId: number, conversationId: number): Promise<number> {
    // Verify membership
    const convRows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_A_ID, USER_B_ID FROM ${chatConversationsTable} WHERE ID = ?`,
      [conversationId]
    )

    if (!convRows[0]) {
      throw new HttpError(404, 'Conversation not found')
    }

    const userA = Number(convRows[0].USER_A_ID)
    const userB = Number(convRows[0].USER_B_ID)

    if (userId !== userA && userId !== userB) {
      throw new HttpError(403, 'Forbidden: you are not a participant in this conversation')
    }

    const affected = await executeUpdate(
      `UPDATE ${chatMessagesTable}
       SET READ_AT = CURRENT_TIMESTAMP(),
           DELIVERED_AT = COALESCE(DELIVERED_AT, CURRENT_TIMESTAMP())
       WHERE CONVERSATION_ID = ? AND SENDER_ID <> ? AND READ_AT IS NULL`,
      [conversationId, userId]
    )

    return affected
  },

  /**
   * Calculates total unread chat messages for a user across all conversations.
   */
  async getUnreadCount(userId: number): Promise<number> {
    const rows = await executeQuery<{ UNREAD_COUNT: number }>(
      `SELECT COUNT(*) AS UNREAD_COUNT
       FROM ${chatMessagesTable} M
       JOIN ${chatConversationsTable} C ON C.ID = M.CONVERSATION_ID
       WHERE (C.USER_A_ID = ? OR C.USER_B_ID = ?)
         AND M.SENDER_ID <> ?
         AND M.READ_AT IS NULL
         AND M.IS_DELETED = FALSE`,
      [userId, userId, userId]
    )

    return Number(rows[0]?.UNREAD_COUNT || 0)
  },
}
