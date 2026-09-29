import { NextFunction, Request, Response } from 'express'
import { taskService } from '../services/task.service'
import { sendSuccess } from '../utils/apiResponse'

export const taskController = {
  async create(request: Request, response: Response, next: NextFunction) {
    try { await taskService.create(request.body, request.user!.id); sendSuccess(response, 201, 'Task created successfully', null) } catch (error) { next(error) }
  },
  async list(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Tasks fetched successfully', await taskService.list(request.user!.id, request.user!.role)) } catch (error) { next(error) }
  },
  async get(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Task fetched successfully', await taskService.get(Number(request.params.id), request.user!.id, request.user!.role)) } catch (error) { next(error) }
  },
  async update(request: Request, response: Response, next: NextFunction) {
    try { await taskService.update(Number(request.params.id), request.body, request.user!.id, request.user!.role); sendSuccess(response, 200, 'Task updated successfully', null) } catch (error) { next(error) }
  },
  async remove(request: Request, response: Response, next: NextFunction) {
    try { await taskService.remove(Number(request.params.id), request.user!.id, request.user!.role); sendSuccess(response, 200, 'Task deleted successfully', null) } catch (error) { next(error) }
  },
  async setStatus(request: Request, response: Response, next: NextFunction) {
    try { await taskService.setStatus(Number(request.params.id), request.body.status, request.user!.id, request.user!.role); sendSuccess(response, 200, 'Task status updated', null) } catch (error) { next(error) }
  },
}