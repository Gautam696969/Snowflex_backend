import { executeDelete, executeInsert, executeQuery, executeUpdate } from '../config/snowflake'
import { DbRow, toApiRow } from '../utils/rows'
import { HttpError } from '../utils/http-error'

export interface DepartmentInput { name?: string; description?: string | null }

export const departmentService = {
  async list(): Promise<Record<string, unknown>[]> {
    return (await executeQuery<DbRow>('SELECT ID, NAME, DESCRIPTION, CREATED_AT, UPDATED_AT FROM DEPARTMENTS ORDER BY NAME')).map(toApiRow)
  },
  async get(id: number): Promise<Record<string, unknown>> {
    const rows = await executeQuery<DbRow>('SELECT ID, NAME, DESCRIPTION, CREATED_AT, UPDATED_AT FROM DEPARTMENTS WHERE ID = ?', [id])
    if (!rows[0]) throw new HttpError(404, 'Department not found')
    return toApiRow(rows[0])
  },
  async create(input: Required<Pick<DepartmentInput, 'name'>> & DepartmentInput): Promise<void> {
    const duplicate = await executeQuery<DbRow>('SELECT ID FROM DEPARTMENTS WHERE UPPER(NAME) = UPPER(?)', [input.name])
    if (duplicate.length) throw new HttpError(409, 'Department name already exists')
    await executeInsert('INSERT INTO DEPARTMENTS (NAME, DESCRIPTION) VALUES (?, ?)', [input.name, input.description ?? null])
  },
  async update(id: number, input: DepartmentInput): Promise<void> {
    const fields: string[] = []
    const binds: (string | number | boolean | null)[] = []
    if (input.name !== undefined) { fields.push('NAME = ?'); binds.push(input.name) }
    if (input.description !== undefined) { fields.push('DESCRIPTION = ?'); binds.push(input.description) }
    if (!fields.length) throw new HttpError(422, 'No department fields provided')
    await executeUpdate(`UPDATE DEPARTMENTS SET ${fields.join(', ')}, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?`, [...binds, id])
  },
  async remove(id: number): Promise<void> {
    await executeDelete('DELETE FROM DEPARTMENTS WHERE ID = ?', [id])
  },
}