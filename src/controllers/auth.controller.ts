import { NextFunction, Request, Response } from 'express'
import { AuthServiceContract, authService } from '../services/auth.service'
import { sendSuccess } from '../utils/apiResponse'

export function createAuthController(service: AuthServiceContract = authService) {
  return {
    register: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const { fullName, email, password } = request.body as {
          fullName: string
          email: string
          password: string
        }
        await service.register(fullName, email, password)
        sendSuccess(response, 201, 'User registered successfully', null)
      } catch (error) {
        next(error)
      }
    },

    login: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const { email, password } = request.body as { email: string; password: string }
        const result = await service.login(email, password)
        sendSuccess(response, 200, 'Login successful', result)
      } catch (error) {
        next(error)
      }
    },

    me: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const user = await service.getUserById(request.user!.id)
        sendSuccess(response, 200, 'Profile fetched successfully', user)
      } catch (error) {
        next(error)
      }
    },

    logout: (_request: Request, response: Response) => {
      sendSuccess(response, 200, 'Logout successful', null)
    },
  }
}
