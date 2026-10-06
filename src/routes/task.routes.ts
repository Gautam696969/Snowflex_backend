import { Router } from 'express'
import { z } from 'zod'
import { taskController } from '../controllers/task.controller'
import { requireAuth } from '../middleware/auth.middleware'
import { authorizeRoles } from '../middleware/role.middleware'
import { validateBody, validateParams } from '../middleware/validation.middleware'

const idSchema = z.object({ id: z.coerce.number().int().positive() })
const taskState = z.enum(['TODO','IN_PROGRESS','COMPLETED','CANCELLED'])
const createSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(4000).nullable().optional(),
  assignedTo: z.number().int().positive(), priority: z.enum(['LOW','MEDIUM','HIGH','URGENT']).default('MEDIUM'),
  status: taskState.default('TODO'), dueDate: z.string().date().nullable().optional(),
})
const updateSchema = createSchema.partial()
const statusSchema = z.object({ status: taskState })

export const taskRouter = Router()
taskRouter.use(requireAuth)
taskRouter.post('/', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR', 'MANAGER'), validateBody(createSchema), taskController.create)
taskRouter.get('/', taskController.list)
taskRouter.get('/:id', validateParams(idSchema), taskController.get)
taskRouter.put('/:id', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR', 'MANAGER'), validateParams(idSchema), validateBody(updateSchema), taskController.update)
taskRouter.delete('/:id', authorizeRoles('ADMIN', 'SUPER_ADMIN', 'HR', 'MANAGER'), validateParams(idSchema), taskController.remove)
taskRouter.patch('/:id/status', validateParams(idSchema), validateBody(statusSchema), taskController.setStatus)