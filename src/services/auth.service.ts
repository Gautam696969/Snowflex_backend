import bcrypt from 'bcryptjs'
import { executeQuery } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { AuthenticatedUser, createToken } from '../utils/jwt'

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
}

async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  // Keep user input in binds, never in SQL text.
  const rows = await executeQuery<UserRow>(
    'SELECT ID, FULL_NAME, EMAIL, PASSWORD_HASH, ROLE FROM USERS WHERE EMAIL = ?',
    [email],
  )
  return rows[0]
}

function toSafeUser(user: UserRow): AuthenticatedUser {
  return {
    id: Number(user.ID),
    fullName: user.FULL_NAME,
    email: user.EMAIL,
    role: user.ROLE,
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

    const passwordHash = await bcrypt.hash(password, 12)
    await executeQuery(
      `INSERT INTO USERS (FULL_NAME, EMAIL, PASSWORD_HASH, ROLE)
       VALUES (?, ?, ?, 'USER')`,
      [fullName, email, passwordHash],
    )
  },

  async login(email, password) {
    const user = await findUserByEmail(email)
    if (!user || !(await bcrypt.compare(password, user.PASSWORD_HASH))) {
      throw new HttpError(401, 'Invalid email or password')
    }

    await executeQuery('UPDATE USERS SET LAST_LOGIN = CURRENT_TIMESTAMP() WHERE ID = ?', [user.ID])
    const safeUser = toSafeUser(user)
    return { token: createToken(toTokenPayload(safeUser)), user: safeUser }
  },

  async getUserById(id) {
    const rows = await executeQuery<UserRow>(
      'SELECT ID, FULL_NAME, EMAIL, ROLE FROM USERS WHERE ID = ?',
      [id],
    )
    if (!rows[0]) {
      throw new HttpError(404, 'User not found')
    }
    return toSafeUser(rows[0])
  },

  async listUsers() {
    const rows = await executeQuery<UserRow>(
      'SELECT ID, FULL_NAME, EMAIL, ROLE FROM USERS ORDER BY ID',
    )
    return rows.map(toSafeUser)
  },
}
