import { NextFunction, Request, Response } from 'express'
import { userService } from '../services/user.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'

export const userController = {
  async getMe(request: Request, response: Response, next: NextFunction) {
    try {
      const profile = await userService.getProfile(request.user!.id)
      sendSuccess(response, 200, 'Profile retrieved successfully', profile)
    } catch (error) {
      next(error)
    }
  },

  async updateMe(request: Request, response: Response, next: NextFunction) {
    try {
      const profile = await userService.updateProfile(
        request.user!.id,
        request.body,
        request.user!.role,
      )
      sendSuccess(response, 200, 'Profile updated successfully', profile)
    } catch (error) {
      next(error)
    }
  },

  async uploadAvatar(request: Request, response: Response, next: NextFunction) {
    try {
      if (!request.file) {
        throw new HttpError(400, 'No image file uploaded')
      }
      const avatarUrl = await userService.updateAvatar(
        request.user!.id,
        request.file.buffer,
        request.file.originalname,
      )
      sendSuccess(response, 200, 'Avatar updated successfully', { avatarUrl })
    } catch (error) {
      next(error)
    }
  },

  async removeAvatar(request: Request, response: Response, next: NextFunction) {
    try {
      await userService.removeAvatar(request.user!.id)
      sendSuccess(response, 200, 'Avatar removed successfully', { avatarUrl: null })
    } catch (error) {
      next(error)
    }
  },

  async changePassword(request: Request, response: Response, next: NextFunction) {
    try {
      const { currentPassword, newPassword } = request.body as {
        currentPassword?: string
        newPassword: string
      }
      await userService.changePassword(request.user!.id, currentPassword, newPassword)
      sendSuccess(response, 200, 'Password changed successfully', null)
    } catch (error) {
      next(error)
    }
  },
}
