import { Request, Response, NextFunction } from 'express'
import { themeService, assertThemePermissions, assertBulkThemePermissions } from '../services/theme.service'
import { authService } from '../services/auth.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'
import { normalizeRole } from '../utils/roles'
import type { SetThemeInput } from '../types/theme.types'

export const themeController = {
  async getMyTheme(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const userId = request.user!.id
      const theme = await themeService.getThemeByUserId(userId)
      sendSuccess(response, 200, 'Current theme fetched successfully', theme)
    } catch (error) {
      next(error)
    }
  },

  async setMyMode(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const userId = request.user!.id
      const mode = request.body.mode as 'light' | 'dark'
      const updated = await themeService.setUserMode(userId, mode)
      sendSuccess(response, 200, `Workspace display mode updated to ${mode}`, updated)
    } catch (error) {
      next(error)
    }
  },

  async getThemeForUser(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const targetUserId = Number(request.params.userId)
      const requesterId = request.user!.id
      const requesterRole = request.user!.role

      if (isNaN(targetUserId)) {
        throw new HttpError(400, 'Invalid userId parameter')
      }

      // If querying someone else, check permissions
      if (requesterId !== targetUserId) {
        const targetUser = await authService.getUserById(targetUserId)
        const normReq = normalizeRole(requesterRole)
        const normTarget = normalizeRole(targetUser.role)

        if (normReq !== 'SUPER_ADMIN' && normReq !== 'ADMIN') {
          throw new HttpError(403, 'Forbidden: You do not have permission to view other users\' themes.')
        }

        if (normReq === 'ADMIN' && normTarget === 'SUPER_ADMIN') {
          throw new HttpError(403, 'Forbidden: Administrators cannot view or modify themes for Super Admins.')
        }
      }

      const theme = await themeService.getThemeByUserId(targetUserId)
      sendSuccess(response, 200, 'User theme fetched successfully', theme)
    } catch (error) {
      next(error)
    }
  },

  async setThemeForUser(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const targetUserId = Number(request.params.userId)
      const requesterId = request.user!.id
      const requesterRole = request.user!.role

      if (isNaN(targetUserId)) {
        throw new HttpError(400, 'Invalid userId parameter')
      }

      const targetUser = await authService.getUserById(targetUserId)
      assertThemePermissions(requesterRole, requesterId, targetUser.role, targetUserId)

      const input: SetThemeInput = request.body
      const updatedTheme = await themeService.setTheme(targetUserId, input, requesterId)

      sendSuccess(response, 200, `Theme updated successfully for user ${targetUser.fullName}`, updatedTheme)
    } catch (error) {
      next(error)
    }
  },

  async resetThemeForUser(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const targetUserId = Number(request.params.userId)
      const requesterId = request.user!.id
      const requesterRole = request.user!.role

      if (isNaN(targetUserId)) {
        throw new HttpError(400, 'Invalid userId parameter')
      }

      const targetUser = await authService.getUserById(targetUserId)
      assertThemePermissions(requesterRole, requesterId, targetUser.role, targetUserId)

      await themeService.resetTheme(targetUserId)
      sendSuccess(response, 200, `Theme reset to default for user ${targetUser.fullName}`, { userId: targetUserId, reset: true })
    } catch (error) {
      next(error)
    }
  },

  async bulkSetThemeForRole(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const role = String(request.params.role)
      const requesterId = request.user!.id
      const requesterRole = request.user!.role

      assertBulkThemePermissions(requesterRole, role)

      const input: SetThemeInput = request.body
      const result = await themeService.bulkSetThemeByRole(role, input, requesterId)

      sendSuccess(response, 200, `Theme applied to all users in role ${role}`, result)
    } catch (error) {
      next(error)
    }
  },
}
