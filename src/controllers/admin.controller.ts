import { NextFunction, Request, Response } from 'express'
import { AuthServiceContract, authService } from '../services/auth.service'
import { sendSuccess } from '../utils/apiResponse'

export function createAdminController(service: AuthServiceContract = authService) {
  return {
    listUsers: async (_request: Request, response: Response, next: NextFunction) => {
      try {
        const users = await service.listUsers()
        sendSuccess(response, 200, 'Users fetched successfully', users)
      } catch (error) {
        next(error)
      }
    },
  }
}