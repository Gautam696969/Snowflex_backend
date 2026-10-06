import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeQueryMock, executeInsertMock, executeUpdateMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  executeInsertMock: vi.fn(),
  executeUpdateMock: vi.fn(),
}))

vi.mock('../src/config/snowflake', () => ({
  executeQuery: executeQueryMock,
  executeInsert: executeInsertMock,
  executeUpdate: executeUpdateMock,
  withTransaction: vi.fn().mockImplementation(async (cb: any) => cb()),
}))

import { confirmationService } from '../src/agent/confirmation.service'
import { toolRegistry } from '../src/agent/tool-registry'
import { resolveDateString } from '../src/agent/date-parser'
import { AgentContext } from '../src/agent/types'

const dummyContext: AgentContext = {
  userId: 10,
  role: 'EMPLOYEE',
  fullName: 'Alex Employee',
  employeeCode: 'EMP-000010',
  requestId: 'test-req-123',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Agent Date Parser', () => {
  it('resolves relative dates correctly based on reference date', () => {
    const reference = '2026-10-06' // Tuesday
    expect(resolveDateString('today', reference)).toBe('2026-10-06')
    expect(resolveDateString('tomorrow', reference)).toBe('2026-10-07')
    expect(resolveDateString('kal', reference)).toBe('2026-10-07')
    expect(resolveDateString('parso', reference)).toBe('2026-10-08')
    expect(resolveDateString('day after tomorrow', reference)).toBe('2026-10-08')
    expect(resolveDateString('2026-10-15', reference)).toBe('2026-10-15')
  })
})

describe('Agent Confirmation Service', () => {
  it('generates a valid signed confirmation token and verifies/consumes it', () => {
    const confirmation = confirmationService.createToken({
      userId: 10,
      leaveTypeId: 1,
      leaveTypeName: 'Casual Leave',
      leaveTypeCode: 'CL',
      isPaid: true,
      startDate: '2026-10-07',
      endDate: '2026-10-07',
      daysCount: 1,
      reason: 'Family function',
      balanceBefore: 10,
      balanceAfter: 9,
      isUnlimited: false,
    })

    expect(confirmation.token).toBeDefined()
    expect(typeof confirmation.token).toBe('string')

    // First consumption succeeds
    const payload = confirmationService.verifyAndConsumeToken(confirmation.token, 10)
    expect(payload.userId).toBe(10)
    expect(payload.leaveTypeName).toBe('Casual Leave')

    // Replay attack: second consumption with the same token MUST be rejected
    expect(() => {
      confirmationService.verifyAndConsumeToken(confirmation.token, 10)
    }).toThrow(/already been used/i)
  })

  it('rejects confirmation token when user ID does not match authenticated user', () => {
    const confirmation = confirmationService.createToken({
      userId: 10,
      leaveTypeId: 1,
      leaveTypeName: 'Casual Leave',
      leaveTypeCode: 'CL',
      isPaid: true,
      startDate: '2026-10-07',
      endDate: '2026-10-07',
      daysCount: 1,
      reason: 'Family function',
      balanceBefore: 10,
      balanceAfter: 9,
      isUnlimited: false,
    })

    // Attacker tries to consume user 10's token with user 99
    expect(() => {
      confirmationService.verifyAndConsumeToken(confirmation.token, 99)
    }).toThrow(/does not belong to the current authenticated user/i)
  })

  it('rejects tampered confirmation token', () => {
    const confirmation = confirmationService.createToken({
      userId: 10,
      leaveTypeId: 1,
      leaveTypeName: 'Casual Leave',
      leaveTypeCode: 'CL',
      isPaid: true,
      startDate: '2026-10-07',
      endDate: '2026-10-07',
      daysCount: 1,
      reason: 'Family function',
      balanceBefore: 10,
      balanceAfter: 9,
      isUnlimited: false,
    })

    const tampered = confirmation.token.slice(0, -4) + 'abcd'
    expect(() => {
      confirmationService.verifyAndConsumeToken(tampered, 10)
    }).toThrow(/signature/i)
  })
})

