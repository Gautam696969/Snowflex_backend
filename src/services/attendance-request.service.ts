import { executeInsert, executeQuery, executeUpdate, withTransaction } from '../config/snowflake'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'
import { normalizeRole } from '../utils/roles'
import { employeeService } from './employee.service'
import { notificationService } from './notification.service'
import {
  broadcastAttendanceRequestCreated,
  broadcastAttendanceRequestDecided,
} from '../socket/socket.server'
import {
  AttendanceRequestItem,
  CreateAttendanceRequestInput,
  AttendanceRequestListFilters,
} from '../types/attendance-request.types'

const requestsTable = snowflakeTable('ATTENDANCE_REQUESTS')
const auditTable = snowflakeTable('ATTENDANCE_REQUEST_AUDIT_LOGS')
const attendanceTable = snowflakeTable('ATTENDANCE')
const employeesTable = snowflakeTable('EMPLOYEES')
const usersTable = snowflakeTable('USERS')
const departmentsTable = snowflakeTable('DEPARTMENTS')

function normalizeDateString(val: unknown): string {
  if (!val) return ''
  if (val instanceof Date) {
    if (!isNaN(val.getTime())) {
      const year = val.getFullYear()
      const month = String(val.getMonth() + 1).padStart(2, '0')
      const day = String(val.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
  }
  const str = String(val).trim()
  const match = str.match(/\b\d{4}-\d{2}-\d{2}\b/)
  if (match) return match[0]

  const parsed = new Date(str)
  if (!isNaN(parsed.getTime())) {
    const year = parsed.getFullYear()
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return str.split('T')[0]
}

function normalizeTimeString(timeVal: unknown, defaultTime: string): string {
  if (!timeVal) return defaultTime
  const trimmed = String(timeVal).trim()
  if (!trimmed) return defaultTime
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    const [h, m] = trimmed.split(':')
    return `${h.padStart(2, '0')}:${m}:00`
  }
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) {
    const [h, m, s] = trimmed.split(':')
    return `${h.padStart(2, '0')}:${m}:${s}`
  }
  return defaultTime
}

function computeWorkingHours(startIso: string, endIso: string): number {
  try {
    const s = new Date(startIso.replace(' ', 'T') + 'Z').getTime()
    const e = new Date(endIso.replace(' ', 'T') + 'Z').getTime()
    if (!isNaN(s) && !isNaN(e) && e > s) {
      const diffMs = e - s
      return Math.round((diffMs / 3600000) * 100) / 100
    }
  } catch {
    // fallback
  }
  return 8.0
}

function formatRequestRow(row: DbRow): AttendanceRequestItem {
  const api = toApiRow(row)
  const rawDate = row.ATTENDANCE_DATE || row.DATE
  const dateStr = normalizeDateString(rawDate)
  const requestType = String(row.REQUEST_TYPE || row.TYPE || 'MISSED_PUNCH')

  return {
    id: Number(row.ID),
    employeeId: Number(row.EMPLOYEE_ID),
    userId: row.USER_ID ? Number(row.USER_ID) : undefined,
    employeeName: row.EMPLOYEE_NAME ? String(row.EMPLOYEE_NAME) : String(api.employeeName || 'Employee'),
    employeeEmail: row.EMPLOYEE_EMAIL ? String(row.EMPLOYEE_EMAIL) : String(api.employeeEmail || ''),
    employeeAvatarUrl: row.EMPLOYEE_AVATAR_URL ? String(row.EMPLOYEE_AVATAR_URL) : null,
    employeeCode: row.EMPLOYEE_CODE ? String(row.EMPLOYEE_CODE) : String(api.employeeCode || ''),
    departmentName: row.DEPARTMENT_NAME ? String(row.DEPARTMENT_NAME) : String(api.departmentName || 'General'),
    date: dateStr,
    attendanceDate: dateStr,
    type: requestType,
    requestType: requestType,
    checkInTime: row.CHECK_IN_TIME ? String(row.CHECK_IN_TIME) : null,
    checkOutTime: row.CHECK_OUT_TIME ? String(row.CHECK_OUT_TIME) : null,
    reason: String(row.REASON || ''),
    status: (String(row.STATUS || 'PENDING').toUpperCase() as AttendanceRequestItem['status']),
    decidedBy: row.DECIDED_BY ? Number(row.DECIDED_BY) : null,
    decidedByName: row.DECIDED_BY_NAME ? String(row.DECIDED_BY_NAME) : null,
    decidedByRole: row.DECIDED_BY_ROLE ? String(row.DECIDED_BY_ROLE) : null,
    decidedAt: row.DECIDED_AT ? new Date(String(row.DECIDED_AT)).toISOString() : null,
    rejectReason: row.REJECT_REASON ? String(row.REJECT_REASON) : null,
    createdAt: row.CREATED_AT ? new Date(String(row.CREATED_AT)).toISOString() : new Date().toISOString(),
    updatedAt: row.UPDATED_AT ? new Date(String(row.UPDATED_AT)).toISOString() : new Date().toISOString(),
  }
}

export const attendanceRequestService = {
  /**
   * Idempotent table check at startup
   */
  async ensureTables(): Promise<void> {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${requestsTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          EMPLOYEE_ID INTEGER NOT NULL,
          ATTENDANCE_DATE DATE NOT NULL,
          REQUEST_TYPE VARCHAR(50) NOT NULL,
          CHECK_IN_TIME VARCHAR(30),
          CHECK_OUT_TIME VARCHAR(30),
          REASON VARCHAR(2000) NOT NULL,
          STATUS VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          DECIDED_BY INTEGER,
          DECIDED_BY_NAME VARCHAR(120),
          DECIDED_BY_ROLE VARCHAR(50),
          DECIDED_AT TIMESTAMP_NTZ,
          REJECT_REASON VARCHAR(1000),
          CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          UPDATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          CONSTRAINT PK_ATTENDANCE_REQUESTS PRIMARY KEY (ID)
        )
      `)

      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${auditTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          REQUEST_ID INTEGER NOT NULL,
          ACTION VARCHAR(20) NOT NULL,
          PERFORMED_BY INTEGER NOT NULL,
          PERFORMED_BY_NAME VARCHAR(120),
          PERFORMED_BY_ROLE VARCHAR(50),
          REASON VARCHAR(2000),
          PREVIOUS_STATUS VARCHAR(20) NOT NULL,
          NEW_STATUS VARCHAR(20) NOT NULL,
          CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          CONSTRAINT PK_ATTENDANCE_REQUEST_AUDIT_LOGS PRIMARY KEY (ID)
        )
      `)
    } catch (err) {
      console.warn('Could not ensure ATTENDANCE_REQUESTS tables in Snowflake:', err)
    }
  },

  /**
   * Submit attendance request (EMPLOYEE only)
   */
  async create(
    userId: number,
    userRole: string,
    input: CreateAttendanceRequestInput
  ): Promise<AttendanceRequestItem> {
    const normalizedRole = normalizeRole(userRole)
    if (normalizedRole !== 'EMPLOYEE' && normalizedRole !== 'USER') {
      throw new HttpError(403, 'Only employees can submit attendance requests')
    }

    const employee = await employeeService.forUser(userId)
    if (!employee || !employee.id) {
      throw new HttpError(404, 'Employee profile not found')
    }
    const employeeId = Number(employee.id)

    const dateOnly = normalizeDateString(input.date)
    if (!dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
      throw new HttpError(400, 'Invalid attendance date format. Expected YYYY-MM-DD')
    }

    // Block duplicate PENDING request for the same employee + date
    const existingPending = await executeQuery<DbRow>(
      `SELECT ID FROM ${requestsTable} WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = TO_DATE(?) AND STATUS = 'PENDING'`,
      [employeeId, dateOnly]
    )
    if (existingPending.length > 0) {
      throw new HttpError(409, 'A pending attendance request already exists for this employee and date')
    }

    const requestType = String(input.type || 'MISSED_PUNCH').trim()
    const checkInTime = input.checkInTime ? String(input.checkInTime).trim() : null
    const checkOutTime = input.checkOutTime ? String(input.checkOutTime).trim() : null
    const reason = String(input.reason || '').trim()

    await executeInsert(
      `INSERT INTO ${requestsTable} (
        EMPLOYEE_ID, ATTENDANCE_DATE, REQUEST_TYPE, CHECK_IN_TIME, CHECK_OUT_TIME, REASON, STATUS, CREATED_AT, UPDATED_AT
      ) VALUES (?, TO_DATE(?), ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
      [employeeId, dateOnly, requestType, checkInTime, checkOutTime, reason]
    )

    // Fetch newly created record with employee and department info
    const rows = await executeQuery<DbRow>(
      `SELECT AR.ID, AR.EMPLOYEE_ID, AR.ATTENDANCE_DATE, AR.REQUEST_TYPE,
              AR.CHECK_IN_TIME, AR.CHECK_OUT_TIME, AR.REASON, AR.STATUS,
              AR.DECIDED_BY, AR.DECIDED_BY_NAME, AR.DECIDED_BY_ROLE, AR.DECIDED_AT,
              AR.REJECT_REASON, AR.CREATED_AT, AR.UPDATED_AT,
              U.FULL_NAME AS EMPLOYEE_NAME, U.EMAIL AS EMPLOYEE_EMAIL, U.AVATAR_URL AS EMPLOYEE_AVATAR_URL,
              E.EMPLOYEE_CODE, D.NAME AS DEPARTMENT_NAME, E.USER_ID
       FROM ${requestsTable} AR
       JOIN ${employeesTable} E ON E.ID = AR.EMPLOYEE_ID
       JOIN ${usersTable} U ON U.ID = E.USER_ID
       LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
       WHERE AR.EMPLOYEE_ID = ?
       ORDER BY AR.CREATED_AT DESC, AR.ID DESC
       LIMIT 1`,
      [employeeId]
    )

    if (!rows[0]) {
      throw new HttpError(500, 'Failed to retrieve submitted attendance request')
    }

    const createdRecord = formatRequestRow(rows[0])

    // Real-time broadcast to all ADMIN, HR, and SUPER_ADMIN users in 'approvers' room
    try {
      broadcastAttendanceRequestCreated({
        request: createdRecord,
        employeeName: createdRecord.employeeName || 'An employee',
      })
    } catch (err) {
      console.warn('Failed to broadcast attendance request creation:', err)
    }

    // Trigger reviewer notifications
    try {
      await notificationService.notifyAdmins({
        type: 'ATTENDANCE_REQUESTED',
        title: 'New Attendance Request',
        message: `${createdRecord.employeeName} submitted an attendance request (${createdRecord.type}) for ${dateOnly}`,
        link: '/dashboard?view=attendance',
        relatedId: createdRecord.id,
      })
    } catch (notifErr) {
      console.warn('Failed to send reviewer notifications for attendance request:', notifErr)
    }

    return createdRecord
  },

  /**
   * List requests: ADMIN/HR/SUPER_ADMIN see all; EMPLOYEE sees only their own
   */
  async list(
    userId: number,
    userRole: string,
    filters: AttendanceRequestListFilters = {}
  ): Promise<{ items: AttendanceRequestItem[]; total: number; page: number; limit: number } | AttendanceRequestItem[]> {
    const normalizedRole = normalizeRole(userRole)
    const isApprover = ['ADMIN', 'HR', 'SUPER_ADMIN'].includes(normalizedRole)

    const conditions: string[] = []
    const binds: (string | number)[] = []

    if (!isApprover) {
      // Find employee ID for current user
      const empRows = await executeQuery<DbRow>(
        `SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`,
        [userId]
      )
      if (!empRows[0]) {
        return filters.page ? { items: [], total: 0, page: Number(filters.page) || 1, limit: Number(filters.limit) || 20 } : []
      }
      conditions.push('AR.EMPLOYEE_ID = ?')
      binds.push(Number(empRows[0].ID))
    }

    if (filters.status && filters.status.toUpperCase() !== 'ALL') {
      conditions.push('AR.STATUS = ?')
      binds.push(filters.status.toUpperCase())
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Ordering: PENDING first, then most recent created
    const orderClause = `ORDER BY CASE WHEN AR.STATUS = 'PENDING' THEN 0 ELSE 1 END, AR.CREATED_AT DESC, AR.ID DESC`

    if (filters.page) {
      const page = Math.max(1, Number(filters.page) || 1)
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))
      const offset = (page - 1) * limit

      const [rows, countRows] = await Promise.all([
        executeQuery<DbRow>(
          `SELECT AR.ID, AR.EMPLOYEE_ID, AR.ATTENDANCE_DATE, AR.REQUEST_TYPE,
                  AR.CHECK_IN_TIME, AR.CHECK_OUT_TIME, AR.REASON, AR.STATUS,
                  AR.DECIDED_BY, AR.DECIDED_BY_NAME, AR.DECIDED_BY_ROLE, AR.DECIDED_AT,
                  AR.REJECT_REASON, AR.CREATED_AT, AR.UPDATED_AT,
                  U.FULL_NAME AS EMPLOYEE_NAME, U.EMAIL AS EMPLOYEE_EMAIL, U.AVATAR_URL AS EMPLOYEE_AVATAR_URL,
                  E.EMPLOYEE_CODE, D.NAME AS DEPARTMENT_NAME, E.USER_ID
           FROM ${requestsTable} AR
           JOIN ${employeesTable} E ON E.ID = AR.EMPLOYEE_ID
           JOIN ${usersTable} U ON U.ID = E.USER_ID
           LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
           ${whereClause}
           ${orderClause}
           LIMIT ? OFFSET ?`,
          [...binds, limit, offset]
        ),
        executeQuery<DbRow>(
          `SELECT COUNT(*) AS CNT
           FROM ${requestsTable} AR
           JOIN ${employeesTable} E ON E.ID = AR.EMPLOYEE_ID
           ${whereClause}`,
          binds
        ),
      ])

      const total = Number(countRows[0]?.CNT || 0)
      const items = rows.map(formatRequestRow)
      return { items, total, page, limit }
    }

    // Default: unpaginated list
    const rows = await executeQuery<DbRow>(
      `SELECT AR.ID, AR.EMPLOYEE_ID, AR.ATTENDANCE_DATE, AR.REQUEST_TYPE,
              AR.CHECK_IN_TIME, AR.CHECK_OUT_TIME, AR.REASON, AR.STATUS,
              AR.DECIDED_BY, AR.DECIDED_BY_NAME, AR.DECIDED_BY_ROLE, AR.DECIDED_AT,
              AR.REJECT_REASON, AR.CREATED_AT, AR.UPDATED_AT,
              U.FULL_NAME AS EMPLOYEE_NAME, U.EMAIL AS EMPLOYEE_EMAIL, U.AVATAR_URL AS EMPLOYEE_AVATAR_URL,
              E.EMPLOYEE_CODE, D.NAME AS DEPARTMENT_NAME, E.USER_ID
       FROM ${requestsTable} AR
       JOIN ${employeesTable} E ON E.ID = AR.EMPLOYEE_ID
       JOIN ${usersTable} U ON U.ID = E.USER_ID
       LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
       ${whereClause}
       ${orderClause}`,
      binds
    )

    return rows.map(formatRequestRow)
  },

  /**
   * Approve or reject request with first-action-wins race condition protection
   */
  async decide(
    requestId: number,
    approverUserId: number,
    approverRole: string,
    action: 'APPROVED' | 'REJECTED',
    rejectReason?: string | null
  ): Promise<AttendanceRequestItem> {
    const normalizedRole = normalizeRole(approverRole)
    if (!['ADMIN', 'HR', 'SUPER_ADMIN'].includes(normalizedRole)) {
      throw new HttpError(403, 'Only Admins, HR, and Super Admins can decide attendance requests')
    }

    // Fetch existing request to verify status and retrieve target employee
    const targetRows = await executeQuery<DbRow>(
      `SELECT AR.ID, AR.STATUS, AR.EMPLOYEE_ID, AR.ATTENDANCE_DATE, AR.REQUEST_TYPE,
              AR.CHECK_IN_TIME, AR.CHECK_OUT_TIME, AR.DECIDED_BY_NAME,
              E.USER_ID AS EMPLOYEE_USER_ID, U.FULL_NAME AS EMPLOYEE_NAME
       FROM ${requestsTable} AR
       JOIN ${employeesTable} E ON E.ID = AR.EMPLOYEE_ID
       JOIN ${usersTable} U ON U.ID = E.USER_ID
       WHERE AR.ID = ?`,
      [requestId]
    )

    const record = targetRows[0]
    if (!record) {
      throw new HttpError(404, 'Attendance request not found')
    }

    const currentStatus = String(record.STATUS || '').toUpperCase()
    if (currentStatus !== 'PENDING') {
      const approverName = String(record.DECIDED_BY_NAME || 'another approver')
      throw new HttpError(409, `Already handled by ${approverName}`)
    }

    // Snapshot approver name
    const approverRows = await executeQuery<DbRow>(
      `SELECT FULL_NAME FROM ${usersTable} WHERE ID = ?`,
      [approverUserId]
    )
    const approverName = String(approverRows[0]?.FULL_NAME || 'Approver')
    const employeeUserId = Number(record.EMPLOYEE_USER_ID)
    const employeeId = Number(record.EMPLOYEE_ID)
    const rawAttendanceDate = record.ATTENDANCE_DATE
    const dateStr = normalizeDateString(rawAttendanceDate)
    const checkInTimeVal = record.CHECK_IN_TIME ? String(record.CHECK_IN_TIME).trim() : null
    const checkOutTimeVal = record.CHECK_OUT_TIME ? String(record.CHECK_OUT_TIME).trim() : null

    // ATOMIC TRANSACTION: update request + sync attendance + insert audit log
    await withTransaction(async () => {
      // Conditional update: must be PENDING
      const rowsAffected = await executeUpdate(
        `UPDATE ${requestsTable}
         SET STATUS = ?,
             DECIDED_BY = ?,
             DECIDED_BY_NAME = ?,
             DECIDED_BY_ROLE = ?,
             DECIDED_AT = CURRENT_TIMESTAMP(),
             REJECT_REASON = ?,
             UPDATED_AT = CURRENT_TIMESTAMP()
         WHERE ID = ? AND STATUS = 'PENDING'`,
        [
          action,
          approverUserId,
          approverName,
          normalizedRole,
          action === 'REJECTED' ? (rejectReason ?? null) : null,
          requestId,
        ]
      )

      if (rowsAffected === 0) {
        // Race condition: another approver decided it in the fraction of a second
        const recheck = await executeQuery<DbRow>(
          `SELECT DECIDED_BY_NAME, DECIDED_BY_ROLE, STATUS FROM ${requestsTable} WHERE ID = ?`,
          [requestId]
        )
        const decidedBy = String(recheck[0]?.DECIDED_BY_NAME || 'another approver')
        throw new HttpError(409, `Already handled by ${decidedBy}`)
      }

      // If approved, create or update the actual ATTENDANCE record in the same transaction
      if (action === 'APPROVED') {
        const checkInTime = normalizeTimeString(checkInTimeVal, '09:00:00')
        const checkOutTime = normalizeTimeString(checkOutTimeVal, '18:00:00')
        const checkInIso = `${dateStr} ${checkInTime}`
        const checkOutIso = `${dateStr} ${checkOutTime}`
        const workingHours = computeWorkingHours(checkInIso, checkOutIso)

        // Check if attendance row already exists for this employee + date
        const existingAttendance = await executeQuery<DbRow>(
          `SELECT ID FROM ${attendanceTable} WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = TO_DATE(?)`,
          [employeeId, dateStr]
        )

        if (existingAttendance.length > 0) {
          await executeUpdate(
            `UPDATE ${attendanceTable}
             SET STATUS = 'PRESENT',
                 CHECK_IN = TO_TIMESTAMP_NTZ(?),
                 CHECK_OUT = TO_TIMESTAMP_NTZ(?),
                 WORKING_HOURS = ?,
                 UPDATED_AT = CURRENT_TIMESTAMP()
             WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = TO_DATE(?)`,
            [checkInIso, checkOutIso, workingHours, employeeId, dateStr]
          )
        } else {
          await executeInsert(
            `INSERT INTO ${attendanceTable} (
               EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_OUT, STATUS, WORKING_HOURS, CREATED_AT, UPDATED_AT
             ) VALUES (
               ?, TO_DATE(?), TO_TIMESTAMP_NTZ(?), TO_TIMESTAMP_NTZ(?), 'PRESENT', ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
             )`,
            [employeeId, dateStr, checkInIso, checkOutIso, workingHours]
          )
        }
      }

      // Record audit log entry
      try {
        await executeInsert(
          `INSERT INTO ${auditTable} (
             REQUEST_ID, ACTION, PERFORMED_BY, PERFORMED_BY_NAME, PERFORMED_BY_ROLE,
             REASON, PREVIOUS_STATUS, NEW_STATUS, CREATED_AT
           ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, CURRENT_TIMESTAMP())`,
          [
            requestId,
            action,
            approverUserId,
            approverName,
            normalizedRole,
            rejectReason ?? null,
            action,
          ]
        )
      } catch (auditErr) {
        console.warn('Could not record attendance request audit log:', auditErr)
      }

      // Add notification for the employee
      try {
        const title = action === 'APPROVED' ? 'Attendance Request Approved' : 'Attendance Request Rejected'
        const reasonSuffix = rejectReason ? `: ${rejectReason}` : ''
        const message = action === 'APPROVED'
          ? `Your attendance request for ${dateStr} was approved by ${approverName} (${normalizedRole}).`
          : `Your attendance request for ${dateStr} was rejected by ${approverName} (${normalizedRole})${reasonSuffix}.`

        await notificationService.createNotification({
          userId: employeeUserId,
          type: action === 'APPROVED' ? 'ATTENDANCE_APPROVED' : 'ATTENDANCE_REJECTED',
          title,
          message,
          link: '/dashboard?view=attendance',
          relatedId: requestId,
        })
      } catch (notifErr) {
        console.warn('Could not create notification for attendance decision:', notifErr)
      }
    })

    // Fetch the updated request record
    const updatedRows = await executeQuery<DbRow>(
      `SELECT AR.ID, AR.EMPLOYEE_ID, AR.ATTENDANCE_DATE, AR.REQUEST_TYPE,
              AR.CHECK_IN_TIME, AR.CHECK_OUT_TIME, AR.REASON, AR.STATUS,
              AR.DECIDED_BY, AR.DECIDED_BY_NAME, AR.DECIDED_BY_ROLE, AR.DECIDED_AT,
              AR.REJECT_REASON, AR.CREATED_AT, AR.UPDATED_AT,
              U.FULL_NAME AS EMPLOYEE_NAME, U.EMAIL AS EMPLOYEE_EMAIL, U.AVATAR_URL AS EMPLOYEE_AVATAR_URL,
              E.EMPLOYEE_CODE, D.NAME AS DEPARTMENT_NAME, E.USER_ID
       FROM ${requestsTable} AR
       JOIN ${employeesTable} E ON E.ID = AR.EMPLOYEE_ID
       JOIN ${usersTable} U ON U.ID = E.USER_ID
       LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
       WHERE AR.ID = ?`,
      [requestId]
    )

    const fallbackRow: DbRow = {
      ...record,
      STATUS: action,
      DECIDED_BY: approverUserId,
      DECIDED_BY_NAME: approverName,
      DECIDED_BY_ROLE: normalizedRole,
      DECIDED_AT: new Date().toISOString(),
      REJECT_REASON: action === 'REJECTED' ? (rejectReason ?? null) : null,
      UPDATED_AT: new Date().toISOString(),
    }
    const finalRow = (Array.isArray(updatedRows) && updatedRows[0]) ? updatedRows[0] : fallbackRow
    const updatedRecord = formatRequestRow(finalRow)

    // Emit live real-time event to approvers AND the employee's personal room
    try {
      broadcastAttendanceRequestDecided(employeeUserId, {
        requestId,
        status: action,
        decidedByName: approverName,
        decidedByRole: normalizedRole,
        decidedAt: updatedRecord.decidedAt || new Date().toISOString(),
        rejectReason: updatedRecord.rejectReason,
        request: updatedRecord,
      })
    } catch (socketErr) {
      console.warn('Failed to emit attendance request decided event:', socketErr)
    }

    return updatedRecord
  },

  /**
   * Pending count for sidebar badge and dashboard indicators
   */
  async getPendingCount(userId: number, userRole: string): Promise<number> {
    const normalizedRole = normalizeRole(userRole)
    const isApprover = ['ADMIN', 'HR', 'SUPER_ADMIN'].includes(normalizedRole)

    if (isApprover) {
      const rows = await executeQuery<DbRow>(
        `SELECT COUNT(*) AS CNT FROM ${requestsTable} WHERE STATUS = 'PENDING'`
      )
      return Number(rows[0]?.CNT || 0)
    }

    const empRows = await executeQuery<DbRow>(
      `SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`,
      [userId]
    )
    if (!empRows[0]) return 0

    const rows = await executeQuery<DbRow>(
      `SELECT COUNT(*) AS CNT FROM ${requestsTable} WHERE EMPLOYEE_ID = ? AND STATUS = 'PENDING'`,
      [Number(empRows[0].ID)]
    )
    return Number(rows[0]?.CNT || 0)
  },
}
