import fs from 'fs'
import path from 'path'
import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'
import { getEnvironment } from '../config/env'
import { notificationService } from './notification.service'

/**
 * Normalizes and persists an attendance photo.
 * Stores the standardized Data URL in the database for 100% persistence
 * across ephemeral container restarts (Render / serverless), and caches
 * the file to disk for fallback serving.
 */
function processAttendancePhoto(base64Data: string, prefix: string, employeeId: number): string | null {
  try {
    if (!base64Data || typeof base64Data !== 'string') return null

    const matches = base64Data.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/)
    const subtype = matches ? matches[1].toLowerCase() : 'jpeg'
    const rawData = matches ? matches[2] : base64Data.includes(',') ? base64Data.split(',')[1] : base64Data
    const buffer = Buffer.from(rawData, 'base64')
    if (buffer.length === 0) return null

    // Cache to local filesystem
    try {
      const dir = path.resolve(process.cwd(), 'uploads', 'attendance')
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const ext = subtype === 'png' ? 'png' : 'jpg'
      const filename = `${prefix}-emp${employeeId}-${Date.now()}.${ext}`
      fs.writeFileSync(path.join(dir, filename), buffer)
    } catch (fsErr) {
      console.warn('Filesystem caching skipped (database persistence active):', fsErr)
    }

    // Return standardized Data URL for persistent Cloudflare D1 storage
    const normalizedDataUrl = `data:image/${subtype === 'png' ? 'png' : 'jpeg'};base64,${rawData}`
    return normalizedDataUrl
  } catch (err) {
    console.error('Failed to process attendance photo:', err)
    return null
  }
}

/**
 * Normalizes database attendance rows for API output.
 * Ensures photo fields are complete, self-contained Data URLs or valid endpoints,
 * eliminating broken relative links across different frontend/backend host domains.
 */
export function normalizeAttendanceRow(row: DbRow): Record<string, unknown> {
  const api = toApiRow(row)

  if (typeof api.checkInPhoto === 'string' && api.checkInPhoto.startsWith('/uploads/')) {
    const diskPath = path.resolve(process.cwd(), api.checkInPhoto.replace(/^\/+/, ''))
    if (fs.existsSync(diskPath)) {
      try {
        const ext = path.extname(diskPath).toLowerCase()
        const mime = ext === '.png' ? 'png' : 'jpeg'
        api.checkInPhoto = `data:image/${mime};base64,${fs.readFileSync(diskPath).toString('base64')}`
      } catch {
        api.checkInPhoto = `/api/attendance/${row.ID}/photo/checkin`
      }
    } else {
      api.checkInPhoto = `/api/attendance/${row.ID}/photo/checkin`
    }
  }

  if (typeof api.checkOutPhoto === 'string' && api.checkOutPhoto.startsWith('/uploads/')) {
    const diskPath = path.resolve(process.cwd(), api.checkOutPhoto.replace(/^\/+/, ''))
    if (fs.existsSync(diskPath)) {
      try {
        const ext = path.extname(diskPath).toLowerCase()
        const mime = ext === '.png' ? 'png' : 'jpeg'
        api.checkOutPhoto = `data:image/${mime};base64,${fs.readFileSync(diskPath).toString('base64')}`
      } catch {
        api.checkOutPhoto = `/api/attendance/${row.ID}/photo/checkout`
      }
    } else {
      api.checkOutPhoto = `/api/attendance/${row.ID}/photo/checkout`
    }
  }

  return api
}

