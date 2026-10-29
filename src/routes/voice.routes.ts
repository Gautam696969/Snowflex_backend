import { Router, Request, Response, NextFunction } from 'express'
import { voiceController, createVoiceUpload } from '../controllers/voice.controller'
import { requireAuth } from '../middleware/auth.middleware'

export const voiceRouter = Router()
voiceRouter.use(requireAuth)

const upload = createVoiceUpload().single('audio')

voiceRouter.post(
  '/transcribe',
  (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            success: false,
            message: 'Audio file is too large. Maximum size is 25 MB.',
            data: null,
          })
          return
        }
        res.status(400).json({
          success: false,
          message: err.message || 'Audio upload failed.',
          data: null,
        })
        return
      }
      next()
    })
  },
  voiceController.transcribe,
)