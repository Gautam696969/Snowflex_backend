import { executeQuery } from '../config/snowflake'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { webpushService } from './webpush.service'
import { logger } from '../utils/logger'

const reminderLogsTable = snowflakeTable('SHIFT_REMINDER_LOGS')
const employeesTable = snowflakeTable('EMPLOYEES')
const usersTable = snowflakeTable('USERS')
const attendanceTable = snowflakeTable('ATTENDANCE')
const leaveRequestsTable = snowflakeTable('LEAVE_REQUESTS')

export type ShiftReminderType = 'SHIFT_START' | 'SHIFT_END'

function parseHHMMToMinutes(hhmm: string, fallbackMinutes: number): number {
  const m = /^(\d{2}):(\d{2})$/.exec((hhmm || '').trim())
  if (!m) return fallbackMinutes
  const hours = Number(m[1])
  const mins = Number(m[2])
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return fallbackMinutes
  return hours * 60 + mins
}

function getKolkataDateAndMinutes(): { dateStr: string; minutesOfDay: number; dayOfWeek: string } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now)

  const get = (type: string) => parts.find((p) => p.type === type)?.value || ''
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  return {
    dateStr,
    minutesOfDay: hour * 60 + minute,
    dayOfWeek: get('weekday'),
  }
}

export const shiftReminderService = {
  async ensureTables(): Promise<void> {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS ${reminderLogsTable} (
          ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
          USER_ID INTEGER NOT NULL,
          REMINDER_DATE VARCHAR(20) NOT NULL,
          REMINDER_TYPE VARCHAR(32) NOT NULL,
          SENT_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
        )
      `)
    } catch {
      // Safe no-op if already created
    }
  },

  async runTick(): Promise<void> {
    const { dateStr, minutesOfDay, dayOfWeek } = getKolkataDateAndMinutes()
    // Optional: skip Sunday if needed; by default run Mon-Sat or every day configured
    if (dayOfWeek === 'Sun' && process.env.SHIFT_REMINDER_SKIP_SUNDAY === 'true') {
      return
    }

    const startMin = parseHHMMToMinutes(process.env.ATTENDANCE_START_TIME || '09:00', 9 * 60)
    const endMin = parseHHMMToMinutes(process.env.ATTENDANCE_END_TIME || '18:00', 18 * 60)

    let reminderType: ShiftReminderType | null = null
    if (minutesOfDay === startMin - 5) {
      reminderType = 'SHIFT_START'
    } else if (minutesOfDay === endMin - 5) {
      reminderType = 'SHIFT_END'
    }

    if (!reminderType) return

    try {
      const employees = await executeQuery<Record<string, unknown>>(
        `SELECT E.ID AS EMPLOYEE_ID, E.USER_ID, U.FULL_NAME
         FROM ${employeesTable} E
         JOIN ${usersTable} U ON U.ID = E.USER_ID
         WHERE COALESCE(E.STATUS, 'ACTIVE') = 'ACTIVE'`
      )

      if (employees.length === 0) return

      // Employees on APPROVED leave today
      const leaveRows = await executeQuery<Record<string, unknown>>(
        `SELECT EMPLOYEE_ID FROM ${leaveRequestsTable}
         WHERE STATUS = 'APPROVED' AND START_DATE <= ? AND END_DATE >= ?`,
        [dateStr, dateStr]
      ).catch(() => [])
      const onLeaveEmpIds = new Set(leaveRows.map((r) => Number(r.EMPLOYEE_ID)))

      // Today's attendance records
      const attRows = await executeQuery<Record<string, unknown>>(
        `SELECT EMPLOYEE_ID, CHECK_IN, CHECK_OUT FROM ${attendanceTable}
         WHERE ATTENDANCE_DATE = ?`,
        [dateStr]
      ).catch(() => [])
      const attMap = new Map<number, { checkedIn: boolean; checkedOut: boolean }>()
      for (const a of attRows) {
        attMap.set(Number(a.EMPLOYEE_ID), {
          checkedIn: Boolean(a.CHECK_IN),
          checkedOut: Boolean(a.CHECK_OUT),
        })
      }

      // Already-sent reminders today (deduplication)
      const sentRows = await executeQuery<Record<string, unknown>>(
        `SELECT USER_ID FROM ${reminderLogsTable}
         WHERE REMINDER_DATE = ? AND REMINDER_TYPE = ?`,
        [dateStr, reminderType]
      ).catch(() => [])
      const alreadySentUserIds = new Set(sentRows.map((r) => Number(r.USER_ID)))

      for (const emp of employees) {
        const employeeId = Number(emp.EMPLOYEE_ID)
        const userId = Number(emp.USER_ID)
        if (!userId || alreadySentUserIds.has(userId) || onLeaveEmpIds.has(employeeId)) {
          continue
        }

        const att = attMap.get(employeeId)
        if (reminderType === 'SHIFT_START' && att?.checkedIn) {
          continue // Already checked in
        }
        if (reminderType === 'SHIFT_END' && (!att?.checkedIn || att.checkedOut)) {
          continue // Not checked in or already checked out
        }

        const payload =
          reminderType === 'SHIFT_START'
            ? {
                title: 'Shift Reminder',
                body: 'Check-in in 5 minutes',
                url: '/dashboard?view=attendance',
                type: 'SHIFT_START_REMINDER',
              }
            : {
                title: 'Shift Wrap-Up Reminder',
                body: 'Check-out in 5 minutes',
                url: '/dashboard?view=attendance',
                type: 'SHIFT_END_REMINDER',
              }

        await executeQuery(
          `INSERT INTO ${reminderLogsTable} (USER_ID, REMINDER_DATE, REMINDER_TYPE) VALUES (?, ?, ?)`,
          [userId, dateStr, reminderType]
        ).catch(() => {})

        await webpushService.sendToUser(userId, payload).catch((err) => {
          logger.warn(`[SHIFT_REMINDER] Failed push for user ${userId}:`, err)
        })
      }
    } catch (err) {
      logger.warn('[SHIFT_REMINDER] Tick error:', err)
    }
  },
}

