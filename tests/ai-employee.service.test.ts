import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeQueryMock, executeInsertMock, executeUpdateMock, aiChatMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  executeInsertMock: vi.fn(),
  executeUpdateMock: vi.fn(),
  aiChatMock: vi.fn(),
}))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: executeQueryMock,
  executeInsert: executeInsertMock,
  executeUpdate: executeUpdateMock,
}))

vi.mock('../src/config/ai', () => ({ aiClient: { chat: aiChatMock } }))

vi.mock('../src/agent/agent-loop', () => ({
  runAgentLoop: vi.fn().mockImplementation(async (message: string, history: any[]) => {
    const aiResult = await aiChatMock([...history, { role: 'user', content: message }])
    return {
      reply: aiResult.reply,
      model: aiResult.model,
      toolCallsExecuted: 0,
      confirmation: null,
    }
  }),
}))

import { aiEmployeeService } from '../src/services/ai-employee.service'

let leaveRows: Record<string, unknown>[]

beforeEach(() => {
  vi.clearAllMocks()
  leaveRows = [{
    FULL_NAME: 'Morgan Rivera',
    LEAVE_TYPE: 'Annual leave',
    START_DATE: '2026-10-02',
    END_DATE: '2026-10-05',
  }]
  executeQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT ID FROM') && sql.includes('USER_ID = ?')) return [{ ID: 91 }]
    if (sql.includes('SELECT ROLE, CONTENT')) return [{ ROLE: 'USER', CONTENT: 'Who is on leave today?' }]
    if (sql.includes('FROM "AUTH_PROJECT"."PUBLIC"."LEAVE_REQUESTS" L')) return leaveRows
    if (sql.includes('ORDER BY CREATED_AT DESC LIMIT 1')) return [{
      ID: 501,
      CONVERSATION_ID: 91,
      ROLE: 'ASSISTANT',
      CONTENT: 'Captured answer',
      MODEL: 'SNOWFLAKE_LIVE_DATA',
      CREATED_AT: '2026-10-03T09:00:00.000Z',
    }]
    if (sql.includes('SELECT ID, USER_ID, TITLE')) return [{
      ID: 91,
      USER_ID: 12,
      TITLE: 'Leave today',
      CREATED_AT: '2026-10-03T08:00:00.000Z',
      UPDATED_AT: '2026-10-03T09:00:00.000Z',
    }]
    return []
  })
  executeInsertMock.mockResolvedValue(undefined)
  executeUpdateMock.mockResolvedValue(undefined)
  aiChatMock.mockResolvedValue({ reply: 'model reply', model: 'test-model' })
})

describe('AI answers for who is on leave today', () => {
  const payload = { conversationId: 91, message: 'Who is on leave today?' }

  it('returns approved leave records for admins without calling the model', async () => {
    await aiEmployeeService.chat(12, 'ADMIN', payload)

    const leaveQueryCall = executeQueryMock.mock.calls.find(([sql]) => String(sql).includes('LEAVE_REQUESTS'))
    expect(leaveQueryCall?.[0]).toContain("L.STATUS = 'APPROVED'")
    expect(leaveQueryCall?.[0]).toContain('L.START_DATE <= CURRENT_DATE()')
    expect(leaveQueryCall?.[0]).toContain('L.END_DATE >= CURRENT_DATE()')
    expect(leaveQueryCall?.[1]).toEqual([])
    expect(executeInsertMock.mock.calls[1][1][1]).toContain('Morgan Rivera — Annual leave (2026-10-02 to 2026-10-05)')
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('limits manager results to direct reports', async () => {
    await aiEmployeeService.chat(12, 'MANAGER', payload)

    const leaveQueryCall = executeQueryMock.mock.calls.find(([sql]) => String(sql).includes('LEAVE_REQUESTS'))
    expect(leaveQueryCall?.[0]).toContain('E.MANAGER_ID IN (SELECT ID FROM')
    expect(leaveQueryCall?.[1]).toEqual([12])
    expect(executeInsertMock.mock.calls[1][1][1]).toContain('your direct reports')
  })

  it('limits employee results to their own approved leave', async () => {
    leaveRows = []
    await aiEmployeeService.chat(12, 'EMPLOYEE', payload)

    const leaveQueryCall = executeQueryMock.mock.calls.find(([sql]) => String(sql).includes('LEAVE_REQUESTS'))
    expect(leaveQueryCall?.[0]).toContain('E.USER_ID = ?')
    expect(leaveQueryCall?.[1]).toEqual([12])
    expect(executeInsertMock.mock.calls[1][1][1]).toBe('You do not have an approved leave request covering today.')
  })

  it('continues to use the model for other questions', async () => {
    await aiEmployeeService.chat(12, 'ADMIN', { ...payload, message: 'Summarise my open tasks' })

    expect(aiChatMock).toHaveBeenCalledOnce()
    expect(executeQueryMock.mock.calls.some(([sql]) => String(sql).includes('LEAVE_REQUESTS'))).toBe(false)
  })
})

describe('stateless widget chat', () => {
  it('answers without creating or updating an AI Employee conversation', async () => {
    const result = await aiEmployeeService.widgetChat(12, 'ADMIN', {
      source: 'widget',
      message: 'Summarise this',
      history: [{ role: 'user', content: 'Earlier widget question' }],
    })

    expect(result.message).toMatchObject({ role: 'assistant', content: 'model reply', model: 'test-model' })
    expect(aiChatMock).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Earlier widget question' }),
      expect.objectContaining({ role: 'user', content: 'Summarise this' }),
    ]))
    expect(executeInsertMock).not.toHaveBeenCalled()
    expect(executeUpdateMock).not.toHaveBeenCalled()
    const conversationQueries = executeQueryMock.mock.calls.filter(([sql]) => String(sql).includes('AI_CONVERSATIONS'))
    expect(conversationQueries).toHaveLength(0)
  })

  it('keeps the live leave-data response available without persistence', async () => {
    const result = await aiEmployeeService.widgetChat(12, 'ADMIN', {
      source: 'widget',
      message: 'Who is on leave today?',
    })

    expect(result.message.content).toContain('Morgan Rivera — Annual leave')
    expect(executeInsertMock).not.toHaveBeenCalled()
    expect(executeUpdateMock).not.toHaveBeenCalled()
  })
})