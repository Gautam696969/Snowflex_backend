import { executeDelete, executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'
import { snowflakeTable } from '../utils/snowflake-identifiers'

const employeesTable = snowflakeTable('EMPLOYEES')
const usersTable = snowflakeTable('USERS')
const departmentsTable = snowflakeTable('DEPARTMENTS')

const leaveRequestsTable = snowflakeTable('LEAVE_REQUESTS')
const leaveTypesTable = snowflakeTable('LEAVE_TYPES')

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
  const entries = (Object.entries(input) as [keyof EmployeeInput, unknown][]).filter(([, value]) => value !== undefined)
  return { columns: entries.map(([key]) => columnMap[key]), values: entries.map(([, value]) => value) }
}

export const employeeService = {
  async list(): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `WITH PENDING_SUMMARY AS (
        SELECT
          L.EMPLOYEE_ID,
          COUNT(L.ID) AS PENDING_COUNT,
          LISTAGG(DISTINCT COALESCE(T.NAME, 'Not specified'), ', ') WITHIN GROUP (ORDER BY COALESCE(T.NAME, 'Not specified') ASC) AS PENDING_TYPE_NAMES
        FROM ${leaveRequestsTable} L
        LEFT JOIN ${leaveTypesTable} T ON T.ID = L.LEAVE_TYPE_ID
        WHERE L.STATUS = 'PENDING'
        GROUP BY L.EMPLOYEE_ID
      ),
      FIRST_PENDING AS (
        SELECT
          L.EMPLOYEE_ID,
          COALESCE(T.NAME, 'Not specified') AS FIRST_PENDING_NAME,
          COALESCE(T.CODE, 'OTHER') AS FIRST_PENDING_CODE,
          COALESCE(T.IS_PAID, TRUE) AS FIRST_PENDING_IS_PAID,
          ROW_NUMBER() OVER (PARTITION BY L.EMPLOYEE_ID ORDER BY L.CREATED_AT ASC) AS RN
        FROM ${leaveRequestsTable} L
        LEFT JOIN ${leaveTypesTable} T ON T.ID = L.LEAVE_TYPE_ID
        WHERE L.STATUS = 'PENDING'
      ),
      TODAY_LEAVE AS (
        SELECT
          L.EMPLOYEE_ID,
          COALESCE(T.NAME, 'Leave') AS TODAY_LEAVE_NAME,
          COALESCE(T.CODE, 'LEAVE') AS TODAY_LEAVE_CODE,
          ROW_NUMBER() OVER (PARTITION BY L.EMPLOYEE_ID ORDER BY L.START_DATE ASC) AS RN
        FROM ${leaveRequestsTable} L
        LEFT JOIN ${leaveTypesTable} T ON T.ID = L.LEAVE_TYPE_ID
        WHERE L.STATUS = 'APPROVED'
          AND CURRENT_DATE() BETWEEN L.START_DATE AND L.END_DATE
      )
      SELECT E.ID, E.USER_ID,
             COALESCE(U.FULL_NAME, 'Employee #' || E.ID::VARCHAR) AS FULL_NAME,
             COALESCE(U.EMAIL, '—') AS EMAIL,
             E.EMPLOYEE_CODE, E.PHONE, E.DEPARTMENT_ID,
             D.NAME AS DEPARTMENT_NAME, E.DESIGNATION, E.JOINING_DATE, E.MANAGER_ID, E.STATUS,
             COALESCE(PS.PENDING_COUNT, 0) AS PENDING_LEAVE_COUNT,
             PS.PENDING_TYPE_NAMES,
             FP.FIRST_PENDING_NAME,
             FP.FIRST_PENDING_CODE,
             FP.FIRST_PENDING_IS_PAID,
             CASE WHEN TL.EMPLOYEE_ID IS NOT NULL THEN TRUE ELSE FALSE END AS ON_LEAVE_TODAY,
             TL.TODAY_LEAVE_NAME,
             TL.TODAY_LEAVE_CODE,
             E.CREATED_AT, E.UPDATED_AT
      FROM ${employeesTable} E
      LEFT JOIN ${usersTable} U ON U.ID = E.USER_ID
      LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
      LEFT JOIN PENDING_SUMMARY PS ON PS.EMPLOYEE_ID = E.ID
      LEFT JOIN FIRST_PENDING FP ON FP.EMPLOYEE_ID = E.ID AND FP.RN = 1
      LEFT JOIN TODAY_LEAVE TL ON TL.EMPLOYEE_ID = E.ID AND TL.RN = 1
      ORDER BY E.ID DESC`,
    )
    return rows.map(toApiRow)
  },
  async get(id: number): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>(
      `SELECT E.ID, E.USER_ID,
              COALESCE(U.FULL_NAME, 'Employee #' || E.ID::VARCHAR) AS FULL_NAME,
              COALESCE(U.EMAIL, '—') AS EMAIL,
              E.EMPLOYEE_CODE, E.PHONE, E.DEPARTMENT_ID,
              D.NAME AS DEPARTMENT_NAME, E.DESIGNATION, E.JOINING_DATE, E.MANAGER_ID, E.STATUS,
              E.CREATED_AT, E.UPDATED_AT
       FROM ${employeesTable} E
       LEFT JOIN ${usersTable} U ON U.ID = E.USER_ID
       LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
       WHERE E.ID = ?`, [id],
    )
    if (!rows[0]) throw new HttpError(404, 'Employee not found')
    return toApiRow(rows[0])
  },
  async forUser(userId: number): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>(`SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`, [userId])
    if (!rows[0]) throw new HttpError(404, 'Employee profile not found')
    return this.get(Number(rows[0].ID))
  },
  async teamForUser(userId: number): Promise<Record<string, unknown>[]> {
    const manager = await executeQuery<DbRow>(`SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`, [userId])
    if (!manager[0]) return []
    const rows = await executeQuery<DbRow>(
      `SELECT E.ID, E.USER_ID,
              COALESCE(U.FULL_NAME, 'Employee #' || E.ID::VARCHAR) AS FULL_NAME,
              COALESCE(U.EMAIL, '—') AS EMAIL,
              E.EMPLOYEE_CODE, E.PHONE, E.DEPARTMENT_ID,
              D.NAME AS DEPARTMENT_NAME, E.DESIGNATION, E.JOINING_DATE, E.MANAGER_ID, E.STATUS
       FROM ${employeesTable} E
       LEFT JOIN ${usersTable} U ON U.ID = E.USER_ID
       LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
       WHERE E.MANAGER_ID = ? ORDER BY E.ID DESC`, [Number(manager[0].ID)],
    )
    return rows.map(toApiRow)
  },
  async create(input: EmployeeInput & { fullName?: string; email?: string }): Promise<Record<string, unknown>> {
    if (!input.employeeCode || !input.employeeCode.trim()) {
      throw new HttpError(400, 'Employee code is required')
    }
    const cleanCode = input.employeeCode.trim()

    let resolvedUserId = input.userId

    // If userId not provided, but fullName or email is provided, resolve or create user in USERS
    if (!resolvedUserId) {
      if (input.email) {
        const cleanEmail = input.email.trim().toLowerCase()
        const existingUsers = await executeQuery<DbRow>(
          `SELECT ID, FULL_NAME, EMAIL FROM ${usersTable} WHERE LOWER(EMAIL) = ?`,
          [cleanEmail],
        )
        if (existingUsers.length > 0) {
          resolvedUserId = Number(existingUsers[0].ID)
        } else {
          const nameToUse = (input.fullName && input.fullName.trim()) || cleanEmail.split('@')[0]
          const dummyHash = '$2b$10$wK1hF9xW7L2B6N6j2qJ2veaZlqUu6yA/KzFhB0SjBfT.CqXmY0v1O'
          await executeInsert(
            `INSERT INTO ${usersTable} (FULL_NAME, EMAIL, PASSWORD_HASH, ROLE) VALUES (?, ?, ?, 'EMPLOYEE')`,
            [nameToUse, cleanEmail, dummyHash],
          )
          const createdUser = await executeQuery<DbRow>(
            `SELECT ID FROM ${usersTable} WHERE LOWER(EMAIL) = ?`,
            [cleanEmail],
          )
          if (createdUser.length > 0) {
            resolvedUserId = Number(createdUser[0].ID)
          }
        }
      } else if (input.fullName && input.fullName.trim()) {
        const nameToUse = input.fullName.trim()
        const slug = nameToUse.toLowerCase().replace(/[^a-z0-9]/g, '') || 'emp'
        const uniqueEmail = `${slug}.${Date.now()}@snowflex.internal`
        const dummyHash = '$2b$10$wK1hF9xW7L2B6N6j2qJ2veaZlqUu6yA/KzFhB0SjBfT.CqXmY0v1O'
        await executeInsert(
          `INSERT INTO ${usersTable} (FULL_NAME, EMAIL, PASSWORD_HASH, ROLE) VALUES (?, ?, ?, 'EMPLOYEE')`,
          [nameToUse, uniqueEmail, dummyHash],
        )
        const createdUser = await executeQuery<DbRow>(
          `SELECT ID FROM ${usersTable} WHERE LOWER(EMAIL) = ?`,
          [uniqueEmail],
        )
        if (createdUser.length > 0) {
          resolvedUserId = Number(createdUser[0].ID)
        }
      }
    }

    if (!resolvedUserId) {
      throw new HttpError(400, 'User ID or employee name/email is required')
    }

    // Verify user exists in USERS; if not, create matching record in USERS so no orphaned records exist
    const user = await executeQuery<DbRow>(
      `SELECT ID, FULL_NAME, EMAIL FROM ${usersTable} WHERE ID = ?`,
      [resolvedUserId],
    )
    if (!user.length) {
      const stubName = (input.fullName && input.fullName.trim()) || `Employee #${resolvedUserId}`
      const stubEmail = (input.email && input.email.trim().toLowerCase()) || `employee${resolvedUserId}@snowflex.internal`
      const dummyHash = '$2b$10$wK1hF9xW7L2B6N6j2qJ2veaZlqUu6yA/KzFhB0SjBfT.CqXmY0v1O'
      await executeInsert(
        `INSERT INTO ${usersTable} (ID, FULL_NAME, EMAIL, PASSWORD_HASH, ROLE) VALUES (?, ?, ?, ?, 'EMPLOYEE')`,
        [resolvedUserId, stubName, stubEmail, dummyHash],
      )
    }

    const duplicate = await executeQuery<DbRow>(
      `SELECT ID, USER_ID, EMPLOYEE_CODE FROM ${employeesTable} WHERE USER_ID = ? OR EMPLOYEE_CODE = ?`,
      [resolvedUserId, cleanCode],
    )
    if (duplicate.length) {
      const match = duplicate[0]
      if (Number(match.USER_ID) === Number(resolvedUserId)) {
        throw new HttpError(409, `An employee record already exists for User ID ${resolvedUserId}`)
      }
      throw new HttpError(409, `Employee code "${cleanCode}" is already in use`)
    }

    const cleanInput: EmployeeInput = {
      userId: resolvedUserId,
      employeeCode: cleanCode,
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.designation !== undefined ? { designation: input.designation } : {}),
      ...(input.joiningDate !== undefined ? { joiningDate: input.joiningDate } : {}),
      ...(input.managerId !== undefined ? { managerId: input.managerId } : {}),
      status: input.status || 'ACTIVE',
    }
    const { columns, values } = inputBinds(cleanInput)

    await executeInsert(
      `INSERT INTO ${employeesTable} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values as (string | number | boolean | null)[],
    )

    const createdRows = await executeQuery<DbRow>(
      `SELECT E.ID, E.USER_ID,
              COALESCE(U.FULL_NAME, 'Employee #' || E.ID::VARCHAR) AS FULL_NAME,
              COALESCE(U.EMAIL, '—') AS EMAIL,
              E.EMPLOYEE_CODE, E.PHONE, E.DEPARTMENT_ID,
              D.NAME AS DEPARTMENT_NAME, E.DESIGNATION, E.JOINING_DATE, E.MANAGER_ID, E.STATUS,
              E.CREATED_AT, E.UPDATED_AT
       FROM ${employeesTable} E
       LEFT JOIN ${usersTable} U ON U.ID = E.USER_ID
       LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
       WHERE E.USER_ID = ? AND E.EMPLOYEE_CODE = ?
       ORDER BY E.ID DESC`,
      [resolvedUserId, cleanCode],
    )
    if (!createdRows[0]) {
      throw new HttpError(500, 'Employee created in Snowflake but failed to retrieve record')
    }
    return toApiRow(createdRows[0])
  },
  async update(id: number, input: Partial<EmployeeInput>): Promise<void> {
    const { columns, values } = inputBinds(input)
    if (!columns.length) throw new HttpError(422, 'No employee fields provided')
    await executeUpdate(
      `UPDATE ${employeesTable} SET ${columns.map((column) => `${column} = ?`).join(', ')}, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [...values, id] as (string | number | boolean | null)[],
    )
  },
  async remove(id: number): Promise<void> {
    await executeDelete(`DELETE FROM ${employeesTable} WHERE ID = ?`, [id])
  },
}