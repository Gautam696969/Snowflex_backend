import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { executeQuery } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { comparePassword, hashPassword } from '../utils/password'
import { snowflakeTable } from '../utils/snowflake-identifiers'

const usersTable = snowflakeTable('USERS')
const employeesTable = snowflakeTable('EMPLOYEES')
const departmentsTable = snowflakeTable('DEPARTMENTS')

export interface UserProfileData {
  id: number
  fullName: string
  email: string
  role: string
  avatarUrl: string | null
  hasPassword: boolean
  employeeId: number | null
  employeeCode: string | null
  phone: string | null
  departmentId: number | null
  departmentName: string | null
  designation: string | null
  joiningDate: string | null
  status: string
  address: string | null
  dateOfBirth: string | null
  gender: string | null
  createdAt: string | null
}

export interface UpdateProfileInput {
  fullName?: string
  phone?: string | null
  designation?: string | null
  address?: string | null
  dateOfBirth?: string | null
  gender?: string | null
  // Admin-only fields:
  email?: string
  employeeCode?: string
  departmentId?: number | null
  status?: string
}

function detectImageType(buffer: Buffer): { ext: string; mime: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return { ext: 'png', mime: 'image/png' }
  }
  if (buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return null
}

export const userService = {
  async getProfile(userId: number): Promise<UserProfileData> {
    const rows = await executeQuery<Record<string, unknown>>(
      `SELECT 
         U.ID,
         U.FULL_NAME,
         U.EMAIL,
         U.ROLE,
         U.AVATAR_URL,
         U.PASSWORD_HASH,
         U.CREATED_AT,
         E.ID AS EMPLOYEE_ID,
         E.EMPLOYEE_CODE,
         E.PHONE,
         E.DEPARTMENT_ID,
         D.NAME AS DEPARTMENT_NAME,
         E.DESIGNATION,
         E.JOINING_DATE,
         E.STATUS,
         E.ADDRESS,
         E.DATE_OF_BIRTH,
         E.GENDER
       FROM ${usersTable} U
       LEFT JOIN ${employeesTable} E ON E.USER_ID = U.ID
       LEFT JOIN ${departmentsTable} D ON D.ID = E.DEPARTMENT_ID
       WHERE U.ID = ?`,
      [userId],
    )

    if (!rows[0]) {
      throw new HttpError(404, 'User profile not found')
    }

    const row = rows[0]
    return {
      id: Number(row.ID),
      fullName: String(row.FULL_NAME || ''),
      email: String(row.EMAIL || ''),
      role: String(row.ROLE === 'USER' ? 'EMPLOYEE' : row.ROLE || 'EMPLOYEE'),
      avatarUrl: row.AVATAR_URL ? String(row.AVATAR_URL) : null,
      hasPassword: Boolean(row.PASSWORD_HASH),
      employeeId: row.EMPLOYEE_ID ? Number(row.EMPLOYEE_ID) : null,
      employeeCode: row.EMPLOYEE_CODE ? String(row.EMPLOYEE_CODE) : null,
      phone: row.PHONE ? String(row.PHONE) : null,
      departmentId: row.DEPARTMENT_ID ? Number(row.DEPARTMENT_ID) : null,
      departmentName: row.DEPARTMENT_NAME ? String(row.DEPARTMENT_NAME) : null,
      designation: row.DESIGNATION ? String(row.DESIGNATION) : null,
      joiningDate: row.JOINING_DATE ? String(row.JOINING_DATE).split('T')[0] : null,
      status: row.STATUS ? String(row.STATUS) : 'ACTIVE',
      address: row.ADDRESS ? String(row.ADDRESS) : null,
      dateOfBirth: row.DATE_OF_BIRTH ? String(row.DATE_OF_BIRTH).split('T')[0] : null,
      gender: row.GENDER ? String(row.GENDER) : null,
      createdAt: row.CREATED_AT ? String(row.CREATED_AT) : null,
    }
  },

  async updateProfile(userId: number, input: UpdateProfileInput, actorRole: string): Promise<UserProfileData> {
    const isAdmin = actorRole === 'ADMIN'

    // 1. Update USERS table if fullName or admin-updated email is present
    const userUpdates: string[] = []
    const userBinds: (string | number | boolean | null)[] = []

    if (input.fullName !== undefined) {
      const cleanName = input.fullName.trim()
      if (cleanName.length < 2) {
        throw new HttpError(400, 'Full name must contain at least 2 characters')
      }
      userUpdates.push('FULL_NAME = ?')
      userBinds.push(cleanName)
    }

    if (isAdmin && input.email !== undefined) {
      const cleanEmail = input.email.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        throw new HttpError(400, 'A valid email address is required')
      }
      // Check duplicate
      const duplicate = await executeQuery<Record<string, unknown>>(
        `SELECT ID FROM ${usersTable} WHERE LOWER(EMAIL) = ? AND ID <> ?`,
        [cleanEmail, userId],
      )
      if (duplicate.length > 0) {
        throw new HttpError(409, 'Email is already used by another account')
      }
      userUpdates.push('EMAIL = ?')
      userBinds.push(cleanEmail)
    }

    if (userUpdates.length > 0) {
      userUpdates.push('UPDATED_AT = CURRENT_TIMESTAMP()')
      userBinds.push(userId)
      await executeQuery(
        `UPDATE ${usersTable} SET ${userUpdates.join(', ')} WHERE ID = ?`,
        userBinds,
      )
    }

    // 2. Update EMPLOYEES table
    const empExisting = await executeQuery<Record<string, unknown>>(
      `SELECT ID FROM ${employeesTable} WHERE USER_ID = ?`,
      [userId],
    )

    const empUpdates: string[] = []
    const empBinds: (string | number | boolean | null)[] = []

    if (input.phone !== undefined) {
      empUpdates.push('PHONE = ?')
      empBinds.push(input.phone ? input.phone.trim() : null)
    }
    if (input.designation !== undefined) {
      empUpdates.push('DESIGNATION = ?')
      empBinds.push(input.designation ? input.designation.trim() : null)
    }
    if (input.address !== undefined) {
      empUpdates.push('ADDRESS = ?')
      empBinds.push(input.address ? input.address.trim() : null)
    }
    if (input.dateOfBirth !== undefined) {
      empUpdates.push('DATE_OF_BIRTH = ?')
      empBinds.push(input.dateOfBirth ? input.dateOfBirth : null)
    }
    if (input.gender !== undefined) {
      empUpdates.push('GENDER = ?')
      empBinds.push(input.gender ? input.gender.trim() : null)
    }

    if (isAdmin) {
      if (input.employeeCode !== undefined) {
        empUpdates.push('EMPLOYEE_CODE = ?')
        empBinds.push(input.employeeCode ? input.employeeCode.trim() : null)
      }
      if (input.departmentId !== undefined) {
        empUpdates.push('DEPARTMENT_ID = ?')
        empBinds.push(input.departmentId ? Number(input.departmentId) : null)
      }
      if (input.status !== undefined) {
        empUpdates.push('STATUS = ?')
        empBinds.push(input.status)
      }
    }

    if (empExisting.length > 0) {
      if (empUpdates.length > 0) {
        empUpdates.push('UPDATED_AT = CURRENT_TIMESTAMP()')
        empBinds.push(userId)
        await executeQuery(
          `UPDATE ${employeesTable} SET ${empUpdates.join(', ')} WHERE USER_ID = ?`,
          empBinds,
        )
      }
    } else {
      // Create linked employee row if one does not exist yet
      const code = (isAdmin && input.employeeCode) || `EMP-${String(userId).padStart(6, '0')}`
      await executeQuery(
        `INSERT INTO ${employeesTable} (
          USER_ID, EMPLOYEE_CODE, PHONE, DESIGNATION, ADDRESS, DATE_OF_BIRTH, GENDER, DEPARTMENT_ID, STATUS
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          code,
          input.phone ? input.phone.trim() : null,
          input.designation ? input.designation.trim() : null,
          input.address ? input.address.trim() : null,
          input.dateOfBirth || null,
          input.gender ? input.gender.trim() : null,
          isAdmin && input.departmentId ? Number(input.departmentId) : null,
          isAdmin && input.status ? input.status : 'ACTIVE',
        ],
      )
    }

    return this.getProfile(userId)
  },

  async updateAvatar(userId: number, fileBuffer: Buffer, _originalFilename: string): Promise<string> {
    if (fileBuffer.length > 2 * 1024 * 1024) {
      throw new HttpError(400, 'Image file size must not exceed 2 MB')
    }

    const detected = detectImageType(fileBuffer)
    if (!detected) {
      throw new HttpError(400, 'Invalid image format. Only JPEG, PNG, and WebP images are allowed.')
    }

    const uploadDir = path.resolve(process.cwd(), 'uploads', 'avatars')
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }

    const filename = `avatar-${userId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${detected.ext}`
    const targetPath = path.join(uploadDir, filename)

    // Delete previous avatar file if exists
    try {
      const existing = await executeQuery<{ AVATAR_URL: string }>(
        `SELECT AVATAR_URL FROM ${usersTable} WHERE ID = ?`,
        [userId],
      )
      const oldUrl = existing[0]?.AVATAR_URL
      if (oldUrl && typeof oldUrl === 'string' && oldUrl.startsWith('/uploads/avatars/')) {
        const oldFile = path.resolve(process.cwd(), oldUrl.replace(/^\//, ''))
        if (fs.existsSync(oldFile)) {
          await fs.promises.unlink(oldFile).catch(() => {})
        }
      }
    } catch {
      // Continue even if old avatar deletion fails
    }

    await fs.promises.writeFile(targetPath, fileBuffer)
    const avatarUrl = `/uploads/avatars/${filename}`

    await executeQuery(
      `UPDATE ${usersTable} SET AVATAR_URL = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [avatarUrl, userId],
    )

    return avatarUrl
  },

  async removeAvatar(userId: number): Promise<void> {
    try {
      const existing = await executeQuery<{ AVATAR_URL: string }>(
        `SELECT AVATAR_URL FROM ${usersTable} WHERE ID = ?`,
        [userId],
      )
      const oldUrl = existing[0]?.AVATAR_URL
      if (oldUrl && typeof oldUrl === 'string' && oldUrl.startsWith('/uploads/avatars/')) {
        const oldFile = path.resolve(process.cwd(), oldUrl.replace(/^\//, ''))
        if (fs.existsSync(oldFile)) {
          await fs.promises.unlink(oldFile).catch(() => {})
        }
      }
    } catch {
      // Continue even if disk unlink fails
    }

    await executeQuery(
      `UPDATE ${usersTable} SET AVATAR_URL = NULL, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [userId],
    )
  },

  async changePassword(userId: number, currentPassword: string | undefined, newPassword: string): Promise<void> {
    const rows = await executeQuery<{ ID: number; PASSWORD_HASH: string }>(
      `SELECT ID, PASSWORD_HASH FROM ${usersTable} WHERE ID = ?`,
      [userId],
    )

    if (!rows[0]) {
      throw new HttpError(404, 'User not found')
    }

    const user = rows[0]

    // If user has an existing password, verify current password
    if (user.PASSWORD_HASH) {
      if (!currentPassword) {
        throw new HttpError(400, 'Current password is required')
      }
      const match = await comparePassword(currentPassword, user.PASSWORD_HASH)
      if (!match) {
        throw new HttpError(400, 'Current password is incorrect')
      }
      if (currentPassword === newPassword) {
        throw new HttpError(400, 'New password cannot be the same as your current password')
      }
    }

    // Password strength verification:
    // Min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 symbol
    if (newPassword.length < 8) {
      throw new HttpError(400, 'Password must be at least 8 characters long')
    }
    if (!/[A-Z]/.test(newPassword)) {
      throw new HttpError(400, 'Password must include at least one uppercase letter')
    }
    if (!/[a-z]/.test(newPassword)) {
      throw new HttpError(400, 'Password must include at least one lowercase letter')
    }
    if (!/[0-9]/.test(newPassword)) {
      throw new HttpError(400, 'Password must include at least one number')
    }
    if (!/[^A-Za-z0-9]/.test(newPassword)) {
      throw new HttpError(400, 'Password must include at least one special symbol')
    }

    const newHash = await hashPassword(newPassword)
    await executeQuery(
      `UPDATE ${usersTable} SET PASSWORD_HASH = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`,
      [newHash, userId],
    )
  },
}
