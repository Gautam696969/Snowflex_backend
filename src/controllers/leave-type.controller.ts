import { NextFunction, Request, Response } from 'express'
import { leaveTypeService } from '../services/leave-type.service'
import { sendSuccess } from '../utils/apiResponse'

export const leaveTypeController = {
  async list(request: Request, response: Response, next: NextFunction) {
    try {
      // If user is ADMIN or HR and ?activeOnly=false, show all; otherwise active only
      const activeOnly = request.query.activeOnly !== 'false'
      const types = await leaveTypeService.list(activeOnly)
      sendSuccess(response, 200, 'Leave types fetched successfully', types)
    } catch (error) {
      next(error)
    }
  },

  async get(request: Request, response: Response, next: NextFunction) {
    try {
      const type = await leaveTypeService.getById(Number(request.params.id))
      sendSuccess(response, 200, 'Leave type fetched successfully', type)
    } catch (error) {
      next(error)
    }
  },

  async create(request: Request, response: Response, next: NextFunction) {
    try {
      const created = await leaveTypeService.create(request.body)
      sendSuccess(response, 201, 'Leave type created successfully', created)
    } catch (error) {
      next(error)
    }
  },

  async update(request: Request, response: Response, next: NextFunction) {
    try {
      const updated = await leaveTypeService.update(Number(request.params.id), request.body)
      sendSuccess(response, 200, 'Leave type updated successfully', updated)
    } catch (error) {
      next(error)
    }
  },

  async toggle(request: Request, response: Response, next: NextFunction) {
    try {
      const isActive = Boolean(request.body.isActive)
      const updated = await leaveTypeService.toggleActive(Number(request.params.id), isActive)
      sendSuccess(response, 200, `Leave type ${isActive ? 'activated' : 'deactivated'} successfully`, updated)
    } catch (error) {
      next(error)
    }
  },

  async delete(request: Request, response: Response, next: NextFunction) {
    try {
      await leaveTypeService.delete(Number(request.params.id))
      sendSuccess(response, 200, 'Leave type deleted successfully', null)
    } catch (error) {
      next(error)
    }
  },
}
