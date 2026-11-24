import { Request, Response, NextFunction } from 'express'
import { webpushService } from '../services/webpush.service'
import { sendSuccess } from '../utils/apiResponse'

export const webpushController = {
  getPublicKey(_req: Request, res: Response) {
    const publicKey = webpushService.getPublicKey()
    sendSuccess(res, 200, 'Public VAPID key retrieved', { publicKey })
  },

  async subscribe(req: Request, res: Response, next: NextFunction) {
    try {
      const { subscription } = req.body as {
        subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
      }
      if (!subscription?.endpoint || !subscription?.keys) {
        res.status(400).json({ success: false, message: 'Invalid subscription object' })
        return
      }

      const userId = Number(req.user?.id)
      await webpushService.saveSubscription(userId, subscription)
      sendSuccess(res, 200, 'Push subscription saved successfully', null)
    } catch (err) {
      next(err)
    }
  },

  async unsubscribe(req: Request, res: Response, next: NextFunction) {
    try {
      const { endpoint } = req.body as { endpoint: string }
      if (endpoint) {
        await webpushService.deleteSubscription(endpoint)
      }
      sendSuccess(res, 200, 'Unsubscribed successfully', null)
    } catch (err) {
      next(err)
    }
  },
}

