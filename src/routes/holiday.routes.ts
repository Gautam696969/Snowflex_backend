import { Router } from 'express'
import { z } from 'zod'
import { holidayController } from '../controllers/holiday.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const idSchema = z.object({
  id: z.coerce.number().int().positive('ID must be a positive integer'),
})

const createHolidaySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Name must be at least 2 characters')
      .max(100, 'Name cannot exceed 100 characters'),
    description: z.string().trim().max(1000).optional().nullable(),
    holidayDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'holidayDate must be in YYYY-MM-DD format'),
    endDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be in YYYY-MM-DD format')
      .optional()
      .nullable(),
    type: z.enum(['PUBLIC', 'COMPANY', 'OPTIONAL', 'RESTRICTED']).default('PUBLIC'),
    color: z
      .string()
      .trim()
      .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'color must be a valid hex code (e.g. #ed6b4f)')
      .optional()
      .nullable(),
    isRecurring: z.boolean().default(false),
  })
  .refine(
    (data) => {
      if (data.endDate && data.endDate < data.holidayDate) {
        return false
      }
      return true
    },
    {
      message: 'endDate must be greater than or equal to holidayDate',
      path: ['endDate'],
    },
  )

const updateHolidaySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Name must be at least 2 characters')
      .max(100, 'Name cannot exceed 100 characters')
      .optional(),
    description: z.string().trim().max(1000).optional().nullable(),
    holidayDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'holidayDate must be in YYYY-MM-DD format')
      .optional(),
    endDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be in YYYY-MM-DD format')
      .optional()
      .nullable(),
    type: z.enum(['PUBLIC', 'COMPANY', 'OPTIONAL', 'RESTRICTED']).optional(),
    color: z
      .string()
      .trim()
      .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'color must be a valid hex code (e.g. #ed6b4f)')
      .optional()
      .nullable(),
    isRecurring: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
  })
  .refine(
    (data) => {
      if (data.holidayDate && data.endDate && data.endDate < data.holidayDate) {
        return false
      }
      return true
    },
    {
      message: 'endDate must be greater than or equal to holidayDate',
      path: ['endDate'],
    },
  )

export const holidayRouter = Router()

// All holiday routes require authentication
holidayRouter.use(requireAuth)

// Read endpoints accessible to all active employees
holidayRouter.get('/upcoming', holidayController.getUpcoming)
holidayRouter.get('/', holidayController.list)
holidayRouter.get('/:id', validateParams(idSchema), holidayController.getById)

// Management endpoints restricted to SUPER_ADMIN, ADMIN, HR
holidayRouter.post(
  '/',
  authorizeRoles('SUPER_ADMIN', 'ADMIN', 'HR'),
  validateBody(createHolidaySchema),
  holidayController.create,
)

holidayRouter.put(
  '/:id',
  authorizeRoles('SUPER_ADMIN', 'ADMIN', 'HR'),
  validateParams(idSchema),
  validateBody(updateHolidaySchema),
  holidayController.update,
)

holidayRouter.delete(
  '/:id',
  authorizeRoles('SUPER_ADMIN', 'ADMIN', 'HR'),
  validateParams(idSchema),
  holidayController.delete,
)
