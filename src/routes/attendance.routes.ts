import { Router } from 'express'
import { z } from 'zod'
import { attendanceController } from '../controllers/attendance.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateParams } from '../middleware/validation.middleware'

const employeeIdSchema = z.object({ employeeId: z.coerce.number().int().positive() })

export const attendanceRouter = Router()

// Public photo endpoint for browser <img> tags and full-size preview
attendanceRouter.get('/:id/photo/:type', attendanceController.getPhoto)

attendanceRouter.use(requireAuth)
attendanceRouter.get('/today', attendanceController.today)
attendanceRouter.post('/check-in', attendanceController.checkIn)
attendanceRouter.post('/check-out', attendanceController.checkOut)
attendanceRouter.get('/me', attendanceController.mine)
attendanceRouter.get('/', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR', 'MANAGER'), attendanceController.list)
attendanceRouter.get('/:employeeId', validateParams(employeeIdSchema), attendanceController.byEmployee)
