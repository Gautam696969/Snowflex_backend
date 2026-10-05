import { Router } from 'express'
import { createAdminController } from '../controllers/admin.controller'
import { authorizeRoles, requireAuth } from '../middleware/auth.middleware'
import { AuthServiceContract } from '../services/auth.service'

export function createAdminRouter(service?: AuthServiceContract): Router {
  const router = Router()
  const controller = createAdminController(service)

  router.get('/users', requireAuth, authorizeRoles('ADMIN', 'HR'), controller.listUsers)
  return router
}