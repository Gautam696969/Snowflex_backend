import { NextFunction, Request, Response } from 'express'
import { dashboardService } from '../services/dashboard.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'
import { normalizeRole } from '../utils/roles'
import { holidayService } from '../services/holiday.service'
import { leaveService } from '../services/leave.service'
import { attendanceRequestService } from '../services/attendance-request.service'
import { employeeService } from '../services/employee.service'

export const dashboardController = {
  async organization(_request: Request, response: Response, next: NextFunction) {
    try {
      sendSuccess(response, 200, 'Dashboard fetched successfully', await dashboardService.organization())
    } catch (error) {
      next(error)
    }
  },

  async admin(request: Request, response: Response, next: NextFunction) {
    try {
      const userRole = normalizeRole(request.user!.role)
      if (!['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
        throw new HttpError(403, 'Role not allowed: admin dashboard is restricted to administrators')
      }
      sendSuccess(response, 200, 'Dashboard fetched successfully', await dashboardService.organization())
    } catch (error) {
      next(error)
    }
  },

  async hr(request: Request, response: Response, next: NextFunction) {
    try {
      const userRole = normalizeRole(request.user!.role)
      if (!['ADMIN', 'SUPER_ADMIN', 'HR'].includes(userRole)) {
        throw new HttpError(403, 'Role not allowed: HR dashboard is restricted to HR and administrators')
      }
      sendSuccess(response, 200, 'Dashboard fetched successfully', await dashboardService.organization())
    } catch (error) {
      next(error)
    }
  },

  async manager(request: Request, response: Response, next: NextFunction) {
    try {
      const userRole = normalizeRole(request.user!.role)
      if (!['MANAGER', 'ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
        throw new HttpError(403, 'Role not allowed: manager dashboard is restricted to managers and administrators')
      }
      sendSuccess(response, 200, 'Dashboard fetched successfully', await dashboardService.manager(request.user!.id))
    } catch (error) {
      next(error)
    }
  },

  async employee(request: Request, response: Response, next: NextFunction) {
    try {
      const rawId = request.params.id || request.params.employeeId || request.query.id || request.query.employeeId
      const targetId = rawId !== undefined && rawId !== null && rawId !== '' ? Number(rawId) : null
      const currentUserId = request.user!.id
      const userRole = normalizeRole(request.user!.role)

      if (targetId !== null) {
        if (isNaN(targetId) || targetId <= 0) {
          throw new HttpError(400, 'Invalid employee ID')
        }
        const targetEmployee = await dashboardService.findEmployee(targetId)
        if (!targetEmployee) {
          throw new HttpError(404, 'Employee not found')
        }
        const empId = Number(targetEmployee.ID)
        const empUserId = Number(targetEmployee.USER_ID)

        // ADMIN, SUPER_ADMIN, and HR can access any employee's dashboard
        if (['ADMIN', 'SUPER_ADMIN', 'HR'].includes(userRole)) {
          const data = await dashboardService.employeeByEmployeeId(empId)
          sendSuccess(response, 200, 'Dashboard fetched successfully', data)
          return
        }

        // MANAGER can view themselves or members of their team
        if (userRole === 'MANAGER') {
          const isSelf = empUserId === currentUserId || empId === currentUserId
          const isTeam = await dashboardService.isTeamMember(currentUserId, empId)
          if (!isSelf && !isTeam) {
            throw new HttpError(403, "Role not allowed: you do not have permission to access this employee's dashboard")
          }
          const data = await dashboardService.employeeByEmployeeId(empId)
          sendSuccess(response, 200, 'Dashboard fetched successfully', data)
          return
        }

        // EMPLOYEE / USER can only view their own dashboard
        const isSelf = empUserId === currentUserId || empId === currentUserId
        if (!isSelf) {
          throw new HttpError(403, 'Role not allowed: you can only view your own dashboard data')
        }
        const data = await dashboardService.employeeByEmployeeId(empId)
        sendSuccess(response, 200, 'Dashboard fetched successfully', data)
        return
      }

      // No targetId provided -> query caller's own employee dashboard
      const data = await dashboardService.employee(currentUserId)
      sendSuccess(response, 200, 'Dashboard fetched successfully', data)
    } catch (error) {
      next(error)
    }
  },

  async stats(request: Request, response: Response, next: NextFunction) {
    try {
      const userRole = normalizeRole(request.user!.role)
      const rawId = request.params.id || request.query.id || request.query.employeeId
      if (rawId) {
        return dashboardController.employeeStats(request, response, next)
      }
      if (['ADMIN', 'SUPER_ADMIN', 'HR'].includes(userRole)) {
        const stats = await employeeService.stats()
        sendSuccess(response, 200, 'Dashboard statistics fetched successfully', stats)
        return
      }
      const emp = await dashboardService.employee(request.user!.id)
      sendSuccess(response, 200, 'Dashboard statistics fetched successfully', emp)
    } catch (error) {
      next(error)
    }
  },

  async employeeStats(request: Request, response: Response, next: NextFunction) {
    return dashboardController.employee(request, response, next)
  },

  async upcoming(request: Request, response: Response, next: NextFunction) {
    try {
      const limit = request.query.limit ? Number(request.query.limit) : 5
      const upcomingHolidays = await holidayService.getUpcoming(limit)
      sendSuccess(response, 200, 'Upcoming events fetched successfully', { holidays: upcomingHolidays })
    } catch (error) {
      next(error)
    }
  },

  async employeeUpcoming(request: Request, response: Response, next: NextFunction) {
    return dashboardController.upcoming(request, response, next)
  },

  async badgeCount(request: Request, response: Response, next: NextFunction) {
    try {
      const userId = request.user!.id
      const role = request.user!.role
      const [leaveCount, attendanceCount] = await Promise.all([
        leaveService.getBadgeCount(userId, role).catch(() => 0),
        attendanceRequestService.getPendingCount(userId, role).catch(() => 0),
      ])
      sendSuccess(response, 200, 'Dashboard badge counts fetched successfully', {
        leaveBadgeCount: leaveCount,
        attendanceBadgeCount: attendanceCount,
        total: leaveCount + attendanceCount,
      })
    } catch (error) {
      next(error)
    }
  },

  async employeeBadgeCount(request: Request, response: Response, next: NextFunction) {
    return dashboardController.badgeCount(request, response, next)
  },
}