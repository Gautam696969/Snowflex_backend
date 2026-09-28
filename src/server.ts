import 'dotenv/config'
import { createApp } from './app'
import { testSnowflakeConnection } from './config/snowflake'

const port = Number(process.env.PORT) || 5000

async function startServer(): Promise<void> {
  if (!process.env.JWT_SECRET?.trim()) {
    console.error('JWT_SECRET is required before starting the authentication API.')
    process.exitCode = 1
    return
  }

  try {
    await testSnowflakeConnection()
    console.info('Snowflake connected')
  } catch {
    console.error('Snowflake connection failed. Check server configuration and connectivity.')
    process.exitCode = 1
    return
  }

  createApp().listen(port, () => {
    console.info(`Backend listening on port ${port}.`)
  })
}

void startServer()
