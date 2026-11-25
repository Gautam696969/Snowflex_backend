import crypto from 'node:crypto'
import { AccessToken } from 'livekit-server-sdk'
import { executeQuery, executeUpdate } from '../config/snowflake'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { HttpError } from '../utils/http-error'
import { chatService, type ChatMessageItem } from './chat.service'
import { getIceServersFromEnv } from './call.service'
import { canChat } from '../config/chatPermissions'
import { notificationService } from './notification.service'

const meetingsTable = snowflakeTable('MEETINGS')
const meetingParticipantsTable = snowflakeTable('MEETING_PARTICIPANTS')
const chatConversationsTable = snowflakeTable('CHAT_CONVERSATIONS')
const chatMessagesTable = snowflakeTable('CHAT_MESSAGES')

export type MeetingStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'MISSED'
export type MeetingParticipantRole = 'HOST' | 'PARTICIPANT'

export interface MeetingParticipantRecord {
  userId: number
  fullName: string
  role: MeetingParticipantRole
  joinedAt: string | null
  leftAt: string | null
  isRemoved: boolean
}

export interface MeetingRecord {
  id: number
  meetingCode: string
  title: string
  description: string
  hostId: number
  hostName: string
  chatId: number | null
  invitedUserIds: number[]
  status: MeetingStatus
  allowScreenShare: boolean
  reminderSent: boolean
  scheduledAt: string | null
  startedAt: string | null
  endedAt: string | null
  joinLink: string
  createdAt: string
  activeParticipantCount: number
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

function parseUserIds(raw: unknown): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(String(raw))
    if (Array.isArray(parsed)) {
      return parsed.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    }
  } catch {
    // ignore malformed JSON
  }
  return []
}

export function buildMeetingCardMessageBody(meeting: {
  meetingCode: string
  title: string
  hostId: number
  hostName: string
  status: MeetingStatus
  scheduledAt: string | null
  startedAt: string | null
  participantCount: number
  joinLink: string
}): string {
  return `[MEETING_CARD]${JSON.stringify(meeting)}`
}

