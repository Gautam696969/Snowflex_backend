import { Router } from 'express'
import { z } from 'zod'
import { themeController } from '../controllers/theme.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const hexColorRegex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export const setThemeSchema = z.object({
  mode: z.enum(['light', 'dark']).optional().nullable(),
  bgColor: z.string().trim().regex(hexColorRegex, 'Invalid hex color for bgColor').optional().nullable(),
  primaryColor: z.string().trim().regex(hexColorRegex, 'Invalid hex color for primaryColor').optional().nullable(),
  accentColor: z.string().trim().regex(hexColorRegex, 'Invalid hex color for accentColor').optional().nullable(),
  sidebarColor: z.string().trim().regex(hexColorRegex, 'Invalid hex color for sidebarColor').optional().nullable(),
  cardColor: z.string().trim().regex(hexColorRegex, 'Invalid hex color for cardColor').optional().nullable(),
  textColor: z.string().trim().regex(hexColorRegex, 'Invalid hex color for textColor').optional().nullable(),
})

export const userIdParamsSchema = z.object({
  userId: z.coerce.number().int().positive('userId must be a positive integer'),
})

export const roleParamsSchema = z.object({
  role: z.string().trim().transform((r) => r.toUpperCase().replace(/[\s-]+/g, '_')),
})

export const setModeSchema = z.object({
  mode: z.enum(['light', 'dark']),
})

export const themeRouter = Router()

themeRouter.use(requireAuth)

themeRouter.get('/me', themeController.getMyTheme)
themeRouter.put('/me/mode', validateBody(setModeSchema), themeController.setMyMode)
themeRouter.put('/role/:role', validateParams(roleParamsSchema), validateBody(setThemeSchema), themeController.bulkSetThemeForRole)
themeRouter.get('/:userId', validateParams(userIdParamsSchema), themeController.getThemeForUser)
themeRouter.put('/:userId', validateParams(userIdParamsSchema), validateBody(setThemeSchema), themeController.setThemeForUser)
themeRouter.delete('/:userId', validateParams(userIdParamsSchema), themeController.resetThemeForUser)
