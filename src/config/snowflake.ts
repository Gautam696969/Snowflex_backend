import 'dotenv/config'
import snowflake, { Binds, Connection, ConnectionOptions } from 'snowflake-sdk'

type SnowflakeRow = Record<string, unknown>

function queryError(error: unknown, sqlText: string): Error {
  const wrapped = new Error('Snowflake query failed', { cause: error }) as Error & { sqlText: string }
  wrapped.sqlText = sqlText
  return wrapped
}

let connectionPromise: Promise<Connection> | undefined

export function isSnowflakeConnected(): boolean {
  return connectionPromise !== undefined
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error('Snowflake configuration is incomplete')
  }
  return value
}

function getConnectionOptions(): ConnectionOptions {
  return {
    account: requiredEnvironmentValue('SNOWFLAKE_ACCOUNT'),
    username: requiredEnvironmentValue('SNOWFLAKE_USERNAME'),
    password: requiredEnvironmentValue('SNOWFLAKE_PASSWORD'),
    warehouse: requiredEnvironmentValue('SNOWFLAKE_WAREHOUSE'),
    database: requiredEnvironmentValue('SNOWFLAKE_DATABASE'),
    schema: process.env.SNOWFLAKE_SCHEMA?.trim() || 'PUBLIC',
    role: requiredEnvironmentValue('SNOWFLAKE_ROLE'),
  }
}

async function getConnection(): Promise<Connection> {
  if (!connectionPromise) {
    connectionPromise = new Promise((resolve, reject) => {
      let candidate: Connection
      try {
        candidate = snowflake.createConnection(getConnectionOptions())
      } catch {
        connectionPromise = undefined
        reject(new Error('Snowflake connection failed'))
        return
      }

      candidate.connect((error, connected) => {
        if (error) {
          connectionPromise = undefined
          reject(new Error('Snowflake connection failed', { cause: error }))
          return
        }
        resolve(connected)
      })
    })
  }
  return connectionPromise
}

export async function executeQuery<T extends SnowflakeRow>(
  sqlText: string,
  binds: Binds = [],
): Promise<T[]> {
  const connection = await getConnection()
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete(error, _statement, rows) {
        if (error) {
          reject(queryError(error, sqlText))
          return
        }
        resolve((rows ?? []) as T[])
      },
    })
  })
}

let txMutex = Promise.resolve()

export async function withTransaction<T>(action: () => Promise<T>): Promise<T> {
  let release: () => void
  const prev = txMutex
  txMutex = new Promise((resolve) => { release = resolve })
  await prev

  try {
    await executeQuery('BEGIN')
    const result = await action()
    await executeQuery('COMMIT')
    return result
  } catch (error) {
    try {
      await executeQuery('ROLLBACK')
    } catch (rbError) {
      console.error('Failed to rollback transaction:', rbError)
    }
    throw error
  } finally {
    release!()
  }
}

export async function executeInsert(sqlText: string, binds: Binds = []): Promise<void> {
  await executeQuery(sqlText, binds)
}

function extractAffectedRows(statement: unknown, rows: unknown): number {
  const stmtAny = statement as { getNumUpdatedRows?: () => number; getNumRowsAffected?: () => number } | undefined
  if (typeof stmtAny?.getNumUpdatedRows === 'function') {
    const val = stmtAny.getNumUpdatedRows()
    if (typeof val === 'number') return val
  }
  if (typeof stmtAny?.getNumRowsAffected === 'function') {
    const val = stmtAny.getNumRowsAffected()
    if (typeof val === 'number') return val
  }
  if (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object') {
    const firstRow = rows[0] as Record<string, unknown>
    for (const key of Object.keys(firstRow)) {
      if (/number of rows (updated|deleted)/i.test(key)) {
        const val = Number(firstRow[key])
        if (!Number.isNaN(val)) return val
      }
    }
  }
  return 0
}

export async function executeUpdate(sqlText: string, binds: Binds = []): Promise<number> {
  const connection = await getConnection()
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete(error, statement, rows) {
        if (error) {
          reject(queryError(error, sqlText))
          return
        }
        resolve(extractAffectedRows(statement, rows))
      },
    })
  })
}

export async function executeDelete(sqlText: string, binds: Binds = []): Promise<number> {
  const connection = await getConnection()
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete(error, statement, rows) {
        if (error) {
          reject(queryError(error, sqlText))
          return
        }
        resolve(extractAffectedRows(statement, rows))
      },
    })
  })
}

export async function testSnowflakeConnection(): Promise<void> {
  await executeQuery('SELECT CURRENT_VERSION() AS VERSION')
}