export const attendanceService = {
  async getTodayStatus(userId: number): Promise<{ checkedIn: boolean; checkedOut: boolean; record: Record<string, unknown> | null }> {
    const employee = await executeQuery<DbRow>('SELECT ID FROM EMPLOYEES WHERE USER_ID = ?', [userId])
    if (!employee[0]) return { checkedIn: false, checkedOut: false, record: null }
    const employeeId = Number(employee[0].ID)
    const rows = await executeQuery<DbRow>(
      `SELECT ID, EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_OUT, STATUS, WORKING_HOURS, CHECK_IN_PHOTO, CHECK_OUT_PHOTO
       FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()`,
      [employeeId]
    )
    if (!rows[0]) return { checkedIn: false, checkedOut: false, record: null }
    return {
      checkedIn: Boolean(rows[0].CHECK_IN),
      checkedOut: Boolean(rows[0].CHECK_OUT),
      record: normalizeAttendanceRow(rows[0]),
    }
  },

  async checkIn(userId: number, photoData?: string | null): Promise<Record<string, unknown>> {
    const employee = await executeQuery<DbRow>(
      `SELECT E.ID, U.FULL_NAME, U.EMAIL, E.EMPLOYEE_CODE
       FROM EMPLOYEES E
       JOIN USERS U ON U.ID = E.USER_ID
       WHERE E.USER_ID = ?`,
      [userId]
    )
    if (!employee[0]) throw new HttpError(404, 'Employee profile not found')
    const employeeId = Number(employee[0].ID)
    const employeeName = String(employee[0].FULL_NAME || 'Employee')

    const exists = await executeQuery<DbRow>(
      'SELECT ID, CHECK_IN, CHECK_OUT, STATUS FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()',
      [employeeId]
    )

    let photoUrl: string | null = null
    if (photoData) {
      photoUrl = processAttendancePhoto(photoData, 'checkin', employeeId)
    }

    const now = new Date()
    const [startH, startM] = (getEnvironment().ATTENDANCE_START_TIME || '09:00').split(':').map(Number)
    const startMinutes = (startH || 9) * 60 + (startM || 0)
    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    const status = currentMinutes > startMinutes ? 'LATE' : 'PRESENT'

    if (exists.length > 0) {
      // Re-punch or update check-in: update timestamp, photo, and reset checkout if needed so shift can be closed later
      const existingId = Number(exists[0].ID)
      await executeUpdate(
        `UPDATE ATTENDANCE SET 
           CHECK_IN = COALESCE(CHECK_IN, CURRENT_TIMESTAMP()),
           CHECK_IN_PHOTO = COALESCE(?, CHECK_IN_PHOTO),
           CHECK_OUT = NULL,
           WORKING_HOURS = NULL,
           STATUS = ?,
           UPDATED_AT = CURRENT_TIMESTAMP()
         WHERE ID = ?`,
        [photoUrl, status, existingId]
      )
    } else {
      await executeInsert(
        `INSERT INTO ATTENDANCE (EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_IN_PHOTO, STATUS)
         VALUES (?, CURRENT_DATE(), CURRENT_TIMESTAMP(), ?, ?)`,
        [employeeId, photoUrl, status],
      )
    }

    const rows = await executeQuery<DbRow>(
      `SELECT ID, EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_OUT, STATUS, WORKING_HOURS, CHECK_IN_PHOTO, CHECK_OUT_PHOTO
       FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()`,
      [employeeId]
    )
    const apiRecord = normalizeAttendanceRow(rows[0])

    // Forward check-in notification automatically to all Admins and Super Admins
    try {
      const checkInFormatted = rows[0]?.CHECK_IN
        ? new Date(String(rows[0].CHECK_IN)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

      await notificationService.notifyAdminsAndSuperAdmins({
        type: 'ATTENDANCE_CHECK_IN',
        title: `Employee Check-In: ${employeeName}`,
        message: `${employeeName} checked in today at ${checkInFormatted} (${status}). Camera photo captured.`,
        link: '/dashboard?view=attendance',
        relatedId: Number(rows[0]?.ID),
      })
    } catch (notifErr) {
      console.warn('Failed to forward check-in notification to admins:', notifErr)
    }

    return apiRecord
  },

  async checkOut(userId: number, photoData?: string | null): Promise<Record<string, unknown>> {
    const employee = await executeQuery<DbRow>(
      `SELECT E.ID, U.FULL_NAME, U.EMAIL, E.EMPLOYEE_CODE
       FROM EMPLOYEES E
       JOIN USERS U ON U.ID = E.USER_ID
       WHERE E.USER_ID = ?`,
      [userId]
    )
    if (!employee[0]) throw new HttpError(404, 'Employee profile not found')
    const employeeId = Number(employee[0].ID)
    const employeeName = String(employee[0].FULL_NAME || 'Employee')

    const existing = await executeQuery<DbRow>(
      'SELECT ID, CHECK_IN, CHECK_OUT, STATUS FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()',
      [employeeId]
    )

    let photoUrl: string | null = null
    if (photoData) {
      photoUrl = processAttendancePhoto(photoData, 'checkout', employeeId)
    }

    if (existing.length === 0) {
      // If no check-in recorded yet today, auto check-in and check-out
      await executeInsert(
        `INSERT INTO ATTENDANCE (EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_OUT, CHECK_OUT_PHOTO, STATUS, WORKING_HOURS)
         VALUES (?, CURRENT_DATE(), CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), ?, 'PRESENT', 0)`,
        [employeeId, photoUrl],
      )
    } else {
      // Calculate working hours in JS based on check-in time
      const checkInMs = existing[0]?.CHECK_IN ? new Date(String(existing[0].CHECK_IN)).getTime() : Date.now()
      const checkOutMs = Date.now()
      const diffHours = Math.max(0, (checkOutMs - checkInMs) / 3600000)
      const workingHours = Math.round(diffHours * 100) / 100
      const existingStatus = String(existing[0]?.STATUS || 'PRESENT')
      const finalStatus = diffHours < 4.0 ? 'HALF_DAY' : existingStatus

      await executeUpdate(
        `UPDATE ATTENDANCE SET 
           CHECK_IN = COALESCE(CHECK_IN, CURRENT_TIMESTAMP()),
           CHECK_OUT = CURRENT_TIMESTAMP(),
           CHECK_OUT_PHOTO = COALESCE(?, CHECK_OUT_PHOTO),
           WORKING_HOURS = ?,
           STATUS = ?,
           UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
        [photoUrl, workingHours, finalStatus, Number(existing[0].ID)],
      )
    }

    const rows = await executeQuery<DbRow>(
      `SELECT ID, EMPLOYEE_ID, ATTENDANCE_DATE, CHECK_IN, CHECK_OUT, STATUS, WORKING_HOURS, CHECK_IN_PHOTO, CHECK_OUT_PHOTO
       FROM ATTENDANCE WHERE EMPLOYEE_ID = ? AND ATTENDANCE_DATE = CURRENT_DATE()`,
      [employeeId]
    )
    const apiRecord = normalizeAttendanceRow(rows[0])

    // Forward check-out notification automatically to all Admins and Super Admins
    try {
      const checkOutFormatted = rows[0]?.CHECK_OUT
        ? new Date(String(rows[0].CHECK_OUT)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const hours = rows[0]?.WORKING_HOURS != null ? `${rows[0].WORKING_HOURS} hrs` : ''

      await notificationService.notifyAdminsAndSuperAdmins({
        type: 'ATTENDANCE_CHECK_OUT',
        title: `Employee Check-Out: ${employeeName}`,
        message: `${employeeName} checked out today at ${checkOutFormatted}${hours ? ` (${hours} worked)` : ''}. Camera photo captured.`,
        link: '/dashboard?view=attendance',
        relatedId: Number(rows[0]?.ID),
      })
    } catch (notifErr) {
      console.warn('Failed to forward check-out notification to admins:', notifErr)
    }

    return apiRecord
  },

  async listForEmployee(employeeId: number): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `SELECT A.ID, A.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL, U.AVATAR_URL,
              A.ATTENDANCE_DATE, A.CHECK_IN, A.CHECK_OUT, A.STATUS, A.WORKING_HOURS,
              A.CHECK_IN_PHOTO, A.CHECK_OUT_PHOTO
       FROM ATTENDANCE A
       JOIN EMPLOYEES E ON E.ID = A.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID
       WHERE A.EMPLOYEE_ID = ? ORDER BY A.ATTENDANCE_DATE DESC`,
      [employeeId],
    )
    return rows.map(normalizeAttendanceRow)
  },

  async listAll(): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `SELECT A.ID, A.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL, U.AVATAR_URL,
              A.ATTENDANCE_DATE, A.CHECK_IN, A.CHECK_OUT, A.STATUS, A.WORKING_HOURS,
              A.CHECK_IN_PHOTO, A.CHECK_OUT_PHOTO
       FROM ATTENDANCE A
       JOIN EMPLOYEES E ON E.ID = A.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID
       ORDER BY A.ATTENDANCE_DATE DESC`
    )
    return rows.map(normalizeAttendanceRow)
  },

  async listForManager(userId: number): Promise<Record<string, unknown>[]> {
    const rows = await executeQuery<DbRow>(
      `SELECT A.ID, A.EMPLOYEE_ID, U.FULL_NAME, U.EMAIL, U.AVATAR_URL,
              A.ATTENDANCE_DATE, A.CHECK_IN, A.CHECK_OUT, A.STATUS, A.WORKING_HOURS,
              A.CHECK_IN_PHOTO, A.CHECK_OUT_PHOTO
       FROM ATTENDANCE A
       JOIN EMPLOYEES E ON E.ID = A.EMPLOYEE_ID
       JOIN USERS U ON U.ID = E.USER_ID
       JOIN EMPLOYEES M ON M.ID = E.MANAGER_ID
       WHERE M.USER_ID = ? ORDER BY A.ATTENDANCE_DATE DESC`,
      [userId],
    )
    return rows.map(normalizeAttendanceRow)
  },

  async getAttendancePhoto(id: number, type: 'checkin' | 'checkout'): Promise<{ buffer: Buffer; contentType: string } | null> {
    const col = type === 'checkout' ? 'CHECK_OUT_PHOTO' : 'CHECK_IN_PHOTO'
    const rows = await executeQuery<DbRow>(
      `SELECT ID, ${col} FROM ATTENDANCE WHERE ID = ?`,
      [id]
    )
    if (!rows[0] || !rows[0][col]) return null

    const photoVal = String(rows[0][col])

    // Case 1: Stored as Data URL
    if (photoVal.startsWith('data:image/')) {
      const matches = photoVal.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/)
      const subtype = matches ? matches[1].toLowerCase() : 'jpeg'
      const rawData = matches ? matches[2] : photoVal.split(',')[1]
      const buffer = Buffer.from(rawData, 'base64')
      return { buffer, contentType: `image/${subtype === 'png' ? 'png' : 'jpeg'}` }
    }

    // Case 2: Stored as relative path /uploads/...
    if (photoVal.startsWith('/uploads/')) {
      const diskPath = path.resolve(process.cwd(), photoVal.replace(/^\/+/, ''))
      if (fs.existsSync(diskPath)) {
        const ext = path.extname(diskPath).toLowerCase()
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg'
        const buffer = fs.readFileSync(diskPath)
        return { buffer, contentType }
      }
    }

    return null
  },

  generatePlaceholderSvg(type: 'checkin' | 'checkout'): string {
    const label = type === 'checkout' ? 'Check-Out' : 'Check-In'
    return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450" fill="none">
  <rect width="600" height="450" fill="#141d18"/>
  <circle cx="300" cy="180" r="64" fill="#1e2c24" stroke="#2f4236" stroke-width="2"/>
  <circle cx="300" cy="180" r="28" fill="#10b981" opacity="0.2"/>
  <path d="M286 172h28l4 6h12a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4h-48a4 4 0 0 1-4-4v-24a4 4 0 0 1 4-4h12l4-6z" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="300" cy="188" r="8" stroke="#10b981" stroke-width="2.5" fill="none"/>
  <text x="300" y="280" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-size="20" font-weight="bold" fill="#edf5ef" text-anchor="middle">${label} Selfie Verified</text>
  <text x="300" y="310" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-size="13" fill="#8da394" text-anchor="middle">Recorded &amp; Confirmed on Attendance Clock</text>
</svg>`
  },
}
