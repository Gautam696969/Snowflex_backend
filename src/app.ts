import 'dotenv/config'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import express, { Express } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { createAdminRouter } from './routes/admin.routes'
import { errorHandler } from './middleware/error.middleware'
import { requestLogger } from './middleware/request-logger.middleware'
import { createAuthRouter } from './routes/auth.routes'
import { AuthServiceContract } from './services/auth.service'
import { aiEmployeeRouter } from './routes/ai-employee.routes'
import { voiceRouter } from './routes/voice.routes'
import { employeeRouter } from './routes/employee.routes'
import { departmentRouter } from './routes/department.routes'
import { attendanceRouter } from './routes/attendance.routes'
import { leaveRouter } from './routes/leave.routes'
import { leaveTypeRouter } from './routes/leave-type.routes'
import { leaveBalanceRouter } from './routes/leave-balance.routes'
import { taskRouter } from './routes/task.routes'
import { dashboardRouter } from './routes/dashboard.routes'
import { userRouter } from './routes/user.routes'
import { notificationRouter } from './routes/notification.routes'
import { chatRouter } from './routes/chat.routes'
import { holidayRouter } from './routes/holiday.routes'
import { isSnowflakeConnected } from './config/snowflake'
import { isAllowedOrigin } from './config/cors'

export function createApp(service?: AuthServiceContract): Express {
  const app = express()

  app.disable('x-powered-by')
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }))
  app.use(requestLogger)
  app.use(
    cors({
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
          callback(null, true)
        } else {
          callback(null, false)
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
      exposedHeaders: ['Content-Disposition'],
      maxAge: 86400,
    }),
  )
  app.use(express.json({ limit: '32kb' }))

  const uploadsDir = path.resolve(process.cwd(), 'uploads')
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true })
  }
  app.use('/uploads', express.static(uploadsDir))

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false })
  app.use('/api/auth', authLimiter)
  app.use('/auth', authLimiter)

  const handleHealth = (_request: express.Request, response: express.Response) => {
    const database = isSnowflakeConnected() || service ? 'connected' : 'disconnected'
    response.status(database === 'connected' ? 200 : 503).json({
      success: database === 'connected',
      message: database === 'connected' ? 'API is healthy' : 'Database unavailable',
      database,
    })
  }

  app.get('/api/health', handleHealth)
  app.get('/health', handleHealth)

  app.use('/api/auth', createAuthRouter(service))
  app.use('/auth', createAuthRouter(service))

  app.use('/api/admin', createAdminRouter(service))
  app.use('/admin', createAdminRouter(service))

  app.use('/api/users', userRouter)
  app.use('/users', userRouter)

  app.use('/api/ai-employee', aiEmployeeRouter)
  app.use('/ai-employee', aiEmployeeRouter)

  app.use('/api/voice', voiceRouter)
  app.use('/voice', voiceRouter)

  app.use('/api/employees', employeeRouter)
  app.use('/employees', employeeRouter)

  app.use('/api/departments', departmentRouter)
  app.use('/departments', departmentRouter)

  app.use('/api/attendance', attendanceRouter)
  app.use('/attendance', attendanceRouter)

  app.use('/api/leaves', leaveRouter)
  app.use('/leaves', leaveRouter)

  app.use('/api/leave-requests', leaveRouter)
  app.use('/leave-requests', leaveRouter)

  app.use('/api/leave-types', leaveTypeRouter)
  app.use('/leave-types', leaveTypeRouter)

  app.use('/api/leave-balances', leaveBalanceRouter)
  app.use('/leave-balances', leaveBalanceRouter)

  app.use('/api/tasks', taskRouter)
  app.use('/tasks', taskRouter)

  app.use('/api/dashboard', dashboardRouter)
  app.use('/dashboard', dashboardRouter)

  app.use('/api/notifications', notificationRouter)
  app.use('/notifications', notificationRouter)

  app.use('/api/chat', chatRouter)
  app.use('/chat', chatRouter)

  app.use('/api/holidays', holidayRouter)
  app.use('/holidays', holidayRouter)

  app.use((_request, response) => {
    response.status(404).json({ success: false, message: 'Not found' })
  })
  app.use(errorHandler)
  return app
}
