import crypto from 'node:crypto'
import { executeQuery } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { AuthenticatedUser, createToken } from '../utils/jwt'
import { logger } from '../utils/logger'
import { comparePassword, hashPassword } from '../utils/password'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { sendPasswordResetEmail } from './email.service'

const usersTable = snowflakeTable('USERS')
const employeesTable = snowflakeTable('EMPLOYEES')
const passwordResetTokensTable = snowflakeTable('PASSWORD_RESET_TOKENS')

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
}

export interface LoginResult {
  token: string
  user: AuthenticatedUser
}

export interface AuthServiceContract {
  register(fullName: string, email: string, password: string): Promise<void>
  login(email: string, password: string): Promise<LoginResult>
  getUserById(id: number): Promise<AuthenticatedUser>
  listUsers(): Promise<AuthenticatedUser[]>
  forgotPassword(email: string, origin?: string): Promise<void>
  resetPassword(token: string, newPassword: string): Promise<void>
}

async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  // Keep user input in binds, never in SQL text.
  const rows = await executeQuery<UserRow>(
    `SELECT ID, FULL_NAME, EMAIL, PASSWORD_HASH, ROLE FROM ${usersTable} WHERE EMAIL = ?`,
    [email],
  )
  return rows[0]
}

function toSafeUser(user: UserRow): AuthenticatedUser {
  return {
    id: Number(user.ID),
    fullName: user.FULL_NAME,
    email: user.EMAIL,
    role: user.ROLE === 'USER' ? 'EMPLOYEE' : user.ROLE,
  }
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
    await executeQuery(
      `INSERT INTO ${employeesTable} (USER_ID, EMPLOYEE_CODE, STATUS)
       SELECT ID, 'EMP-' || LPAD(ID::VARCHAR, 6, '0'), 'ACTIVE' FROM ${usersTable} WHERE ID = ?`,
      [createdUser.ID],
    )
  },

  async login(email, password) {
    const user = await findUserByEmail(email)
    if (!user || !(await comparePassword(password, user.PASSWORD_HASH))) {
      throw new HttpError(401, 'Invalid email or password')
    }

    await executeQuery(`UPDATE ${usersTable} SET LAST_LOGIN = CURRENT_TIMESTAMP() WHERE ID = ?`, [user.ID])
    const safeUser = toSafeUser(user)
    return { token: createToken(toTokenPayload(safeUser)), user: safeUser }
  },

  async getUserById(id) {
    const rows = await executeQuery<UserRow>(
      `SELECT ID, FULL_NAME, EMAIL, ROLE FROM ${usersTable} WHERE ID = ?`,
      [id],
    )
    if (!rows[0]) {
      throw new HttpError(404, 'User not found')
    }
    return toSafeUser(rows[0])
  },

  async listUsers() {
    const rows = await executeQuery<UserRow>(
      `SELECT ID, FULL_NAME, EMAIL, ROLE FROM ${usersTable} ORDER BY ID`,
    )
    return rows.map(toSafeUser)
  },

  async forgotPassword(email: string, clientOrigin?: string) {
    const user = await findUserByEmail(email)
    if (!user) {
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
      interface TokenRow {
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
