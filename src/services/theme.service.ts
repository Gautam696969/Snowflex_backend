import { executeQuery, isSnowflakeConnected } from '../config/snowflake'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { HttpError } from '../utils/http-error'
import { normalizeRole } from '../utils/roles'
import { authService } from './auth.service'
import { getSocketServer } from '../socket/socket.server'
import type { UserTheme, SetThemeInput } from '../types/theme.types'

const userThemesTable = snowflakeTable('USER_THEMES')

// In-memory store for fallback / fast cache
const userThemesMap = new Map<number, UserTheme>()

let tableEnsuredPromise: Promise<void> | null = null

export async function ensureThemeTables(): Promise<void> {
  if (!tableEnsuredPromise) {
    tableEnsuredPromise = (async () => {
      try {
        await executeQuery(`
          CREATE TABLE IF NOT EXISTS ${userThemesTable} (
            ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
            USER_ID INTEGER NOT NULL UNIQUE,
            MODE VARCHAR(10),
            BG_COLOR VARCHAR(20),
            PRIMARY_COLOR VARCHAR(20),
            ACCENT_COLOR VARCHAR(20),
            SIDEBAR_COLOR VARCHAR(20),
            CARD_COLOR VARCHAR(20),
            TEXT_COLOR VARCHAR(20),
            UPDATED_BY INTEGER,
            CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
            UPDATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
          )
        `)
        // Ensure MODE column exists on preexisting tables
        await executeQuery(`ALTER TABLE ${userThemesTable} ADD COLUMN IF NOT EXISTS MODE VARCHAR(10)`).catch(() => {})
      } catch (err) {
        // Fallback gracefully to in-memory store in mock environments or before table creation
      }
    })()
  }
  return tableEnsuredPromise
}

export function assertThemePermissions(
  requesterRole: string,
  requesterId: number,
  targetRole: string,
  targetUserId: number
): void {
  const normReq = normalizeRole(requesterRole)
  const normTarget = normalizeRole(targetRole)

  // Super Admin can change theme of ANY user, including themselves
  if (normReq === 'SUPER_ADMIN') {
    return
  }

  // Admin rules
  if (normReq === 'ADMIN') {
    // Admin CAN NEVER change theme of a Super Admin
    if (normTarget === 'SUPER_ADMIN') {
      throw new HttpError(403, 'Forbidden: Administrators cannot modify themes for Super Admins.')
    }

    // Admin can change their own theme
    if (requesterId === targetUserId) {
      return
    }

    // Admin can change theme for Manager, HR, and Employee
    if (['MANAGER', 'HR', 'EMPLOYEE', 'USER'].includes(normTarget)) {
      return
    }

    // Admin cannot change another Admin's theme
    throw new HttpError(403, 'Forbidden: Administrators cannot modify themes for other Administrators.')
  }

  // All other roles (Manager, HR, Employee) cannot modify custom themes
  throw new HttpError(403, 'Forbidden: You do not have permission to modify custom themes.')
}

export function assertBulkThemePermissions(requesterRole: string, targetRole: string): void {
  const normReq = normalizeRole(requesterRole)
  const normTarget = normalizeRole(targetRole)

  if (normReq === 'SUPER_ADMIN') {
    return
  }

  if (normReq === 'ADMIN') {
    if (normTarget === 'SUPER_ADMIN') {
      throw new HttpError(403, 'Forbidden: Administrators cannot bulk modify themes for Super Admins.')
    }
    if (normTarget === 'ADMIN') {
      throw new HttpError(403, 'Forbidden: Administrators cannot bulk modify themes for Administrators.')
    }
    if (['MANAGER', 'HR', 'EMPLOYEE', 'USER'].includes(normTarget)) {
      return
    }
  }

  throw new HttpError(403, 'Forbidden: You do not have permission to bulk modify themes.')
}

function rowToUserTheme(row: Record<string, unknown>): UserTheme {
  return {
    id: row.ID != null ? Number(row.ID) : undefined,
    userId: Number(row.USER_ID),
    mode: row.MODE ? (String(row.MODE).toLowerCase() as 'light' | 'dark') : null,
    bgColor: row.BG_COLOR ? String(row.BG_COLOR) : null,
    primaryColor: row.PRIMARY_COLOR ? String(row.PRIMARY_COLOR) : null,
    accentColor: row.ACCENT_COLOR ? String(row.ACCENT_COLOR) : null,
    sidebarColor: row.SIDEBAR_COLOR ? String(row.SIDEBAR_COLOR) : null,
    cardColor: row.CARD_COLOR ? String(row.CARD_COLOR) : null,
    textColor: row.TEXT_COLOR ? String(row.TEXT_COLOR) : null,
    updatedBy: row.UPDATED_BY != null ? Number(row.UPDATED_BY) : null,
    createdAt: row.CREATED_AT ? new Date(String(row.CREATED_AT)).toISOString() : new Date().toISOString(),
    updatedAt: row.UPDATED_AT ? new Date(String(row.UPDATED_AT)).toISOString() : new Date().toISOString(),
  }
}