export const meetingService = {
  async ensureTables(): Promise<void> {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${meetingsTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          MEETING_CODE VARCHAR(64) NOT NULL,
          TITLE VARCHAR(200) NOT NULL,
          DESCRIPTION VARCHAR(1000),
          HOST_ID INTEGER NOT NULL,
          CHAT_ID INTEGER,
          INVITED_USER_IDS VARCHAR(2000),
          STATUS VARCHAR(32) NOT NULL,
          ALLOW_SCREEN_SHARE BOOLEAN DEFAULT TRUE,
          REMINDER_SENT BOOLEAN DEFAULT FALSE,
          SCHEDULED_AT TIMESTAMP_NTZ,
          STARTED_AT TIMESTAMP_NTZ,
          ENDED_AT TIMESTAMP_NTZ,
          JOIN_LINK VARCHAR(300) NOT NULL,
          CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
        )
      `)
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${meetingParticipantsTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          MEETING_ID INTEGER NOT NULL,
          USER_ID INTEGER NOT NULL,
          ROLE VARCHAR(32) NOT NULL,
          JOINED_AT TIMESTAMP_NTZ,
          LEFT_AT TIMESTAMP_NTZ,
          IS_REMOVED BOOLEAN DEFAULT FALSE
        )
      `)
    } catch {
      // Safe no-op if already created
    }
  },

  async postChatSystemMessage(params: {
    conversationId: number
    senderId: number
    body: string
    clientMessageId: string
  }): Promise<ChatMessageItem> {
    await executeQuery(
      `INSERT INTO ${chatMessagesTable} (CONVERSATION_ID, SENDER_ID, BODY, CREATED_AT, DELIVERED_AT, CLIENT_MESSAGE_ID, IS_DELETED)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), ?, FALSE)`,
      [params.conversationId, params.senderId, params.body, params.clientMessageId]
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
      [params.conversationId, params.clientMessageId]
    )

    const r = rows[0]
    if (!r) {
      return {
        id: Date.now(),
        conversationId: params.conversationId,
        senderId: params.senderId,
        body: params.body,
        createdAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        readAt: null,
        clientMessageId: params.clientMessageId,
        isDeleted: false,
      }
    }

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
  },

  async hydrateMeeting(row: Record<string, unknown>): Promise<MeetingRecord> {
    const meetingId = Number(row.ID)
    const hostId = Number(row.HOST_ID)
    let hostName = 'Host'
    try {
      const hostInfo = await chatService.getUserInfo(hostId)
      hostName = hostInfo.fullName || hostInfo.email
    } catch {
      // keep fallback
    }

    const activeRows = await executeQuery<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT
       FROM ${meetingParticipantsTable}
       WHERE MEETING_ID = ? AND JOINED_AT IS NOT NULL AND LEFT_AT IS NULL AND IS_REMOVED = FALSE`,
      [meetingId]
    )

    return {
      id: meetingId,
      meetingCode: String(row.MEETING_CODE),
      title: String(row.TITLE || 'Team Meeting'),
      description: String(row.DESCRIPTION || ''),
      hostId,
      hostName,
      chatId: row.CHAT_ID ? Number(row.CHAT_ID) : null,
      invitedUserIds: parseUserIds(row.INVITED_USER_IDS),
      status: String(row.STATUS || 'LIVE') as MeetingStatus,
      allowScreenShare: Boolean(row.ALLOW_SCREEN_SHARE ?? true),
      reminderSent: Boolean(row.REMINDER_SENT ?? false),
      scheduledAt: toNullableIsoString(row.SCHEDULED_AT),
      startedAt: toNullableIsoString(row.STARTED_AT),
      endedAt: toNullableIsoString(row.ENDED_AT),
      joinLink: String(row.JOIN_LINK || `/meeting/${String(row.MEETING_CODE)}`),
      createdAt: toIsoString(row.CREATED_AT),
      activeParticipantCount: Number(activeRows[0]?.CNT || 0),
    }
  },

  async createMeeting(input: {
    hostId: number
    title: string
    description?: string
    chatId?: number | null
    invitedUserIds?: number[]
    scheduledAt?: string | null
  }): Promise<{
    meeting: MeetingRecord
    cardMessage: ChatMessageItem | null
    statusMessage: ChatMessageItem | null
    recipientUserIds: number[]
  }> {
    const host = await chatService.getUserInfo(input.hostId)
    if (host.status !== 'ACTIVE') {
      throw new HttpError(403, 'Your account is deactivated')
    }

    const invitedSet = new Set<number>([input.hostId])
    if (Array.isArray(input.invitedUserIds)) {
      for (const uid of input.invitedUserIds) {
        if (Number.isInteger(uid) && uid > 0 && uid !== input.hostId) {
          const target = await chatService.getUserInfo(uid).catch(() => null)
          if (target && target.status === 'ACTIVE' && canChat(host.role, target.role)) {
            invitedSet.add(uid)
          }
        }
      }
    }

    let validChatId: number | null = null
    if (input.chatId) {
      const convRows = await executeQuery<Record<string, unknown>>(
        `SELECT ID, USER_A_ID, USER_B_ID FROM ${chatConversationsTable} WHERE ID = ?`,
        [input.chatId]
      )
      const conv = convRows[0]
      if (!conv) throw new HttpError(404, 'Conversation not found')
      const userA = Number(conv.USER_A_ID)
      const userB = Number(conv.USER_B_ID)
      if (userA !== input.hostId && userB !== input.hostId) {
        throw new HttpError(403, 'You are not a member of this chat')
      }
      validChatId = Number(conv.ID)
      invitedSet.add(userA)
      invitedSet.add(userB)
    }

    const meetingCode = `sf-${crypto.randomBytes(5).toString('hex')}`
    const joinLink = `/meeting/${meetingCode}`
    const isScheduled = Boolean(input.scheduledAt)
    const status: MeetingStatus = isScheduled ? 'SCHEDULED' : 'LIVE'
    const scheduledDate = input.scheduledAt ? new Date(input.scheduledAt) : null
    if (isScheduled && (!scheduledDate || isNaN(scheduledDate.getTime()))) {
      throw new HttpError(400, 'Invalid scheduledAt date/time')
    }

    const invitedList = Array.from(invitedSet)

    await executeQuery(
      `INSERT INTO ${meetingsTable} (
        MEETING_CODE, TITLE, DESCRIPTION, HOST_ID, CHAT_ID, INVITED_USER_IDS,
        STATUS, ALLOW_SCREEN_SHARE, REMINDER_SENT, SCHEDULED_AT, STARTED_AT, JOIN_LINK, CREATED_AT
      ) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, FALSE, ?, ${isScheduled ? 'NULL' : 'CURRENT_TIMESTAMP()'}, ?, CURRENT_TIMESTAMP())`,
      [
        meetingCode,
        input.title.trim().slice(0, 200),
        (input.description || '').trim().slice(0, 1000),
        input.hostId,
        validChatId,
        JSON.stringify(invitedList),
        status,
        scheduledDate,
        joinLink,
      ]
    )

    const createdRows = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingsTable} WHERE MEETING_CODE = ? LIMIT 1`,
      [meetingCode]
    )
    if (!createdRows[0]) {
      throw new HttpError(500, 'Failed to create meeting')
    }

    const meetingId = Number(createdRows[0].ID)

    // Register host in MEETING_PARTICIPANTS
    await executeQuery(
      `INSERT INTO ${meetingParticipantsTable} (MEETING_ID, USER_ID, ROLE, JOINED_AT, IS_REMOVED)
       VALUES (?, ?, 'HOST', ${isScheduled ? 'NULL' : 'CURRENT_TIMESTAMP()'}, FALSE)`,
      [meetingId, input.hostId]
    )

    const meeting = await this.hydrateMeeting(createdRows[0])

    let cardMessage: ChatMessageItem | null = null
    let statusMessage: ChatMessageItem | null = null

    if (validChatId) {
      cardMessage = await this.postChatSystemMessage({
        conversationId: validChatId,
        senderId: input.hostId,
        body: buildMeetingCardMessageBody({
          meetingCode: meeting.meetingCode,
          title: meeting.title,
          hostId: meeting.hostId,
          hostName: meeting.hostName,
          status: meeting.status,
          scheduledAt: meeting.scheduledAt,
          startedAt: meeting.startedAt,
          participantCount: isScheduled ? invitedList.length : Math.max(1, meeting.activeParticipantCount),
          joinLink: meeting.joinLink,
        }),
        clientMessageId: `meet-card-${meeting.meetingCode}`,
      })

      if (!isScheduled) {
        statusMessage = await this.postChatSystemMessage({
          conversationId: validChatId,
          senderId: input.hostId,
          body: `🎥 Meeting started: ${meeting.title}`,
          clientMessageId: `meet-start-${meeting.meetingCode}`,
        })
      }
    }

    const recipientUserIds = invitedList.filter((id) => id !== input.hostId)
    return { meeting, cardMessage, statusMessage, recipientUserIds }
  },

  async assertMeetingAccess(meetingCode: string, userId: number): Promise<{
    row: Record<string, unknown>
    meeting: MeetingRecord
    participantRow: Record<string, unknown> | null
  }> {
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingsTable} WHERE MEETING_CODE = ? LIMIT 1`,
      [meetingCode]
    )
    const row = rows[0]
    if (!row) {
      throw new HttpError(404, 'Meeting not found')
    }

    const meeting = await this.hydrateMeeting(row)
    const user = await chatService.getUserInfo(userId)
    if (user.status !== 'ACTIVE') {
      throw new HttpError(403, 'Your account is deactivated')
    }

    const isInvited = meeting.hostId === userId || meeting.invitedUserIds.includes(userId)
    if (!isInvited) {
      throw new HttpError(403, 'You are not invited to this meeting')
    }

    const partRows = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingParticipantsTable} WHERE MEETING_ID = ? AND USER_ID = ? LIMIT 1`,
      [meeting.id, userId]
    )
    const participantRow = partRows[0] || null

    if (participantRow && Boolean(participantRow.IS_REMOVED)) {
      throw new HttpError(403, 'You were removed from this meeting by the host and cannot rejoin')
    }

    return { row, meeting, participantRow }
  },

  async getMeeting(meetingCode: string, userId: number): Promise<{
    meeting: MeetingRecord
    participants: MeetingParticipantRecord[]
  }> {
    const { meeting } = await this.assertMeetingAccess(meetingCode, userId)
    const participants = await this.getMeetingParticipants(meeting.id)
    return { meeting, participants }
  },

  async getMeetingParticipants(meetingId: number): Promise<MeetingParticipantRecord[]> {
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingParticipantsTable} WHERE MEETING_ID = ? AND IS_REMOVED = FALSE`,
      [meetingId]
    )

    const result: MeetingParticipantRecord[] = []
    for (const r of rows) {
      const uid = Number(r.USER_ID)
      let fullName = `User #${uid}`
      try {
        const u = await chatService.getUserInfo(uid)
        fullName = u.fullName || u.email
      } catch {
        // ignore
      }
      result.push({
        userId: uid,
        fullName,
        role: String(r.ROLE || 'PARTICIPANT') as MeetingParticipantRole,
        joinedAt: toNullableIsoString(r.JOINED_AT),
        leftAt: toNullableIsoString(r.LEFT_AT),
        isRemoved: Boolean(r.IS_REMOVED),
      })
    }
    return result
  },

  async joinMeeting(meetingCode: string, userId: number): Promise<{
    meeting: MeetingRecord
    role: MeetingParticipantRole
    token: string | null
    livekitUrl: string | null
    iceServers: ReturnType<typeof getIceServersFromEnv>
  }> {
    const { row, meeting, participantRow } = await this.assertMeetingAccess(meetingCode, userId)

    if (meeting.status === 'ENDED' || meeting.status === 'MISSED') {
      throw new HttpError(400, 'This meeting has already ended')
    }

    if (meeting.status === 'SCHEDULED') {
      await executeUpdate(
        `UPDATE ${meetingsTable} SET STATUS = 'LIVE', STARTED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
        [meeting.id]
      )
    }

    const assignedRole: MeetingParticipantRole =
      meeting.hostId === userId || String(participantRow?.ROLE || '') === 'HOST' ? 'HOST' : 'PARTICIPANT'

    if (participantRow) {
      await executeUpdate(
        `UPDATE ${meetingParticipantsTable}
         SET JOINED_AT = CURRENT_TIMESTAMP(), LEFT_AT = NULL, ROLE = ?
         WHERE ID = ?`,
        [assignedRole, Number(participantRow.ID)]
      )
    } else {
      await executeQuery(
        `INSERT INTO ${meetingParticipantsTable} (MEETING_ID, USER_ID, ROLE, JOINED_AT, IS_REMOVED)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP(), FALSE)`,
        [meeting.id, userId, assignedRole]
      )
    }

    const user = await chatService.getUserInfo(userId)

    // Generate short-lived LiveKit JWT token on the backend (API secret never exposed to client)
    let token: string | null = null
    const livekitUrl = (process.env.LIVEKIT_URL || '').trim() || null
    const apiKey = (process.env.LIVEKIT_API_KEY || '').trim()
    const apiSecret = (process.env.LIVEKIT_API_SECRET || '').trim()

    if (livekitUrl && apiKey && apiSecret) {
      const at = new AccessToken(apiKey, apiSecret, {
        identity: `user-${userId}`,
        name: user.fullName || user.email,
        ttl: '2h',
        metadata: JSON.stringify({ userId, role: assignedRole }),
      })
      at.addGrant({
        roomJoin: true,
        room: meeting.meetingCode,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        roomAdmin: assignedRole === 'HOST',
      })
      token = await at.toJwt()
    }

    const refreshedRows = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingsTable} WHERE ID = ? LIMIT 1`,
      [meeting.id]
    )
    const updatedMeeting = await this.hydrateMeeting(refreshedRows[0] || row)

    return {
      meeting: updatedMeeting,
      role: assignedRole,
      token,
      livekitUrl,
      iceServers: getIceServersFromEnv(),
    }
  },

  async leaveMeeting(meetingCode: string, userId: number): Promise<{
    meeting: MeetingRecord
    transferredHostToUserId: number | null
  }> {
    const { meeting, participantRow } = await this.assertMeetingAccess(meetingCode, userId)

    if (participantRow) {
      await executeUpdate(
        `UPDATE ${meetingParticipantsTable} SET LEFT_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
        [Number(participantRow.ID)]
      )
    }

    let transferredHostToUserId: number | null = null
    if (meeting.hostId === userId && meeting.status === 'LIVE') {
      const remaining = await executeQuery<Record<string, unknown>>(
        `SELECT * FROM ${meetingParticipantsTable}
         WHERE MEETING_ID = ? AND USER_ID <> ? AND JOINED_AT IS NOT NULL AND LEFT_AT IS NULL AND IS_REMOVED = FALSE
         ORDER BY JOINED_AT ASC LIMIT 1`,
        [meeting.id, userId]
      )
      if (remaining[0]) {
        const nextHostId = Number(remaining[0].USER_ID)
        transferredHostToUserId = nextHostId
        await executeUpdate(`UPDATE ${meetingsTable} SET HOST_ID = ? WHERE ID = ?`, [nextHostId, meeting.id])
        await executeUpdate(`UPDATE ${meetingParticipantsTable} SET ROLE = 'HOST' WHERE ID = ?`, [
          Number(remaining[0].ID),
        ])
      }
    }

    const refreshed = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingsTable} WHERE ID = ? LIMIT 1`,
      [meeting.id]
    )
    return {
      meeting: await this.hydrateMeeting(refreshed[0]),
      transferredHostToUserId,
    }
  },

  async removeParticipant(meetingCode: string, hostUserId: number, targetUserId: number): Promise<void> {
    const { meeting } = await this.assertMeetingAccess(meetingCode, hostUserId)
    if (meeting.hostId !== hostUserId) {
      throw new HttpError(403, 'Only the meeting host can remove participants')
    }
    if (targetUserId === hostUserId) {
      throw new HttpError(400, 'Host cannot remove themselves')
    }

    const existing = await executeQuery<Record<string, unknown>>(
      `SELECT ID FROM ${meetingParticipantsTable} WHERE MEETING_ID = ? AND USER_ID = ? LIMIT 1`,
      [meeting.id, targetUserId]
    )
    if (existing[0]) {
      await executeUpdate(
        `UPDATE ${meetingParticipantsTable}
         SET IS_REMOVED = TRUE, LEFT_AT = CURRENT_TIMESTAMP()
         WHERE ID = ?`,
        [Number(existing[0].ID)]
      )
    } else {
      await executeQuery(
        `INSERT INTO ${meetingParticipantsTable} (MEETING_ID, USER_ID, ROLE, LEFT_AT, IS_REMOVED)
         VALUES (?, ?, 'PARTICIPANT', CURRENT_TIMESTAMP(), TRUE)`,
        [meeting.id, targetUserId]
      )
    }
  },

  async setScreenSharePolicy(meetingCode: string, hostUserId: number, allowScreenShare: boolean): Promise<void> {
    const { meeting } = await this.assertMeetingAccess(meetingCode, hostUserId)
    if (meeting.hostId !== hostUserId) {
      throw new HttpError(403, 'Only the meeting host can change screen share permissions')
    }
    await executeUpdate(`UPDATE ${meetingsTable} SET ALLOW_SCREEN_SHARE = ? WHERE ID = ?`, [
      allowScreenShare,
      meeting.id,
    ])
  },

  async endMeeting(meetingCode: string, requesterId: number): Promise<{
    meeting: MeetingRecord
    durationMinutes: number
    endedMessage: ChatMessageItem | null
  }> {
    const { meeting } = await this.assertMeetingAccess(meetingCode, requesterId)
    if (meeting.hostId !== requesterId) {
      throw new HttpError(403, 'Only the meeting host can end the meeting for all participants')
    }

    if (meeting.status === 'ENDED') {
      return { meeting, durationMinutes: 0, endedMessage: null }
    }

    await executeUpdate(
      `UPDATE ${meetingsTable} SET STATUS = 'ENDED', ENDED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [meeting.id]
    )
    await executeUpdate(
      `UPDATE ${meetingParticipantsTable} SET LEFT_AT = CURRENT_TIMESTAMP() WHERE MEETING_ID = ? AND LEFT_AT IS NULL`,
      [meeting.id]
    )

    const startMs = meeting.startedAt ? new Date(meeting.startedAt).getTime() : Date.now()
    const durationMinutes = Math.max(1, Math.round((Date.now() - startMs) / 60_000))

    let endedMessage: ChatMessageItem | null = null
    if (meeting.chatId) {
      endedMessage = await this.postChatSystemMessage({
        conversationId: meeting.chatId,
        senderId: requesterId,
        body: `🎥 Meeting ended - duration ${durationMinutes} min`,
        clientMessageId: `meet-end-${meeting.meetingCode}`,
      })
    }

    const refreshed = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingsTable} WHERE ID = ? LIMIT 1`,
      [meeting.id]
    )
    return {
      meeting: await this.hydrateMeeting(refreshed[0]),
      durationMinutes,
      endedMessage,
    }
  },

  async listMeetingsForUser(
    userId: number,
    filter: 'upcoming' | 'past' | 'all' = 'all'
  ): Promise<MeetingRecord[]> {
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingsTable} ORDER BY ID DESC LIMIT 100`
    )

    const list: MeetingRecord[] = []
    for (const row of rows) {
      const hostId = Number(row.HOST_ID)
      const invited = parseUserIds(row.INVITED_USER_IDS)
      if (hostId !== userId && !invited.includes(userId)) continue

      const status = String(row.STATUS || 'LIVE') as MeetingStatus
      if (filter === 'upcoming' && status !== 'SCHEDULED' && status !== 'LIVE') continue
      if (filter === 'past' && status !== 'ENDED' && status !== 'MISSED') continue

      list.push(await this.hydrateMeeting(row))
    }
    return list
  },

  async processScheduledRemindersAndMissed(
    onReminder?: (meeting: MeetingRecord, recipientIds: number[]) => void,
    onMissed?: (meeting: MeetingRecord, message: ChatMessageItem) => void
  ): Promise<void> {
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT * FROM ${meetingsTable} WHERE STATUS = 'SCHEDULED'`
    )

    const now = Date.now()
    const tenMinMs = 10 * 60 * 1000
    const thirtyMinMs = 30 * 60 * 1000

    for (const row of rows) {
      const scheduledAtStr = row.SCHEDULED_AT ? String(row.SCHEDULED_AT) : null
      if (!scheduledAtStr) continue
      const scheduledMs = new Date(scheduledAtStr).getTime()
      if (isNaN(scheduledMs)) continue

      const meeting = await this.hydrateMeeting(row)

      // 1. Send 10-minute reminder notification
      if (!meeting.reminderSent && scheduledMs - now <= tenMinMs && scheduledMs - now >= -5 * 60 * 1000) {
        await executeUpdate(`UPDATE ${meetingsTable} SET REMINDER_SENT = TRUE WHERE ID = ?`, [meeting.id])
        const recipients = Array.from(new Set([meeting.hostId, ...meeting.invitedUserIds]))
        for (const uid of recipients) {
          await notificationService
            .createNotification({
              userId: uid,
              type: 'MEETING_REMINDER',
              title: `Meeting starting soon: ${meeting.title}`,
              message: `Your scheduled meeting with ${meeting.hostName} starts in ~10 minutes.`,
              link: meeting.joinLink,
              relatedId: meeting.id,
            })
            .catch(() => {})
        }
        onReminder?.(meeting, recipients)
      }

      // 2. Mark missed if 30 minutes past scheduledAt and never started
      if (now - scheduledMs > thirtyMinMs) {
        await executeUpdate(
          `UPDATE ${meetingsTable} SET STATUS = 'MISSED', ENDED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
          [meeting.id]
        )
        if (meeting.chatId) {
          const msg = await this.postChatSystemMessage({
            conversationId: meeting.chatId,
            senderId: meeting.hostId,
            body: `🎥 Missed meeting: ${meeting.title}`,
            clientMessageId: `meet-missed-${meeting.meetingCode}`,
          })
          onMissed?.(meeting, msg)
        }
      }
    }
  },
}

