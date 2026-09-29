import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'

export interface LeaveInput { leaveTypeId: number; startDate: string; endDate: string; reason: string }

function leaveDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new HttpError(422, 'Invalid leave date range')
  return Math.floor((end - start) / 86_400_000) + 1
}

export const leaveService = {
  async create(userId: number, input: LeaveInput): Promise<void> {
    const employee = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    if (!employee[0]) throw new HttpError(404, 'Employee profile not found')
    const days = leaveDays(input.startDate, input.endDate)
    const type = await executeQuery<DbRow>('SELECT ID FROM LEAVE_TYPES WHERE ID = ?', [input.leaveTypeId])
    if (!type[0]) throw new HttpError(404, 'Leave type not found')
    await executeInsert('INSERT INTO LEAVE_REQUESTS (EMPLOYEE_ID, LEAVE_TYPE_ID, START_DATE, END_DATE, TOTAL_DAYS, REASON, STATUS) VALUES (?, ?, ?, ?, ?, ?, \'PENDING\')', [Number(employee[0].ID), input.leaveTypeId, input.startDate, input.endDate, days, input.reason])
  },
  async listForUser(userId: number): Promise<Record<string, unknown>[]> {
    return (await executeQuery<DbRow>('SELECT L.ID, L.EMPLOYEE_ID, L.LEAVE_TYPE_ID, T.NAME AS LEAVE_TYPE, L.START_DATE, L.END_DATE, L.TOTAL_DAYS, L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON, L.CREATED_AT FROM LEAVE_REQUESTS L JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID WHERE E.USER_ID = ? ORDER BY L.CREATED_AT DESC', [userId])).map(toApiRow)
  },
  async listAll(): Promise<Record<string, unknown>[]> {
    return (await executeQuery<DbRow>('SELECT L.ID, L.EMPLOYEE_ID, U.FULL_NAME, L.LEAVE_TYPE_ID, T.NAME AS LEAVE_TYPE, L.START_DATE, L.END_DATE, L.TOTAL_DAYS, L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON FROM LEAVE_REQUESTS L JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID JOIN USERS U ON U.ID = E.USER_ID JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID ORDER BY L.CREATED_AT DESC')).map(toApiRow)
  },
  async listForManager(userId: number): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.EMPLOYEE_ID, U.FULL_NAME, L.LEAVE_TYPE_ID, T.NAME AS LEAVE_TYPE,
       L.START_DATE, L.END_DATE, L.TOTAL_DAYS, L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON
       FROM LEAVE_REQUESTS L JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID JOIN LEAVE_TYPES T ON T.ID = L.LEAVE_TYPE_ID
       JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID WHERE M.USER_ID = ? ORDER BY L.CREATED_AT DESC`, [userId],
    )
    return rows.map(toApiRow)
  },
  async get(id: number): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>('SELECT ID, EMPLOYEE_ID, LEAVE_TYPE_ID, START_DATE, END_DATE, TOTAL_DAYS, REASON, STATUS, APPROVED_BY, APPROVED_AT, REJECTION_REASON FROM LEAVE_REQUESTS WHERE ID = ?', [id])
    if (!rows[0]) throw new HttpError(404, 'Leave request not found')
    return toApiRow(rows[0])
  },
  async getVisible(id: number, userId: number, role: string): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>(
      `SELECT L.ID, L.EMPLOYEE_ID, E.USER_ID, M.USER_ID AS MANAGER_USER_ID, L.LEAVE_TYPE_ID,
       L.START_DATE, L.END_DATE, L.TOTAL_DAYS, L.REASON, L.STATUS, L.APPROVED_BY, L.APPROVED_AT, L.REJECTION_REASON
       FROM LEAVE_REQUESTS L JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID
       LEFT JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID WHERE L.ID = ?`, [id],
    )
    const row = rows[0]
    if (!row) throw new HttpError(404, 'Leave request not found')
    const privileged = ['ADMIN', 'HR'].includes(role)
    const managerCanView = role === 'MANAGER' && Number(row.MANAGER_USER_ID) === userId
    if (!privileged && !managerCanView && Number(row.USER_ID) !== userId) throw new HttpError(403, 'Forbidden')
    return toApiRow(row)
  },
  async decide(id: number, approverUserId: number, status: 'APPROVED' | 'REJECTED', reason?: string): Promise<void> {
    const rows = await executeQuery<DbRow>('SELECT L.ID, L.STATUS, E.USER_ID, E.MANAGER_ID, M.USER_ID AS MANAGER_USER_ID FROM LEAVE_REQUESTS L JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID LEFT JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID WHERE L.ID = ?', [id])
    if (!rows[0]) throw new HttpError(404, 'Leave request not found')
    if (Number(rows[0].USER_ID) === approverUserId) throw new HttpError(403, 'You cannot approve your own leave')
    if (rows[0].STATUS !== 'PENDING') throw new HttpError(409, 'Leave request is not pending')
    const actor = await executeQuery<DbRow>('SELECT ROLE FROM USERS WHERE ID = ?', [approverUserId])
    const role = String(actor[0]?.ROLE ?? '')
    if (!['ADMIN', 'HR'].includes(role) && Number(rows[0].MANAGER_USER_ID) !== approverUserId) throw new HttpError(403, 'Forbidden')
    await executeUpdate('UPDATE LEAVE_REQUESTS SET STATUS = ?, APPROVED_BY = ?, APPROVED_AT = CURRENT_TIMESTAMP(), REJECTION_REASON = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?', [status, approverUserId, reason ?? null, id])
  },
  async cancel(id: number, userId: number): Promise<void> {
    const rows = await executeQuery<DbRow>('SELECT L.ID, L.STATUS FROM LEAVE_REQUESTS L JOIN EMPLOYEES E ON E.ID = L.EMPLOYEE_ID WHERE L.ID = ? AND E.USER_ID = ?', [id, userId])
    if (!rows[0]) throw new HttpError(404, 'Leave request not found')
    if (rows[0].STATUS !== 'PENDING') throw new HttpError(409, 'Only pending leave requests can be cancelled')
    await executeUpdate('UPDATE LEAVE_REQUESTS SET STATUS = \'CANCELLED\', UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?', [id])
  },
}