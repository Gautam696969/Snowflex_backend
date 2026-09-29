import { Router } from 'express'
import { z } from 'zod'
import { createAuthController } from '../controllers/auth.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { validateBody } from '../middleware/validation.middleware'
import { AuthServiceContract } from '../services/auth.service'

const registerSchema = z.object({
  fullName: z.string().trim().min(1).max(150),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72),
})

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(72),
})

export function createAuthRouter(service?: AuthServiceContract): Router {
  const router = Router()
  const controller = createAuthController(service)
  router.post(
    '/register',
    validateBody(registerSchema),
    controller.register,
  )

  router.post(
    '/login',
    validateBody(loginSchema),
    controller.login,
  )

  router.get('/me', requireAuth, controller.me)
  router.post('/logout', requireAuth, controller.logout)
  return router
}
