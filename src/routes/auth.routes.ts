import { Router } from 'express'
import { body } from 'express-validator'
import { createAuthController } from '../controllers/auth.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { AuthServiceContract } from '../services/auth.service'

export function createAuthRouter(service?: AuthServiceContract): Router {
  const router = Router()
  const controller = createAuthController(service)
  const validateRequest = (request: Parameters<typeof controller.register>[0], response: Parameters<typeof controller.register>[1], next: Parameters<typeof controller.register>[2]) => {
    const { validationResult } = require('express-validator') as typeof import('express-validator')
    const errors = validationResult(request)
    if (!errors.isEmpty()) {
      response.status(400).json({ success: false, message: 'Invalid request' })
      return
    }
    next()
  }

  router.post(
    '/register',
    body('fullName').isString().trim().isLength({ min: 1, max: 150 }),
    body('email').isString().isEmail().normalizeEmail(),
    body('password').isString().isLength({ min: 8, max: 128 }).isByteLength({ min: 8, max: 72 }),
    validateRequest,
    controller.register,
  )

  router.post(
    '/login',
    body('email').isString().isEmail().normalizeEmail(),
    body('password').isString().isLength({ min: 1, max: 128 }).isByteLength({ min: 1, max: 72 }),
    validateRequest,
    controller.login,
  )

  router.get('/me', requireAuth, controller.me)
  router.post('/logout', requireAuth, controller.logout)
  return router
}
