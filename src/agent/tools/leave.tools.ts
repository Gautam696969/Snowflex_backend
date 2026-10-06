import { z } from 'zod'
import { defineTool } from '../types'
import { leaveTypeService } from '../../services/leave-type.service'
import { leaveBalanceService } from '../../services/leave-balance.service'
import { calculateWorkingDays, leaveService } from '../../services/leave.service'
import { confirmationService } from '../confirmation.service'
import { resolveDateString, formatDateNice } from '../date-parser'
import { executeQuery } from '../../config/snowflake'
import { DbRow } from '../../utils/rows'
import { HttpError } from '../../utils/http-error'

// Helper to fuzzy match leave type by code or name
async function matchLeaveType(query: string) {
  const activeTypes = await leaveTypeService.list(true)
  const q = query.trim().toLowerCase()

  // 1. Exact match on code
  const exactCode = activeTypes.find((t) => t.code.toLowerCase() === q)
  if (exactCode) return { matched: exactCode, activeTypes }

  // 2. Exact match on name
  const exactName = activeTypes.find((t) => t.name.toLowerCase() === q)
  if (exactName) return { matched: exactName, activeTypes }

  // 3. Name or Code contains keyword
  const containsMatch = activeTypes.find((t) =>
    t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q),
  )
  if (containsMatch) return { matched: containsMatch, activeTypes }

  // 4. Special aliases
  if (q.includes('casual') || q === 'cl') {
    const cl = activeTypes.find((t) => t.code === 'CL' || t.name.toLowerCase().includes('casual'))
    if (cl) return { matched: cl, activeTypes }
  }
  if (q.includes('sick') || q === 'sl' || q.includes('medical') || q.includes('bimari')) {
    const sl = activeTypes.find((t) => t.code === 'SL' || t.name.toLowerCase().includes('sick'))
    if (sl) return { matched: sl, activeTypes }
  }
  if (q.includes('paternity') || q.includes('father')) {
    const pl = activeTypes.find((t) => t.code === 'PL' || t.name.toLowerCase().includes('paternity'))
    if (pl) return { matched: pl, activeTypes }
  }
  if (q.includes('comp') || q.includes('compensatory')) {
    const comp = activeTypes.find((t) => t.code === 'COMP' || t.name.toLowerCase().includes('compensatory'))
    if (comp) return { matched: comp, activeTypes }
  }
  if (q.includes('without pay') || q.includes('unpaid') || q.includes('lwp')) {
    const lwp = activeTypes.find((t) => t.code === 'LWP' || !t.isPaid)
    if (lwp) return { matched: lwp, activeTypes }
  }

  return { matched: null, activeTypes }
}

export const getLeaveTypesTool = defineTool({
  name: 'get_leave_types',
  description: 'List all active leave types with their code, name, paid/unpaid status, yearly quota, and the user remaining balance.',
  parameters: z.object({}),
  openAiParameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (_args, context) => {
    const [types, balances] = await Promise.all([
      leaveTypeService.list(true),
      leaveBalanceService.getBalancesForUser(context.userId),
    ])

    return types.map((t) => {
      const bal = balances.find((b) => b.leaveTypeId === t.id)
      return {
        id: t.id,
        name: t.name,
        code: t.code,
        isPaid: t.isPaid,
        yearlyQuota: t.yearlyQuota !== null ? t.yearlyQuota : 'Unlimited',
        remainingBalance: bal ? (bal.isUnlimited ? 'Unlimited' : bal.remaining) : 'N/A',
      }
    })
  },
})

export const getMyLeaveBalanceTool = defineTool({
  name: 'get_my_leave_balance',
  description: "Get the current authenticated user's leave balances across all leave categories, showing total quota, used, pending, and remaining days.",
  parameters: z.object({}),
  openAiParameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (_args, context) => {
    const balances = await leaveBalanceService.getBalancesForUser(context.userId)
    return balances.map((b) => ({
      leaveTypeId: b.leaveTypeId,
      leaveType: b.leaveTypeName,
      code: b.leaveTypeCode,
      isPaid: b.isPaid,
      totalQuota: b.isUnlimited ? 'Unlimited' : b.total,
      usedDays: b.used,
      pendingDays: b.pending,
      remainingDays: b.isUnlimited ? 'Unlimited' : b.remaining,
    }))
  },
})

