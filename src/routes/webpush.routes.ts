import { Router } from 'express'
import { webpushController } from '../controllers/webpush.controller'
import { requireAuth } from '../middleware/auth.middleware'

export const webpushRouter = Router()

// Public VAPID key can be fetched publicly or with auth
webpushRouter.get('/public-key', webpushController.getPublicKey)

// Subscribe & unsubscribe require user authentication
webpushRouter.post('/subscribe', requireAuth, webpushController.subscribe)
webpushRouter.post('/unsubscribe', requireAuth, webpushController.unsubscribe)

