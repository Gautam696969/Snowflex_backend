import { executeDelete, executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'

export interface TaskInput { title?: string; description?: string | null; assignedTo?: number; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'; status?: 'TODO' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; dueDate?: string | null }

export const taskService = {
  async list(userId: number, role: string): Promise<Record<string, unknown>[]> {
    const rows = ['ADMIN', 'HR'].includes(role)
      ? await executeQuery<DbRow>(`SELECT T.ID, T.TITLE, T.DESCRIPTION, T.ASSIGNED_TO,
          U.FULL_NAME AS ASSIGNED_TO_NAME, U.AVATAR_URL AS ASSIGNED_TO_AVATAR_URL,
          T.ASSIGNED_BY, C.FULL_NAME AS ASSIGNED_BY_NAME, C.AVATAR_URL AS ASSIGNED_BY_AVATAR_URL,
          T.PRIORITY, T.STATUS, T.DUE_DATE, T.CREATED_AT, T.UPDATED_AT, T.COMPLETED_AT
        FROM TASKS T JOIN EMPLOYEES E ON E.ID = T.ASSIGNED_TO
        JOIN USERS U ON U.ID = E.USER_ID LEFT JOIN USERS C ON C.ID = T.ASSIGNED_BY
        ORDER BY T.DUE_DATE`)
      : role === 'MANAGER'
        ? await executeQuery<DbRow>(`SELECT T.ID, T.TITLE, T.DESCRIPTION, T.ASSIGNED_TO,
            U.FULL_NAME AS ASSIGNED_TO_NAME, U.AVATAR_URL AS ASSIGNED_TO_AVATAR_URL,
            T.ASSIGNED_BY, C.FULL_NAME AS ASSIGNED_BY_NAME, C.AVATAR_URL AS ASSIGNED_BY_AVATAR_URL,
            T.PRIORITY, T.STATUS, T.DUE_DATE, T.CREATED_AT, T.UPDATED_AT, T.COMPLETED_AT
          FROM TASKS T JOIN EMPLOYEES E ON E.ID = T.ASSIGNED_TO
          JOIN USERS U ON U.ID = E.USER_ID LEFT JOIN USERS C ON C.ID = T.ASSIGNED_BY
          LEFT JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID
          WHERE T.ASSIGNED_BY = ? OR M.USER_ID = ? ORDER BY T.DUE_DATE`, [userId, userId])
        : await executeQuery<DbRow>(`SELECT T.ID, T.TITLE, T.DESCRIPTION, T.ASSIGNED_TO,
            U.FULL_NAME AS ASSIGNED_TO_NAME, U.AVATAR_URL AS ASSIGNED_TO_AVATAR_URL,
            T.ASSIGNED_BY, C.FULL_NAME AS ASSIGNED_BY_NAME, C.AVATAR_URL AS ASSIGNED_BY_AVATAR_URL,
            T.PRIORITY, T.STATUS, T.DUE_DATE, T.CREATED_AT, T.UPDATED_AT, T.COMPLETED_AT
          FROM TASKS T JOIN EMPLOYEES E ON E.ID = T.ASSIGNED_TO
          JOIN USERS U ON U.ID = E.USER_ID LEFT JOIN USERS C ON C.ID = T.ASSIGNED_BY
          WHERE E.USER_ID = ? ORDER BY T.DUE_DATE`, [userId])
    return rows.map(toApiRow)
  },
  async get(id: number, userId: number, role: string): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>(`SELECT T.ID, T.TITLE, T.DESCRIPTION, T.ASSIGNED_TO,
      U.FULL_NAME AS ASSIGNED_TO_NAME, U.AVATAR_URL AS ASSIGNED_TO_AVATAR_URL,
      T.ASSIGNED_BY, C.FULL_NAME AS ASSIGNED_BY_NAME, C.AVATAR_URL AS ASSIGNED_BY_AVATAR_URL,
      T.PRIORITY, T.STATUS, T.DUE_DATE, T.CREATED_AT, T.UPDATED_AT, T.COMPLETED_AT
      FROM TASKS T JOIN EMPLOYEES E ON E.ID = T.ASSIGNED_TO JOIN USERS U ON U.ID = E.USER_ID
      LEFT JOIN USERS C ON C.ID = T.ASSIGNED_BY LEFT JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID
      WHERE T.ID = ? AND (? IN ('ADMIN','HR') OR T.ASSIGNED_BY = ? OR E.USER_ID = ? OR (? = 'MANAGER' AND M.USER_ID = ?))`, [id, role, userId, userId, role, userId])
    if (!rows[0]) throw new HttpError(404, 'Task not found')
    return toApiRow(rows[0])
  },
  async create(input: TaskInput, assignedBy: number): Promise<void> {
    const assigned = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE ID = ? AND STATUS = \'ACTIVE\'', [input.assignedTo!])
    if (!assigned[0]) throw new HttpError(404, 'Active employee not found')
    await executeInsert('INSERT INTO TASKS (TITLE, DESCRIPTION, ASSIGNED_TO, ASSIGNED_BY, PRIORITY, STATUS, DUE_DATE) VALUES (?, ?, ?, ?, ?, ?, ?)', [input.title!, input.description ?? null, input.assignedTo!, assignedBy, input.priority ?? 'MEDIUM', input.status ?? 'TODO', input.dueDate ?? null])
  },
  async update(id: number, input: TaskInput, actorId: number, role: string): Promise<void> {
    if (role === 'EMPLOYEE') throw new HttpError(403, 'Forbidden')
    const fields: string[] = []
    const binds: (string | number | boolean | null)[] = []
    const map: [keyof TaskInput, string][] = [['title','TITLE'],['description','DESCRIPTION'],['assignedTo','ASSIGNED_TO'],['priority','PRIORITY'],['status','STATUS'],['dueDate','DUE_DATE']]
    for (const [key, column] of map) if (input[key] !== undefined) { fields.push(`${column} = ?`); binds.push(input[key] as string | number | null) }
    if (!fields.length) throw new HttpError(422, 'No task fields provided')
    await executeUpdate(`UPDATE TASKS SET ${fields.join(', ')}, COMPLETED_AT = IFF(? = 'COMPLETED', CURRENT_TIMESTAMP(), COMPLETED_AT), UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ? AND (? IN ('ADMIN','HR') OR ASSIGNED_BY = ?)`, [...binds, input.status ?? '', id, role, actorId])
  },
  async setStatus(id: number, status: NonNullable<TaskInput['status']>, userId: number, role: string): Promise<void> {
    const rows = await executeQuery<DbRow>(`SELECT T.ID FROM TASKS T JOIN EMPLOYEES E ON E.ID = T.ASSIGNED_TO LEFT JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID WHERE T.ID = ? AND (? IN ('ADMIN','HR') OR E.USER_ID = ? OR (? = 'MANAGER' AND (T.ASSIGNED_BY = ? OR M.USER_ID = ?)))`, [id, role, userId, role, userId, userId])
    if (!rows[0]) throw new HttpError(404, 'Task not found')
    await executeUpdate('UPDATE TASKS SET STATUS = ?, COMPLETED_AT = IFF(? = \'COMPLETED\', CURRENT_TIMESTAMP(), NULL), UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?', [status, status, id])
  },
  async remove(id: number, actorId: number, role: string): Promise<void> {
    if (!['ADMIN','HR','MANAGER'].includes(role)) throw new HttpError(403, 'Forbidden')
    await executeDelete(`DELETE FROM TASKS WHERE ID = ? AND (? IN ('ADMIN','HR') OR ASSIGNED_BY = ?)`, [id, role, actorId])
  },
}