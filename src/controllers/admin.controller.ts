import { NextFunction, Request, Response } from 'express'
import { executeQuery, isSnowflakeConnected } from '../config/snowflake'
import { AuthServiceContract, authService } from '../services/auth.service'
import { sendPasswordResetEmail } from '../services/email.service'
import { sendSuccess } from '../utils/apiResponse'
import { HttpError } from '../utils/http-error'
import { snowflakeTable } from '../utils/snowflake-identifiers'
import { assertNotLastActiveSuperAdmin } from '../utils/super-admin-safeguards'

const usersTable = snowflakeTable('USERS')
const employeesTable = snowflakeTable('EMPLOYEES')
const departmentsTable = snowflakeTable('DEPARTMENTS')

export function createAdminController(service: AuthServiceContract = authService) {
  return {
    listUsers: async (_request: Request, response: Response, next: NextFunction) => {
      try {
        const users = await service.listUsers()
        sendSuccess(response, 200, 'Users fetched successfully', users)
      } catch (error) {
        next(error)
      }
    },

    updateUserRole: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const id = Number(request.params.id)
        const { role } = request.body as { role: string }
        if (id === request.user?.id && request.user.role === 'ADMIN' && role !== 'ADMIN') {
          throw new HttpError(400, 'You cannot remove your own administrator privileges.')
        }

        if (role !== 'SUPER_ADMIN') await assertNotLastActiveSuperAdmin(id, 'demote')

        await executeQuery(
          `UPDATE ${usersTable} SET ROLE = ? WHERE ID = ?`,
          [role, id],
        )

        const user = await service.getUserById(id)
        sendSuccess(response, 200, `User role updated to ${role}`, user)
      } catch (error) {
        next(error)
      }
    },

    getSystemInfo: async (_request: Request, response: Response, next: NextFunction) => {
      try {
        const mailConfig = {
          configured: Boolean((process.env.MAIL_USER || process.env.SMTP_USER) && (process.env.MAIL_PASS || process.env.SMTP_PASS)),
          host: process.env.MAIL_HOST || process.env.SMTP_HOST || 'smtp.gmail.com',
          port: Number(process.env.MAIL_PORT || process.env.SMTP_PORT || 465),
          user: (process.env.MAIL_USER || process.env.SMTP_USER)
            ? `${(process.env.MAIL_USER || process.env.SMTP_USER || '').slice(0, 3)}***@${(process.env.MAIL_USER || process.env.SMTP_USER || '').split('@')[1] || 'gmail.com'}`
            : 'Not configured',
          from: process.env.MAIL_FROM || process.env.EMAIL_FROM || 'Snowflex <noreply@snowflex.com>',
        }

        let counts = {
          users: 0,
          admins: 0,
          hr: 0,
          superAdmins: 0,
          managers: 0,
          employees: 0,
          employeeProfiles: 0,
          departments: 0,
        }

        try {
          const statsQuery = await executeQuery<Record<string, unknown>>(`
            SELECT
              (SELECT COUNT(*) FROM ${usersTable}) AS TOTAL_USERS,
              (SELECT COUNT(*) FROM ${usersTable} WHERE ROLE = 'ADMIN') AS TOTAL_ADMINS,
              (SELECT COUNT(*) FROM ${usersTable} WHERE ROLE = 'SUPER_ADMIN') AS TOTAL_SUPER_ADMINS,
              (SELECT COUNT(*) FROM ${usersTable} WHERE ROLE = 'HR') AS TOTAL_HR,
              (SELECT COUNT(*) FROM ${usersTable} WHERE ROLE = 'MANAGER') AS TOTAL_MANAGERS,
              (SELECT COUNT(*) FROM ${usersTable} WHERE ROLE IN ('EMPLOYEE', 'USER')) AS TOTAL_EMPLOYEES,
              (SELECT COUNT(*) FROM ${employeesTable}) AS TOTAL_EMPLOYEE_PROFILES,
              (SELECT COUNT(*) FROM ${departmentsTable}) AS TOTAL_DEPARTMENTS
          `)
          const s = statsQuery[0] || {}
          counts = {
            users: Number(s.TOTAL_USERS || 0),
            admins: Number(s.TOTAL_ADMINS || 0),
            hr: Number(s.TOTAL_HR || 0),
            superAdmins: Number(s.TOTAL_SUPER_ADMINS || 0),
            managers: Number(s.TOTAL_MANAGERS || 0),
            employees: Number(s.TOTAL_EMPLOYEES || 0),
            employeeProfiles: Number(s.TOTAL_EMPLOYEE_PROFILES || 0),
            departments: Number(s.TOTAL_DEPARTMENTS || 0),
          }
        } catch {
          // If query fails in test environment
        }

        sendSuccess(response, 200, 'System status retrieved', {
          database: {
            status: isSnowflakeConnected() ? 'CONNECTED' : 'DISCONNECTED',
            database: process.env.SNOWFLAKE_DATABASE || 'AUTH_PROJECT',
            schema: process.env.SNOWFLAKE_SCHEMA || 'PUBLIC',
            warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'SNOWFLAKE_LEARNING_WH',
            account: process.env.SNOWFLAKE_ACCOUNT || 'Snowflake Cloud',
          },
          email: mailConfig,
          server: {
            uptimeSeconds: Math.floor(process.uptime()),
            nodeVersion: process.version,
            environment: process.env.NODE_ENV || 'development',
            port: process.env.PORT || 5000,
            frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
          },
          counts,
        })
      } catch (error) {
        next(error)
      }
    },

    testEmail: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const targetEmail = (request.body as { to?: string })?.to || request.user?.email
        if (!targetEmail) {
          throw new HttpError(400, 'Target email is required.')
        }

        await sendPasswordResetEmail({
          to: targetEmail,
          resetUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`,
          fullName: 'Snowflex Admin',
        })

        sendSuccess(response, 200, `Test email successfully sent to ${targetEmail}`, null)
      } catch (error) {
        next(error)
      }
    },
  }
}