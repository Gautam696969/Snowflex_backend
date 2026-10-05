import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'
import { notificationService } from './notification.service'
import { leaveBalanceService } from './leave-balance.service'

export interface LeaveInput {
  leaveTypeId: number
  startDate: string
  endDate: string
  reason: string
  halfDaySession?: 'FIRST_HALF' | 'SECOND_HALF' | null
  documentUrl?: string | null
}

export interface LeaveListFilters {
  leaveTypeId?: number
  status?: string
  sortBy?: string
  sortOrder?: 'ASC' | 'DESC'
}

export function calculateWorkingDays(startDate: string, endDate: string, halfDaySession?: string | null): number {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
    throw new HttpError(422, 'Invalid leave date range')
  }

  if (halfDaySession) {
    return 0.5
  }

  let workingDays = 0
  const cur = new Date(start)
  while (cur <= end) {
    const day = cur.getUTCDay()
    if (day !== 0 && day !== 6) { // exclude Sunday (0) and Saturday (6)
      workingDays++
    }
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return workingDays
}

export const leaveService = {
  async create(userId: number, input: LeaveInput): Promise<{ id: number; daysCount: number }> {
    let empRows = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    if (!empRows[0]) {
      const empCode = `EMP-${String(userId).padStart(6, '0')}`
      await executeInsert(
        `INSERT INTO EMPLOYEES (USER_ID, EMPLOYEE_CODE, STATUS, CREATED_AT, UPDATED_AT)
         VALUES (?, ?, 'ACTIVE', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [userId, empCode]
      ).catch(() => {})
      empRows = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    }
    if (!empRows[0]) throw new HttpError(404, 'Employee profile not found')
    const employeeId = Number(empRows[0].ID)

    // Verify leave type
    const typeRows = await executeQuery<DbRow>(
      'SELECT ID, NAME, CODE, IS_PAID, YEARLY_QUOTA, REQUIRES_DOCUMENT, IS_ACTIVE FROM LEAVE_TYPES WHERE ID = ?',
      [input.leaveTypeId]
    )
    if (!typeRows[0] || !typeRows[0].IS_ACTIVE) {
      throw new HttpError(404, 'Active leave type not found')
    }
    const leaveType = {
      id: Number(typeRows[0].ID),
      name: String(typeRows[0].NAME || ''),
      code: String(typeRows[0].CODE || ''),
      isPaid: Boolean(typeRows[0].IS_PAID),
      yearlyQuota: typeRows[0].YEARLY_QUOTA !== null && typeRows[0].YEARLY_QUOTA !== undefined ? Number(typeRows[0].YEARLY_QUOTA) : null,
      requiresDocument: Boolean(typeRows[0].REQUIRES_DOCUMENT),
    }

    // Auto-detect half day if leave type is HDL
    const isHalfDay = input.halfDaySession || leaveType.code === 'HDL'
    const halfDaySession = isHalfDay ? (input.halfDaySession || 'FIRST_HALF') : null

    // Calculate days count excluding weekends
    const daysCount = calculateWorkingDays(input.startDate, input.endDate, halfDaySession)
    if (daysCount <= 0) {
      throw new HttpError(422, 'Selected date range contains no working days (weekends only)')
    }

    // Validate past dates (only permitted for Sick Leave)
    const today = new Date().toISOString().split('T')[0]
    if (input.startDate < today && leaveType.code !== 'SL') {
      throw new HttpError(422, 'Past dates are only permitted for Sick Leave requests')
    }

    // Validate reason for "Other"
    const trimmedReason = (input.reason || '').trim()
    if (leaveType.code === 'OTHER' && !trimmedReason) {
      throw new HttpError(422, 'A detailed reason is required for Other leave requests')
    }

    // Validate overlap with existing PENDING or APPROVED requests
    const overlapRows = await executeQuery<DbRow>(
      `SELECT ID, START_DATE, END_DATE, STATUS FROM LEAVE_REQUESTS
       WHERE EMPLOYEE_ID = ?
         AND STATUS IN ('PENDING', 'APPROVED')
         AND NOT (END_DATE < ? OR START_DATE > ?)`,
      [employeeId, input.startDate, input.endDate]
    )
    if (overlapRows.length > 0) {
      throw new HttpError(409, 'You already have a pending or approved leave request covering these dates.')
    }

    // Balance check for quota-limited types
    const leaveYear = parseInt(input.startDate.split('-')[0], 10) || new Date().getFullYear()
    if (leaveType.yearlyQuota !== null) {
      const balances = await leaveBalanceService.getBalancesForEmployee(employeeId, leaveYear)
      const currentBal = balances.find((b) => b.leaveTypeId === leaveType.id)
      const remaining = currentBal ? currentBal.remaining : 0

      if (daysCount > remaining) {
        throw new HttpError(
          422,
          `Insufficient leave balance for ${leaveType.name}. You have ${remaining} day(s) remaining, but requested ${daysCount} day(s). Consider applying for Leave Without Pay (LWP) instead.`
        )
      }
    }

    // Insert into LEAVE_REQUESTS
    await executeInsert(
      `INSERT INTO LEAVE_REQUESTS (
        EMPLOYEE_ID, LEAVE_TYPE_ID, START_DATE, END_DATE, TOTAL_DAYS, DAYS_COUNT, HALF_DAY_SESSION, DOCUMENT_URL, REASON, STATUS, CREATED_AT, UPDATED_AT
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
      [
        employeeId,
        leaveType.id,
        input.startDate,
        input.endDate,
        Math.ceil(daysCount),
        daysCount,
        halfDaySession,
        input.documentUrl ?? null,
        trimmedReason,
      ]
    )

    // Reserve pending days in LEAVE_BALANCES
    await leaveBalanceService.reservePending(employeeId, leaveType.id, daysCount, leaveYear)

    // Query newly created leave ID
    const newLeave = await executeQuery<DbRow>(
      'SELECT ID FROM LEAVE_REQUESTS WHERE EMPLOYEE_ID = ? ORDER BY CREATED_AT DESC, ID DESC LIMIT 1',
      [employeeId]
    )
    const leaveId = newLeave[0]?.ID ? Number(newLeave[0].ID) : 0

    // Fetch employee name for notification
    const userRow = await executeQuery<DbRow>('SELECT FULL_NAME FROM USERS WHERE ID = ?', [userId])
    const employeeName = String(userRow[0]?.FULL_NAME || 'An employee')

    // Notify all ADMINS with leave type
    const dateRange = input.startDate === input.endDate ? input.startDate : `${input.startDate} to ${input.endDate}`
    await notificationService.notifyAdmins({
      type: 'LEAVE_REQUESTED',
      title: 'New Leave Request',
      message: `${employeeName} requested ${leaveType.name} (${dateRange})`,
      link: '/dashboard?view=leaves',
      relatedId: leaveId,
    }).catch((err) => {
      console.error('Failed to notify admins of leave request:', err)
    })

    return { id: leaveId, daysCount }
  },

  async listForUser(userId: number): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.EMPLOYEE_ID, L.LEAVE_TYPE_ID,
              COALESCE(T.NAME, 'Not specified') AS LEAVE_TYPE,
              COALESCE(T.NAME, 'Not specified') AS LEAVE_TYPE_NAME,
              COALESCE(T.CODE, 'OTHER') AS LEAVE_TYPE_CODE,
              COALESCE(T.IS_PAID, TRUE) AS IS_PAID,
              T.YEARLY_QUOTA,
              COALESCE(T.REQUIRES_DOCUMENT, FALSE) AS REQUIRES_DOCUMENT,
              L.START_DATE, L.END_DATE,
              COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) AS DAYS_COUNT,
              L.TOTAL_DAYS, L.HALF_DAY_SESSION, L.DOCUMENT_URL,
              L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON, L.CREATED_AT
       FROM LEAVE_REQUESTS L
       JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       LEFT JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID
       WHERE E.USER_ID = ?
       ORDER BY L.CREATED_AT DESC`,
      [userId]
    )
    return rows.map(toApiRow)
  },

  async listAll(filters?: LeaveListFilters): Promise<Record<string, unknown>[]> {
    const whereClauses: string[] = []
    const params: (string | number | boolean | null)[] = []

    if (filters?.leaveTypeId) {
      whereClauses.push('L.LEAVE_TYPE_ID = ?')
      params.push(Number(filters.leaveTypeId))
    }

    if (filters?.status && filters.status !== 'ALL') {
      whereClauses.push('L.STATUS = ?')
      params.push(filters.status.toUpperCase())
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

    const sortOrder = filters?.sortOrder === 'ASC' ? 'ASC' : 'DESC'
    let orderClause = 'ORDER BY L.CREATED_AT DESC'
    if (filters?.sortBy === 'leave_type') {
      orderClause = `ORDER BY COALESCE(T.NAME, 'Not specified') ${sortOrder}`
    } else if (filters?.sortBy === 'employee') {
      orderClause = `ORDER BY U.FULL_NAME ${sortOrder}`
    } else if (filters?.sortBy === 'start_date') {
      orderClause = `ORDER BY L.START_DATE ${sortOrder}`
    } else if (filters?.sortBy === 'days_count') {
      orderClause = `ORDER BY COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) ${sortOrder}`
    } else if (filters?.sortBy === 'status') {
      orderClause = `ORDER BY L.STATUS ${sortOrder}`
    }

    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL,
              L.LEAVE_TYPE_ID,
              COALESCE(T.NAME, 'Not specified') AS LEAVE_TYPE,
              COALESCE(T.NAME, 'Not specified') AS LEAVE_TYPE_NAME,
              COALESCE(T.CODE, 'OTHER') AS LEAVE_TYPE_CODE,
              COALESCE(T.IS_PAID, TRUE) AS IS_PAID,
              T.YEARLY_QUOTA,
              COALESCE(T.REQUIRES_DOCUMENT, FALSE) AS REQUIRES_DOCUMENT,
              L.START_DATE, L.END_DATE,
              COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) AS DAYS_COUNT,
              L.TOTAL_DAYS, L.HALF_DAY_SESSION, L.DOCUMENT_URL,
              L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON, L.CREATED_AT,
              COALESCE(B.TOTAL, 0) AS QUOTA_TOTAL,
              COALESCE(B.USED, 0) AS QUOTA_USED,
              COALESCE(B.PENDING, 0) AS QUOTA_PENDING,
              (COALESCE(B.TOTAL, 0) - COALESCE(B.USED, 0) - COALESCE(B.PENDING, 0)) AS REMAINING_BALANCE
       FROM LEAVE_REQUESTS L
       JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID
       LEFT JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID
       LEFT JOIN LEAVE_BALANCES B ON B.EMPLOYEE_ID = L.EMPLOYEE_ID AND B.LEAVE_TYPE_ID = L.LEAVE_TYPE_ID AND B.YEAR = YEAR(L.START_DATE)
       ${whereSql}
       ${orderClause}`,
      params
    )
    return rows.map(toApiRow)
  },

  async listForManager(userId: number, filters?: LeaveListFilters): Promise<Record<string, unknown>[]> {
    const whereClauses: string[] = ['M.USER_ID = ?']
    const params: (string | number | boolean | null)[] = [userId]

    if (filters?.leaveTypeId) {
      whereClauses.push('L.LEAVE_TYPE_ID = ?')
      params.push(Number(filters.leaveTypeId))
    }

    if (filters?.status && filters.status !== 'ALL') {
      whereClauses.push('L.STATUS = ?')
      params.push(filters.status.toUpperCase())
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`

    const sortOrder = filters?.sortOrder === 'ASC' ? 'ASC' : 'DESC'
    let orderClause = 'ORDER BY L.CREATED_AT DESC'
    if (filters?.sortBy === 'leave_type') {
      orderClause = `ORDER BY COALESCE(T.NAME, 'Not specified') ${sortOrder}`
    } else if (filters?.sortBy === 'employee') {
      orderClause = `ORDER BY U.FULL_NAME ${sortOrder}`
    } else if (filters?.sortBy === 'start_date') {
      orderClause = `ORDER BY L.START_DATE ${sortOrder}`
    } else if (filters?.sortBy === 'days_count') {
      orderClause = `ORDER BY COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) ${sortOrder}`
    } else if (filters?.sortBy === 'status') {
      orderClause = `ORDER BY L.STATUS ${sortOrder}`
    }

    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL,
              L.LEAVE_TYPE_ID,
              COALESCE(T.NAME, 'Not specified') AS LEAVE_TYPE,
              COALESCE(T.NAME, 'Not specified') AS LEAVE_TYPE_NAME,
              COALESCE(T.CODE, 'OTHER') AS LEAVE_TYPE_CODE,
              COALESCE(T.IS_PAID, TRUE) AS IS_PAID,
              T.YEARLY_QUOTA,
              COALESCE(T.REQUIRES_DOCUMENT, FALSE) AS REQUIRES_DOCUMENT,
              L.START_DATE, L.END_DATE,
              COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) AS DAYS_COUNT,
              L.TOTAL_DAYS, L.HALF_DAY_SESSION, L.DOCUMENT_URL,
              L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON, L.CREATED_AT,
              COALESCE(B.TOTAL, 0) AS QUOTA_TOTAL,
              COALESCE(B.USED, 0) AS QUOTA_USED,
              COALESCE(B.PENDING, 0) AS QUOTA_PENDING,
              (COALESCE(B.TOTAL, 0) - COALESCE(B.USED, 0) - COALESCE(B.PENDING, 0)) AS REMAINING_BALANCE
       FROM LEAVE_REQUESTS L
       JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID
       LEFT JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID
       JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID
       LEFT JOIN LEAVE_BALANCES B ON B.EMPLOYEE_ID = L.EMPLOYEE_ID AND B.LEAVE_TYPE_ID = L.LEAVE_TYPE_ID AND B.YEAR = YEAR(L.START_DATE)
       ${whereSql}
       ${orderClause}`,
      params
    )
    return rows.map(toApiRow)
  },

  async getVisible(id: number, userId: number, role: string): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.EMPLOYEE_ID, E.USER_ID, M.USER_ID AS MANAGER_USER_ID,
              L.LEAVE_TYPE_ID, T.NAME AS LEAVE_TYPE, T.CODE AS LEAVE_TYPE_CODE,
              T.IS_PAID, T.YEARLY_QUOTA,
              L.START_DATE, L.END_DATE,
              COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) AS DAYS_COUNT,
              L.TOTAL_DAYS, L.HALF_DAY_SESSION, L.DOCUMENT_URL,
              L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON, L.CREATED_AT
       FROM LEAVE_REQUESTS L
       JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID
       LEFT JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID
       WHERE L.ID = ?`,
      [id]
    )
    const row = rows[0]
    if (!row) throw new HttpError(404, 'Leave request not found')
    const privileged = ['ADMIN', 'HR'].includes(role)
    const managerCanView = role === 'MANAGER' && Number(row.MANAGER_USER_ID) === userId
    if (!privileged && !managerCanView && Number(row.USER_ID) !== userId) throw new HttpError(403, 'Forbidden')
    return toApiRow(row)
  },

  async decide(id: number, approverUserId: number, status: 'APPROVED' | 'REJECTED', reason?: string): Promise<void> {
    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.STATUS, L.EMPLOYEE_ID, L.LEAVE_TYPE_ID, L.START_DATE, L.END_DATE,
              COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) AS DAYS_COUNT,
              T.NAME AS LEAVE_TYPE_NAME,
              E.USER_ID, E.MANAGER_ID, M.USER_ID AS MANAGER_USER_ID
       FROM LEAVE_REQUESTS L
       JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID
       LEFT JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID
       WHERE L.ID = ?`,
      [id]
    )
    if (!rows[0]) throw new HttpError(404, 'Leave request not found')
    if (Number(rows[0].USER_ID) === approverUserId) throw new HttpError(403, 'You cannot approve your own leave')
    if (rows[0].STATUS !== 'PENDING') throw new HttpError(409, 'Leave request is not pending')

    const actor = await executeQuery<DbRow>('SELECT ROLE, FULL_NAME FROM USERS WHERE ID = ?', [approverUserId])
    const role = String(actor[0]?.ROLE ?? '')
    const approverName = String(actor[0]?.FULL_NAME ?? 'Administrator')
    if (!['ADMIN', 'HR'].includes(role) && Number(rows[0].MANAGER_USER_ID) !== approverUserId) throw new HttpError(403, 'Forbidden')

    // Update leave request row
    await executeUpdate(
      `UPDATE LEAVE_REQUESTS
       SET STATUS = ?, APPROVED_BY = ?, APPROVED_AT = CURRENT_TIMESTAMP(), REJECTION_REASON = ?, UPDATED_AT = CURRENT_TIMESTAMP()
       WHERE ID = ?`,
      [status, approverUserId, reason ?? null, id]
    )

    const employeeId = Number(rows[0].EMPLOYEE_ID)
    const leaveTypeId = Number(rows[0].LEAVE_TYPE_ID)
    const daysCount = Number(rows[0].DAYS_COUNT || 1)
    const leaveTypeName = String(rows[0].LEAVE_TYPE_NAME || 'Leave')
    const startDate = String(rows[0].START_DATE || '').split('T')[0]
    const endDate = String(rows[0].END_DATE || '').split('T')[0]
    const leaveYear = parseInt(startDate.split('-')[0], 10) || new Date().getFullYear()

    // Update leave balances atomically
    if (status === 'APPROVED') {
      await leaveBalanceService.approveLeave(employeeId, leaveTypeId, daysCount, leaveYear)
    } else {
      await leaveBalanceService.releasePending(employeeId, leaveTypeId, daysCount, leaveYear)
    }

    // Notify employee of approval or rejection with leave type
    const employeeUserId = Number(rows[0].USER_ID)
    const dateRange = startDate && endDate ? (startDate === endDate ? startDate : `${startDate} to ${endDate}`) : 'your requested dates'

    if (status === 'APPROVED') {
      await notificationService.createNotification({
        userId: employeeUserId,
        type: 'LEAVE_APPROVED',
        title: 'Leave Request Approved',
        message: `Your ${leaveTypeName} request (${dateRange}) was approved by ${approverName}`,
        link: '/dashboard?view=leaves',
        relatedId: id,
      }).catch((err) => {
        console.error(`Failed to notify employee ${employeeUserId} of approval:`, err)
      })
    } else {
      const reasonPart = reason ? `: ${reason}` : ''
      await notificationService.createNotification({
        userId: employeeUserId,
        type: 'LEAVE_REJECTED',
        title: 'Leave Request Rejected',
        message: `Your ${leaveTypeName} request (${dateRange}) was rejected${reasonPart}`,
        link: '/dashboard?view=leaves',
        relatedId: id,
      }).catch((err) => {
        console.error(`Failed to notify employee ${employeeUserId} of rejection:`, err)
      })
    }
  },

  async cancel(id: number, userId: number): Promise<void> {
    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.STATUS, L.EMPLOYEE_ID, L.LEAVE_TYPE_ID, L.START_DATE,
              COALESCE(L.DAYS_COUNT, L.TOTAL_DAYS) AS DAYS_COUNT
       FROM LEAVE_REQUESTS L
       JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       WHERE L.ID = ? AND E.USER_ID = ?`,
      [id, userId]
    )
    if (!rows[0]) throw new HttpError(404, 'Leave request not found')
    if (rows[0].STATUS !== 'PENDING') throw new HttpError(409, 'Only pending leave requests can be cancelled')

    const employeeId = Number(rows[0].EMPLOYEE_ID)
    const leaveTypeId = Number(rows[0].LEAVE_TYPE_ID)
    const daysCount = Number(rows[0].DAYS_COUNT || 1)
    const startDate = String(rows[0].START_DATE || '').split('T')[0]
    const leaveYear = parseInt(startDate.split('-')[0], 10) || new Date().getFullYear()

    await executeUpdate(
      "UPDATE LEAVE_REQUESTS SET STATUS = 'CANCELLED', UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?",
      [id]
    )

    // Release pending balance
    await leaveBalanceService.releasePending(employeeId, leaveTypeId, daysCount, leaveYear)
  },
}