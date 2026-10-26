import 'dotenv/config'

export type SnowflakeRow = Record<string, unknown>
export type Binds = (string | number | boolean | null | undefined | Date | unknown)[]

interface D1QueryResult<T> {
  results: T[]
  success: boolean
  meta?: {
    changes?: number
    last_row_id?: number
    rows_read?: number
    rows_written?: number
    duration?: number
  }
}

interface D1ApiResponse<T> {
  result: D1QueryResult<T>[]
  success: boolean
  errors: { code: number; message: string }[]
  messages: string[]
}

function getCredentials(): { accountId: string; databaseId: string; apiToken: string } {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
  const databaseId = (process.env.CLOUDFLARE_DATABASE_ID || '').trim()
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim()

  if (!accountId || !databaseId || !apiToken) {
    throw new Error('Cloudflare D1 configuration is incomplete. Check CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, and CLOUDFLARE_API_TOKEN in .env')
  }

  return { accountId, databaseId, apiToken }
}

export function isSnowflakeConnected(): boolean {
  try {
    getCredentials()
    return true
  } catch {
    return false
  }
}

/**
 * Normalizes Snowflake-specific SQL syntax into Cloudflare D1 (SQLite) compatible SQL.
 */
export function normalizeSql(sqlText: string): string {
  let sql = sqlText

  // 1. Remove Snowflake-style 3-part or 2-part database/schema table prefixes:
  // e.g. "AUTH_PROJECT"."PUBLIC"."USERS" -> "USERS"
  sql = sql.replace(/"[A-Za-z0-9_$]+"\."[A-Za-z0-9_$]+"\."([A-Za-z0-9_$]+)"/g, '"$1"')
  sql = sql.replace(/[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+\."?([A-Za-z0-9_$]+)"?/g, '"$1"')

  // 2. Replace CURRENT_TIMESTAMP() with SQLite standard CURRENT_TIMESTAMP
  sql = sql.replace(/CURRENT_TIMESTAMP\(\)/gi, 'CURRENT_TIMESTAMP')

  // 3. Replace CURRENT_DATE() with CURRENT_DATE
  sql = sql.replace(/CURRENT_DATE\(\)/gi, 'CURRENT_DATE')

  // 4. Replace Snowflake IFF(condition, then, else) with SQLite IIF(condition, then, else)
  sql = sql.replace(/\bIFF\(/gi, 'IIF(')

  // 5. Replace GREATEST / LEAST with SQLite MAX / MIN
  sql = sql.replace(/\bGREATEST\(/gi, 'MAX(')
  sql = sql.replace(/\bLEAST\(/gi, 'MIN(')

  // 6. Replace Snowflake YEAR(x) with SQLite strftime
  sql = sql.replace(/\bYEAR\(([^)]+)\)/gi, "CAST(strftime('%Y', $1) AS INTEGER)")

  // 7. Strip TO_DATE(?) and TO_TIMESTAMP_NTZ(?) wrappers (SQLite stores dates as ISO text)
  sql = sql.replace(/\bTO_DATE\(([^)]+)\)/gi, '$1')
  sql = sql.replace(/\bTO_TIMESTAMP_NTZ\(([^)]+)\)/gi, '$1')

  // 8. Replace Snowflake cast ::VARCHAR or ::INTEGER with SQLite compatible form
  sql = sql.replace(/([a-zA-Z0-9_.]+)::VARCHAR/gi, '$1')
  sql = sql.replace(/([a-zA-Z0-9_.]+)::INTEGER/gi, '$1')

  // 9. Replace LPAD employee code formatting with SQLite printf
  sql = sql.replace(/'EMP-'\s*\|\|\s*LPAD\(([^,]+),\s*6,\s*'0'\)/gi, "printf('EMP-%06d', $1)")

  // 10. DDL Normalization for runtime CREATE TABLE calls:
  sql = sql.replace(/INTEGER\s+AUTOINCREMENT\s+START\s+1\s+INCREMENT\s+1/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
  sql = sql.replace(/TIMESTAMP_NTZ/gi, 'DATETIME')
  sql = sql.replace(/BOOLEAN\s+DEFAULT\s+(TRUE|FALSE)/gi, (_m, val) => `INTEGER DEFAULT ${val.toUpperCase() === 'TRUE' ? 1 : 0}`)

  // 11. Replace Snowflake REGEXP_REPLACE role normalization with SQLite REPLACE
  sql = sql.replace(/REGEXP_REPLACE\(\s*(UPPER\(TRIM\([^)]+\)\)|[^,]+)\s*,\s*'\[\[:space:\]-\]\+'\s*,\s*'_'\s*\)/gi, "REPLACE(REPLACE($1, '-', '_'), ' ', '_')")
  sql = sql.replace(/REGEXP_REPLACE\(\s*(.+?)\s*,\s*'[^']+'\s*,\s*'_'\s*\)/gi, "REPLACE(REPLACE($1, '-', '_'), ' ', '_')")

  // 12. Replace Snowflake DATE_TRUNC with SQLite date start of month
  sql = sql.replace(/DATE_TRUNC\(\s*'MONTH'\s*,\s*CURRENT_DATE(?:\(\))?\s*\)/gi, "date('now', 'start of month')")
  sql = sql.replace(/DATE_TRUNC\(\s*'MONTH'\s*,\s*([^)]+)\s*\)/gi, "date($1, 'start of month')")

  // 13. Replace Snowflake LISTAGG ... WITHIN GROUP with SQLite GROUP_CONCAT
  sql = sql.replace(/LISTAGG\(\s*DISTINCT\s+([^,]+)\s*,\s*'[^']*'\s*\)\s+WITHIN\s+GROUP\s*\([^)]*\)/gi, "REPLACE(GROUP_CONCAT(DISTINCT $1), ',', ', ')")
  sql = sql.replace(/LISTAGG\(\s*([^,]+)\s*,\s*'[^']*'\s*\)\s+WITHIN\s+GROUP\s*\([^)]*\)/gi, "REPLACE(GROUP_CONCAT($1), ',', ', ')")

  // 14. Replace Snowflake TO_VARCHAR(x, 'YYYY-MM-DD') with SQLite date(x) or string
  sql = sql.replace(/\bTO_VARCHAR\(([^,)]+)(?:,\s*'[^']*')?\)/gi, 'date($1)')

  return sql
}

/**
 * Normalizes bind parameters for SQLite:
 * - booleans become 1 or 0
 * - Dates become YYYY-MM-DD HH:MM:SS
 * - undefined becomes null
 */
export function normalizeBinds(binds: Binds): unknown[] {
  return binds.map((val) => {
    if (typeof val === 'boolean') {
      return val ? 1 : 0
    }
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return null
      return val.toISOString().replace('T', ' ').replace('Z', '')
    }
    if (val === undefined) {
      return null
    }
    return val
  })
}

/**
 * Ensures returned row keys have uppercase equivalents so code looking for row.ID, row.FULL_NAME works seamlessly.
 */
function normalizeRow<T extends SnowflakeRow>(row: T): T {
  const result: Record<string, unknown> = { ...row }
  for (const [key, value] of Object.entries(row)) {
    result[key.toUpperCase()] = value
  }
  return result as T
}

async function sendD1Query<T extends SnowflakeRow>(sqlText: string, binds: Binds = []): Promise<D1QueryResult<T>> {
  const { accountId, databaseId, apiToken } = getCredentials()
  const sql = normalizeSql(sqlText)
  const params = normalizeBinds(binds)

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Cloudflare D1 request failed with status ${response.status}: ${errorText}`)
  }

  const payload = (await response.json()) as D1ApiResponse<T>

  if (!payload.success || !payload.result?.[0]) {
    const errorMsg = payload.errors?.map((e) => e.message).join(', ') || 'Unknown Cloudflare D1 error'
    const error = new Error(`Cloudflare D1 query failed: ${errorMsg}`) as Error & { sqlText: string }
    error.sqlText = sql
    throw error
  }

  return payload.result[0]
}

export async function executeQuery<T extends SnowflakeRow = Record<string, unknown>>(
  sqlText: string,
  binds: Binds = [],
): Promise<T[]> {
  const result = await sendD1Query<T>(sqlText, binds)
  return (result.results ?? []).map((row) => normalizeRow(row))
}

let txMutex = Promise.resolve()

export async function withTransaction<T>(action: () => Promise<T>): Promise<T> {
  let release: () => void
  const prev = txMutex
  txMutex = new Promise((resolve) => {
    release = resolve
  })
  await prev

  try {
    return await action()
  } finally {
    release!()
  }
}

export async function executeInsert(sqlText: string, binds: Binds = []): Promise<void> {
  await sendD1Query(sqlText, binds)
}

export async function executeUpdate(sqlText: string, binds: Binds = []): Promise<number> {
  const result = await sendD1Query(sqlText, binds)
  return result.meta?.changes ?? 0
}

export async function executeDelete(sqlText: string, binds: Binds = []): Promise<number> {
  const result = await sendD1Query(sqlText, binds)
  return result.meta?.changes ?? 0
}

export async function testSnowflakeConnection(): Promise<void> {
  await executeQuery('SELECT 1 AS CONNECTED')
}
