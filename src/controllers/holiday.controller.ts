import { NextFunction, Request, Response } from 'express'
import { holidayService } from '../services/holiday.service'
import { sendSuccess } from '../utils/apiResponse'

export const holidayController = {
  async list(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const year = request.query.year ? Number(request.query.year) : undefined
      const month = request.query.month ? Number(request.query.month) : undefined
      const type = request.query.type ? String(request.query.type).trim() : undefined
      const status = request.query.status ? String(request.query.status).trim() : undefined
      const search = request.query.search ? String(request.query.search).trim() : undefined

      const holidays = await holidayService.list({ year, month, type, status, search })
      sendSuccess(response, 200, 'Holidays fetched successfully', holidays)
    } catch (error) {
      next(error)
    }
  },

  async getUpcoming(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const limit = request.query.limit ? Number(request.query.limit) : 5
      const upcoming = await holidayService.getUpcoming(limit)
      sendSuccess(response, 200, 'Upcoming holidays fetched successfully', upcoming)
    } catch (error) {
      next(error)
    }
  },

  async getById(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const holiday = await holidayService.getById(Number(request.params.id))
      sendSuccess(response, 200, 'Holiday fetched successfully', holiday)
    } catch (error) {
      next(error)
    }
  },

  async create(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const userId = request.user?.id ?? 0
      const created = await holidayService.create(request.body, userId)
      sendSuccess(response, 201, 'Holiday created successfully', created)
    } catch (error) {
      next(error)
    }
  },

  async update(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const userId = request.user?.id ?? 0
      const updated = await holidayService.update(Number(request.params.id), request.body, userId)
      sendSuccess(response, 200, 'Holiday updated successfully', updated)
    } catch (error) {
      next(error)
    }
  },

  async delete(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const userId = request.user?.id ?? 0
      const userRole = request.user?.role ?? 'EMPLOYEE'
      const hard = request.query.hard === 'true'
      const result = await holidayService.delete(Number(request.params.id), userId, hard, userRole)
      sendSuccess(
        response,
        200,
        result.status === 'DELETED' ? 'Holiday deleted permanently' : 'Holiday cancelled successfully',
        result,
      )
    } catch (error) {
      next(error)
    }
  },
}
