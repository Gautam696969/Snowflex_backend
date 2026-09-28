import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testSnowflakeConnection } from '../src/config/snowflake'

const connectionVariables = [
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USERNAME',
  'SNOWFLAKE_PASSWORD',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_DATABASE',
  'SNOWFLAKE_SCHEMA',
  'SNOWFLAKE_ROLE',
]
const savedValues = new Map<string, string | undefined>()

beforeEach(() => {
  savedValues.clear()
  for (const name of connectionVariables) {
    savedValues.set(name, process.env[name])
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of connectionVariables) {
    const value = savedValues.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('Snowflake connection check', () => {
  it('fails with a sanitized error when connection settings are missing', async () => {
    await expect(testSnowflakeConnection()).rejects.toThrow('Snowflake connection failed')
  })
})