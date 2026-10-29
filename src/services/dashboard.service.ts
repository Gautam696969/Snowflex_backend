import { executeQuery } from '../config/snowflake'
import { DbRow } from '../utils/rows'
import { HttpError } from '../utils/http-error'
import { snowflakeTable } from '../utils/snowflake-identifiers'

const employeesTable = snowflakeTable('EMPLOYEES')
const attendanceTable = snowflakeTable('ATTENDANCE')
const leavesTable = snowflakeTable('LEAVE_REQUESTS')
const leaveTypesTable = snowflakeTable('LEAVE_TYPES')
const tasksTable = snowflakeTable('TASKS')

async function one(sql: string, binds: (string | number)[] = []): Promise<Record<string, unknown>> {
  return (await executeQuery<DbRow>(sql, binds))[0] ?? {}
}

export const dashboardService = {
  async organization(): Promise<Record<string, unknown>> {
    return one(`SELECT
      (SELECT COUNT(*) FROM ${employeesTable} WHERE STATUS = 'ACTIVE') AS TOTAL_EMPLOYEES,
      (SELECT COUNT(*) FROM ${employeesTable} WHERE STATUS = 'ACTIVE') AS ACTIVE_EMPLOYEES,
      (SELECT COUNT(*) FROM ${attendanceTable} WHERE ATTENDANCE_DATE = CURRENT_DATE() AND STATUS IN ('PRESENT','LATE')) AS PRESENT_TODAY,
      (SELECT COUNT(*) FROM ${employeesTable} WHERE STATUS = 'ACTIVE') - (SELECT COUNT(*) FROM ${attendanceTable} WHERE ATTENDANCE_DATE = CURRENT_DATE() AND STATUS IN ('PRESENT','LATE')) AS ABSENT_TODAY,
      (SELECT COUNT(*) FROM ${attendanceTable} WHERE ATTENDANCE_DATE = CURRENT_DATE() AND STATUS = 'LATE') AS LATE_TODAY,
      (SELECT COUNT(*) FROM ${leavesTable} WHERE STATUS = 'PENDING') AS PENDING_LEAVES,
      (SELECT COUNT(*) FROM ${tasksTable} WHERE STATUS IN ('TODO','IN_PROGRESS')) AS PENDING_TASKS`)
  },
  async manager(userId: number): Promise<Record<string, unknown>> {
    return one(`SELECT
      (SELECT COUNT(*) FROM ${employeesTable} M JOIN ${employeesTable} E ON E.MANAGER_ID = M.ID WHERE M.USER_ID = ? AND E.STATUS = 'ACTIVE') AS TEAM_SIZE,
      (SELECT COUNT(*) FROM ${attendanceTable} A JOIN ${employeesTable} M ON A.EMPLOYEE_ID IN (SELECT E.ID FROM ${employeesTable} E WHERE E.MANAGER_ID = M.ID) WHERE M.USER_ID = ? AND A.ATTENDANCE_DATE = CURRENT_DATE() AND A.STATUS IN ('PRESENT','LATE')) AS TEAM_PRESENT_TODAY,
      (SELECT COUNT(*) FROM ${employeesTable} M JOIN ${employeesTable} E ON E.MANAGER_ID = M.ID WHERE M.USER_ID = ? AND E.STATUS = 'ACTIVE') - (SELECT COUNT(*) FROM ${attendanceTable} A JOIN ${employeesTable} E ON E.ID = A.EMPLOYEE_ID JOIN ${employeesTable} M ON M.ID = E.MANAGER_ID WHERE M.USER_ID = ? AND A.ATTENDANCE_DATE = CURRENT_DATE() AND A.STATUS IN ('PRESENT','LATE')) AS TEAM_ABSENT_TODAY,
      (SELECT COUNT(*) FROM ${leavesTable} L JOIN ${employeesTable} M ON L.EMPLOYEE_ID IN (SELECT E.ID FROM ${employeesTable} E WHERE E.MANAGER_ID = M.ID) WHERE M.USER_ID = ? AND L.STATUS = 'PENDING') AS PENDING_LEAVE_REQUESTS,
      (SELECT COUNT(*) FROM ${tasksTable} T JOIN ${employeesTable} M ON T.ASSIGNED_TO IN (SELECT E.ID FROM ${employeesTable} E WHERE E.MANAGER_ID = M.ID) WHERE M.USER_ID = ? AND T.STATUS IN ('TODO','IN_PROGRESS')) AS PENDING_TASKS`, [userId, userId, userId, userId, userId, userId])
  },
  async employee(userId: number): Promise<Record<string, unknown>> {
    const employee = await executeQuery<DbRow>(`SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`, [userId])
    if (!employee[0]) throw new HttpError(403, 'Employee profile not linked to this user')
    return this.employeeByEmployeeId(Number(employee[0].ID))
  },
  async employeeByEmployeeId(employeeId: number): Promise<Record<string, unknown>> {
    return one(`SELECT
      (SELECT COUNT(*) FROM ${attendanceTable} WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE >= DATE_TRUNC('MONTH', CURRENT_DATE())) AS ATTENDANCE_THIS_MONTH,
      (SELECT COALESCE(SUM(DEFAULT_DAYS), 0) FROM ${leaveTypesTable}) - COALESCE((SELECT SUM(TOTAL_DAYS) FROM ${leavesTable} WHERE EMPLOYEE_ID = ? AND STATUS = 'APPROVED'), 0) AS LEAVE_BALANCE,
      (SELECT COUNT(*) FROM ${leavesTable} WHERE EMPLOYEE_ID = ? AND STATUS = 'PENDING') AS PENDING_LEAVES,
      (SELECT COUNT(*) FROM ${tasksTable} WHERE ASSIGNED_TO = ? AND STATUS IN ('TODO','IN_PROGRESS')) AS ASSIGNED_TASKS,
      (SELECT COUNT(*) FROM ${tasksTable} WHERE ASSIGNED_TO = ? AND STATUS = 'COMPLETED') AS COMPLETED_TASKS`, [employeeId, employeeId, employeeId, employeeId, employeeId])
  },
  async findEmployee(id: number): Promise<DbRow | null> {
    const rows = await executeQuery<DbRow>(
      `SELECT ID, USER_ID, MANAGER_ID FROM ${employeesTable} WHERE ID = ? OR USER_ID = ? ORDER BY CASE WHEN ID = ? THEN 0 ELSE 1 END ASC LIMIT 1`,
      [id, id, id]
    )
    return rows[0] ?? null
  },
  async isTeamMember(managerUserId: number, employeeId: number): Promise<boolean> {
    const manager = await executeQuery<DbRow>(`SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`, [managerUserId])
    if (!manager[0]) return false
    const rows = await executeQuery<DbRow>(
      `SELECT ID FROM ${employeesTable} WHERE ID = ? AND MANAGER_ID = ?`,
      [employeeId, Number(manager[0].ID)]
    )
    return Boolean(rows[0])
  },
}