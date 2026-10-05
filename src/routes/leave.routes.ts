import { Router } from 'express'
import { z } from 'zod'
import { leaveController } from '../controllers/leave.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const idSchema = z.object({ id: z.coerce.number().int().positive() })
const createSchema = z.object({
  leaveTypeId: z.coerce.number().int().positive(),
  startDate: z.string().date(),
  endDate: z.string().date(),
  reason: z.string().trim().min(1).max(2000),
  halfDaySession: z.enum(['FIRST_HALF', 'SECOND_HALF']).optional().nullable(),
  documentUrl: z.string().trim().max(500).optional().nullable(),
}).refine((value) => value.endDate >= value.startDate, { path: ['endDate'], message: 'End date must be on or after start date' })
const rejectSchema = z.object({ reason: z.string().trim().min(1).max(1000) })

export const leaveRouter = Router()
leaveRouter.use(requireAuth)
leaveRouter.post('/', validateBody(createSchema), leaveController.create)
leaveRouter.get('/me', leaveController.mine)
leaveRouter.get('/', authorizeRoles('ADMIN','HR','MANAGER'), leaveController.list)
leaveRouter.get('/:id', validateParams(idSchema), leaveController.get)
leaveRouter.patch('/:id/approve', authorizeRoles('ADMIN','HR','MANAGER'), validateParams(idSchema), leaveController.approve)
leaveRouter.patch('/:id/reject', authorizeRoles('ADMIN','HR','MANAGER'), validateParams(idSchema), validateBody(rejectSchema), leaveController.reject)
leaveRouter.patch('/:id/cancel', validateParams(idSchema), leaveController.cancel)