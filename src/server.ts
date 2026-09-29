import 'dotenv/config'
import { createApp } from './app'
import { testSnowflakeConnection } from './config/snowflake'
import { getEnvironment } from './config/env'

async function startServer(): Promise<void> {
  let env: ReturnType<typeof getEnvironment>
  try {
    env = getEnvironment()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid server configuration')
    process.exitCode = 1
    return
  }

  if (!process.env.JWT_SECRET?.trim()) {
    console.error('JWT_SECRET is required before starting the authentication API.')
    process.exitCode = 1
    return
  }

  try {
    console.info('Connecting to Snowflake...')
    await testSnowflakeConnection()
    console.info('Snowflake connected successfully')
  } catch {
    console.error('Snowflake connection failed. Check server configuration and connectivity.')
    process.exitCode = 1
    return
  }

  createApp().listen(env.PORT, () => {
    console.info(`Server running on port ${env.PORT}`)
  })
}

void startServer()
