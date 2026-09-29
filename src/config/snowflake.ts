import 'dotenv/config'
import snowflake, { Binds, Connection, ConnectionOptions } from 'snowflake-sdk'

type SnowflakeRow = Record<string, unknown>

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
          reject(new Error('Snowflake query failed', { cause: error }))
          return
        }
        resolve((rows ?? []) as T[])
      },
    })
  })
}

export async function executeInsert(sqlText: string, binds: Binds = []): Promise<void> {
  await executeQuery(sqlText, binds)
}

export async function executeUpdate(sqlText: string, binds: Binds = []): Promise<void> {
  await executeQuery(sqlText, binds)
}

export async function executeDelete(sqlText: string, binds: Binds = []): Promise<void> {
  await executeQuery(sqlText, binds)
}

export async function testSnowflakeConnection(): Promise<void> {
  await executeQuery('SELECT CURRENT_VERSION() AS VERSION')
}
