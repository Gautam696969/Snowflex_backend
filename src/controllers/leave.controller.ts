import { NextFunction, Request, Response } from 'express'
import { leaveService } from '../services/leave.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'
import { logger } from '../utils/logger'

export const leaveController = {
  async create(request: Request, response: Response, next: NextFunction) {
    try { const result = await leaveService.create(request.user!.id, request.body, request.user!.role); sendSuccess(response, 201, 'Leave request submitted', result) } catch (error) { next(error) }
  },
  async mine(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Leave requests fetched successfully', await leaveService.listForUser(request.user!.id)) } catch (error) { next(error) }
  },
  async list(request: Request, response: Response, next: NextFunction) {
    try {
      const requestedScope = request.query.scope
      if (requestedScope !== undefined && requestedScope !== 'team' && requestedScope !== 'admin') {
        throw new HttpError(400, 'scope must be either team or admin')
      }
      const filters = {
        leaveTypeId: request.query.leaveTypeId ? Number(request.query.leaveTypeId) : undefined,
        status: request.query.status ? String(request.query.status) : undefined,
        sortBy: request.query.sortBy ? String(request.query.sortBy) : undefined,
        sortOrder: request.query.sortOrder === 'asc' ? ('ASC' as const) : ('DESC' as const),
      }
      const scope = requestedScope === 'admin' ? 'admin' : 'team'
      const rows = await leaveService.listAll(request.user!.id, request.user!.role, scope, filters)
      sendSuccess(response, 200, 'Leave requests fetched successfully', rows)
    } catch (error) { next(error) }
  },
  async get(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Leave request fetched successfully', await leaveService.getVisible(Number(request.params.id), request.user!.id, request.user!.role)) } catch (error) { next(error) }
  },
  async approve(request: Request, response: Response, next: NextFunction) {
    const requestId = (request.headers['x-request-id'] as string) || `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const leaveId = Number(request.params.id)
    const userId = request.user!.id
    logger.info('[LEAVE_APPROVE_ATTEMPT]', { requestId, userId, leaveId })
    try {
      const record = await leaveService.decide(leaveId, userId, request.user!.role, 'APPROVED', undefined, requestId)
      logger.info('[LEAVE_APPROVE_SUCCESS]', { requestId, userId, leaveId, outcome: 'SUCCESS' })
      sendSuccess(response, 200, 'Leave request approved', record)
    } catch (error) {
      logger.warn('[LEAVE_APPROVE_FAILED]', { requestId, userId, leaveId, error: (error as Error).message })
      next(error)
    }
  },
  async reject(request: Request, response: Response, next: NextFunction) {
    const requestId = (request.headers['x-request-id'] as string) || `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const leaveId = Number(request.params.id)
    const userId = request.user!.id
    logger.info('[LEAVE_REJECT_ATTEMPT]', { requestId, userId, leaveId })
    try {
      const record = await leaveService.decide(leaveId, userId, request.user!.role, 'REJECTED', request.body?.reason, requestId)
      logger.info('[LEAVE_REJECT_SUCCESS]', { requestId, userId, leaveId, outcome: 'SUCCESS' })
      sendSuccess(response, 200, 'Leave request rejected', record)
    } catch (error) {
      logger.warn('[LEAVE_REJECT_FAILED]', { requestId, userId, leaveId, error: (error as Error).message })
      next(error)
    }
  },
  async badgeCount(request: Request, response: Response, next: NextFunction) {
    try {
      const count = await leaveService.getBadgeCount(request.user!.id, request.user!.role)
      sendSuccess(response, 200, 'Leave badge count fetched successfully', { count })
    } catch (error) { next(error) }
  },
  async cancel(request: Request, response: Response, next: NextFunction) {
    try { await leaveService.cancel(Number(request.params.id), request.user!.id); sendSuccess(response, 200, 'Leave request cancelled', null) } catch (error) { next(error) }
  },
}