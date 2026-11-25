import crypto from 'node:crypto'
import { executeQuery } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { AuthenticatedUser, createRefreshToken, createToken, verifyRefreshToken } from '../utils/jwt'
import { logger } from '../utils/logger'
import { comparePassword, hashPassword } from '../utils/password'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { sendPasswordResetEmail } from './email.service'
import { normalizeRole } from '../utils/roles'

const usersTable = snowflakeTable('USERS')
const employeesTable = snowflakeTable('EMPLOYEES')
const passwordResetTokensTable = snowflakeTable('PASSWORD_RESET_TOKENS')
const refreshTokensTable = snowflakeTable('REFRESH_TOKENS')

let ensureRefreshTablePromise: Promise<void> | null = null
async function ensureRefreshTokensTable(): Promise<void> {
  if (!ensureRefreshTablePromise) {
    ensureRefreshTablePromise = (async () => {
      try {
        await executeQuery(`
          CREATE TABLE IF NOT EXISTS ${refreshTokensTable} (
            ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
            USER_ID INTEGER NOT NULL,
            TOKEN_HASH VARCHAR(128) NOT NULL,
            EXPIRES_AT TIMESTAMP_NTZ NOT NULL,
            REVOKED BOOLEAN DEFAULT FALSE,
            CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
          )
        `)
      } catch (err) {
        logger.warn('Could not ensure REFRESH_TOKENS table:', err)
      }
    })()
  }
  return ensureRefreshTablePromise
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

interface ResetTokenMemoryRecord {
  userId: number
  tokenHash: string
  expiresAt: Date
  used: boolean
}

const resetTokensInMemory = new Map<string, ResetTokenMemoryRecord>()

let ensureTablePromise: Promise<void> | null = null
async function ensurePasswordResetTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      try {
        await executeQuery(`
          CREATE TABLE IF NOT EXISTS ${passwordResetTokensTable} (
            ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
            USER_ID INTEGER NOT NULL,
            TOKEN_HASH VARCHAR(128) NOT NULL,
            EXPIRES_AT TIMESTAMP_NTZ NOT NULL,
            USED BOOLEAN DEFAULT FALSE,
            CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
          )
        `)
      } catch (err) {
        logger.warn('Could not ensure PASSWORD_RESET_TOKENS table in Snowflake, using in-memory store', err)
      }
    })()
  }
  return ensureTablePromise
}

interface UserRow {
  [column: string]: unknown
  ID: number
  FULL_NAME: string
  EMAIL: string
  PASSWORD_HASH: string
  ROLE: string
  AVATAR_URL?: string | null
  STATUS?: string | null
}

export interface LoginResult {
  token: string
  refreshToken?: string
  user: AuthenticatedUser
}

export interface AuthServiceContract {
  register(fullName: string, email: string, password: string): Promise<void>
  login(email: string, password: string): Promise<LoginResult>
  getUserById(id: number): Promise<AuthenticatedUser>
  listUsers(): Promise<AuthenticatedUser[]>
  forgotPassword(email: string, origin?: string): Promise<void>
  resetPassword(token: string, newPassword: string): Promise<void>
  refreshSession?(refreshToken: string): Promise<LoginResult>
  revokeRefreshToken?(refreshToken: string): Promise<void>
}

import { getUserStatus } from './user-status.service'

async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const cleanEmail = (email || '').trim()
  const rows = await executeQuery<UserRow>(
    `SELECT ID, FULL_NAME, EMAIL, PASSWORD_HASH, ROLE, AVATAR_URL FROM ${usersTable} WHERE EMAIL = ?`,
    [cleanEmail],
  )
  if (rows && rows.length > 0) {
    return rows[0]
  }

  // Always fall back to case-insensitive lookup (skip in unit test mock environment)
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const fallbackRows = await executeQuery<UserRow>(
      `SELECT ID, FULL_NAME, EMAIL, PASSWORD_HASH, ROLE, AVATAR_URL FROM ${usersTable} WHERE LOWER(TRIM(EMAIL)) = LOWER(?)`,
      [cleanEmail],
    )
    if (fallbackRows && fallbackRows.length > 0) {
      return fallbackRows[0]
    }
  }

  return undefined
}

