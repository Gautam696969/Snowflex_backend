import { NextFunction, Request, Response } from 'express'
import { AuthServiceContract, authService } from '../services/auth.service'

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
        response.status(201).json({ success: true, message: 'User registered successfully' })
      } catch (error) {
        next(error)
      }
    },

    login: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const { email, password } = request.body as { email: string; password: string }
        const result = await service.login(email, password)
        response.status(200).json({
          success: true,
          message: 'Login successful',
          token: result.token,
          user: result.user,
        })
      } catch (error) {
        next(error)
      }
    },

    me: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const user = await service.getUserById(request.user!.id)
        response.status(200).json({ success: true, user })
      } catch (error) {
        next(error)
      }
    },

    logout: (_request: Request, response: Response) => {
      response.status(200).json({ success: true, message: 'Logout successful' })
    },
  }
}
