import { Router } from 'express'
import { z } from 'zod'
import { employeeController } from '../controllers/employee.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const idSchema = z.object({ id: z.coerce.number().int().positive() })
const terminateSchema = z.object({
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters'),
})
const createSchema = z.object({
  userId: z.number().int().positive().optional(),
  fullName: z.string().trim().min(1).max(150).optional(),
  email: z.string().trim().email().max(255).optional(),
  employeeCode: z.string().trim().min(1).max(40),
  phone: z.string().trim().max(40).nullable().optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  designation: z.string().trim().max(120).nullable().optional(),
  joiningDate: z.string().date().nullable().optional(),
  managerId: z.number().int().positive().nullable().optional(),
  status: z.enum(['ACTIVE','INACTIVE','TERMINATED']).default('ACTIVE'),
})
const updateSchema = createSchema.partial().omit({ userId: true })

export const employeeRouter = Router()
employeeRouter.use(requireAuth)
employeeRouter.get('/', employeeController.list)
employeeRouter.get('/stats', employeeController.stats)
employeeRouter.get('/:id/profile', validateParams(idSchema), employeeController.profile)
employeeRouter.get('/:id', validateParams(idSchema), employeeController.get)
employeeRouter.post('/', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateBody(createSchema), employeeController.create)
employeeRouter.post('/:id/terminate', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateParams(idSchema), validateBody(terminateSchema), employeeController.terminate)
employeeRouter.post('/:id/reactivate', authorizeRoles('ADMIN', 'SUPER_ADMIN'), validateParams(idSchema), employeeController.reactivate)
employeeRouter.put('/:id', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateParams(idSchema), validateBody(updateSchema), employeeController.update)
employeeRouter.patch('/:id', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateParams(idSchema), validateBody(updateSchema), employeeController.update)
employeeRouter.delete('/:id', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), validateParams(idSchema), employeeController.remove)