describe('Agent Security & Prompt Injection Protection', () => {
  it('strictly rejects any tool call attempting to inject user_id or employee_id', async () => {
    const maliciousArgs = {
      leave_type: 'CL',
      start_date: '2026-10-07',
      end_date: '2026-10-07',
      reason: 'Bypass attempt',
      user_id: 999, // Injection attempt!
    }

    const execution = await toolRegistry.execute('check_leave_request', maliciousArgs, dummyContext)
    expect(execution.success).toBe(false)
    expect(execution.error).toContain('Access Denied')
  })

  it('strictly rejects tool call attempting to inject employee_id', async () => {
    const maliciousArgs = {
      leave_type: 'CL',
      start_date: '2026-10-07',
      end_date: '2026-10-07',
      reason: 'Bypass attempt',
      employee_id: 5, // Injection attempt!
    }

    const execution = await toolRegistry.execute('check_leave_request', maliciousArgs, dummyContext)
    expect(execution.success).toBe(false)
    expect(execution.error).toContain('Access Denied')
  })
})

describe('Agent Leave Tools: check_leave_request (DRY RUN)', () => {
  it('validates a valid leave request and returns confirmation without DB write', async () => {
    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM LEAVE_TYPES')) {
        return [{
          ID: 1,
          NAME: 'Casual Leave',
          CODE: 'CL',
          IS_PAID: true,
          YEARLY_QUOTA: 12,
          REQUIRES_DOCUMENT: false,
          IS_ACTIVE: true,
        }]
      }
      if (sql.includes('FROM EMPLOYEES WHERE USER_ID = ?')) {
        return [{ ID: 101, USER_ID: 10 }]
      }
      if (sql.includes('FROM LEAVE_BALANCES')) {
        return [{
          ID: 1,
          EMPLOYEE_ID: 101,
          LEAVE_TYPE_ID: 1,
          YEAR: 2026,
          TOTAL: 12,
          USED: 2,
          PENDING: 0,
          NAME: 'Casual Leave',
          CODE: 'CL',
          IS_PAID: true,
          YEARLY_QUOTA: 12,
        }]
      }
      if (sql.includes('FROM LEAVE_REQUESTS')) {
        return [] // No overlap
      }
      return []
    })

    const result = await toolRegistry.execute('check_leave_request', {
      leave_type: 'Casual Leave',
      start_date: '2026-10-07', // Wednesday
      end_date: '2026-10-07',
      reason: 'Family function',
    }, dummyContext)

    expect(result.success).toBe(true)
    const out = result.output as any
    expect(out.valid).toBe(true)
    expect(out.confirmationRequired).toBe(true)
    expect(out.confirmationToken).toBeDefined()
    expect(out.summary.daysCount).toBe(1)
    expect(out.summary.balanceBefore).toBe(10)
    expect(out.summary.balanceAfter).toBe(9)

    // Verify zero database inserts/updates occurred during check_leave_request
    expect(executeUpdateMock).not.toHaveBeenCalled()
  })

  it('blocks leave request when balance is insufficient and suggests LWP', async () => {
    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM LEAVE_TYPES')) {
        return [{
          ID: 1,
          NAME: 'Casual Leave',
          CODE: 'CL',
          IS_PAID: true,
          YEARLY_QUOTA: 12,
          REQUIRES_DOCUMENT: false,
          IS_ACTIVE: true,
        }]
      }
      if (sql.includes('FROM EMPLOYEES WHERE USER_ID = ?')) {
        return [{ ID: 101, USER_ID: 10 }]
      }
      if (sql.includes('FROM LEAVE_BALANCES')) {
        return [{
          ID: 1,
          EMPLOYEE_ID: 101,
          LEAVE_TYPE_ID: 1,
          YEAR: 2026,
          TOTAL: 12,
          USED: 12, // All 12 days used, 0 remaining
          PENDING: 0,
          NAME: 'Casual Leave',
          CODE: 'CL',
          IS_PAID: true,
          YEARLY_QUOTA: 12,
        }]
      }
      return []
    })

    const result = await toolRegistry.execute('check_leave_request', {
      leave_type: 'CL',
      start_date: '2026-10-07',
      end_date: '2026-10-07',
      reason: 'Personal work',
    }, dummyContext)

    expect(result.success).toBe(true)
    const out = result.output as any
    expect(out.valid).toBe(false)
    expect(out.error).toContain('Insufficient leave balance')
    expect(out.error).toContain('Leave Without Pay (LWP)')
    expect(out.suggestLwp).toBe(true)
  })

  it('blocks leave request when dates overlap with existing leaves', async () => {
    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM LEAVE_TYPES')) {
        return [{
          ID: 1,
          NAME: 'Casual Leave',
          CODE: 'CL',
          IS_PAID: true,
          YEARLY_QUOTA: 12,
          REQUIRES_DOCUMENT: false,
          IS_ACTIVE: true,
        }]
      }
      if (sql.includes('FROM EMPLOYEES WHERE USER_ID = ?')) {
        return [{ ID: 101, USER_ID: 10 }]
      }
      if (sql.includes('FROM LEAVE_REQUESTS')) {
        // Existing overlapping leave!
        return [{ ID: 55, START_DATE: '2026-10-07', END_DATE: '2026-10-08', STATUS: 'APPROVED' }]
      }
      return []
    })

    const result = await toolRegistry.execute('check_leave_request', {
      leave_type: 'CL',
      start_date: '2026-10-07',
      end_date: '2026-10-07',
      reason: 'Doctor appointment',
    }, dummyContext)

    expect(result.success).toBe(true)
    const out = result.output as any
    expect(out.valid).toBe(false)
    expect(out.error).toContain('already have a pending or approved leave request')
  })
})

