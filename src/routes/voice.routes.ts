import { Router } from 'express'
import { voiceController, createVoiceUpload } from '../controllers/voice.controller'
import { requireAuth } from '../middleware/auth.middleware'

export const voiceRouter = Router()
voiceRouter.use(requireAuth)

voiceRouter.post('/transcribe', createVoiceUpload().single('audio'), voiceController.transcribe)