import { Router } from 'express'
import { z } from 'zod'
import { meetingController } from '../controllers/meeting.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { validateBody } from '../middleware/validation.middleware'

const createMeetingSchema = z.object({
  title: z.string().trim().min(1, 'Meeting title is required').max(200),
  description: z.string().trim().max(1000).optional(),
  chatId: z.number().int().positive().nullable().optional(),
  invitedUserIds: z.array(z.number().int().positive()).optional(),
  scheduledAt: z.string().trim().nullable().optional(),
})

export const meetingRouter = Router()

meetingRouter.use(requireAuth)

meetingRouter.post('/', validateBody(createMeetingSchema), meetingController.createMeeting)
meetingRouter.get('/', meetingController.listMeetings)
meetingRouter.get('/:code', meetingController.getMeeting)
meetingRouter.post('/:code/join', meetingController.joinMeeting)
meetingRouter.post('/:code/leave', meetingController.leaveMeeting)
meetingRouter.post('/:code/end', meetingController.endMeeting)

