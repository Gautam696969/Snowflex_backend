import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'

export interface LeaveBalanceDto {
  id: number
  employeeId: number
  leaveTypeId: number
  leaveTypeName: string
  leaveTypeCode: string
  description: string | null
  isPaid: boolean
  requiresDocument: boolean
  year: number
  total: number
  used: number
  pending: number
  remaining: number
  isUnlimited: boolean
}

export const leaveBalanceService = {
  async ensureBalancesForEmployee(employeeId: number, year = new Date().getFullYear()): Promise<void> {
    // Fetch all active leave types
    const types = await executeQuery<DbRow>(
      `SELECT ID, YEARLY_QUOTA, DEFAULT_DAYS, IS_PAID FROM LEAVE_TYPES WHERE IS_ACTIVE = TRUE`
    )

    // Check existing balances for this year
    const existing = await executeQuery<DbRow>(
      `SELECT LEAVE_TYPE_ID FROM LEAVE_BALANCES WHERE EMPLOYEE_ID = ? AND YEAR = ?`,
      [employeeId, year]
    )
    const existingTypeIds = new Set(existing.map((r) => Number(r.LEAVE_TYPE_ID)))

    for (const t of types) {
      const typeId = Number(t.ID)
      if (!existingTypeIds.has(typeId)) {
        const quota = t.YEARLY_QUOTA !== null && t.YEARLY_QUOTA !== undefined ? Number(t.YEARLY_QUOTA) : null
        const total = quota !== null ? quota : 9999 // 9999 represents unlimited
        await executeInsert(
          `INSERT INTO LEAVE_BALANCES (EMPLOYEE_ID, LEAVE_TYPE_ID, YEAR, TOTAL, USED, PENDING, CREATED_AT, UPDATED_AT)
           VALUES (?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
          [employeeId, typeId, year, total]
        ).catch(() => {
          // ignore duplicate insert race conditions
        })
      }
    }
  },

  async getBalancesForEmployee(employeeId: number, year = new Date().getFullYear()): Promise<LeaveBalanceDto[]> {
    await this.ensureBalancesForEmployee(employeeId, year)

    const rows = await executeQuery<DbRow>(
      `SELECT B.ID, B.EMPLOYEE_ID, B.LEAVE_TYPE_ID, T.NAME AS LEAVE_TYPE_NAME,
              T.CODE AS LEAVE_TYPE_CODE, T.DESCRIPTION, T.IS_PAID, T.YEARLY_QUOTA,
              T.REQUIRES_DOCUMENT, B.YEAR, B.TOTAL, B.USED, B.PENDING
       FROM LEAVE_BALANCES B
       JOIN LEAVE_TYPES T ON T.ID = B.LEAVE_TYPE_ID
       WHERE B.EMPLOYEE_ID = ? AND B.YEAR = ? AND T.IS_ACTIVE = TRUE
       ORDER BY T.ID ASC`,
      [employeeId, year]
    )

    return rows.map((r) => {
      const api = toApiRow(r)
      const isUnlimited = api.yearlyQuota === null || api.yearlyQuota === undefined
      const total = Number(api.total ?? 0)
      const used = Number(api.used ?? 0)
      const pending = Number(api.pending ?? 0)
      const remaining = isUnlimited ? 9999 : Math.max(0, total - used - pending)

      return {
        id: Number(api.id),
        employeeId: Number(api.employeeId),
        leaveTypeId: Number(api.leaveTypeId),
        leaveTypeName: String(api.leaveTypeName || ''),
        leaveTypeCode: String(api.leaveTypeCode || ''),
        description: api.description ? String(api.description) : null,
        isPaid: Boolean(api.isPaid ?? true),
        requiresDocument: Boolean(api.requiresDocument ?? false),
        year: Number(api.year),
        total: isUnlimited ? 0 : total,
        used,
        pending,
        remaining: isUnlimited ? 0 : remaining,
        isUnlimited,
      }
    })
  },

  async getBalancesForUser(userId: number, year = new Date().getFullYear()): Promise<LeaveBalanceDto[]> {
    let empRow = await executeQuery<DbRow>(
      `SELECT ID FROM EMPLOYEES WHERE USER_ID = ?`,
      [userId]
    )
    if (!empRow[0]) {
      // Auto-provision an employee profile for users who don't have one yet
      const empCode = `EMP-${String(userId).padStart(6, '0')}`
      await executeInsert(
        `INSERT INTO EMPLOYEES (USER_ID, EMPLOYEE_CODE, STATUS, CREATED_AT, UPDATED_AT)
         VALUES (?, ?, 'ACTIVE', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [userId, empCode]
      ).catch(() => {})
      empRow = await executeQuery<DbRow>(
        `SELECT ID FROM EMPLOYEES WHERE USER_ID = ?`,
        [userId]
      )
    }
    if (!empRow[0]) return []
    const employeeId = Number(empRow[0].ID)
    return this.getBalancesForEmployee(employeeId, year)
  },

  async reservePending(employeeId: number, leaveTypeId: number, days: number, year = new Date().getFullYear()): Promise<void> {
    await this.ensureBalancesForEmployee(employeeId, year)
    await executeUpdate(
      `UPDATE LEAVE_BALANCES
       SET PENDING = PENDING + ?, UPDATED_AT = CURRENT_TIMESTAMP()
       WHERE EMPLOYEE_ID = ? AND LEAVE_TYPE_ID = ? AND YEAR = ?`,
      [days, employeeId, leaveTypeId, year]
    )
  },

  async approveLeave(employeeId: number, leaveTypeId: number, days: number, year = new Date().getFullYear()): Promise<void> {
    await this.ensureBalancesForEmployee(employeeId, year)
    await executeUpdate(
      `UPDATE LEAVE_BALANCES
       SET PENDING = GREATEST(0, PENDING - ?), USED = USED + ?, UPDATED_AT = CURRENT_TIMESTAMP()
       WHERE EMPLOYEE_ID = ? AND LEAVE_TYPE_ID = ? AND YEAR = ?`,
      [days, days, employeeId, leaveTypeId, year]
    )
  },

  async releasePending(employeeId: number, leaveTypeId: number, days: number, year = new Date().getFullYear()): Promise<void> {
    await this.ensureBalancesForEmployee(employeeId, year)
    await executeUpdate(
      `UPDATE LEAVE_BALANCES
       SET PENDING = GREATEST(0, PENDING - ?), UPDATED_AT = CURRENT_TIMESTAMP()
       WHERE EMPLOYEE_ID = ? AND LEAVE_TYPE_ID = ? AND YEAR = ?`,
      [days, employeeId, leaveTypeId, year]
    )
  },
}
