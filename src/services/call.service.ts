import { executeQuery, executeUpdate } from '../config/snowflake'
import { canChat } from '../config/chatPermissions'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { HttpError } from '../utils/http-error'
import { chatService, type ChatMessageItem } from './chat.service'

const callLogsTable = snowflakeTable('CALL_LOGS')
const chatMessagesTable = snowflakeTable('CHAT_MESSAGES')
const chatConversationsTable = snowflakeTable('CHAT_CONVERSATIONS')

export type CallLogStatus = 'RINGING' | 'CONNECTED' | 'COMPLETED' | 'REJECTED' | 'MISSED' | 'BUSY'

export interface CallLogItem {
  id: number
  callId: string
  conversationId: number
  callerId: number
  receiverId: number
  status: CallLogStatus
  startedAt: string
  connectedAt: string | null
  endedAt: string | null
  durationSeconds: number
}

export interface IceServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
}

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

export function formatCallDurationMessage(status: CallLogStatus, durationSeconds: number): string {
  if (status === 'REJECTED') {
    return '📹 Video call declined'
  }
  if (status === 'BUSY') {
    return '📹 Missed video call (Busy)'
  }
  if (status === 'MISSED' || durationSeconds <= 0) {
    return '📹 Missed video call'
  }

  const mins = Math.floor(durationSeconds / 60)
  const secs = durationSeconds % 60
  if (mins >= 1) {
    return secs > 0 ? `📹 Video call - ${mins} min ${secs} sec` : `📹 Video call - ${mins} min`
  }
  return `📹 Video call - ${secs} sec`
}

export function getIceServersFromEnv(): IceServerConfig[] {
  const stunRaw = (process.env.WEBRTC_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').trim()
  const stunUrls = stunRaw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)

  const servers: IceServerConfig[] = []
  if (stunUrls.length > 0) {
    servers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls })
  }

  const turnUrl = (process.env.WEBRTC_TURN_URL || '').trim()
  const turnUsername = (process.env.WEBRTC_TURN_USERNAME || '').trim()
  const turnCredential = (process.env.WEBRTC_TURN_CREDENTIAL || '').trim()

  if (turnUrl) {
    const turnUrls = turnUrl
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
    const turnEntry: IceServerConfig = {
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
    }
    if (turnUsername) turnEntry.username = turnUsername
    if (turnCredential) turnEntry.credential = turnCredential
    servers.push(turnEntry)
  }

  return servers
}

