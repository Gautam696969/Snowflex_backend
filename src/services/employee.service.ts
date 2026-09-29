import { executeDelete, executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'

const employeeColumns = ['USER_ID', 'EMPLOYEE_CODE', 'PHONE', 'DEPARTMENT_ID', 'DESIGNATION', 'JOINING_DATE', 'MANAGER_ID', 'STATUS'] as const
type EmployeeField = typeof employeeColumns[number]

export interface EmployeeInput {
  userId?: number
  employeeCode?: string
  phone?: string | null
  departmentId?: number | null
  designation?: string | null
  joiningDate?: string | null
  managerId?: number | null
  status?: 'ACTIVE' | 'INACTIVE'
}

function inputBinds(input: EmployeeInput): { columns: EmployeeField[]; values: unknown[] } {
  const columnMap: Record<keyof EmployeeInput, EmployeeField> = {
    userId: 'USER_ID', employeeCode: 'EMPLOYEE_CODE', phone: 'PHONE', departmentId: 'DEPARTMENT_ID',
    designation: 'DESIGNATION', joiningDate: 'JOINING_DATE', managerId: 'MANAGER_ID', status: 'STATUS',
  }
  const entries = Object.entries(input) as [keyof EmployeeInput, unknown][]
  return { columns: entries.map(([key]) => columnMap[key]), values: entries.map(([, value]) => value) }
}

export const employeeService = {
  async list(): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `SELECT E.ID, E.USER_ID, U.FULL_NAME, U.EMAIL, E.EMPLOYEE_CODE, E.PHONE, E.DEPARTMENT_ID,
              D.NAME AS DEPARTMENT_NAME, E.DESIGNATION, E.JOINING_DATE, E.MANAGER_ID, E.STATUS,
              E.CREATED_AT, E.UPDATED_AT
       FROM EMPLOYEES E JOIN USERS U ON U.ID = E.USER_ID
       LEFT JOIN DEPARTMENTS D ON D.ID = E.DEPARTMENT_ID ORDER BY E.ID`,
    )
    return rows.map(toApiRow)
  },
  async get(id: number): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>(
      `SELECT E.ID, E.USER_ID, U.FULL_NAME, U.EMAIL, E.EMPLOYEE_CODE, E.PHONE, E.DEPARTMENT_ID,
              D.NAME AS DEPARTMENT_NAME, E.DESIGNATION, E.JOINING_DATE, E.MANAGER_ID, E.STATUS,
              E.CREATED_AT, E.UPDATED_AT
       FROM EMPLOYEES E JOIN USERS U ON U.ID = E.USER_ID
       LEFT JOIN DEPARTMENTS D ON D.ID = E.DEPARTMENT_ID WHERE E.ID = ?`, [id],
    )
    if (!rows[0]) throw new HttpError(404, 'Employee not found')
    return toApiRow(rows[0])
  },
  async forUser(userId: number): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    if (!rows[0]) throw new HttpError(404, 'Employee profile not found')
    return this.get(Number(rows[0].ID))
  },
  async teamForUser(userId: number): Promise<Record<string, unknown>[]> {
    const manager = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    if (!manager[0]) return []
    const rows = await executeQuery<DbRow>(
      `SELECT E.ID, E.USER_ID, U.FULL_NAME, U.EMAIL, E.EMPLOYEE_CODE, E.PHONE, E.DEPARTMENT_ID,
              D.NAME AS DEPARTMENT_NAME, E.DESIGNATION, E.JOINING_DATE, E.MANAGER_ID, E.STATUS
       FROM EMPLOYEES E JOIN USERS U ON U.ID = E.USER_ID LEFT JOIN DEPARTMENTS D ON D.ID = E.DEPARTMENT_ID
      WHERE E.MANAGER_ID = ? ORDER BY E.ID`, [Number(manager[0].ID)],
    )
    return rows.map(toApiRow)
  },
  async create(input: EmployeeInput): Promise<void> {
    const { columns, values } = inputBinds(input)
    const duplicate = await executeQuery<DbRow>(
      'SELECT ID FROM EMPLOYEES WHERE USER_ID = ? OR EMPLOYEE_CODE = ?',
      [input.userId!, input.employeeCode!],
    )
    if (duplicate.length) throw new HttpError(409, 'Employee already exists')
    await executeInsert(`INSERT INTO EMPLOYEES (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values as (string | number | boolean | null)[])
  },
  async update(id: number, input: Partial<EmployeeInput>): Promise<void> {
    const { columns, values } = inputBinds(input)
    if (!columns.length) throw new HttpError(422, 'No employee fields provided')
    await executeUpdate(`UPDATE EMPLOYEES SET ${columns.map((column) => `${column} = ?`).join(', ')}, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`, [...values, id] as (string | number | boolean | null)[])
  },
  async remove(id: number): Promise<void> {
    await executeDelete('DELETE FROM EMPLOYEES WHERE ID = ?', [id])
  },
}