export const checkLeaveRequestTool = defineTool({
  name: 'check_leave_request',
  description: 'Dry run to validate a leave request before submitting. Validates leave type, date range, working days calculation, weekend exclusion, past dates, overlap with existing leaves, and balance. Does NOT write to the database. Returns validation status, summary, and a short-lived confirmation token.',
  parameters: z.object({
    leave_type: z.string().min(1).describe("Leave type code or name (e.g., 'CL', 'Casual Leave', 'SL', 'Sick Leave')"),
    start_date: z.string().describe("Start date in YYYY-MM-DD format (resolve relative dates like 'tomorrow', 'next Monday' to YYYY-MM-DD)"),
    end_date: z.string().describe("End date in YYYY-MM-DD format (resolve relative dates to YYYY-MM-DD)"),
    half_day_session: z.enum(['FIRST_HALF', 'SECOND_HALF']).optional().nullable().describe("Optional: 'FIRST_HALF' or 'SECOND_HALF' for half-day leave"),
    reason: z.string().min(1).describe('Reason for the leave request'),
  }),
  openAiParameters: {
    type: 'object',
    properties: {
      leave_type: {
        type: 'string',
        description: "Leave type code or name (e.g. 'CL', 'Casual Leave', 'SL', 'Sick Leave')",
      },
      start_date: {
        type: 'string',
        description: "Start date in YYYY-MM-DD format (resolve relative dates like 'tomorrow' to YYYY-MM-DD)",
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format (resolve relative dates to YYYY-MM-DD)',
      },
      half_day_session: {
        type: 'string',
        enum: ['FIRST_HALF', 'SECOND_HALF'],
        description: "Optional: 'FIRST_HALF' or 'SECOND_HALF' for half-day leave",
      },
      reason: {
        type: 'string',
        description: 'Reason for the leave request',
      },
    },
    required: ['leave_type', 'start_date', 'end_date', 'reason'],
  },
  execute: async (args, context) => {
    // 1. Resolve leave type
    const { matched, activeTypes } = await matchLeaveType(args.leave_type)
    if (!matched) {
      return {
        valid: false,
        error: `Leave type '${args.leave_type}' is not recognized.`,
        availableTypes: activeTypes.map((t) => ({ code: t.code, name: t.name })),
        instruction: 'Ask the user which leave type they would like to use from the available types.',
      }
    }

    // 2. Resolve & validate dates
    const startDate = resolveDateString(args.start_date)
    const endDate = resolveDateString(args.end_date)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return {
        valid: false,
        error: 'Invalid date format. Please specify dates in YYYY-MM-DD format.',
        instruction: 'Ask user for valid start and end dates.',
      }
    }

    if (endDate < startDate) {
      return {
        valid: false,
        error: 'End date cannot be earlier than start date.',
        instruction: 'Ask the user to provide a valid date range where end date is on or after start date.',
      }
    }

    // 3. Calculate working days
    const isHalfDay = Boolean(args.half_day_session || matched.code === 'HDL')
    const halfDaySession = isHalfDay ? (args.half_day_session || 'FIRST_HALF') : null

    let daysCount: number
    try {
      daysCount = calculateWorkingDays(startDate, endDate, halfDaySession)
    } catch {
      return {
        valid: false,
        error: 'Invalid date range provided.',
        instruction: 'Ask the user for a valid date range.',
      }
    }

    if (daysCount <= 0) {
      return {
        valid: false,
        error: 'The selected date range contains no working days (falls entirely on weekends).',
        instruction: 'Explain that the selected dates fall on a weekend, and ask if they would like to pick a working day instead.',
      }
    }

    // 4. Past dates validation (only allowed for Sick Leave)
    const today = new Date().toISOString().split('T')[0]
    if (startDate < today && matched.code !== 'SL') {
      return {
        valid: false,
        error: 'Past dates are only permitted for Sick Leave requests.',
        instruction: 'Inform the user that past dates can only be submitted for Sick Leave, not other leave types.',
      }
    }

    // 5. Reason validation for OTHER
    const trimmedReason = (args.reason || '').trim()
    if (matched.code === 'OTHER' && !trimmedReason) {
      return {
        valid: false,
        error: 'A detailed reason is required for Other leave requests.',
        instruction: 'Ask the user to provide a specific reason for this leave.',
      }
    }

    // 6. Overlap check with existing PENDING or APPROVED requests
    let empRows = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [context.userId])
    if (!empRows[0]) {
      const empCode = `EMP-${String(context.userId).padStart(6, '0')}`
      await executeQuery(
        `INSERT INTO EMPLOYEES (USER_ID, EMPLOYEE_CODE, STATUS, CREATED_AT, UPDATED_AT)
         VALUES (?, ?, 'ACTIVE', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [context.userId, empCode],
      ).catch(() => {})
      empRows = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [context.userId])
    }
    const employeeId = empRows[0]?.ID ? Number(empRows[0].ID) : 0

    if (employeeId > 0) {
      const overlaps = await executeQuery<DbRow>(
        `SELECT ID, START_DATE, END_DATE, STATUS FROM LEAVE_REQUESTS
         WHERE EMPLOYEE_ID = ?
           AND STATUS IN ('PENDING', 'APPROVED')
           AND NOT (END_DATE < ? OR START_DATE > ?)`,
        [employeeId, startDate, endDate],
      )
      if (overlaps.length > 0) {
        return {
          valid: false,
          error: `You already have a pending or approved leave request covering these dates (${startDate} to ${endDate}).`,
          instruction: 'Inform the user about the existing overlapping leave request.',
        }
      }
    }

    // 7. Balance check
    const leaveYear = parseInt(startDate.split('-')[0], 10) || new Date().getFullYear()
    let remainingBalance = 9999
    const isUnlimited = matched.yearlyQuota === null

    if (!isUnlimited) {
      const balances = await leaveBalanceService.getBalancesForUser(context.userId, leaveYear)
      const bal = balances.find((b) => b.leaveTypeId === matched.id)
      remainingBalance = bal ? bal.remaining : 0

      if (daysCount > remainingBalance) {
        return {
          valid: false,
          error: `Insufficient leave balance for ${matched.name}. You have ${remainingBalance} day(s) remaining, but requested ${daysCount} day(s). Consider applying for Leave Without Pay (LWP) instead.`,
          remaining: remainingBalance,
          requested: daysCount,
          suggestLwp: true,
          instruction: `Inform the user that they only have ${remainingBalance} day(s) remaining for ${matched.name}, and suggest applying for Leave Without Pay (LWP) instead.`,
        }
      }
    }

    const balanceAfter = isUnlimited ? 9999 : Math.max(0, remainingBalance - daysCount)

    // 8. Generate short-lived confirmation token
    const confirmation = confirmationService.createToken({
      userId: context.userId,
      leaveTypeId: matched.id,
      leaveTypeName: matched.name,
      leaveTypeCode: matched.code,
      isPaid: matched.isPaid,
      startDate,
      endDate,
      daysCount,
      halfDaySession,
      reason: trimmedReason,
      balanceBefore: remainingBalance,
      balanceAfter,
      isUnlimited,
    })

    return {
      valid: true,
      confirmationRequired: true,
      confirmationToken: confirmation.token,
      summary: {
        leaveTypeId: matched.id,
        leaveTypeName: matched.name,
        leaveTypeCode: matched.code,
        isPaid: matched.isPaid,
        startDate,
        endDate,
        formattedStartDate: formatDateNice(startDate),
        formattedEndDate: formatDateNice(endDate),
        daysCount,
        halfDaySession,
        reason: trimmedReason,
        balanceBefore: isUnlimited ? 'Unlimited' : remainingBalance,
        balanceAfter: isUnlimited ? 'Unlimited' : balanceAfter,
        isUnlimited,
      },
      instruction:
        'IMPORTANT: Present this summary clearly to the user (leave type, dates, working days, reason, balance after) and ask them to confirm before submitting.',
    }
  },
})

export const applyLeaveTool = defineTool({
  name: 'apply_leave',
  description: 'Submit an authorized leave request. REQUIRES a valid confirmation_token generated by check_leave_request. Never call this directly without user confirmation.',
  parameters: z.object({
    confirmation_token: z.string().describe('The short-lived confirmation token issued by check_leave_request after the user agrees to proceed'),
  }),
  openAiParameters: {
    type: 'object',
    properties: {
      confirmation_token: {
        type: 'string',
        description: 'The short-lived confirmation token issued by check_leave_request',
      },
    },
    required: ['confirmation_token'],
  },
  execute: async (args, context) => {
    if (!args.confirmation_token) {
      throw new HttpError(400, 'Confirmation token is required. Please call check_leave_request first and ask the user to confirm.')
    }

    const payload = confirmationService.verifyAndConsumeToken(args.confirmation_token, context.userId)

    const result = await leaveService.create(
      context.userId,
      {
        leaveTypeId: payload.leaveTypeId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        reason: payload.reason,
        halfDaySession: payload.halfDaySession,
      },
      context.role,
    )

    return {
      success: true,
      message: `Leave request for ${payload.leaveTypeName} (${payload.startDate} to ${payload.endDate}) submitted successfully.`,
      leaveRequestId: result.id,
      daysCount: result.daysCount,
      status: 'PENDING',
    }
  },
})

export const getMyLeaveRequestsTool = defineTool({
  name: 'get_my_leave_requests',
  description: "Get the current authenticated user's recent leave requests and their statuses (e.g. to check 'what is the status of my last leave').",
  parameters: z.object({
    status: z.enum(['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional().describe('Filter by request status'),
    limit: z.number().int().min(1).max(20).optional().describe('Number of requests to return (default: 5)'),
  }),
  openAiParameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
        description: 'Filter by request status (default: ALL)',
      },
      limit: {
        type: 'number',
        description: 'Number of requests to return (default: 5)',
      },
    },
    required: [],
  },
  execute: async (args, context) => {
    const list = await leaveService.listForUser(context.userId)
    const filterStatus = args.status && args.status !== 'ALL' ? args.status.toUpperCase() : null
    const filtered = filterStatus ? list.filter((r) => String(r.status).toUpperCase() === filterStatus) : list
    const limit = args.limit || 5
    const results = filtered.slice(0, limit)

    return results.map((r) => ({
      id: r.id,
      leaveType: r.leaveTypeName || r.leaveType,
      code: r.leaveTypeCode,
      startDate: r.startDate,
      endDate: r.endDate,
      daysCount: r.daysCount,
      status: r.status,
      reason: r.reason,
      approverName: r.approverName || null,
      decidedAt: r.decidedAt || null,
      decisionNote: r.decisionNote || null,
      createdAt: r.createdAt,
    }))
  },
})

export const cancelMyLeaveTool = defineTool({
  name: 'cancel_my_leave',
  description: "Cancel the user's own PENDING leave request by request ID.",
  parameters: z.object({
    request_id: z.number().int().positive().describe('The ID of the pending leave request to cancel'),
  }),
  openAiParameters: {
    type: 'object',
    properties: {
      request_id: {
        type: 'number',
        description: 'The numeric ID of the pending leave request to cancel',
      },
    },
    required: ['request_id'],
  },
  execute: async (args, context) => {
    await leaveService.cancel(args.request_id, context.userId)
    return {
      success: true,
      message: `Leave request #${args.request_id} has been cancelled successfully.`,
    }
  },
})