export const callService = {
  async ensureTables(): Promise<void> {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${callLogsTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          CALL_ID VARCHAR(128) NOT NULL,
          CONVERSATION_ID INTEGER NOT NULL,
          CALLER_ID INTEGER NOT NULL,
          RECEIVER_ID INTEGER NOT NULL,
          STATUS VARCHAR(32) NOT NULL,
          STARTED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          CONNECTED_AT TIMESTAMP_NTZ,
          ENDED_AT TIMESTAMP_NTZ,
          DURATION_SECONDS INTEGER DEFAULT 0
        )
      `)
    } catch {
      // Safe no-op if already created
    }
  },

  async validateCallEligibility(callerId: number, receiverId: number, conversationId?: number): Promise<{
    conversationId: number
    caller: Awaited<ReturnType<typeof chatService.getUserInfo>>
    receiver: Awaited<ReturnType<typeof chatService.getUserInfo>>
  }> {
    if (callerId === receiverId) {
      throw new HttpError(400, 'Cannot start a video call with yourself')
    }

    const [caller, receiver] = await Promise.all([
      chatService.getUserInfo(callerId),
      chatService.getUserInfo(receiverId),
    ])

    if (caller.status !== 'ACTIVE') {
      throw new HttpError(403, 'Your account is deactivated')
    }
    if (receiver.status !== 'ACTIVE') {
      throw new HttpError(400, 'Recipient account is deactivated')
    }

    if (!canChat(caller.role, receiver.role)) {
      throw new HttpError(403, 'You are not permitted to call this employee')
    }

    const conv = await chatService.getOrCreateConversation(callerId, caller.role, receiverId)
    if (conversationId && conv.id !== conversationId) {
      throw new HttpError(403, 'Conversation does not match participants')
    }

    return {
      conversationId: conv.id,
      caller,
      receiver,
    }
  },

  async createCallLog(params: {
    callId: string
    conversationId: number
    callerId: number
    receiverId: number
    status: CallLogStatus
  }): Promise<void> {
    await executeQuery(
      `INSERT INTO ${callLogsTable} (CALL_ID, CONVERSATION_ID, CALLER_ID, RECEIVER_ID, STATUS, STARTED_AT, DURATION_SECONDS)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(), 0)`,
      [params.callId, params.conversationId, params.callerId, params.receiverId, params.status]
    )
  },

  async markCallConnected(callId: string): Promise<void> {
    await executeUpdate(
      `UPDATE ${callLogsTable}
       SET STATUS = 'CONNECTED', CONNECTED_AT = CURRENT_TIMESTAMP()
       WHERE CALL_ID = ?`,
      [callId]
    )
  },

  async finalizeCallLogAndCreateChatMessage(params: {
    callId: string
    conversationId: number
    callerId: number
    receiverId: number
    status: 'COMPLETED' | 'REJECTED' | 'MISSED' | 'BUSY'
    durationSeconds: number
  }): Promise<ChatMessageItem> {
    const safeDuration = Math.max(0, Math.floor(params.durationSeconds))

    await executeUpdate(
      `UPDATE ${callLogsTable}
       SET STATUS = ?, ENDED_AT = CURRENT_TIMESTAMP(), DURATION_SECONDS = ?
       WHERE CALL_ID = ?`,
      [params.status, safeDuration, params.callId]
    )

    const body = formatCallDurationMessage(params.status, safeDuration)
    const clientMessageId = `call-${params.callId}`

    // Insert directly into CHAT_MESSAGES so even system statuses work cleanly with idempotency
    const existing = await executeQuery<Record<string, unknown>>(
      `SELECT ID, CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, READ_AT, CLIENT_MESSAGE_ID, IS_DELETED
       FROM ${chatMessagesTable}
       WHERE CONVERSATION_ID = ? AND CLIENT_MESSAGE_ID = ?`,
      [params.conversationId, clientMessageId]
    )

    if (existing[0]) {
      const r = existing[0]
      return {
        id: Number(r.ID),
        conversationId: Number(r.CONVERSATION_ID),
        senderId: Number(r.SENDER_ID),
        body: String(r.BODY || ''),
        createdAt: toIsoString(r.CREATED_AT),
        deliveredAt: toNullableIsoString(r.DELIVERED_AT),
        readAt: toNullableIsoString(r.READ_AT),
        clientMessageId: r.CLIENT_MESSAGE_ID ? String(r.CLIENT_MESSAGE_ID) : null,
        isDeleted: Boolean(r.IS_DELETED),
      }
    }

    await executeQuery(
      `INSERT INTO ${chatMessagesTable} (CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, CLIENT_MESSAGE_ID, IS_DELETED)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), ?, FALSE)`,
      [params.conversationId, params.callerId, body, clientMessageId]
    )

    await executeUpdate(
      `UPDATE ${chatConversationsTable} SET LAST_MESSAGE_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [params.conversationId]
    )

    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, READ_AT, CLIENT_MESSAGE_ID, IS_DELETED
       FROM ${chatMessagesTable}
       WHERE CONVERSATION_ID = ? AND CLIENT_MESSAGE_ID = ?
       ORDER BY ID DESC LIMIT 1`,
      [params.conversationId, clientMessageId]
    )

    const row = rows[0]
    if (!row) {
      return {
        id: Date.now(),
        conversationId: params.conversationId,
        senderId: params.callerId,
        body,
        createdAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        readAt: null,
        clientMessageId,
        isDeleted: false,
      }
    }

    return {
      id: Number(row.ID),
      conversationId: Number(row.CONVERSATION_ID),
      senderId: Number(row.SENDER_ID),
      body: String(row.BODY || ''),
      createdAt: toIsoString(row.CREATED_AT),
      deliveredAt: toNullableIsoString(row.DELIVERED_AT),
      readAt: toNullableIsoString(row.READ_AT),
      clientMessageId: row.CLIENT_MESSAGE_ID ? String(row.CLIENT_MESSAGE_ID) : null,
      isDeleted: Boolean(row.IS_DELETED),
    }
  },

  async getCallLogsForUser(userId: number, limit = 30): Promise<CallLogItem[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100)
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, CALL_ID, CONVERSATION_ID, CALLER_ID, RECEIVER_ID, STATUS, STARTED_AT, CONNECTED_AT, ENDED_AT, DURATION_SECONDS
       FROM ${callLogsTable}
       WHERE CALLER_ID = ? OR RECEIVER_ID = ?
       ORDER BY ID DESC
       LIMIT ?`,
      [userId, userId, safeLimit]
    )

    return rows.map((r) => ({
      id: Number(r.ID),
      callId: String(r.CALL_ID),
      conversationId: Number(r.CONVERSATION_ID),
      callerId: Number(r.CALLER_ID),
      receiverId: Number(r.RECEIVER_ID),
      status: String(r.STATUS) as CallLogStatus,
      startedAt: toIsoString(r.STARTED_AT),
      connectedAt: toNullableIsoString(r.CONNECTED_AT),
      endedAt: toNullableIsoString(r.ENDED_AT),
      durationSeconds: Number(r.DURATION_SECONDS || 0),
    }))
  },
}

