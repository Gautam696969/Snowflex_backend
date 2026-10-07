import { NextFunction, Request, Response } from 'express'
import { employeeService } from '../services/employee.service'
import { HttpError } from '../utils/http-error'
import { sendSuccess } from '../utils/apiResponse'

const broadRoles = ['ADMIN', 'SUPER_ADMIN', 'HR']

export const employeeController = {
  async list(request: Request, response: Response, next: NextFunction) {
    try {
      const status = typeof request.query.status === 'string' ? request.query.status : 'ACTIVE'
      const users = broadRoles.includes(request.user!.role)
        ? await employeeService.list(status)
        : request.user!.role === 'MANAGER'
          ? await employeeService.teamForUser(request.user!.id)
          : [await employeeService.forUser(request.user!.id)]
      sendSuccess(response, 200, 'Employees fetched successfully', users)
    } catch (error) { next(error) }
  },
  async stats(_request: Request, response: Response, next: NextFunction) {
    try {
      const stats = await employeeService.stats()
      sendSuccess(response, 200, 'Employee statistics fetched successfully', stats)
    } catch (error) { next(error) }
  },
  async terminate(request: Request, response: Response, next: NextFunction) {
    try {
      const id = Number(request.params.id)
      const { reason } = request.body as { reason: string }
      const updated = await employeeService.terminate(id, reason, {
        id: request.user!.id,
        role: request.user!.role,
      })
      sendSuccess(response, 200, 'Employee terminated successfully', updated)
    } catch (error) { next(error) }
  },
  async reactivate(request: Request, response: Response, next: NextFunction) {
    try {
      const id = Number(request.params.id)
      const updated = await employeeService.reactivate(id, {
        id: request.user!.id,
        role: request.user!.role,
      })
      sendSuccess(response, 200, 'Employee reactivated successfully', updated)
    } catch (error) { next(error) }
  },
  async get(request: Request, response: Response, next: NextFunction) {
    try {
      const id = Number(request.params.id)
      const employee = await employeeService.get(id)
      if (!broadRoles.includes(request.user!.role)) {
        const visible = request.user!.role === 'MANAGER'
          ? (await employeeService.teamForUser(request.user!.id)).some((person) => Number(person.id) === id)
          : Number(employee.userId) === request.user!.id
        if (!visible) throw new HttpError(403, 'Forbidden')
      }
      sendSuccess(response, 200, 'Employee fetched successfully', employee)
    } catch (error) { next(error) }
  },
  async create(request: Request, response: Response, next: NextFunction) {
    try {
      const created = await employeeService.create(request.body)
      sendSuccess(response, 201, 'Employee created successfully', created)
    } catch (error) { next(error) }
  },
  async update(request: Request, response: Response, next: NextFunction) {
    try {
      await employeeService.update(Number(request.params.id), request.body)
      sendSuccess(response, 200, 'Employee updated successfully', null)
    } catch (error) { next(error) }
  },
  async remove(request: Request, response: Response, next: NextFunction) {
    try {
      await employeeService.remove(Number(request.params.id))
      sendSuccess(response, 200, 'Employee deleted successfully', null)
    } catch (error) { next(error) }
  },
  async profile(request: Request, response: Response, next: NextFunction) {
    return employeeController.get(request, response, next)
  },
}