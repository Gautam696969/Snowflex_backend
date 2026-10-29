import { Router } from 'express'
import { dashboardController } from '../controllers/dashboard.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'

export const dashboardRouter = Router()
dashboardRouter.use(requireAuth)
dashboardRouter.get('/admin', dashboardController.admin)
dashboardRouter.get('/hr', dashboardController.hr)
dashboardRouter.get('/manager', dashboardController.manager)
dashboardRouter.get('/stats', dashboardController.stats)
dashboardRouter.get('/upcoming', dashboardController.upcoming)
dashboardRouter.get('/badge-count', dashboardController.badgeCount)
dashboardRouter.get('/employee/:id/stats', dashboardController.employeeStats)
dashboardRouter.get('/employee/:id/upcoming', dashboardController.employeeUpcoming)
dashboardRouter.get('/employee/:id/badge-count', dashboardController.employeeBadgeCount)
dashboardRouter.get('/employee/:id', dashboardController.employee)
dashboardRouter.get('/employee', dashboardController.employee)