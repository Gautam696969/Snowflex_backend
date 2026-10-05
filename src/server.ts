import 'dotenv/config'
import { createApp } from './app'
import { testSnowflakeConnection } from './config/snowflake'
import { getEnvironment } from './config/env'
import { validateGroqConfig } from './config/groq'
import { logger } from './utils/logger'
import { verifyMailSetup } from './services/email.service'

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

  validateGroqConfig()

  try {
    logger.info('Connecting to Snowflake...')
    await testSnowflakeConnection()
    logger.success('Snowflake connected successfully')
  } catch {
    logger.error('Snowflake connection failed. Check server configuration and connectivity.')
    process.exitCode = 1
    return
  }

  await verifyMailSetup()

  const server = createApp().listen(env.PORT, () => {
    logger.success(`Server running on port ${env.PORT}`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${env.PORT} is already in use by another process. Please stop the existing process or choose a different port.`)
    } else {
      logger.error(`Server error: ${err.message}`)
    }
    process.exit(1)
  })

  const shutdown = () => {
    logger.info('Shutting down server...')
    server.close(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void startServer()
