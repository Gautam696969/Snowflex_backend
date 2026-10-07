export type HolidayType = 'PUBLIC' | 'COMPANY' | 'OPTIONAL' | 'RESTRICTED'
export type HolidayStatus = 'ACTIVE' | 'CANCELLED'

export interface HolidayDto {
  id: number
  name: string
  description: string | null
  holidayDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
  type: HolidayType
  color: string | null
  isRecurring: boolean
  status: HolidayStatus
  createdByName?: string | null
  updatedByName?: string | null
  createdAt?: string
  updatedAt?: string
  daysCount?: number
}

export interface CreateHolidayInput {
  name: string
  description?: string | null
  holidayDate: string
  endDate?: string | null
  type?: HolidayType
  color?: string | null
  isRecurring?: boolean
}

export interface UpdateHolidayInput {
  name?: string
  description?: string | null
  holidayDate?: string
  endDate?: string | null
  type?: HolidayType
  color?: string | null
  isRecurring?: boolean
  status?: HolidayStatus
}

export interface HolidayFilterQuery {
  year?: number
  month?: number
  type?: string
  status?: string
  search?: string
}
