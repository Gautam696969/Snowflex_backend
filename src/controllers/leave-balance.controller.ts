import { NextFunction, Request, Response } from 'express'
import { leaveBalanceService } from '../services/leave-balance.service'
import { sendSuccess } from '../utils/apiResponse'

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
      const year = request.query.year ? parseInt(String(request.query.year), 10) : new Date().getFullYear()
      const balances = await leaveBalanceService.getBalancesForEmployee(employeeId, year)
      sendSuccess(response, 200, 'Employee leave balances fetched successfully', balances)
    } catch (error) {
      next(error)
    }
  },
}
