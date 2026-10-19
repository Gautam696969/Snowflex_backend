import { NextFunction, Request, Response } from 'express'
import { attendanceRequestService } from '../services/attendance-request.service'
import { sendSuccess } from '../utils/apiResponse'

export const attendanceRequestController = {
  async create(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const record = await attendanceRequestService.create(
        request.user!.id,
        request.user!.role,
        request.body
      )
      sendSuccess(response, 201, 'Attendance request submitted successfully', record)
    } catch (error) {
      next(error)
    }
  },

  async list(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const status = typeof request.query.status === 'string' ? request.query.status : undefined
      const page = request.query.page ? Number(request.query.page) : undefined
      const limit = request.query.limit ? Number(request.query.limit) : undefined

      const data = await attendanceRequestService.list(request.user!.id, request.user!.role, {
        status,
        page,
        limit,
      })
      sendSuccess(response, 200, 'Attendance requests fetched successfully', data)
    } catch (error) {
      next(error)
    }
  },

  async approve(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const id = Number(request.params.id)
      const record = await attendanceRequestService.decide(
        id,
        request.user!.id,
        request.user!.role,
        'APPROVED'
      )
      sendSuccess(response, 200, 'Attendance request approved', record)
    } catch (error) {
      next(error)
    }
  },

  async reject(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const id = Number(request.params.id)
      const reason = request.body?.reason || request.body?.rejectReason || null
      const record = await attendanceRequestService.decide(
        id,
        request.user!.id,
        request.user!.role,
        'REJECTED',
        reason
      )
      sendSuccess(response, 200, 'Attendance request rejected', record)
    } catch (error) {
      next(error)
    }
  },

  async badgeCount(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const count = await attendanceRequestService.getPendingCount(
        request.user!.id,
        request.user!.role
      )
      sendSuccess(response, 200, 'Pending count fetched successfully', { pendingCount: count })
    } catch (error) {
      next(error)
    }
  },
}
