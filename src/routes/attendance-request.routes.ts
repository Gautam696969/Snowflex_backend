import { Router } from 'express'
import { z } from 'zod'
import { attendanceRequestController } from '../controllers/attendance-request.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD'),
  type: z.string().trim().min(1, 'Type is required').max(50),
  checkInTime: z.string().trim().max(30).optional().nullable(),
  checkOutTime: z.string().trim().max(30).optional().nullable(),
  reason: z.string().trim().min(1, 'Reason is required').max(2000),
})

const rejectSchema = z.object({
  reason: z.string().trim().max(1000).optional().nullable(),
  rejectReason: z.string().trim().max(1000).optional().nullable(),
})

export const attendanceRequestRouter = Router()
attendanceRequestRouter.use(requireAuth)

// POST /attendance-requests -> EMPLOYEE only
attendanceRequestRouter.post(
  '/',
  authorizeRoles('EMPLOYEE', 'USER'),
  validateBody(createSchema),
  attendanceRequestController.create
)

// GET /attendance-requests/badge-count
attendanceRequestRouter.get('/badge-count', attendanceRequestController.badgeCount)

// GET /attendance-requests?status=&page= -> ADMIN/HR/SUPER_ADMIN see all; EMPLOYEE sees only their own
attendanceRequestRouter.get('/', attendanceRequestController.list)

// PATCH /attendance-requests/:id/approve -> ADMIN/HR/SUPER_ADMIN only
attendanceRequestRouter.patch(
  '/:id/approve',
  authorizeRoles('ADMIN', 'HR', 'SUPER_ADMIN'),
  validateParams(idParamSchema),
  attendanceRequestController.approve
)

// PATCH /attendance-requests/:id/reject -> ADMIN/HR/SUPER_ADMIN only
attendanceRequestRouter.patch(
  '/:id/reject',
  authorizeRoles('ADMIN', 'HR', 'SUPER_ADMIN'),
  validateParams(idParamSchema),
  validateBody(rejectSchema),
  attendanceRequestController.reject
)
