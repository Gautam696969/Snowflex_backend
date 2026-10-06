import { executeQuery } from '../config/snowflake'
import { HttpError } from './http-error'

interface SuperAdminState extends Record<string, unknown> {
  ROLE: string
  EMPLOYEE_STATUS: string | null
}

export async function assertNotLastActiveSuperAdmin(userId: number, action: 'deactivate' | 'remove' | 'demote'): Promise<void> {
  const targetRows = await executeQuery<SuperAdminState>(
    `SELECT U.ROLE, E.STATUS AS EMPLOYEE_STATUS
     FROM USERS U LEFT JOIN EMPLOYEES E ON E.USER_ID = U.ID
     WHERE U.ID = ?`,
    [userId],
  )
  const target = targetRows[0]
  if (
    !target
    || String(target.ROLE).toUpperCase() !== 'SUPER_ADMIN'
    || String(target.EMPLOYEE_STATUS ?? 'ACTIVE').toUpperCase() !== 'ACTIVE'
  ) return

  const activeRows = await executeQuery<Record<string, unknown>>(
    `SELECT COUNT(*) AS CNT
     FROM USERS U LEFT JOIN EMPLOYEES E ON E.USER_ID = U.ID
     WHERE UPPER(U.ROLE) = 'SUPER_ADMIN' AND COALESCE(E.STATUS, 'ACTIVE') = 'ACTIVE'`,
  )
  if (Number(activeRows[0]?.CNT ?? 0) <= 1) {
    const verb = action === 'demote' ? 'demote' : action
    throw new HttpError(409, `Cannot ${verb} the last active SUPER_ADMIN.`)
  }
}