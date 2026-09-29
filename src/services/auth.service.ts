import { executeQuery } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { AuthenticatedUser, createToken } from '../utils/jwt'
import { comparePassword, hashPassword } from '../utils/password'
import { snowflakeTable } from '../utils/snowflake-identifiers'

const usersTable = snowflakeTable('USERS')
const employeesTable = snowflakeTable('EMPLOYEES')

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
}
