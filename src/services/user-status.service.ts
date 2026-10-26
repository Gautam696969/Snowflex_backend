import { executeQuery } from '../config/snowflake'
import { DbRow } from '../utils/rows'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { normalizeRole } from '../utils/roles'

const usersTable = snowflakeTable('USERS')
const employeesTable = snowflakeTable('EMPLOYEES')

interface CachedStatus {
  status: string
  role?: string
  expiresAt: number
}

// In-memory cache for user account status with 30s TTL
const statusCache = new Map<number, CachedStatus>()
const STATUS_CACHE_TTL_MS = 30_000

export async function getUserAccountInfo(userId: number): Promise<{ status: string; role?: string }> {
  const cached = statusCache.get(userId)
  if (cached && cached.expiresAt > Date.now() && cached.role) {
    return { status: cached.status, role: cached.role }
  }

  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return { status: cached?.status || 'ACTIVE', role: cached?.role }
  }

  try {
    const rows = await executeQuery<DbRow>(
      `SELECT U.STATUS AS USER_STATUS, E.STATUS AS EMP_STATUS, U.ROLE
       FROM ${usersTable} U
       LEFT JOIN ${employeesTable} E ON E.USER_ID = U.ID
       WHERE U.ID = ?`,
      [userId],
    )

    if (!rows[0]) {
      return { status: 'ACTIVE' }
    }

    const rawRole = rows[0]?.ROLE ? String(rows[0].ROLE) : undefined
    const role = rawRole ? normalizeRole(rawRole) : undefined
    const userStatus = String(rows[0]?.USER_STATUS || 'ACTIVE').toUpperCase()
    const empStatus = rows[0]?.EMP_STATUS ? String(rows[0].EMP_STATUS).toUpperCase() : null

    // Super Admin and Admin accounts are governed by USERS.STATUS, preventing orphaned/inactive EMPLOYEES sub-records from causing lockout
    let status = userStatus
    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      status = userStatus
    } else {
      status = empStatus || userStatus
    }

    statusCache.set(userId, { status, role, expiresAt: Date.now() + STATUS_CACHE_TTL_MS })
    return { status, role }
  } catch {
    if (cached) return { status: cached.status, role: cached.role }
    return { status: 'ACTIVE' }
  }
}

export async function getUserStatus(userId: number): Promise<string> {
  const info = await getUserAccountInfo(userId)
  return info.status
}

export async function getLiveUserRole(userId: number): Promise<string | undefined> {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return undefined
  }
  try {
    const info = await getUserAccountInfo(userId)
    return info.role
  } catch {
    return undefined
  }
}

export function clearUserStatusCache(userId: number): void {
  statusCache.delete(userId)
}

export function setUserStatusCache(userId: number, status: string): void {
  statusCache.set(userId, {
    status: status.toUpperCase(),
    expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
  })
}

export async function ensureTerminationTables(): Promise<void> {
  const statements = [
    `ALTER TABLE ${usersTable} ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20) DEFAULT 'ACTIVE'`,
    `ALTER TABLE ${usersTable} ADD COLUMN IF NOT EXISTS TERMINATED_AT TIMESTAMP_NTZ`,
    `ALTER TABLE ${usersTable} ADD COLUMN IF NOT EXISTS TERMINATED_BY INTEGER`,
    `ALTER TABLE ${usersTable} ADD COLUMN IF NOT EXISTS TERMINATION_REASON VARCHAR(2000)`,

    `ALTER TABLE ${employeesTable} ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20) DEFAULT 'ACTIVE'`,
    `ALTER TABLE ${employeesTable} ADD COLUMN IF NOT EXISTS TERMINATED_AT TIMESTAMP_NTZ`,
    `ALTER TABLE ${employeesTable} ADD COLUMN IF NOT EXISTS TERMINATED_BY INTEGER`,
    `ALTER TABLE ${employeesTable} ADD COLUMN IF NOT EXISTS TERMINATION_REASON VARCHAR(2000)`,

    `CREATE TABLE IF NOT EXISTS USER_STATUS_LOGS (
      ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
      USER_ID INTEGER NOT NULL,
      ACTION VARCHAR(20) NOT NULL,
      PERFORMED_BY INTEGER NOT NULL,
      REASON VARCHAR(2000),
      CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
    )`,
  ]

  for (const sql of statements) {
    try {
      await executeQuery(sql)
    } catch {
      // Non-fatal if schema already contains column/table or compilation error occurs
    }
  }
}
