import { NextFunction, Request, Response } from 'express'
import { departmentService } from '../services/department.service'
import { sendSuccess } from '../utils/apiResponse'

export const departmentController = {
  async list(_request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Departments fetched successfully', await departmentService.list()) } catch (error) { next(error) }
  },
  async get(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Department fetched successfully', await departmentService.get(Number(request.params.id))) } catch (error) { next(error) }
  },
  async create(request: Request, response: Response, next: NextFunction) {
    try { await departmentService.create(request.body); sendSuccess(response, 201, 'Department created successfully', null) } catch (error) { next(error) }
  },
  async update(request: Request, response: Response, next: NextFunction) {
    try { await departmentService.update(Number(request.params.id), request.body); sendSuccess(response, 200, 'Department updated successfully', null) } catch (error) { next(error) }
  },
  async remove(request: Request, response: Response, next: NextFunction) {
    try { await departmentService.remove(Number(request.params.id)); sendSuccess(response, 200, 'Department deleted successfully', null) } catch (error) { next(error) }
  },
}