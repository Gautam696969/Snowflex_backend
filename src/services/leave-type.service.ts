import { executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { HttpError } from '../utils/http-error'
import { DbRow, toApiRow } from '../utils/rows'

export interface LeaveTypeDto {
  id: number
  name: string
  code: string
  description: string | null
  isPaid: boolean
  yearlyQuota: number | null
  requiresDocument: boolean
  isActive: boolean
  createdAt?: string
  updatedAt?: string
}

export interface CreateLeaveTypeInput {
  name: string
  code: string
  description?: string | null
  isPaid?: boolean
  yearlyQuota?: number | null
  requiresDocument?: boolean
  isActive?: boolean
}

export interface UpdateLeaveTypeInput {
  name?: string
  code?: string
  description?: string | null
  isPaid?: boolean
  yearlyQuota?: number | null
  requiresDocument?: boolean
  isActive?: boolean
}

export const leaveTypeService = {
  async list(activeOnly = true): Promise<LeaveTypeDto[]> {
    const query = activeOnly
      ? `SELECT ID, NAME, CODE, DESCRIPTION, IS_PAID, YEARLY_QUOTA, DEFAULT_DAYS, REQUIRES_DOCUMENT, IS_ACTIVE, CREATED_AT, UPDATED_AT
         FROM LEAVE_TYPES
         WHERE IS_ACTIVE = TRUE
         ORDER BY ID ASC`
      : `SELECT ID, NAME, CODE, DESCRIPTION, IS_PAID, YEARLY_QUOTA, DEFAULT_DAYS, REQUIRES_DOCUMENT, IS_ACTIVE, CREATED_AT, UPDATED_AT
         FROM LEAVE_TYPES
         ORDER BY ID ASC`

    const rows = await executeQuery<DbRow>(query)
    return rows.map((r) => {
      const api = toApiRow(r)
      return {
        id: Number(api.id),
        name: String(api.name || ''),
        code: String(api.code || ''),
        description: api.description ? String(api.description) : null,
        isPaid: Boolean(api.isPaid ?? true),
        yearlyQuota: api.yearlyQuota !== null && api.yearlyQuota !== undefined ? Number(api.yearlyQuota) : null,
        requiresDocument: Boolean(api.requiresDocument ?? false),
        isActive: Boolean(api.isActive ?? true),
        createdAt: api.createdAt ? String(api.createdAt) : undefined,
        updatedAt: api.updatedAt ? String(api.updatedAt) : undefined,
      }
    })
  },

  async getById(id: number): Promise<LeaveTypeDto> {
    const rows = await executeQuery<DbRow>(
      `SELECT ID, NAME, CODE, DESCRIPTION, IS_PAID, YEARLY_QUOTA, DEFAULT_DAYS, REQUIRES_DOCUMENT, IS_ACTIVE, CREATED_AT, UPDATED_AT
       FROM LEAVE_TYPES WHERE ID = ?`,
      [id]
    )
    if (!rows[0]) throw new HttpError(404, 'Leave type not found')
    const api = toApiRow(rows[0])
    return {
      id: Number(api.id),
      name: String(api.name || ''),
      code: String(api.code || ''),
      description: api.description ? String(api.description) : null,
      isPaid: Boolean(api.isPaid ?? true),
      yearlyQuota: api.yearlyQuota !== null && api.yearlyQuota !== undefined ? Number(api.yearlyQuota) : null,
      requiresDocument: Boolean(api.requiresDocument ?? false),
      isActive: Boolean(api.isActive ?? true),
      createdAt: api.createdAt ? String(api.createdAt) : undefined,
      updatedAt: api.updatedAt ? String(api.updatedAt) : undefined,
    }
  },

  async create(input: CreateLeaveTypeInput): Promise<LeaveTypeDto> {
    const name = input.name.trim()
    const code = input.code.trim().toUpperCase()
    if (!name || !code) {
      throw new HttpError(400, 'Name and Code are required')
    }

    // Check duplicate
    const existing = await executeQuery<DbRow>(
      `SELECT ID FROM LEAVE_TYPES WHERE UPPER(NAME) = ? OR UPPER(CODE) = ?`,
      [name.toUpperCase(), code]
    )
    if (existing.length > 0) {
      throw new HttpError(409, 'A leave type with this name or code already exists')
    }

    const quota = input.yearlyQuota !== undefined && input.yearlyQuota !== null ? Number(input.yearlyQuota) : null
    const isPaid = input.isPaid ?? true
    const requiresDoc = input.requiresDocument ?? false
    const isActive = input.isActive ?? true
    const desc = input.description ? input.description.trim() : null

    await executeInsert(
      `INSERT INTO LEAVE_TYPES (NAME, CODE, DESCRIPTION, IS_PAID, YEARLY_QUOTA, DEFAULT_DAYS, REQUIRES_DOCUMENT, IS_ACTIVE, CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
      [name, code, desc, isPaid, quota, quota ?? 0, requiresDoc, isActive]
    )

    const created = await executeQuery<DbRow>(
      `SELECT ID, NAME, CODE, DESCRIPTION, IS_PAID, YEARLY_QUOTA, REQUIRES_DOCUMENT, IS_ACTIVE, CREATED_AT
       FROM LEAVE_TYPES WHERE UPPER(CODE) = ? ORDER BY CREATED_AT DESC LIMIT 1`,
      [code]
    )
    return toApiRow(created[0]) as unknown as LeaveTypeDto
  },

  async update(id: number, input: UpdateLeaveTypeInput): Promise<LeaveTypeDto> {
    const existing = await this.getById(id)

    const updates: string[] = []
    const binds: (string | number | boolean | null)[] = []

    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new HttpError(400, 'Name cannot be empty')
      const duplicate = await executeQuery<DbRow>(
        `SELECT ID FROM LEAVE_TYPES WHERE UPPER(NAME) = ? AND ID <> ?`,
        [name.toUpperCase(), id]
      )
      if (duplicate.length > 0) throw new HttpError(409, 'Another leave type with this name exists')
      updates.push('NAME = ?')
      binds.push(name)
    }

    if (input.code !== undefined) {
      const code = input.code.trim().toUpperCase()
      if (!code) throw new HttpError(400, 'Code cannot be empty')
      const duplicate = await executeQuery<DbRow>(
        `SELECT ID FROM LEAVE_TYPES WHERE UPPER(CODE) = ? AND ID <> ?`,
        [code, id]
      )
      if (duplicate.length > 0) throw new HttpError(409, 'Another leave type with this code exists')
      updates.push('CODE = ?')
      binds.push(code)
    }

    if (input.description !== undefined) {
      updates.push('DESCRIPTION = ?')
      binds.push(input.description ? input.description.trim() : null)
    }

    if (input.isPaid !== undefined) {
      updates.push('IS_PAID = ?')
      binds.push(Boolean(input.isPaid))
    }

    if (input.yearlyQuota !== undefined) {
      const quota = input.yearlyQuota !== null ? Number(input.yearlyQuota) : null
      updates.push('YEARLY_QUOTA = ?')
      binds.push(quota)
      updates.push('DEFAULT_DAYS = ?')
      binds.push(quota ?? 0)
    }

    if (input.requiresDocument !== undefined) {
      updates.push('REQUIRES_DOCUMENT = ?')
      binds.push(Boolean(input.requiresDocument))
    }

    if (input.isActive !== undefined) {
      updates.push('IS_ACTIVE = ?')
      binds.push(Boolean(input.isActive))
    }

    if (updates.length === 0) {
      return existing
    }

    binds.push(id)
    await executeUpdate(
      `UPDATE LEAVE_TYPES SET ${updates.join(', ')} WHERE ID = ?`,
      binds
    )

    return this.getById(id)
  },

  async toggleActive(id: number, isActive: boolean): Promise<LeaveTypeDto> {
    await this.getById(id)
    await executeUpdate(
      `UPDATE LEAVE_TYPES SET IS_ACTIVE = ? WHERE ID = ?`,
      [isActive, id]
    )
    return this.getById(id)
  },

  async delete(id: number): Promise<void> {
    await this.getById(id)

    // Check if referenced by existing leave requests
    const countRow = await executeQuery<DbRow>(
      `SELECT COUNT(*) AS CNT FROM LEAVE_REQUESTS WHERE LEAVE_TYPE_ID = ?`,
      [id]
    )
    const count = Number(countRow[0]?.CNT || 0)
    if (count > 0) {
      throw new HttpError(
        409,
        `Cannot delete this leave type because it is referenced by ${count} leave request(s). Please deactivate it instead.`
      )
    }

    await executeUpdate(`DELETE FROM LEAVE_TYPES WHERE ID = ?`, [id])
  },
}
