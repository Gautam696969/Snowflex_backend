import { Router } from 'express'
import { z } from 'zod'
import { leaveTypeController } from '../controllers/leave-type.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const idSchema = z.object({ id: z.coerce.number().int().positive() })

const createTypeSchema = z.object({
  name: z.string().trim().min(2).max(40),
  code: z.string().trim().min(1).max(20),
  description: z.string().trim().max(500).optional().nullable(),
  isPaid: z.boolean().optional(),
  yearlyQuota: z.number().int().nonnegative().optional().nullable(),
  requiresDocument: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

const updateTypeSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  code: z.string().trim().min(1).max(20).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  isPaid: z.boolean().optional(),
  yearlyQuota: z.number().int().nonnegative().optional().nullable(),
  requiresDocument: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

const toggleSchema = z.object({
  isActive: z.boolean(),
})

export const leaveTypeRouter = Router()
leaveTypeRouter.use(requireAuth)

leaveTypeRouter.get('/', leaveTypeController.list)
leaveTypeRouter.get('/:id', validateParams(idSchema), leaveTypeController.get)

// Admin and HR operations
leaveTypeRouter.post('/', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateBody(createTypeSchema), leaveTypeController.create)
leaveTypeRouter.put('/:id', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateParams(idSchema), validateBody(updateTypeSchema), leaveTypeController.update)
leaveTypeRouter.patch('/:id/toggle', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateParams(idSchema), validateBody(toggleSchema), leaveTypeController.toggle)
leaveTypeRouter.delete('/:id', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateParams(idSchema), leaveTypeController.delete)
