import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testSnowflakeConnection } from '../src/config/snowflake'

const connectionVariables = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_DATABASE_ID',
  'CLOUDFLARE_API_TOKEN',
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

describe('Cloudflare D1 connection check', () => {
  it('fails with a sanitized error when connection settings are missing', async () => {
    await expect(testSnowflakeConnection()).rejects.toThrow('Cloudflare D1 configuration is incomplete')
  })
})