import { Router } from 'express'
import { z } from 'zod'
import { leaveBalanceController } from '../controllers/leave-balance.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateParams } from '../middleware/validation.middleware'

const employeeParamsSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
})

export const leaveBalanceRouter = Router()
leaveBalanceRouter.use(requireAuth)

leaveBalanceRouter.get('/me', leaveBalanceController.mine)
leaveBalanceRouter.get(
  '/employee/:employeeId',
  authorizeRoles('ADMIN', 'HR', 'MANAGER'),
  validateParams(employeeParamsSchema),
  leaveBalanceController.forEmployee
)
