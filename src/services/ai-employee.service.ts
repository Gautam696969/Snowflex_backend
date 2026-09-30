import { randomUUID } from 'node:crypto'
import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { aiClient, AiChatMessage } from '../config/ai'
import { logger } from '../utils/logger'

const conversationsTable = snowflakeTable('AI_CONVERSATIONS')
const messagesTable = snowflakeTable('AI_MESSAGES')

export interface AiConversation {
  id: number
  userId: number
  title: string
  createdAt: string
  updatedAt: string
}

export interface AiMessage {
  id: number
  conversationId: number
  role: 'user' | 'assistant'
  content: string
  model?: string
  createdAt: string
}

export interface AiChatResponse {
  conversation: AiConversation
  message: AiMessage
}

function toApiConversation(row: Record<string, unknown>): AiConversation {
  return {
    id: Number(row.ID),
    userId: Number(row.USER_ID),
    title: String(row.TITLE ?? 'New conversation'),
    createdAt: String(row.CREATED_AT),
    updatedAt: String(row.UPDATED_AT),
  }
}

function toApiMessage(row: Record<string, unknown>): AiMessage {
  return {
    id: Number(row.ID),
    conversationId: Number(row.CONVERSATION_ID),
    role: String(row.ROLE).toLowerCase() as 'user' | 'assistant',
    content: String(row.CONTENT),
    model: row.MODEL ? String(row.MODEL) : undefined,
    createdAt: String(row.CREATED_AT),
  }
}

function buildSystemPrompt(userId: number, role: string): string {
  return [
    'You are the Snowflex AI Employee — an intelligent assistant for the Snowflex People Operations platform.',
    `The current user has ID ${userId} and role ${role}.`,
    'Help with HR tasks such as summarizing leave balances, attendance trends, team rosters, and drafting leave requests or announcements.',
    'Keep responses concise, professional, and grounded in the Snowflex workspace context.',
  ].join(' ')
}

export const aiEmployeeService = {
  async listConversations(userId: number): Promise<AiConversation[]> {
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_ID, TITLE, CREATED_AT, UPDATED_AT FROM ${conversationsTable} WHERE USER_ID = ? ORDER BY UPDATED_AT DESC`,
      [userId],
    )
    return rows.map(toApiConversation)
  },

  async createConversation(userId: number, title?: string): Promise<AiConversation> {
    const finalTitle = title?.trim() || 'New conversation'
    const id = parseInt(randomUUID().replace(/-/g, '').slice(0, 13), 16)
    await executeInsert(
      `INSERT INTO ${conversationsTable} (ID, USER_ID, TITLE) VALUES (?, ?, ?)`,
      [id, userId, finalTitle],
    )
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_ID, TITLE, CREATED_AT, UPDATED_AT FROM ${conversationsTable} WHERE ID = ?`,
      [id],
    )
    if (!rows[0]) throw new HttpError(500, 'Failed to create conversation')
    return toApiConversation(rows[0])
  },

  async listMessages(conversationId: number, userId: number): Promise<AiMessage[]> {
    const owner = await executeQuery<Record<string, unknown>>(
      `SELECT ID FROM ${conversationsTable} WHERE ID = ? AND USER_ID = ?`,
      [conversationId, userId],
    )
    if (!owner[0]) throw new HttpError(404, 'Conversation not found')

    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, CONVERSATION_ID, ROLE, CONTENT, MODEL, CREATED_AT FROM ${messagesTable} WHERE CONVERSATION_ID = ? ORDER BY CREATED_AT ASC`,
      [conversationId],
    )
    return rows.map(toApiMessage)
  },

  async chat(userId: number, role: string, payload: { conversationId?: number; message: string }): Promise<AiChatResponse> {
    const userMessage = payload.message.trim()
    if (!userMessage) throw new HttpError(422, 'Message is required')

    let conversationId = payload.conversationId
    if (!conversationId) {
      const created = await this.createConversation(userId, userMessage.slice(0, 60))
      conversationId = created.id
    } else {
      const owner = await executeQuery<Record<string, unknown>>(
        `SELECT ID FROM ${conversationsTable} WHERE ID = ? AND USER_ID = ?`,
        [conversationId, userId],
      )
      if (!owner[0]) throw new HttpError(404, 'Conversation not found')
    }

    logger.info(`AI chat: user=${userId} conversation=${conversationId} message="${userMessage.slice(0, 80)}"`)

    await executeInsert(
      `INSERT INTO ${messagesTable} (CONVERSATION_ID, ROLE, CONTENT) VALUES (?, 'USER', ?)`,
      [conversationId, userMessage],
    )

    const historyRows = await executeQuery<Record<string, unknown>>(
      `SELECT ROLE, CONTENT FROM ${messagesTable} WHERE CONVERSATION_ID = ? ORDER BY CREATED_AT ASC`,
      [conversationId],
    )
    const history: AiChatMessage[] = historyRows.map((row) => ({
      role: String(row.ROLE).toLowerCase() as 'user' | 'assistant',
      content: String(row.CONTENT),
    }))

    const messages: AiChatMessage[] = [{ role: 'system', content: buildSystemPrompt(userId, role) }, ...history]

    let result
    try {
      result = await aiClient.chat(messages)
    } catch (aiError) {
      logger.error('AI provider call failed', { error: aiError instanceof Error ? aiError.message : String(aiError) })
      throw new HttpError(502, 'AI provider is unavailable. Please try again later.')
    }

    await executeInsert(
      `INSERT INTO ${messagesTable} (CONVERSATION_ID, ROLE, CONTENT, MODEL) VALUES (?, 'ASSISTANT', ?, ?)`,
      [conversationId, result.reply, result.model],
    )

    await executeUpdate(
      `UPDATE ${conversationsTable} SET UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [conversationId],
    )

    const messageRows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, CONVERSATION_ID, ROLE, CONTENT, MODEL, CREATED_AT FROM ${messagesTable} WHERE CONVERSATION_ID = ? ORDER BY CREATED_AT DESC LIMIT 1`,
      [conversationId],
    )
    if (!messageRows[0]) {
      logger.error('AI response message not found after insert', { conversationId })
      throw new HttpError(500, 'Failed to store AI response')
    }

    const convRows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, USER_ID, TITLE, CREATED_AT, UPDATED_AT FROM ${conversationsTable} WHERE ID = ?`,
      [conversationId],
    )
    if (!convRows[0]) {
      logger.error('Conversation not found after chat', { conversationId })
      throw new HttpError(500, 'Failed to load conversation')
    }

    return {
      conversation: toApiConversation(convRows[0]),
      message: toApiMessage(messageRows[0]),
    }
  },

  async deleteConversation(conversationId: number, userId: number): Promise<void> {
    const owner = await executeQuery<Record<string, unknown>>(
      `SELECT ID FROM ${conversationsTable} WHERE ID = ? AND USER_ID = ?`,
      [conversationId, userId],
    )
    if (!owner[0]) throw new HttpError(404, 'Conversation not found')
    await executeUpdate(`DELETE FROM ${messagesTable} WHERE CONVERSATION_ID = ?`, [conversationId])
    await executeUpdate(`DELETE FROM ${conversationsTable} WHERE ID = ?`, [conversationId])
  },
}