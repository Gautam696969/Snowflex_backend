import { NextFunction, Request, Response } from 'express'
import { AuthServiceContract, authService } from '../services/auth.service'

export function createAdminController(service: AuthServiceContract = authService) {
  return {
    listUsers: async (_request: Request, response: Response, next: NextFunction) => {
      try {
        const users = await service.listUsers()
        response.status(200).json({ success: true, users })
      } catch (error) {
        next(error)
      }
    },
  }
}