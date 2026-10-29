import { NextFunction, Request, Response } from 'express'
import { leaveBalanceService } from '../services/leave-balance.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'
import { normalizeRole } from '../utils/roles'
import { dashboardService } from '../services/dashboard.service'

export const leaveBalanceController = {
  async mine(request: Request, response: Response, next: NextFunction) {
    try {
      const year = request.query.year ? parseInt(String(request.query.year), 10) : new Date().getFullYear()
      const balances = await leaveBalanceService.getBalancesForUser(request.user!.id, year)
      sendSuccess(response, 200, 'My leave balances fetched successfully', balances)
    } catch (error) {
      next(error)
    }
  },

  async forEmployee(request: Request, response: Response, next: NextFunction) {
    try {
      const employeeId = Number(request.params.employeeId)
      const userRole = normalizeRole(request.user!.role)
      const currentUserId = request.user!.id

      // Non-admin roles must satisfy ownership or manager hierarchy checks
      if (!['ADMIN', 'SUPER_ADMIN', 'HR'].includes(userRole)) {
        const targetEmployee = await dashboardService.findEmployee(employeeId)
        if (!targetEmployee) {
          throw new HttpError(404, 'Employee not found')
        }
        const isSelf = Number(targetEmployee.USER_ID) === currentUserId || Number(targetEmployee.ID) === currentUserId
        if (userRole === 'MANAGER') {
          const isTeam = await dashboardService.isTeamMember(currentUserId, Number(targetEmployee.ID))
          if (!isSelf && !isTeam) {
            throw new HttpError(403, "Role not allowed: you do not have permission to view this employee's leave balance")
          }
        } else {
          if (!isSelf) {
            throw new HttpError(403, 'Role not allowed: you can only view your own leave balance')
          }
        }
      }

      const year = request.query.year ? parseInt(String(request.query.year), 10) : new Date().getFullYear()
      const balances = await leaveBalanceService.getBalancesForEmployee(employeeId, year)
      sendSuccess(response, 200, 'Employee leave balances fetched successfully', balances)
    } catch (error) {
      next(error)
    }
  },
}
