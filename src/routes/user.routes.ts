import { Router } from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { userController } from '../controllers/user.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { validateBody } from '../middleware/validation.middleware'
import { HttpError } from '../utils/http-error'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg']
    if (allowed.includes(file.mimetype.toLowerCase())) {
      cb(null, true)
    } else {
      cb(new HttpError(400, 'Invalid file type. Allowed formats: JPG, PNG, WebP.'))
    }
  },
})

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many password change attempts. Please try again after 15 minutes.',
  },
})

const updateProfileSchema = z.object({
  fullName: z.string().min(2, 'Full name must contain at least 2 characters').max(100).optional(),
  phone: z.string().max(30).nullable().optional(),
  designation: z.string().max(100).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  gender: z.string().max(50).nullable().optional(),
  email: z.string().email().optional(),
  employeeCode: z.string().max(30).optional(),
  departmentId: z.coerce.number().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, 'New password must contain at least 8 characters'),
})

export const userRouter = Router()

userRouter.use(requireAuth)

userRouter.get('/me', userController.getMe)
userRouter.put('/me', validateBody(updateProfileSchema), userController.updateMe)
userRouter.patch('/me', validateBody(updateProfileSchema), userController.updateMe)

// Avatar routes (supports both POST and PUT as per requirements)
userRouter.post('/me/avatar', upload.single('avatar'), userController.uploadAvatar)
userRouter.put('/me/avatar', upload.single('avatar'), userController.uploadAvatar)
userRouter.delete('/me/avatar', userController.removeAvatar)

// Password change
userRouter.post('/me/change-password', changePasswordLimiter, validateBody(changePasswordSchema), userController.changePassword)