export const themeService = {
  async getThemeByUserId(userId: number): Promise<UserTheme | null> {
    await ensureThemeTables()

    // Check Snowflake if connected
    if (isSnowflakeConnected()) {
      try {
        const rows = await executeQuery<Record<string, unknown>>(
          `SELECT ID, USER_ID, MODE, BG_COLOR, PRIMARY_COLOR, ACCENT_COLOR, SIDEBAR_COLOR, CARD_COLOR, TEXT_COLOR, UPDATED_BY, CREATED_AT, UPDATED_AT
           FROM ${userThemesTable}
           WHERE USER_ID = ?`,
          [userId]
        )
        if (rows[0]) {
          const theme = rowToUserTheme(rows[0])
          userThemesMap.set(userId, theme)
          return theme
        }
      } catch (err) {
        // Fall back to memory
      }
    }

    // In-memory lookup
    return userThemesMap.get(userId) || null
  },

  async setTheme(targetUserId: number, input: SetThemeInput, updatedBy: number): Promise<UserTheme> {
    await ensureThemeTables()

    const now = new Date().toISOString()
    const existing = userThemesMap.get(targetUserId)
    const themeRecord: UserTheme = {
      userId: targetUserId,
      mode: input.mode !== undefined ? input.mode : (existing?.mode || null),
      bgColor: input.bgColor !== undefined ? input.bgColor : (existing?.bgColor || '#f4f6f1'),
      primaryColor: input.primaryColor !== undefined ? input.primaryColor : (existing?.primaryColor || '#193c33'),
      accentColor: input.accentColor !== undefined ? input.accentColor : (existing?.accentColor || '#ed6b4f'),
      sidebarColor: input.sidebarColor !== undefined ? input.sidebarColor : (existing?.sidebarColor || null),
      cardColor: input.cardColor !== undefined ? input.cardColor : (existing?.cardColor || null),
      textColor: input.textColor !== undefined ? input.textColor : (existing?.textColor || null),
      updatedBy,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
    }

    // Update in-memory
    userThemesMap.set(targetUserId, themeRecord)

    // Update in Snowflake if connected
    if (isSnowflakeConnected()) {
      try {
        await executeQuery(
          `MERGE INTO ${userThemesTable} AS target
           USING (SELECT ? AS USER_ID) AS src
           ON target.USER_ID = src.USER_ID
           WHEN MATCHED THEN
             UPDATE SET
               MODE = ?,
               BG_COLOR = ?,
               PRIMARY_COLOR = ?,
               ACCENT_COLOR = ?,
               SIDEBAR_COLOR = ?,
               CARD_COLOR = ?,
               TEXT_COLOR = ?,
               UPDATED_BY = ?,
               UPDATED_AT = CURRENT_TIMESTAMP()
           WHEN NOT MATCHED THEN
             INSERT (USER_ID, MODE, BG_COLOR, PRIMARY_COLOR, ACCENT_COLOR, SIDEBAR_COLOR, CARD_COLOR, TEXT_COLOR, UPDATED_BY)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            targetUserId,
            themeRecord.mode || null,
            themeRecord.bgColor || null,
            themeRecord.primaryColor || null,
            themeRecord.accentColor || null,
            themeRecord.sidebarColor || null,
            themeRecord.cardColor || null,
            themeRecord.textColor || null,
            updatedBy,
            targetUserId,
            themeRecord.mode || null,
            themeRecord.bgColor || null,
            themeRecord.primaryColor || null,
            themeRecord.accentColor || null,
            themeRecord.sidebarColor || null,
            themeRecord.cardColor || null,
            themeRecord.textColor || null,
            updatedBy,
          ]
        )
      } catch (err) {
        // Memory copy remains active
      }
    }

    // Real-time broadcast to target user via socket
    const io = getSocketServer()
    if (io) {
      io.to(`user:${targetUserId}`).emit('theme:updated', themeRecord)
    }

    return themeRecord
  },

  async setUserMode(userId: number, mode: 'light' | 'dark'): Promise<UserTheme> {
    await ensureThemeTables()
    const existing = await this.getThemeByUserId(userId)
    if (existing) {
      return this.setTheme(
        userId,
        {
          mode,
          bgColor: existing.bgColor,
          primaryColor: existing.primaryColor,
          accentColor: existing.accentColor,
          sidebarColor: existing.sidebarColor,
          cardColor: existing.cardColor,
          textColor: existing.textColor,
        },
        userId
      )
    } else {
      return this.setTheme(userId, { mode }, userId)
    }
  },

  async resetTheme(targetUserId: number): Promise<boolean> {
    await ensureThemeTables()

    userThemesMap.delete(targetUserId)

    if (isSnowflakeConnected()) {
      try {
        await executeQuery(`DELETE FROM ${userThemesTable} WHERE USER_ID = ?`, [targetUserId])
      } catch (err) {
        // Memory copy deleted
      }
    }

    const io = getSocketServer()
    if (io) {
      io.to(`user:${targetUserId}`).emit('theme:reset', { userId: targetUserId })
    }

    return true
  },

  async bulkSetThemeByRole(
    targetRole: string,
    input: SetThemeInput,
    updatedBy: number
  ): Promise<{ affectedCount: number; userIds: number[] }> {
    await ensureThemeTables()

    const normRole = normalizeRole(targetRole)
    const allUsers = await authService.listUsers()
    const targetUsers = allUsers.filter((u) => {
      const uRole = normalizeRole(u.role)
      if (normRole === 'EMPLOYEE' && (uRole === 'EMPLOYEE' || uRole === 'USER')) return true
      return uRole === normRole
    })

    const userIds: number[] = []

    for (const u of targetUsers) {
      await this.setTheme(u.id, input, updatedBy)
      userIds.push(u.id)
    }

    return { affectedCount: userIds.length, userIds }
  },

  // Helper to clear memory for tests
  _clearMemory(): void {
    userThemesMap.clear()
  },
}
