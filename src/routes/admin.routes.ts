import { Router } from 'express'
import { z } from 'zod'
import { createAdminController } from '../controllers/admin.controller'
import { authorizeRoles, requireAuth } from '../middleware/auth.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'
import { AuthServiceContract } from '../services/auth.service'

const roleSchema = z.object({
  role: z.enum(['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE']),
})

const idSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const testEmailSchema = z.object({
  to: z.string().trim().email().optional(),
})

export function createAdminRouter(service?: AuthServiceContract): Router {
  const router = Router()
  const controller = createAdminController(service)

  router.get('/users', requireAuth, authorizeRoles('ADMIN', 'HR'), controller.listUsers)
  router.patch('/users/:id/role', requireAuth, authorizeRoles('ADMIN'), validateParams(idSchema), validateBody(roleSchema), controller.updateUserRole)
  router.get('/system', requireAuth, authorizeRoles('ADMIN'), controller.getSystemInfo)
  router.post('/test-email', requireAuth, authorizeRoles('ADMIN'), validateBody(testEmailSchema), controller.testEmail)

  return router
}