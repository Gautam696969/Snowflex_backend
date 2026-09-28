import 'dotenv/config'
import cors from 'cors'
import express, { Express } from 'express'
import { createAdminRouter } from './routes/admin.routes'
import { errorHandler } from './middleware/error.middleware'
import { createAuthRouter } from './routes/auth.routes'
import { AuthServiceContract } from './services/auth.service'

function allowedOrigins(): Set<string> {
  const configured = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (process.env.NODE_ENV !== 'production') {
    configured.push('http://localhost:5173')
  }
  return new Set(configured)
}

function isLocalViteOrigin(origin: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1):517\d$/.test(origin)
}

export function createApp(service?: AuthServiceContract): Express {
  const app = express()
  const origins = allowedOrigins()

  app.use(
    cors({
      origin(origin, callback) {
        if (
          !origin ||
          origins.has(origin) ||
          (process.env.NODE_ENV !== 'production' && isLocalViteOrigin(origin))
        ) {
          callback(null, true)
          return
        }
        callback(new Error('Origin is not allowed'))
      },
    }),
  )
  app.use(express.json({ limit: '16kb' }))

  app.get('/api/health', (_request, response) => {
    response.status(200).json({ success: true, message: 'Backend is running' })
  })
  app.use('/api/auth', createAuthRouter(service))
  app.use('/api/admin', createAdminRouter(service))
  app.use((_request, response) => {
    response.status(404).json({ success: false, message: 'Not found' })
  })
  app.use(errorHandler)
  return app
}
