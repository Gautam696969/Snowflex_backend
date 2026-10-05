import { NextFunction, Request, Response } from 'express'
import { leaveService } from '../services/leave.service'
import { sendSuccess } from '../utils/apiResponse'

export const leaveController = {
  async create(request: Request, response: Response, next: NextFunction) {
    try { const result = await leaveService.create(request.user!.id, request.body); sendSuccess(response, 201, 'Leave request submitted', result) } catch (error) { next(error) }
  },
  async mine(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Leave requests fetched successfully', await leaveService.listForUser(request.user!.id)) } catch (error) { next(error) }
  },
  async list(request: Request, response: Response, next: NextFunction) {
    try {
      const filters = {
        leaveTypeId: request.query.leaveTypeId ? Number(request.query.leaveTypeId) : undefined,
        status: request.query.status ? String(request.query.status) : undefined,
        sortBy: request.query.sortBy ? String(request.query.sortBy) : undefined,
        sortOrder: request.query.sortOrder === 'asc' ? ('ASC' as const) : ('DESC' as const),
      }
      const rows = request.user!.role === 'MANAGER'
        ? await leaveService.listForManager(request.user!.id, filters)
        : await leaveService.listAll(filters)
      sendSuccess(response, 200, 'Leave requests fetched successfully', rows)
    } catch (error) { next(error) }
  },
  async get(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Leave request fetched successfully', await leaveService.getVisible(Number(request.params.id), request.user!.id, request.user!.role)) } catch (error) { next(error) }
  },
  async approve(request: Request, response: Response, next: NextFunction) {
    try { await leaveService.decide(Number(request.params.id), request.user!.id, 'APPROVED'); sendSuccess(response, 200, 'Leave request approved', null) } catch (error) { next(error) }
  },
  async reject(request: Request, response: Response, next: NextFunction) {
    try { await leaveService.decide(Number(request.params.id), request.user!.id, 'REJECTED', request.body.reason); sendSuccess(response, 200, 'Leave request rejected', null) } catch (error) { next(error) }
  },
  async cancel(request: Request, response: Response, next: NextFunction) {
    try { await leaveService.cancel(Number(request.params.id), request.user!.id); sendSuccess(response, 200, 'Leave request cancelled', null) } catch (error) { next(error) }
  },
}