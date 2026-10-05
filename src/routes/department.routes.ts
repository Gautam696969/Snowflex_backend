import { Router } from 'express'
import { z } from 'zod'
import { departmentController } from '../controllers/department.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const idSchema = z.object({ id: z.coerce.number().int().positive() })
const createSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).nullable().optional() })
const updateSchema = createSchema.partial()

export const departmentRouter = Router()
departmentRouter.use(requireAuth)
departmentRouter.get('/', departmentController.list)
departmentRouter.get('/:id', validateParams(idSchema), departmentController.get)
departmentRouter.post('/', authorizeRoles('ADMIN','HR'), validateBody(createSchema), departmentController.create)
departmentRouter.put('/:id', authorizeRoles('ADMIN','HR'), validateParams(idSchema), validateBody(updateSchema), departmentController.update)
departmentRouter.patch('/:id', authorizeRoles('ADMIN','HR'), validateParams(idSchema), validateBody(updateSchema), departmentController.update)
departmentRouter.delete('/:id', authorizeRoles('ADMIN','HR'), validateParams(idSchema), departmentController.remove)