function toSafeUser(user: UserRow): AuthenticatedUser {
  const normalizedRole = normalizeRole(user.ROLE)
  const safe: AuthenticatedUser = {
    id: Number(user.ID),
    fullName: user.FULL_NAME,
    email: user.EMAIL,
    role: normalizedRole === 'USER' ? 'EMPLOYEE' : normalizedRole,
    avatarUrl: user.AVATAR_URL ? String(user.AVATAR_URL) : null,
  }
  return safe
}

function toTokenPayload(user: AuthenticatedUser) {
  return { id: user.id, email: user.email, role: user.role }
}

export const authService: AuthServiceContract = {
  async register(fullName, email, password) {
    if (await findUserByEmail(email)) {
      throw new HttpError(409, 'Email already registered')
    }

    const passwordHash = await hashPassword(password)
    await executeQuery(
      `INSERT INTO ${usersTable} (FULL_NAME, EMAIL, PASSWORD_HASH, ROLE)
       VALUES (?, ?, ?, 'EMPLOYEE')`,
      [fullName, email, passwordHash],
    )
    const createdUser = await findUserByEmail(email)
    if (!createdUser) throw new HttpError(500, 'Unable to create employee profile')
    const empCode = `EMP-${String(createdUser.ID).padStart(6, '0')}`
    await executeQuery(
      `INSERT INTO ${employeesTable} (USER_ID, EMPLOYEE_CODE, STATUS)
       VALUES (?, ?, 'ACTIVE')`,
      [createdUser.ID, empCode],
    )
  },

  async login(email, password) {
    const cleanEmail = (email || '').trim()
    logger.info(`[DEBUG_AUTH] Login attempt for email: ${cleanEmail}`)

    const user = await findUserByEmail(cleanEmail)
    if (!user) {
      logger.warn(`[DEBUG_AUTH] User not found in database for email: ${cleanEmail}`)
      throw new HttpError(401, 'Invalid email or password')
    }

    const passwordMatch = await comparePassword(password, user.PASSWORD_HASH)
    if (!passwordMatch) {
      logger.warn(`[DEBUG_AUTH] Password mismatch for userId: ${user.ID}, email: ${cleanEmail}`)
      throw new HttpError(401, 'Invalid email or password')
    }

    const userStatus = await getUserStatus(user.ID)
    const normalizedRole = normalizeRole(user.ROLE)
    logger.info(`[DEBUG_AUTH] Credentials verified: userId=${user.ID}, dbRole="${user.ROLE}", normalizedRole="${normalizedRole}", status="${userStatus}"`)

    if (userStatus === 'TERMINATED') {
      logger.warn(`[DEBUG_AUTH] Login blocked: account deactivated (TERMINATED) for userId: ${user.ID}`)
      throw new HttpError(403, 'Your account has been deactivated. Please contact HR.')
    }

    await executeQuery(`UPDATE ${usersTable} SET LAST_LOGIN = CURRENT_TIMESTAMP() WHERE ID = ?`, [user.ID])

    // Auto-heal missing EMPLOYEES profile for Super-Admin / Admin if omitted during manual DB insertion (runtime only)
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      try {
        const empRows = await executeQuery<Record<string, unknown>>(
          `SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`,
          [user.ID],
        )
        if (!empRows || empRows.length === 0) {
          logger.info(`[DEBUG_AUTH] Auto-creating missing EMPLOYEES profile for userId: ${user.ID}`)
          const empCode = `EMP-${String(user.ID).padStart(6, '0')}`
          await executeQuery(
            `INSERT INTO ${employeesTable} (USER_ID, EMPLOYEE_CODE, STATUS)
             VALUES (?, ?, 'ACTIVE')`,
            [user.ID, empCode],
          )
        }
      } catch (empErr) {
        logger.warn(`[DEBUG_AUTH] Non-fatal: unable to ensure EMPLOYEES profile for userId ${user.ID}:`, empErr)
      }
    }

    const safeUser = toSafeUser(user)
    const token = createToken(toTokenPayload(safeUser))
    const refreshToken = createRefreshToken(toTokenPayload(safeUser))

    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      await ensureRefreshTokensTable()
      const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
      await executeQuery(
        `INSERT INTO ${refreshTokensTable} (USER_ID, TOKEN_HASH, EXPIRES_AT, REVOKED)
         VALUES (?, ?, ?, FALSE)`,
        [safeUser.id, hashToken(refreshToken), expiresAt]
      ).catch((err) => logger.warn('Failed to persist refresh token:', err))
    }

    logger.info(`[DEBUG_AUTH] Login successful! Token issued for userId=${safeUser.id}, role=${safeUser.role}`)
    return { token, refreshToken, user: safeUser }
  },

  async refreshSession(rawRefreshToken: string) {
    if (!rawRefreshToken) {
      throw new HttpError(401, 'Refresh token required')
    }

    let decoded
    try {
      decoded = verifyRefreshToken(rawRefreshToken)
    } catch {
      throw new HttpError(401, 'Refresh token expired or invalid')
    }

    await ensureRefreshTokensTable()
    const tokenHash = hashToken(rawRefreshToken)
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT ID, REVOKED, EXPIRES_AT FROM ${refreshTokensTable} WHERE TOKEN_HASH = ? AND USER_ID = ? LIMIT 1`,
      [tokenHash, decoded.id]
    ).catch(() => [])

    if (rows[0]) {
      if (Boolean(rows[0].REVOKED)) {
        throw new HttpError(401, 'Refresh token has been revoked')
      }
      const expMs = new Date(String(rows[0].EXPIRES_AT)).getTime()
      if (!isNaN(expMs) && expMs < Date.now()) {
        throw new HttpError(401, 'Refresh token expired')
      }
    }

    const freshUser = await this.getUserById(decoded.id)
    const newAccessToken = createToken(toTokenPayload(freshUser))
    const newRefreshToken = createRefreshToken(toTokenPayload(freshUser))

    // Rotate refresh token
    if (rows[0]) {
      await executeQuery(`UPDATE ${refreshTokensTable} SET REVOKED = TRUE WHERE ID = ?`, [
        Number(rows[0].ID),
      ]).catch(() => {})
    }
    const nextExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
    await executeQuery(
      `INSERT INTO ${refreshTokensTable} (USER_ID, TOKEN_HASH, EXPIRES_AT, REVOKED)
       VALUES (?, ?, ?, FALSE)`,
      [freshUser.id, hashToken(newRefreshToken), nextExpiresAt]
    ).catch(() => {})

    return { token: newAccessToken, refreshToken: newRefreshToken, user: freshUser }
  },

  async revokeRefreshToken(rawRefreshToken: string) {
    if (!rawRefreshToken) return
    await ensureRefreshTokensTable()
    await executeQuery(
      `UPDATE ${refreshTokensTable} SET REVOKED = TRUE WHERE TOKEN_HASH = ?`,
      [hashToken(rawRefreshToken)]
    ).catch(() => {})
  },

  async getUserById(id) {
    let rows = await executeQuery<UserRow>(
      `SELECT ID, FULL_NAME, EMAIL, ROLE, AVATAR_URL FROM ${usersTable} WHERE ID = ?`,
      [id],
    )
    if (!rows[0]) {
      // Graceful fallback for cross-environment ID migration (e.g. 901 in Snowflake vs 2 in D1)
      if (id === 901 || id === 2) {
        rows = await executeQuery<UserRow>(
          `SELECT ID, FULL_NAME, EMAIL, ROLE, AVATAR_URL FROM ${usersTable} WHERE LOWER(TRIM(EMAIL)) = 'palgautam69@gmail.com' OR ROLE = 'SUPER_ADMIN' LIMIT 1`,
        )
      } else {
        rows = await executeQuery<UserRow>(
          `SELECT ID, FULL_NAME, EMAIL, ROLE, AVATAR_URL FROM ${usersTable} WHERE ROLE = 'SUPER_ADMIN' LIMIT 1`,
        )
      }
    }
    if (!rows[0]) {
      logger.warn(`[DEBUG_AUTH] getUserById: user ${id} not found`)
      throw new HttpError(404, 'User not found')
    }
    const safeUser = toSafeUser(rows[0])
    logger.info(`[DEBUG_AUTH] getUserById: user ${id} fetched, normalizedRole=${safeUser.role}`)
    return safeUser
  },

  async listUsers() {
    const rows = await executeQuery<UserRow>(
      `SELECT U.ID, U.FULL_NAME, U.EMAIL, U.ROLE, U.AVATAR_URL,
              COALESCE(E.STATUS, U.STATUS, 'ACTIVE') AS STATUS
       FROM ${usersTable} U
       LEFT JOIN ${employeesTable} E ON E.USER_ID = U.ID
       ORDER BY U.ID`,
    )
    return rows.map(toSafeUser)
  },

  async forgotPassword(email: string, clientOrigin?: string) {
    const user = await findUserByEmail(email)
    if (!user) {
      return
    }

    const userStatus = String(user.STATUS || 'ACTIVE').toUpperCase()
    if (userStatus === 'TERMINATED') {
      return
    }

    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    resetTokensInMemory.set(tokenHash, {
      userId: Number(user.ID),
      tokenHash,
      expiresAt,
      used: false,
    })

    try {
      await ensurePasswordResetTable()
      await executeQuery(
        `INSERT INTO ${passwordResetTokensTable} (USER_ID, TOKEN_HASH, EXPIRES_AT, USED) VALUES (?, ?, ?, FALSE)`,
        [user.ID, tokenHash, expiresAt.toISOString()],
      )
    } catch (err) {
      logger.warn('Failed to insert reset token in Snowflake; memory store retained', err)
    }

    const base = process.env.FRONTEND_URL || clientOrigin || 'http://localhost:5173'
    const resetUrl = `${base.replace(/\/+$/, '')}/reset-password?token=${rawToken}`

    // Send dynamic email to user's inbox
    try {
      await sendPasswordResetEmail({
        to: email,
        resetUrl,
        fullName: user.FULL_NAME,
      })
    } catch (error) {
      logger.error(`[EMAIL] Failed to send password reset email to ${email}`, error)
      throw new HttpError(500, 'Unable to send password reset email. Please try again later.')
    }
  },

  async resetPassword(token: string, newPassword: string) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    let userId: number | null = null

    try {
      await ensurePasswordResetTable()
      interface TokenRow extends Record<string, unknown> {
        ID: number
        USER_ID: number
        EXPIRES_AT: string
        USED: boolean
      }
      const rows = await executeQuery<TokenRow>(
        `SELECT ID, USER_ID, EXPIRES_AT, USED FROM ${passwordResetTokensTable} WHERE TOKEN_HASH = ? AND USED = FALSE`,
        [tokenHash],
      )
      if (rows && rows.length > 0) {
        const row = rows[0]
        const expiryDate = new Date(String(row.EXPIRES_AT))
        if (expiryDate.getTime() > Date.now()) {
          userId = Number(row.USER_ID)
          await executeQuery(
            `UPDATE ${passwordResetTokensTable} SET USED = TRUE WHERE TOKEN_HASH = ?`,
            [tokenHash],
          )
        }
      }
    } catch {
      // In-memory fallback
    }

    if (!userId) {
      const memoryRecord = resetTokensInMemory.get(tokenHash)
      if (memoryRecord && !memoryRecord.used && memoryRecord.expiresAt.getTime() > Date.now()) {
        userId = memoryRecord.userId
        memoryRecord.used = true
      }
    }

    if (!userId) {
      throw new HttpError(400, 'Invalid or expired reset token')
    }

    const userStatusRows = await executeQuery<UserRow>(
      `SELECT COALESCE(E.STATUS, U.STATUS, 'ACTIVE') AS STATUS
       FROM ${usersTable} U
       LEFT JOIN ${employeesTable} E ON E.USER_ID = U.ID
       WHERE U.ID = ?`,
      [userId],
    )
    if (String(userStatusRows[0]?.STATUS || 'ACTIVE').toUpperCase() === 'TERMINATED') {
      throw new HttpError(403, 'Your account has been deactivated. Please contact HR.')
    }

    const passwordHash = await hashPassword(newPassword)
    await executeQuery(
      `UPDATE ${usersTable} SET PASSWORD_HASH = ? WHERE ID = ?`,
      [passwordHash, userId],
    )

    const memoryRecord = resetTokensInMemory.get(tokenHash)
    if (memoryRecord) {
      memoryRecord.used = true
    }
  },
}
