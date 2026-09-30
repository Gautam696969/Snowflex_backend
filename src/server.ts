import 'dotenv/config'
import { createApp } from './app'
import { testSnowflakeConnection } from './config/snowflake'
import { getEnvironment } from './config/env'
import { logger } from './utils/logger'

async function startServer(): Promise<void> {
  let env: ReturnType<typeof getEnvironment>
  try {
    env = getEnvironment()
  } catch (error) {
    logger.error(error instanceof Error ? error.message : 'Invalid server configuration')
    process.exitCode = 1
    return
  }

  if (!process.env.JWT_SECRET?.trim()) {
    logger.error('JWT_SECRET is required before starting the authentication API.')
    process.exitCode = 1
    return
  }

  try {
    logger.info('Connecting to Snowflake...')
    await testSnowflakeConnection()
    logger.success('Snowflake connected successfully')
  } catch {
    logger.error('Snowflake connection failed. Check server configuration and connectivity.')
    process.exitCode = 1
    return
  }

  createApp().listen(env.PORT, () => {
    logger.success(`Server running on port ${env.PORT}`)
  })
}

void startServer()
