export type AttendanceRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export type AttendanceRequestType =
  | 'MISSED_PUNCH'
  | 'WORK_FROM_HOME'
  | 'ON_DUTY'
  | 'CORRECTION'
  | string

export interface CreateAttendanceRequestInput {
  date: string
  type: string
  checkInTime?: string | null
  checkOutTime?: string | null
  reason: string
}

export interface RejectAttendanceRequestInput {
  reason?: string | null
}

export interface AttendanceRequestItem {
  id: number
  employeeId: number
  userId?: number
  employeeName?: string
  employeeEmail?: string
  employeeAvatarUrl?: string | null
  employeeCode?: string
  departmentName?: string
  date: string
  attendanceDate: string
  type: string
  requestType: string
  checkInTime: string | null
  checkOutTime: string | null
  reason: string
  status: AttendanceRequestStatus
  decidedBy: number | null
  decidedByName: string | null
  decidedByRole: string | null
  decidedAt: string | null
  rejectReason: string | null
  createdAt: string
  updatedAt: string
}

export interface AttendanceRequestListFilters {
  status?: string
  page?: number
  limit?: number
}
