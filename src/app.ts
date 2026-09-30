import 'dotenv/config'
import cors from 'cors'
import helmet from 'helmet'
import { requestLogger } from './middleware/request-logger.middleware'
import rateLimit from 'express-rate-limit'
import express, { Express, RequestHandler } from 'express'
import { createAdminRouter } from './routes/admin.routes'
import { errorHandler } from './middleware/error.middleware'
import { createAuthRouter } from './routes/auth.routes'
import { AuthServiceContract } from './services/auth.service'
import { employeeRouter } from './routes/employee.routes'
import { departmentRouter } from './routes/department.routes'
import { attendanceRouter } from './routes/attendance.routes'
import { leaveRouter } from './routes/leave.routes'
import { taskRouter } from './routes/task.routes'
import { dashboardRouter } from './routes/dashboard.routes'
import { isSnowflakeConnected } from './config/snowflake'

function allowedOrigins(): Set<string> {
  const configured = (process.env.CORS_ORIGIN ?? process.env.FRONTEND_URL ?? '')
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

  app.disable('x-powered-by')
  app.use(helmet())
  app.use(requestLogger)
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
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false }))

  app.get('/api/health', (_request, response) => {
    const database = isSnowflakeConnected() || service ? 'connected' : 'disconnected'
    response.status(database === 'connected' ? 200 : 503).json({
      success: database === 'connected',
      message: database === 'connected' ? 'API is healthy' : 'Database unavailable',
      database,
    })
  })
  app.use('/api/auth', createAuthRouter(service))
  app.use('/api/admin', createAdminRouter(service))
  app.use('/api/employees', employeeRouter)
  app.use('/api/departments', departmentRouter)
  app.use('/api/attendance', attendanceRouter)
  app.use('/api/leaves', leaveRouter)
  app.use('/api/tasks', taskRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use((_request, response) => {
    response.status(404).json({ success: false, message: 'Not found' })
  })
  app.use(errorHandler)
  return app
}
