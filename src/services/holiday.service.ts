import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { HttpError } from '../utils/http-error'
import { DbRow } from '../utils/rows'
import { getSocketServer } from '../socket/socket.server'
import { notificationService } from './notification.service'
import { normalizeRole } from '../utils/roles'
import {
  HolidayDto,
  CreateHolidayInput,
  UpdateHolidayInput,
  HolidayFilterQuery,
  HolidayType,
  HolidayStatus,
} from '../types/holiday.types'

const holidaysTable = snowflakeTable('HOLIDAYS')
const usersTable = snowflakeTable('USERS')

// In-memory cache for holiday lists with 60s TTL
interface CacheEntry {
  data: HolidayDto[]
  expiresAt: number
}
const listCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

export function clearHolidayCache(): void {
  listCache.clear()
}

/**
 * Returns current date string formatted as YYYY-MM-DD in Asia/Kolkata timezone
 */
export function getTodayKolkata(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(new Date())
}

/**
 * Normalizes any DB date representation to clean YYYY-MM-DD string
 */
export function toIsoDate(val: unknown): string {
  if (!val) return ''
  if (typeof val === 'string') {
    return val.split('T')[0]
  }
  if (val instanceof Date) {
    const y = val.getFullYear()
    const m = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(val).slice(0, 10)
}

/**
 * Calculate difference in days between two YYYY-MM-DD dates (inclusive)
 */
function calculateDaysCount(startStr: string, endStr: string): number {
  if (!startStr) return 1
  if (!endStr || endStr === startStr) return 1
  try {
    const s = new Date(`${startStr}T00:00:00Z`).getTime()
    const e = new Date(`${endStr}T00:00:00Z`).getTime()
    const diff = Math.round((e - s) / (1000 * 60 * 60 * 24))
    return Math.max(1, diff + 1)
  } catch {
    return 1
  }
}

/**
 * Maps a database row to HolidayDto, adjusting recurring dates to target year if specified
 */
function toHolidayDto(row: DbRow, targetYear?: number): HolidayDto {
  const origStartDate = toIsoDate(row.HOLIDAY_DATE)
  const origEndDate = row.END_DATE ? toIsoDate(row.END_DATE) : origStartDate
  const isRecurring = Boolean(row.IS_RECURRING)

  let holidayDate = origStartDate
  let endDate = origEndDate

  if (isRecurring && targetYear && origStartDate) {
    const parts = origStartDate.split('-')
    if (parts.length === 3) {
      const month = parts[1]
      const day = parts[2]
      holidayDate = `${targetYear}-${month}-${day}`

      // Preserve duration for multi-day recurring holidays
      const durationDays = calculateDaysCount(origStartDate, origEndDate)
      if (durationDays > 1) {
        const startDt = new Date(`${holidayDate}T00:00:00Z`)
        startDt.setUTCDate(startDt.getUTCDate() + (durationDays - 1))
        endDate = startDt.toISOString().slice(0, 10)
      } else {
        endDate = holidayDate
      }
    }
  }

  const daysCount = calculateDaysCount(holidayDate, endDate)

  return {
    id: Number(row.ID),
    name: String(row.NAME || ''),
    description: row.DESCRIPTION ? String(row.DESCRIPTION) : null,
    holidayDate,
    endDate,
    type: (String(row.TYPE || 'PUBLIC').toUpperCase()) as HolidayType,
    color: row.COLOR ? String(row.COLOR) : null,
    isRecurring,
    status: (String(row.STATUS || 'ACTIVE').toUpperCase()) as HolidayStatus,
    createdByName: row.CREATED_BY_NAME ? String(row.CREATED_BY_NAME) : null,
    updatedByName: row.UPDATED_BY_NAME ? String(row.UPDATED_BY_NAME) : null,
    createdAt: row.CREATED_AT ? new Date(String(row.CREATED_AT)).toISOString() : undefined,
    updatedAt: row.UPDATED_AT ? new Date(String(row.UPDATED_AT)).toISOString() : undefined,
    daysCount,
  }
}

export const holidayService = {
  /**
   * Idempotent table check at startup
   */
  async ensureTables(): Promise<void> {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${holidaysTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          NAME VARCHAR(150) NOT NULL,
          DESCRIPTION VARCHAR(1000),
          HOLIDAY_DATE DATE NOT NULL,
          END_DATE DATE,
          TYPE VARCHAR(30) NOT NULL DEFAULT 'PUBLIC',
          COLOR VARCHAR(20),
          IS_RECURRING BOOLEAN NOT NULL DEFAULT FALSE,
          STATUS VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          CREATED_BY INTEGER,
          UPDATED_BY INTEGER,
          CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
          UPDATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
        )
      `)
    } catch (err) {
      console.warn('Could not ensure HOLIDAYS table in Snowflake:', err)
    }
  },

  /**
   * List holidays for a specific year and optional filters
   */
  async list(filter: HolidayFilterQuery = {}): Promise<HolidayDto[]> {
    const currentYear = Number(getTodayKolkata().split('-')[0])
    const year = filter.year ? Number(filter.year) : currentYear
    const month = filter.month ? Number(filter.month) : null
    const typeFilter = filter.type ? String(filter.type).trim().toUpperCase() : null
    const statusFilter = filter.status ? String(filter.status).trim().toUpperCase() : 'ACTIVE'
    const searchQuery = filter.search ? String(filter.search).trim().toLowerCase() : null

    const cacheKey = `${year}:${month ?? 'all'}:${typeFilter ?? 'all'}:${statusFilter}:${searchQuery ?? 'all'}`
    const cached = listCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    let sql = `
      SELECT H.ID, H.NAME, H.DESCRIPTION, H.HOLIDAY_DATE, H.END_DATE, H.TYPE, H.COLOR,
             H.IS_RECURRING, H.STATUS, H.CREATED_AT, H.UPDATED_AT,
             U.FULL_NAME AS CREATED_BY_NAME,
             U2.FULL_NAME AS UPDATED_BY_NAME
      FROM ${holidaysTable} H
      LEFT JOIN ${usersTable} U ON U.ID = H.CREATED_BY
      LEFT JOIN ${usersTable} U2 ON U2.ID = H.UPDATED_BY
      WHERE (
        (H.IS_RECURRING = FALSE AND YEAR(H.HOLIDAY_DATE) = ?)
        OR (H.IS_RECURRING = TRUE)
      )
    `
    const binds: (string | number)[] = [year]

    if (statusFilter !== 'ALL') {
      sql += ' AND H.STATUS = ?'
      binds.push(statusFilter)
    }

    if (typeFilter) {
      sql += ' AND UPPER(H.TYPE) = ?'
      binds.push(typeFilter)
    }

    sql += ' ORDER BY H.HOLIDAY_DATE ASC, H.ID ASC'

    const rows = await executeQuery<DbRow>(sql, binds)

    // Convert rows and map recurring holidays to target year
    let items = rows.map((r) => toHolidayDto(r, year))

    // Apply month filter on effective holidayDate
    if (month && month >= 1 && month <= 12) {
      const monthStr = String(month).padStart(2, '0')
      items = items.filter((item) => {
        const itemMonth = item.holidayDate.split('-')[1]
        const endMonth = item.endDate ? item.endDate.split('-')[1] : itemMonth
        return itemMonth === monthStr || endMonth === monthStr
      })
    }

    // Apply search query filter
    if (searchQuery) {
      items = items.filter((item) =>
        item.name.toLowerCase().includes(searchQuery) ||
        (item.description && item.description.toLowerCase().includes(searchQuery))
      )
    }

    // Sort by effective holidayDate ascending
    items.sort((a, b) => a.holidayDate.localeCompare(b.holidayDate) || a.id - b.id)

    listCache.set(cacheKey, {
      data: items,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })

    return items
  },

  /**
   * Next upcoming holidays (from today onwards)
   */
  async getUpcoming(limit = 5): Promise<HolidayDto[]> {
    const today = getTodayKolkata()
    const currentYear = Number(today.split('-')[0])
    const maxLimit = Math.max(1, Math.min(20, Number(limit) || 5))

    // Fetch this year and next year to handle year rollover smoothly
    const [thisYearItems, nextYearItems] = await Promise.all([
      this.list({ year: currentYear, status: 'ACTIVE' }),
      this.list({ year: currentYear + 1, status: 'ACTIVE' }),
    ])

    const allUpcoming = [...thisYearItems, ...nextYearItems]
      .filter((h) => h.endDate >= today || h.holidayDate >= today)
      .sort((a, b) => a.holidayDate.localeCompare(b.holidayDate) || a.id - b.id)

    // Deduplicate by ID and target date
    const seen = new Set<string>()
    const deduped: HolidayDto[] = []
    for (const item of allUpcoming) {
      const key = `${item.id}-${item.holidayDate}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(item)
      }
      if (deduped.length >= maxLimit) break
    }

    return deduped
  },

  /**
   * Get single holiday by ID
   */
  async getById(id: number): Promise<HolidayDto> {
    const rows = await executeQuery<DbRow>(
      `SELECT H.ID, H.NAME, H.DESCRIPTION, H.HOLIDAY_DATE, H.END_DATE, H.TYPE, H.COLOR,
              H.IS_RECURRING, H.STATUS, H.CREATED_AT, H.UPDATED_AT,
              U.FULL_NAME AS CREATED_BY_NAME,
              U2.FULL_NAME AS UPDATED_BY_NAME
       FROM ${holidaysTable} H
       LEFT JOIN ${usersTable} U ON U.ID = H.CREATED_BY
       LEFT JOIN ${usersTable} U2 ON U2.ID = H.UPDATED_BY
       WHERE H.ID = ?`,
      [id],
    )

    if (!rows[0]) {
      throw new HttpError(404, 'Holiday not found')
    }

    return toHolidayDto(rows[0])
  },

  /**
   * Create a new holiday (SUPER_ADMIN, ADMIN, HR only)
   */
  async create(input: CreateHolidayInput, userId: number): Promise<HolidayDto> {
    const name = input.name.trim()
    const holidayDate = input.holidayDate.trim()
    const endDate = input.endDate ? input.endDate.trim() : holidayDate
    const type = (input.type || 'PUBLIC').toUpperCase()
    const color = input.color ? input.color.trim() : null
    const isRecurring = Boolean(input.isRecurring)
    const description = input.description ? input.description.trim() : null

    // Application-level unique check for duplicate active holiday on same date
    const existing = await executeQuery<DbRow>(
      `SELECT ID FROM ${holidaysTable}
       WHERE UPPER(TRIM(NAME)) = ? AND HOLIDAY_DATE = ? AND STATUS = 'ACTIVE'`,
      [name.toUpperCase(), holidayDate],
    )

    if (existing.length > 0) {
      throw new HttpError(409, `A holiday with name "${name}" already exists on ${holidayDate}`)
    }

    await executeInsert(
      `INSERT INTO ${holidaysTable} (
        NAME, DESCRIPTION, HOLIDAY_DATE, END_DATE, TYPE, COLOR, IS_RECURRING, STATUS,
        CREATED_BY, UPDATED_BY, CREATED_AT, UPDATED_AT
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
      [name, description, holidayDate, endDate, type, color, isRecurring, userId, userId],
    )

    const createdRows = await executeQuery<DbRow>(
      `SELECT H.ID, H.NAME, H.DESCRIPTION, H.HOLIDAY_DATE, H.END_DATE, H.TYPE, H.COLOR,
              H.IS_RECURRING, H.STATUS, H.CREATED_AT, H.UPDATED_AT,
              U.FULL_NAME AS CREATED_BY_NAME,
              U2.FULL_NAME AS UPDATED_BY_NAME
       FROM ${holidaysTable} H
       LEFT JOIN ${usersTable} U ON U.ID = H.CREATED_BY
       LEFT JOIN ${usersTable} U2 ON U2.ID = H.UPDATED_BY
       WHERE UPPER(TRIM(H.NAME)) = ? AND H.HOLIDAY_DATE = ?
       ORDER BY H.CREATED_AT DESC, H.ID DESC
       LIMIT 1`,
      [name.toUpperCase(), holidayDate],
    )

    if (!createdRows[0]) {
      throw new HttpError(500, 'Failed to retrieve created holiday')
    }

    const created = toHolidayDto(createdRows[0])
    clearHolidayCache()

    // Real-time broadcast via Socket.IO
    const io = getSocketServer()
    if (io) {
      io.emit('holiday:changed', { action: 'created', holiday: created })
    }

    // Single bulk notification to all active employees
    void notificationService.notifyAllActiveUsers({
      type: 'HOLIDAY',
      title: 'New Holiday Added',
      message: `${created.name} on ${created.holidayDate}${created.endDate !== created.holidayDate ? ` to ${created.endDate}` : ''}`,
      link: '/dashboard?view=holidays',
      relatedId: created.id,
    })

    return created
  },

  /**
   * Update an existing holiday
   */
  async update(id: number, input: UpdateHolidayInput, userId: number): Promise<HolidayDto> {
    const existing = await executeQuery<DbRow>(
      `SELECT ID, NAME, HOLIDAY_DATE, END_DATE, TYPE, COLOR, IS_RECURRING, STATUS, DESCRIPTION
       FROM ${holidaysTable} WHERE ID = ?`,
      [id],
    )

    if (!existing[0]) {
      throw new HttpError(404, 'Holiday not found')
    }

    const current = existing[0]
    const name = input.name !== undefined ? input.name.trim() : String(current.NAME)
    const holidayDate = input.holidayDate !== undefined ? input.holidayDate.trim() : toIsoDate(current.HOLIDAY_DATE)
    const endDate = input.endDate !== undefined ? (input.endDate ? input.endDate.trim() : holidayDate) : (current.END_DATE ? toIsoDate(current.END_DATE) : holidayDate)
    const type = input.type !== undefined ? input.type.toUpperCase() : String(current.TYPE)
    const color = input.color !== undefined ? (input.color ? input.color.trim() : null) : (current.COLOR ? String(current.COLOR) : null)
    const isRecurring = input.isRecurring !== undefined ? Boolean(input.isRecurring) : Boolean(current.IS_RECURRING)
    const status = input.status !== undefined ? input.status.toUpperCase() : String(current.STATUS)
    const description = input.description !== undefined ? (input.description ? input.description.trim() : null) : (current.DESCRIPTION ? String(current.DESCRIPTION) : null)

    // Validate duplicate if name or holidayDate changed and status is ACTIVE
    if (status === 'ACTIVE') {
      const duplicate = await executeQuery<DbRow>(
        `SELECT ID FROM ${holidaysTable}
         WHERE UPPER(TRIM(NAME)) = ? AND HOLIDAY_DATE = ? AND STATUS = 'ACTIVE' AND ID <> ?`,
        [name.toUpperCase(), holidayDate, id],
      )
      if (duplicate.length > 0) {
        throw new HttpError(409, `A holiday with name "${name}" already exists on ${holidayDate}`)
      }
    }

    await executeUpdate(
      `UPDATE ${holidaysTable}
       SET NAME = ?,
           DESCRIPTION = ?,
           HOLIDAY_DATE = ?,
           END_DATE = ?,
           TYPE = ?,
           COLOR = ?,
           IS_RECURRING = ?,
           STATUS = ?,
           UPDATED_BY = ?,
           UPDATED_AT = CURRENT_TIMESTAMP()
       WHERE ID = ?`,
      [name, description, holidayDate, endDate, type, color, isRecurring, status, userId, id],
    )

    const updated = await this.getById(id)
    clearHolidayCache()

    // Real-time broadcast via Socket.IO
    const io = getSocketServer()
    if (io) {
      io.emit('holiday:changed', { action: 'updated', holiday: updated })
    }

    // Bulk notification to all active employees
    void notificationService.notifyAllActiveUsers({
      type: 'HOLIDAY',
      title: 'Holiday Updated',
      message: `${updated.name} on ${updated.holidayDate}`,
      link: '/dashboard?view=holidays',
      relatedId: updated.id,
    })

    return updated
  },

  /**
   * Delete or soft-cancel a holiday
   */
  async delete(id: number, userId: number, hard = false, userRole = 'EMPLOYEE'): Promise<{ id: number; status: string }> {
    const existing = await executeQuery<DbRow>(
      `SELECT ID, NAME FROM ${holidaysTable} WHERE ID = ?`,
      [id],
    )

    if (!existing[0]) {
      throw new HttpError(404, 'Holiday not found')
    }

    const holidayName = String(existing[0].NAME || 'Holiday')
    const normalized = normalizeRole(userRole)

    if (hard && normalized === 'SUPER_ADMIN') {
      await executeUpdate(`DELETE FROM ${holidaysTable} WHERE ID = ?`, [id])
    } else {
      await executeUpdate(
        `UPDATE ${holidaysTable}
         SET STATUS = 'CANCELLED',
             UPDATED_BY = ?,
             UPDATED_AT = CURRENT_TIMESTAMP()
         WHERE ID = ?`,
        [userId, id],
      )
    }

    clearHolidayCache()

    // Real-time broadcast via Socket.IO
    const io = getSocketServer()
    if (io) {
      io.emit('holiday:changed', {
        action: 'deleted',
        holiday: { id, name: holidayName, status: hard ? 'DELETED' : 'CANCELLED' },
      })
    }

    return { id, status: hard && normalized === 'SUPER_ADMIN' ? 'DELETED' : 'CANCELLED' }
  },
}
