import { NextFunction, Request, Response } from 'express'
import { attendanceService } from '../services/attendance.service'
import { employeeService } from '../services/employee.service'
import { HttpError } from '../utils/http-error'
import { sendSuccess } from '../utils/apiResponse'

export const attendanceController = {
  async checkIn(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 201, 'Checked in successfully', await attendanceService.checkIn(request.user!.id)) } catch (error) { next(error) }
  },
  async checkOut(request: Request, response: Response, next: NextFunction) {
    try { sendSuccess(response, 200, 'Checked out successfully', await attendanceService.checkOut(request.user!.id)) } catch (error) { next(error) }
  },
  async mine(request: Request, response: Response, next: NextFunction) {
    try {
      const employee = await employeeService.forUser(request.user!.id)
      sendSuccess(response, 200, 'Attendance fetched successfully', await attendanceService.listForEmployee(Number(employee.id)))
    } catch (error) { next(error) }
  },
  async byEmployee(request: Request, response: Response, next: NextFunction) {
    try {
      const employeeId = Number(request.params.employeeId)
      const role = request.user!.role
      if (!['ADMIN', 'HR'].includes(role)) {
        const employee = await employeeService.get(employeeId)
        const own = Number(employee.userId) === request.user!.id
        const team = role === 'MANAGER' && (await employeeService.teamForUser(request.user!.id)).some((item) => Number(item.id) === employeeId)
        if (!own && !team) throw new HttpError(403, 'Forbidden')
      }
      sendSuccess(response, 200, 'Attendance fetched successfully', await attendanceService.listForEmployee(employeeId))
    } catch (error) { next(error) }
  },
  async list(request: Request, response: Response, next: NextFunction) {
    try {
      const rows = request.user!.role === 'MANAGER'
        ? await attendanceService.listForManager(request.user!.id)
        : await attendanceService.listAll()
      sendSuccess(response, 200, 'Attendance fetched successfully', rows)
    } catch (error) { next(error) }
  },
}