describe('Agent Leave Tools: apply_leave (Server Confirmation Guard)', () => {
  it('refuses to execute apply_leave without a valid confirmation_token', async () => {
    const result = await toolRegistry.execute('apply_leave', {
      confirmation_token: '',
    }, dummyContext)

    expect(result.success).toBe(false)
  })

  it('submits leave request and reserves balance when valid confirmation token is provided', async () => {
    // Generate valid confirmation token
    const confirmation = confirmationService.createToken({
      userId: 10,
      leaveTypeId: 1,
      leaveTypeName: 'Casual Leave',
      leaveTypeCode: 'CL',
      isPaid: true,
      startDate: '2026-10-07',
      endDate: '2026-10-07',
      daysCount: 1,
      reason: 'Family function',
      balanceBefore: 10,
      balanceAfter: 9,
      isUnlimited: false,
    })

    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM EMPLOYEES WHERE USER_ID = ?')) {
        return [{ ID: 101, USER_ID: 10 }]
      }
      if (sql.includes('FROM LEAVE_TYPES')) {
        return [{ ID: 1, NAME: 'Casual Leave', CODE: 'CL', IS_PAID: true, YEARLY_QUOTA: 12, IS_ACTIVE: true }]
      }
      if (sql.includes('FROM LEAVE_BALANCES')) {
        return [{ ID: 1, EMPLOYEE_ID: 101, LEAVE_TYPE_ID: 1, YEAR: 2026, TOTAL: 12, USED: 2, PENDING: 0, YEARLY_QUOTA: 12, IS_PAID: true }]
      }
      if (sql.includes('FROM LEAVE_REQUESTS WHERE EMPLOYEE_ID = ? AND STATUS IN')) {
        return [] // No overlap
      }
      if (sql.includes('SELECT ID FROM LEAVE_REQUESTS WHERE EMPLOYEE_ID = ? ORDER BY CREATED_AT DESC')) {
        return [{ ID: 999 }]
      }
      if (sql.includes('FROM USERS WHERE ID = ?')) {
        return [{ FULL_NAME: 'Alex Employee' }]
      }
      return []
    })
    executeInsertMock.mockResolvedValue(undefined)
    executeUpdateMock.mockResolvedValue(1)

    const result = await toolRegistry.execute('apply_leave', {
      confirmation_token: confirmation.token,
    }, dummyContext)

    expect(result.success).toBe(true)
    const out = result.output as any
    expect(out.success).toBe(true)
    expect(out.leaveRequestId).toBe(999)
    expect(out.status).toBe('PENDING')

    // Confirm that LEAVE_REQUESTS insert was called
    const insertCall = executeInsertMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO LEAVE_REQUESTS'))
    expect(insertCall).toBeDefined()
  })
})
