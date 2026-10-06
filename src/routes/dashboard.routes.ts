import { Router } from 'express'
import { dashboardController } from '../controllers/dashboard.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'

export const dashboardRouter = Router()
dashboardRouter.use(requireAuth)
dashboardRouter.get('/admin', authorizeRoles('ADMIN', 'SUPER_ADMIN'), dashboardController.organization)
dashboardRouter.get('/hr', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR'), dashboardController.organization)
dashboardRouter.get('/manager', authorizeRoles('MANAGER', 'ADMIN', 'SUPER_ADMIN'), dashboardController.manager)
dashboardRouter.get('/employee', authorizeRoles('EMPLOYEE','USER'), dashboardController.employee)