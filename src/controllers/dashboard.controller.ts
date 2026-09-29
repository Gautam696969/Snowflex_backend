import { NextFunction, Request, Response } from 'express'
import { dashboardService } from '../services/dashboard.service'
import { sendSuccess } from '../utils/apiResponse'

export const dashboardController = {
  async organization(_request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Dashboard fetched successfully', await dashboardService.organization()) } catch (error) { next(error) }
  },
  async manager(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Dashboard fetched successfully', await dashboardService.manager(request.user!.id)) } catch (error) { next(error) }
  },
  async employee(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Dashboard fetched successfully', await dashboardService.employee(request.user!.id)) } catch (error) { next(error) }
  },
}