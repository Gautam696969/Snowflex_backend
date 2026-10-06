import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'
import { getEnvironment } from '../config/env'

export const attendanceService = {
  async checkIn(userId: number): Promise<Record<string, unknown>> {
    const employee = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    if (!employee[0]) throw new HttpError(404, 'Employee profile not found')
    const employeeId = Number(employee[0].ID)
    const exists = await executeQuery<DbRow>('SELECT ID FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()', [employeeId])
    if (exists.length) throw new HttpError(409, 'Attendance already recorded today')
    const startTime = getEnvironment().ATTENDANCE_START_TIME
    await executeInsert(
      `INSERT INTO ATTENDANCE (EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, STATUS)
       VALUES (?, CURRENT_DATE(), CURRENT_TIMESTAMP(),
         IFF(TO_TIME(CURRENT_TIMESTAMP()) > TO_TIME(?), 'LATE', 'PRESENT'))`,
      [employeeId, startTime],
    )
    const rows = await executeQuery<DbRow>('SELECT ID, EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_OUT, STATUS, WORKING_HOURS FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()', [employeeId])
    return toApiRow(rows[0])
  },
  async checkOut(userId: number): Promise<Record<string, unknown>> {
    const employee = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    if (!employee[0]) throw new HttpError(404, 'Employee profile not found')
    const employeeId = Number(employee[0].ID)
    const existing = await executeQuery<DbRow>('SELECT ID, CHECK_IN, CHECK_OUT FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()', [employeeId])
    if (!existing[0]?.CHECK_IN) throw new HttpError(409, 'Check in before checking out')
    if (existing[0].CHECK_OUT) throw new HttpError(409, 'Attendance already checked out')
    await executeUpdate(
      `UPDATE ATTENDANCE SET CHECK_OUT = CURRENT_TIMESTAMP(),
       WORKING_HOURS = ROUND(DATEDIFF('second', CHECK_IN, CURRENT_TIMESTAMP()) / 3600.0, 2),
       STATUS = IFF(DATEDIFF('minute', CHECK_IN, CURRENT_TIMESTAMP()) < 240, 'HALF_DAY', STATUS),
       UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`, [Number(existing[0].ID)],
    )
    const rows = await executeQuery<DbRow>('SELECT ID, EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_OUT, STATUS, WORKING_HOURS FROM ATTENDANCE WHERE ID = ?', [Number(existing[0].ID)])
    return toApiRow(rows[0])
  },
  async listForEmployee(employeeId: number): Promise<Record<string, unknown>[]> {
    return (await executeQuery<DbRow>(
      `SELECT A.ID, A.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL, U.AVATAR_URL,
              A.ATTENDANCE_DATE, A.CHECK_IN, A.CHECK_OUT, A.STATUS, A.WORKING_HOURS
       FROM ATTENDANCE A
       JOIN EMPLOYEES E ON E.ID = A.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID
       WHERE A.EMPLOYEE_ID = ? ORDER BY A.ATTENDANCE_DATE DESC`,
      [employeeId],
    )).map(toApiRow)
  },
  async listAll(): Promise<Record<string, unknown>[]> {
    return (await executeQuery<DbRow>('SELECT A.ID, A.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL, U.AVATAR_URL, A.ATTENDANCE_DATE, A.CHECK_IN, A.CHECK_OUT, A.STATUS, A.WORKING_HOURS FROM ATTENDANCE A JOIN EMPLOYEES E ON E.ID = A.EMPLOYEE_ID JOIN USERS U ON U.ID = E.USER_ID ORDER BY A.ATTENDANCE_DATE DESC')).map(toApiRow)
  },
  async listForManager(userId: number): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `SELECT A.ID, A.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL, U.AVATAR_URL, A.ATTENDANCE_DATE, A.CHECK_IN, A.CHECK_OUT, A.STATUS, A.WORKING_HOURS
       FROM ATTENDANCE A JOIN EMPLOYEES E ON E.ID = A.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID
       WHERE M.USER_ID = ? ORDER BY A.ATTENDANCE_DATE DESC`, [userId],
    )
    return rows.map(toApiRow)
  },
}